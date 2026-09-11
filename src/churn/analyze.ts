/**
 * Analyse comportementale : croise l'historique git avec les métriques AST.
 * Un hotspot est du code compliqué et souvent modifié — c'est là que la dette coûte,
 * et donc la seule liste de refactoring qui vaille (Tornhill, « Software Design X-Rays »).
 */
import { globToRegExp, matchesAnyGlob } from '../core/glob.js';
import { envelope } from '../core/findings.js';
import type { ResolvedConfig, ScopeConfig } from '../core/config.js';
import type {
  ChurnReport,
  ChurnSummary,
  FileChurn,
  FileMetrics,
  Hotspot,
} from '../core/types.js';
import type { GitCommit } from './git.js';
import { readGitLog, renameTracker, windowStartDate } from './git.js';

interface MutableChurn {
  file: string;
  commits: number;
  addedLines: number;
  deletedLines: number;
  firstChange: string;
  lastChange: string;
}

/** Agrège les commits par fichier en suivant les renommages. */
export function aggregateChurn(commits: GitCommit[], scope: ScopeConfig): FileChurn[] {
  const includePatterns = scope.include.map(globToRegExp);
  const excludePatterns = scope.exclude.map(globToRegExp);
  const currentPath = renameTracker();
  const byFile = new Map<string, MutableChurn>();

  for (const commit of commits) {
    for (const change of commit.files) {
      const current = currentPath(change);
      if (
        !matchesAnyGlob(includePatterns, current)
        || matchesAnyGlob(excludePatterns, current)
      ) {
        continue;
      }
      const entry = byFile.get(current);
      if (entry === undefined) {
        byFile.set(current, {
          file: current,
          commits: 1,
          addedLines: change.addedLines,
          deletedLines: change.deletedLines,
          firstChange: commit.date,
          lastChange: commit.date,
        });
        continue;
      }
      entry.commits += 1;
      entry.addedLines += change.addedLines;
      entry.deletedLines += change.deletedLines;
      // Les commits arrivent du plus récent au plus ancien.
      if (commit.date < entry.firstChange) entry.firstChange = commit.date;
      if (commit.date > entry.lastChange) entry.lastChange = commit.date;
    }
  }
  return [...byFile.values()].sort((a, b) => b.commits - a.commits || a.file.localeCompare(b.file));
}

/**
 * Hotspots = churn × complexité. Un fichier sans fonction mesurée (barrel, constantes)
 * a un score nul : beaucoup de commits sur un fichier simple n'est pas de la dette.
 */
export function computeHotspots(churn: FileChurn[], files: FileMetrics[]): Hotspot[] {
  const metricsByFile = new Map(files.map((file) => [file.file, file]));
  const hotspots: Hotspot[] = [];
  for (const entry of churn) {
    const metrics = metricsByFile.get(entry.file);
    if (metrics === undefined) continue;
    const maxCyclomatic = metrics.functions.reduce((max, fn) => Math.max(max, fn.cyclomatic), 0);
    const maxCognitive = metrics.functions.reduce((max, fn) => Math.max(max, fn.cognitive), 0);
    hotspots.push({
      file: entry.file,
      commits: entry.commits,
      addedLines: entry.addedLines,
      deletedLines: entry.deletedLines,
      maxCyclomatic,
      maxCognitive,
      score: entry.commits * Math.max(maxCyclomatic, maxCognitive),
    });
  }
  return hotspots.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

export function summarizeChurn(commitsScanned: number, files: FileChurn[]): ChurnSummary {
  return {
    commitsScanned,
    filesChanged: files.length,
    addedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
    deletedLines: files.reduce((sum, file) => sum + file.deletedLines, 0),
  };
}

export interface ChurnOptions {
  /** Plage de révisions (`main..HEAD`) ; prioritaire sur la fenêtre en jours. */
  range?: string;
  /** Injecté pour rendre la fenêtre déterministe en test. */
  now?: Date;
}

export function analyzeChurn(
  rootPath: string,
  config: ResolvedConfig,
  files: FileMetrics[],
  options: ChurnOptions = {},
): ChurnReport {
  const since = options.range === undefined
    ? windowStartDate(config.churn.windowDays, options.now ?? new Date())
    : undefined;
  const log = readGitLog(rootPath, since === undefined ? { range: options.range } : { since });
  const churn = aggregateChurn(log.commits, config.scope);
  const report: ChurnReport = {
    ...envelope(rootPath, 'git'),
    available: log.available,
    windowDays: config.churn.windowDays,
    summary: summarizeChurn(log.commits.length, churn),
    files: churn,
    hotspots: computeHotspots(churn, files),
  };
  if (log.reason !== undefined) report.unavailableReason = log.reason;
  const window = options.range ?? since;
  if (window !== undefined) report.since = window;
  return report;
}
