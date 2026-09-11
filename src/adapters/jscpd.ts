/**
 * Adaptateur jscpd : duplication de blocs.
 * GitClear mesure +81 % de duplication de blocs depuis 2023, et SlopCodeBench
 * compte les lignes clonées dans sa métrique Verbosity : ce module rend donc
 * deux choses, un rapport de duplication et l'ensemble des lignes clonées.
 *
 * jscpd n'écrit son JSON que dans un fichier ; la sortie standard ne sert à rien.
 *
 * jscpd reçoit la liste exacte des fichiers du périmètre, pas la racine. Filtrer ses
 * clones après coup ne suffirait pas : il regroupe les copies d'un même bloc autour
 * de la première rencontrée, donc deux fichiers du périmètre ne sont reliés que par
 * une copie hors périmètre, et ses statistiques ne se recalculent pas à partir des clones.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { compareFindings, envelope, makeFinding } from '../core/findings.js';
import type { DuplicationReport, DuplicationStatistics, Finding } from '../core/types.js';
import { runTool } from './run.js';

export interface CloneSide {
  file: string;
  start: number;
  end: number;
}

export interface Clone {
  first: CloneSide;
  second: CloneSide;
  lines: number;
}

export interface JscpdMapping {
  statistics: DuplicationStatistics;
  clones: Clone[];
  findings: Finding[];
  /** Lignes couvertes par au moins un clone, par fichier — entrée de la verbosité. */
  cloneLines: Map<string, Set<number>>;
  /** Clones écartés parce qu'un de leurs côtés n'est pas un fichier du périmètre. */
  outOfScope: number;
}

/** Racine telle que jscpd l'écrit : il résout les liens symboliques (/tmp → /private/tmp). */
export interface JscpdScope {
  root: string;
  files: readonly string[];
}

function sideOf(raw: unknown, root: string): CloneSide | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const side = raw as Record<string, unknown>;
  const name = side['name'];
  const start = side['start'];
  const end = side['end'];
  if (typeof name !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
    return undefined;
  }
  return { file: relative(root, name).split('\\').join('/'), start, end };
}

function readStatistics(parsed: unknown): DuplicationStatistics {
  const statistics: DuplicationStatistics = { clones: 0, duplicatedLines: 0, percent: 0 };
  const total = (parsed as { statistics?: { total?: unknown } }).statistics?.total;
  if (typeof total !== 'object' || total === null) return statistics;
  const stats = total as Record<string, unknown>;
  if (typeof stats['clones'] === 'number') statistics.clones = stats['clones'];
  if (typeof stats['duplicatedLines'] === 'number') statistics.duplicatedLines = stats['duplicatedLines'];
  if (typeof stats['percentage'] === 'number') statistics.percent = stats['percentage'];
  return statistics;
}

function readClones(parsed: unknown, root: string): Clone[] {
  const duplicates = (parsed as { duplicates?: unknown }).duplicates;
  if (!Array.isArray(duplicates)) return [];
  const clones: Clone[] = [];
  for (const raw of duplicates) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const first = sideOf(entry['firstFile'], root);
    const second = sideOf(entry['secondFile'], root);
    if (first === undefined || second === undefined) continue;
    const lines = typeof entry['lines'] === 'number' ? entry['lines'] : first.end - first.start + 1;
    clones.push({ first, second, lines });
  }
  return clones;
}

function coveredLines(clones: Clone[]): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  for (const side of clones.flatMap((clone) => [clone.first, clone.second])) {
    let covered = byFile.get(side.file);
    if (covered === undefined) {
      covered = new Set();
      byFile.set(side.file, covered);
    }
    for (let line = side.start; line <= side.end; line += 1) covered.add(line);
  }
  return byFile;
}

function cloneFinding(clone: Clone, threshold: number): Finding {
  const key = `${clone.second.file}:${clone.second.start}`;
  return makeFinding({
    tool: 'jscpd',
    rule: 'duplicate-block',
    file: clone.first.file,
    line: clone.first.start,
    symbol: key,
    symbolKey: key,
    value: clone.lines,
    threshold,
    message:
      `${clone.lines} lignes dupliquées avec ${clone.second.file}`
      + ` (lignes ${clone.second.start}-${clone.second.end})`,
  });
}

/** Un clone ne compte que si ses deux côtés sont des fichiers du périmètre. */
export function mapJscpdReport(parsed: unknown, threshold: number, scope: JscpdScope): JscpdMapping {
  const inScope = new Set(scope.files);
  const all = readClones(parsed, scope.root);
  const clones = all.filter((clone) => inScope.has(clone.first.file) && inScope.has(clone.second.file));
  return {
    statistics: readStatistics(parsed),
    clones,
    findings: clones.map((clone) => cloneFinding(clone, threshold)).sort(compareFindings),
    cloneLines: coveredLines(clones),
    outOfScope: all.length - clones.length,
  };
}

export interface DuplicationAnalysis {
  report: DuplicationReport;
  cloneLines: Map<string, Set<number>>;
}

/** Nombre de lignes en dessous duquel un bloc dupliqué n'est pas signalé. */
const MIN_CLONE_LINES = 5;
const MIN_CLONE_TOKENS = 50;
/** Formats jscpd correspondant au périmètre TypeScript de l'outil. */
const CLONE_FORMATS = 'typescript,tsx';

function unavailable(
  rootPath: string,
  toolVersion: string,
  reason: string,
  outOfScope = 0,
): DuplicationAnalysis {
  return {
    report: {
      ...envelope(rootPath, toolVersion),
      available: false,
      unavailableReason: reason,
      statistics: { clones: 0, duplicatedLines: 0, percent: 0 },
      findings: [],
      outOfScope,
    },
    cloneLines: new Map(),
  };
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Config jscpd du dépôt analysé, cherchée dans l'ordre de jscpd lui-même (load_config,
 * cli.rs) : un fichier absent ou illisible passe au suivant.
 */
function projectConfig(root: string): Record<string, unknown> {
  for (const candidate of ['.jscpd.json', '.config/jscpd.json', '.config/.jscpd.json']) {
    const config = readJsonObject(join(root, candidate));
    if (config !== undefined) return config;
  }
  const embedded = readJsonObject(join(root, 'package.json'))?.['jscpd'];
  return typeof embedded === 'object' && embedded !== null ? (embedded as Record<string, unknown>) : {};
}

/**
 * `--config` coupe la recherche automatique de jscpd : la config du dépôt (ignore,
 * ignorePattern…) est donc recopiée, seule la liste de fichiers est remplacée. La liste
 * passe par ce fichier parce qu'en arguments, elle dépasse vite ARG_MAX.
 */
function jscpdArgs(outputDir: string, root: string, files: readonly string[]): string[] {
  const configPath = join(outputDir, 'jscpd-scope.json');
  const config = { ...projectConfig(root), path: files.map((file) => join(root, file)) };
  writeFileSync(configPath, JSON.stringify(config), 'utf8');
  return [
    '--config', configPath,
    '--absolute',
    '--reporters', 'json',
    '--output', outputDir,
    '--silent',
    '--min-lines', String(MIN_CLONE_LINES),
    '--min-tokens', String(MIN_CLONE_TOKENS),
    '--format', CLONE_FORMATS,
  ];
}

/** `files` : fichiers du périmètre, relatifs à rootPath, tels que rendus par collectFiles. */
export function analyzeDuplication(rootPath: string, files: readonly string[]): DuplicationAnalysis {
  // Sans chemin, jscpd analyse son répertoire courant : tout le dépôt.
  if (files.length === 0) return unavailable(rootPath, 'inconnue', 'aucun fichier dans le périmètre');
  const root = realpathSync(rootPath);
  const outputDir = mkdtempSync(join(tmpdir(), 'crap-detector-jscpd-'));
  try {
    const result = runTool('jscpd', 'jscpd', jscpdArgs(outputDir, root, files), rootPath);
    if (!result.ok) return unavailable(rootPath, result.version, result.reason ?? 'jscpd indisponible');
    let mapping: JscpdMapping;
    try {
      const raw = readFileSync(join(outputDir, 'jscpd-report.json'), 'utf8');
      mapping = mapJscpdReport(JSON.parse(raw), MIN_CLONE_LINES, { root, files });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unavailable(rootPath, result.version, `rapport jscpd illisible : ${message}`);
    }
    if (mapping.outOfScope > 0) {
      const reason = `jscpd a rendu ${mapping.outOfScope} clone(s) hors des fichiers transmis : `
        + 'ses statistiques couvrent un autre périmètre';
      return unavailable(rootPath, result.version, reason, mapping.outOfScope);
    }
    return {
      report: {
        ...envelope(rootPath, result.version),
        available: true,
        statistics: mapping.statistics,
        findings: mapping.findings,
        outOfScope: 0,
      },
      cloneLines: mapping.cloneLines,
    };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}
