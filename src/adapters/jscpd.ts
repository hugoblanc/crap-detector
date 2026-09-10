/**
 * Adaptateur jscpd : duplication de blocs.
 * GitClear mesure +81 % de duplication de blocs depuis 2023, et SlopCodeBench
 * compte les lignes clonées dans sa métrique Verbosity : ce module rend donc
 * deux choses, un rapport de duplication et l'ensemble des lignes clonées.
 *
 * jscpd n'écrit son JSON que dans un fichier ; la sortie standard ne sert à rien.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
}

function sideOf(raw: unknown): CloneSide | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const side = raw as Record<string, unknown>;
  const file = side['name'];
  const start = side['start'];
  const end = side['end'];
  if (typeof file !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
    return undefined;
  }
  return { file, start, end };
}

export function mapJscpdReport(parsed: unknown, threshold: number): JscpdMapping {
  const statistics: DuplicationStatistics = { clones: 0, duplicatedLines: 0, percent: 0 };
  const clones: Clone[] = [];
  const cloneLines = new Map<string, Set<number>>();

  const total = (parsed as { statistics?: { total?: unknown } }).statistics?.total;
  if (typeof total === 'object' && total !== null) {
    const stats = total as Record<string, unknown>;
    if (typeof stats['clones'] === 'number') statistics.clones = stats['clones'];
    if (typeof stats['duplicatedLines'] === 'number') {
      statistics.duplicatedLines = stats['duplicatedLines'];
    }
    if (typeof stats['percentage'] === 'number') statistics.percent = stats['percentage'];
  }

  const duplicates = (parsed as { duplicates?: unknown }).duplicates;
  if (Array.isArray(duplicates)) {
    for (const raw of duplicates) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const first = sideOf(entry['firstFile']);
      const second = sideOf(entry['secondFile']);
      if (first === undefined || second === undefined) continue;
      const lines = typeof entry['lines'] === 'number' ? entry['lines'] : first.end - first.start + 1;
      clones.push({ first, second, lines });
      for (const side of [first, second]) {
        let covered = cloneLines.get(side.file);
        if (covered === undefined) {
          covered = new Set();
          cloneLines.set(side.file, covered);
        }
        for (let line = side.start; line <= side.end; line += 1) covered.add(line);
      }
    }
  }

  const findings = clones
    .map((clone) => {
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
    })
    .sort(compareFindings);

  return { statistics, clones, findings, cloneLines };
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

export function analyzeDuplication(
  rootPath: string,
  excludeGlobs: string[],
): DuplicationAnalysis {
  const outputDir = mkdtempSync(join(tmpdir(), 'crap-detector-jscpd-'));
  try {
    const args = [
      '--reporters', 'json',
      '--output', outputDir,
      '--silent',
      '--min-lines', String(MIN_CLONE_LINES),
      '--min-tokens', String(MIN_CLONE_TOKENS),
      // Sans restriction de format, jscpd analyse aussi le Markdown et le HTML
      // du dépôt, hors du périmètre déclaré dans le scope.
      '--format', CLONE_FORMATS,
    ];
    for (const glob of excludeGlobs) args.push('--ignore', glob);
    args.push(rootPath);
    const result = runTool('jscpd', 'jscpd', args, rootPath);
    const base = { ...envelope(rootPath, result.version), available: result.ok };
    const empty: DuplicationStatistics = { clones: 0, duplicatedLines: 0, percent: 0 };
    if (!result.ok) {
      return {
        report: {
          ...base,
          unavailableReason: result.reason ?? 'jscpd indisponible',
          statistics: empty,
          findings: [],
        },
        cloneLines: new Map(),
      };
    }
    try {
      const raw = readFileSync(join(outputDir, 'jscpd-report.json'), 'utf8');
      const mapping = mapJscpdReport(JSON.parse(raw), MIN_CLONE_LINES);
      return {
        report: {
          ...base,
          statistics: mapping.statistics,
          findings: mapping.findings,
        },
        cloneLines: mapping.cloneLines,
      };
    } catch (error) {
      return {
        report: {
          ...base,
          available: false,
          unavailableReason:
            `rapport jscpd illisible : ${error instanceof Error ? error.message : String(error)}`,
          statistics: empty,
          findings: [],
        },
        cloneLines: new Map(),
      };
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}
