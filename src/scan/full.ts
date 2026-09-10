/**
 * Chemin complet : le chemin rapide, plus git et les outils externes.
 *
 * git, knip et jscpd sont chargés par `import()` dynamique. Un import statique
 * suffirait à charger knip — plusieurs mégaoctets — à chaque démarrage du CLI,
 * y compris pour `crap-detector file`, dont tout l'intérêt est de rester sous
 * les 200 ms.
 */
import { compareFindings, envelope } from '../core/findings.js';
import type { ResolvedConfig } from '../core/config.js';
import type { Aggregates, Finding, ReportScope, ScanReport } from '../core/types.js';
import type { GitIgnoredResult } from '../churn/git.js';
import { scanFast } from './fast.js';

export interface ScanOptions {
  /** Plage de révisions pour le churn ; sinon la fenêtre en jours de la config. */
  range?: string;
  /** Sauter git : ni churn, ni hotspots, ni couplage temporel. */
  skipChurn?: boolean;
  /** Sauter knip et jscpd, les deux sous-processus lents. */
  skipExternalTools?: boolean;
  /** Injecté pour rendre la fenêtre d'historique déterministe en test. */
  now?: Date;
}

export async function scanFull(
  rootPath: string,
  config: ResolvedConfig,
  options: ScanOptions = {},
): Promise<ScanReport> {
  const ignored = await readIgnored(rootPath);
  const fast = scanFast(rootPath, config, ignored);
  const aggregates: Aggregates = { ...fast.aggregates };
  const findings: Finding[] = [...fast.findings];

  const report: ScanReport = {
    ...envelope(rootPath, 'ts-morph'),
    filesScanned: fast.files.length,
    thresholds: config.thresholds,
    scope: reportScope(config, ignored),
    metrics: fast.metrics,
    slop: fast.slop,
    imports: fast.imports,
    dependencies: fast.dependencies,
    aggregates,
    findings,
  };

  if (options.skipChurn !== true) {
    const [{ readGitLog, windowStartDate }, { aggregateChurn, computeHotspots, summarizeChurn }, { analyzeCoupling }] =
      await Promise.all([
        import('../churn/git.js'),
        import('../churn/analyze.js'),
        import('../churn/coupling.js'),
      ]);
    const since = options.range === undefined
      ? windowStartDate(config.churn.windowDays, options.now ?? new Date())
      : undefined;
    const log = readGitLog(rootPath, since === undefined ? { range: options.range } : { since });
    const churnFiles = aggregateChurn(log.commits, config.scope);
    const window = options.range ?? since;
    report.churn = {
      ...envelope(rootPath, 'git'),
      available: log.available,
      windowDays: config.churn.windowDays,
      summary: summarizeChurn(log.commits.length, churnFiles),
      files: churnFiles,
      hotspots: computeHotspots(churnFiles, fast.metrics.files),
    };
    if (log.reason !== undefined) report.churn.unavailableReason = log.reason;
    if (window !== undefined) report.churn.since = window;
    if (log.available) {
      const coupling = analyzeCoupling(rootPath, log.commits, config.scope, config.churn, fast.graph);
      report.coupling = coupling;
      aggregates['coupling.hidden.count'] = coupling.summary.hiddenPairs;
      findings.push(...coupling.findings);
    }
  }

  if (options.skipExternalTools !== true) {
    const [{ analyzeDeadCode }, { analyzeDuplication }] = await Promise.all([
      import('../adapters/knip.js'),
      import('../adapters/jscpd.js'),
    ]);

    const deadCode = analyzeDeadCode(rootPath);
    report.deadCode = deadCode;
    if (deadCode.available) {
      aggregates['deadcode.exports.count'] = deadCode.summary.unusedExports;
      aggregates['deadcode.files.count'] = deadCode.summary.unusedFiles;
      findings.push(...deadCode.findings);
    }

    const duplication = analyzeDuplication(rootPath, config.scope.exclude);
    report.duplication = duplication.report;
    if (duplication.report.available) {
      aggregates['duplication.percent'] = duplication.report.statistics.percent;
      aggregates['duplication.lines'] = duplication.report.statistics.duplicatedLines;
      findings.push(...duplication.report.findings);
      // Les lignes clonées entrent dans la verbosité : le score AST seul la sous-estime.
      const { summarizeSlop } = await import('../slop/analyze.js');
      const summary = summarizeSlop(fast.slopHits, fast.metrics.summary.totalSloc, {
        cloneLines: duplication.cloneLines,
      });
      report.slop = { ...fast.slop, summary };
      aggregates['verbosity.fraction'] = summary.verbosityFraction;
      aggregates['verbosity.lines'] = summary.verboseLines;
    }
  }

  report.findings = findings.sort(compareFindings);
  return report;
}

/**
 * Lu même avec --no-git : le périmètre ne doit pas dépendre de ce drapeau, sinon
 * `check --no-git` compterait `.next/` face à une baseline qui l'excluait.
 */
async function readIgnored(rootPath: string): Promise<GitIgnoredResult> {
  const { readGitIgnored } = await import('../churn/git.js');
  return readGitIgnored(rootPath);
}

function reportScope(config: ResolvedConfig, ignored: GitIgnoredResult): ReportScope {
  const scope: ReportScope = {
    include: [...config.scope.include],
    exclude: [...config.scope.exclude],
    gitignore: ignored.available,
  };
  if (ignored.reason !== undefined) scope.gitignoreUnavailableReason = ignored.reason;
  return scope;
}
