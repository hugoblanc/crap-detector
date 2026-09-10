/**
 * Couplage temporel (change coupling) : deux fichiers qui changent toujours ensemble.
 * Quand aucune arête d'import ne les relie, c'est du couplage caché — un lien de
 * conception qu'aucun linter ni analyse statique ne voit, seulement l'historique.
 * Référence : Tornhill, « Software Design X-Rays », chapitre sur le change coupling.
 */
import { globToRegExp, matchesAnyGlob } from '../core/glob.js';
import { compareFindings, envelope, makeFinding } from '../core/findings.js';
import type { ChurnConfig, ScopeConfig } from '../core/config.js';
import type { CoChange, CouplingReport, Finding } from '../core/types.js';
import type { ImportGraph } from '../imports/extract.js';
import { areLinked } from '../imports/extract.js';
import type { GitCommit } from './git.js';

const PAIR_SEPARATOR = '\u0000';

/** Fichiers du scope touchés par le commit, dédoublonnés et triés. */
function scopedFiles(commit: GitCommit, include: RegExp[], exclude: RegExp[]): string[] {
  const files = new Set<string>();
  for (const change of commit.files) {
    if (matchesAnyGlob(include, change.path) && !matchesAnyGlob(exclude, change.path)) {
      files.add(change.path);
    }
  }
  return [...files].sort();
}

/**
 * Compte les co-modifications par paire.
 *
 * Deux garde-fous, dans cet ordre :
 * 1. Les commits touchant plus de maxFilesPerCommit fichiers sont ignorés — un
 *    reformatage global relierait tout à tout sans rien dire de la conception.
 * 2. Seuls les fichiers ayant déjà atteint minCoChangeCommits sont appariés. Une
 *    paire ne peut pas dépasser le nombre de commits de son fichier le moins actif,
 *    donc ce filtre est exact et évite d'allouer des millions de paires inutiles.
 */
export function computeCoChanges(
  commits: GitCommit[],
  scope: ScopeConfig,
  config: ChurnConfig,
  graph: ImportGraph,
): CoChange[] {
  const include = scope.include.map(globToRegExp);
  const exclude = scope.exclude.map(globToRegExp);

  const eligible: string[][] = [];
  const commitCounts = new Map<string, number>();
  for (const commit of commits) {
    const files = scopedFiles(commit, include, exclude);
    if (files.length < 2 || files.length > config.maxFilesPerCommit) continue;
    eligible.push(files);
    for (const file of files) commitCounts.set(file, (commitCounts.get(file) ?? 0) + 1);
  }

  const together = new Map<string, number>();
  for (const files of eligible) {
    const active = files.filter(
      (file) => (commitCounts.get(file) ?? 0) >= config.minCoChangeCommits,
    );
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const key = `${active[i]}${PAIR_SEPARATOR}${active[j]}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
    }
  }

  const pairs: CoChange[] = [];
  for (const [key, count] of together) {
    if (count < config.minCoChangeCommits) continue;
    const [fileA, fileB] = key.split(PAIR_SEPARATOR) as [string, string];
    const commitsA = commitCounts.get(fileA) ?? 0;
    const commitsB = commitCounts.get(fileB) ?? 0;
    const degree = count / Math.min(commitsA, commitsB);
    if (degree < config.minCoChangeDegree) continue;
    pairs.push({
      fileA,
      fileB,
      together: count,
      commitsA,
      commitsB,
      degree,
      linked: areLinked(graph, fileA, fileB),
    });
  }
  return pairs.sort(
    (a, b) => b.degree - a.degree
      || b.together - a.together
      || a.fileA.localeCompare(b.fileA)
      || a.fileB.localeCompare(b.fileB),
  );
}

/** Une paire fortement couplée mais sans import est un lien de conception implicite. */
export function couplingFindings(pairs: CoChange[], config: ChurnConfig): Finding[] {
  const findings = pairs
    .filter((pair) => !pair.linked)
    .map((pair) =>
      makeFinding({
        tool: 'churn',
        rule: 'hidden-coupling',
        file: pair.fileA,
        symbol: pair.fileB,
        symbolKey: pair.fileB,
        value: Math.round(pair.degree * 100),
        threshold: Math.round(config.minCoChangeDegree * 100),
        message:
          `${pair.fileA} et ${pair.fileB} changent ensemble dans ${pair.together} commits `
          + `(${Math.round(pair.degree * 100)} %) sans import entre eux`,
      }));
  return findings.sort(compareFindings);
}

export function analyzeCoupling(
  rootPath: string,
  commits: GitCommit[],
  scope: ScopeConfig,
  config: ChurnConfig,
  graph: ImportGraph,
): CouplingReport {
  const pairs = computeCoChanges(commits, scope, config, graph);
  const findings = couplingFindings(pairs, config);
  return {
    ...envelope(rootPath, 'git'),
    summary: {
      pairs: pairs.length,
      hiddenPairs: pairs.filter((pair) => !pair.linked).length,
    },
    pairs,
    findings,
  };
}
