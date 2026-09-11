/**
 * Couplage temporel (change coupling) : deux fichiers qui changent toujours ensemble.
 * Quand aucun lien d'imports ne l'explique, c'est du couplage caché — un lien de
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
import { renameTracker } from './git.js';

const PAIR_SEPARATOR = '\u0000';

interface History {
  /** Fichiers encore présents de chaque commit retenu, sous leur nom actuel, triés. */
  commits: string[][];
  /** Fichier → nombre de commits retenus qui le touchent. */
  counts: Map<string, number>;
}

/**
 * Commits retenus pour l'appariement. Un commit touchant plus de maxFilesPerCommit fichiers
 * du scope est ignoré : un reformatage global relierait tout à tout sans rien dire de la
 * conception. Un fichier absent du graphe n'existe plus dans le périmètre : aucune paire ne le cite.
 */
function readHistory(commits: GitCommit[], scope: ScopeConfig, config: ChurnConfig, graph: ImportGraph): History {
  const include = scope.include.map(globToRegExp);
  const exclude = scope.exclude.map(globToRegExp);
  const currentPath = renameTracker();
  const history: History = { commits: [], counts: new Map() };
  for (const commit of commits) {
    const scoped = new Set(commit.files.map(currentPath)
      .filter((path) => matchesAnyGlob(include, path) && !matchesAnyGlob(exclude, path)));
    if (scoped.size < 2 || scoped.size > config.maxFilesPerCommit) continue;
    const files: string[] = [];
    for (const file of [...scoped].sort()) {
      if (!graph.edges.has(file)) continue;
      files.push(file);
      history.counts.set(file, (history.counts.get(file) ?? 0) + 1);
    }
    history.commits.push(files);
  }
  return history;
}

/**
 * Commits partagés par paire. Seuls les fichiers ayant déjà atteint minCoChangeCommits sont
 * appariés : une paire ne peut pas dépasser le nombre de commits de son fichier le moins actif,
 * donc ce filtre est exact et évite d'allouer des millions de paires inutiles.
 */
function countPairs(history: History, config: ChurnConfig): Map<string, number> {
  const together = new Map<string, number>();
  for (const files of history.commits) {
    const active = files.filter((file) => (history.counts.get(file) ?? 0) >= config.minCoChangeCommits);
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const key = `${active[i]}${PAIR_SEPARATOR}${active[j]}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
    }
  }
  return together;
}

/** Paires co-modifiées au-delà des seuils, les plus couplées d'abord. */
export function computeCoChanges(
  commits: GitCommit[],
  scope: ScopeConfig,
  config: ChurnConfig,
  graph: ImportGraph,
): CoChange[] {
  const history = readHistory(commits, scope, config, graph);
  const pairs: CoChange[] = [];
  for (const [key, together] of countPairs(history, config)) {
    if (together < config.minCoChangeCommits) continue;
    const [fileA, fileB] = key.split(PAIR_SEPARATOR) as [string, string];
    const commitsA = history.counts.get(fileA) ?? 0;
    const commitsB = history.counts.get(fileB) ?? 0;
    const degree = together / Math.min(commitsA, commitsB);
    if (degree < config.minCoChangeDegree) continue;
    pairs.push({ fileA, fileB, together, commitsA, commitsB, degree, linked: areLinked(graph, fileA, fileB) });
  }
  return pairs.sort(
    (a, b) => b.degree - a.degree
      || b.together - a.together
      || a.fileA.localeCompare(b.fileA)
      || a.fileB.localeCompare(b.fileB),
  );
}

/** Une paire fortement couplée sans lien d'imports est un lien de conception implicite. */
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
          + `(${Math.round(pair.degree * 100)} %) sans lien d'imports entre eux`,
      }));
  return findings.sort(compareFindings);
}

/**
 * undefined sous minHistoryCommits commits : sur un historique court, le couplage n'est pas
 * nul mais non mesuré, et aucun finding n'en sort.
 */
export function analyzeCoupling(
  rootPath: string,
  commits: GitCommit[],
  scope: ScopeConfig,
  config: ChurnConfig,
  graph: ImportGraph,
): CouplingReport | undefined {
  if (commits.length < config.minHistoryCommits) return undefined;
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
