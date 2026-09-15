/**
 * Chemin complet : le chemin rapide, plus git et les outils externes.
 *
 * git, knip et jscpd sont chargés par `import()` dynamique. Un import statique
 * suffirait à charger knip — plusieurs mégaoctets — à chaque démarrage du CLI,
 * y compris pour `crap-detector file`, dont tout l'intérêt est de rester sous
 * les 200 ms.
 */
import { compareFindings, envelope } from '../core/findings.js';
import { enabledOptionalRules } from '../core/config.js';
import type { ResolvedConfig } from '../core/config.js';
import type { ReportScope } from '../core/scope.js';
import type { AggregateKey, Aggregates, DeadCodeReport, Finding, ScanReport } from '../core/types.js';
import type { GitIgnoredResult } from '../churn/git.js';
import { manifestResolver } from '../imports/manifest.js';
import { summarizeSlop } from '../slop/analyze.js';
import { scanFast } from './fast.js';
import type { FastScan } from './fast.js';
import { addOrphans } from './orphans.js';

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

  const report: ScanReport = {
    ...envelope(rootPath, 'ts-morph'),
    filesScanned: fast.files.length,
    thresholds: config.thresholds,
    scope: reportScope(config, ignored, fast),
    metrics: fast.metrics,
    slop: fast.slop,
    imports: fast.imports,
    dependencies: fast.dependencies,
    aggregates: { ...fast.aggregates },
    findings: [...fast.findings],
  };

  if (options.skipChurn !== true) await addChurn(report, fast, config, options);
  if (options.skipExternalTools !== true) await addExternalTools(rootPath, fast, report, config);
  if (report.deadCode?.available !== true) addOrphans(report, fast, config.scope, ignored);

  assertRatiosInRange(report.aggregates);
  report.findings.sort(compareFindings);
  return report;
}

/** Churn, hotspots et couplage temporel, lus dans l'historique git. */
async function addChurn(report: ScanReport, fast: FastScan, config: ResolvedConfig, options: ScanOptions): Promise<void> {
  const [{ readGitLog, windowStartDate }, { aggregateChurn, computeHotspots, summarizeChurn }, { analyzeCoupling }] =
    await Promise.all([
      import('../churn/git.js'),
      import('../churn/analyze.js'),
      import('../churn/coupling.js'),
    ]);
  const { rootPath } = report;
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
  if (!log.available) return;
  const coupling = analyzeCoupling(rootPath, log.commits, config.scope, config.churn, fast.graph);
  if (coupling === undefined) return;
  report.coupling = coupling;
  report.aggregates['coupling.hidden.count'] = coupling.summary.hiddenPairs;
  report.findings.push(...coupling.findings);
}

/** knip et jscpd complètent le rapport en place : findings, agrégats et verbosité. */
async function addExternalTools(rootPath: string, fast: FastScan, report: ScanReport, config: ResolvedConfig): Promise<void> {
  const [{ analyzeDeadCode }, { analyzeDuplication }, { judgeKnipReport }, { exportOriginLookup }] = await Promise.all([
    import('../adapters/knip.js'),
    import('../adapters/jscpd.js'),
    import('../adapters/knip-reliability.js'),
    import('../imports/local-usage.js'),
  ]);
  const { aggregates } = report;

  const deadCodeOptions = { exportOrigin: exportOriginLookup(fast.sourceFiles) };
  const mapped = withoutNativeDuplicates(
    rootPath,
    fast.files,
    analyzeDeadCode(rootPath, fast.files, config.rules, deadCodeOptions),
  );
  const deadCode = judgeKnipReport(rootPath, mapped, fast.files.length, config.knip);
  report.deadCode = deadCode;
  // Seul ce bloc verse des findings knip au rapport : knip absent ou sortie illisible, `available`
  // est false, `findings` est vide et rien n'est ajouté ni rétrogradé. Voir le test « sans knip ».
  if (deadCode.available) {
    report.scope.knipTrusted = deadCode.reliability?.trusted !== false;
    // Non fiable, knip n'a rien mesuré du code mort : agrégats absents, pas à zéro.
    if (report.scope.knipTrusted) {
      aggregates['deadcode.exports.count'] = deadCode.summary.unusedExports;
      aggregates['deadcode.files.count'] = deadCode.summary.unusedFiles;
    }
    report.findings = demoteDeadFileMetrics([...report.findings, ...deadCode.findings], deadCode);
  }

  // jscpd mesure aussi les fichiers vendorisés : sans eux, la copie qu'un fichier vivant en fait
  // ne se voit plus. Ils ne portent aucun finding, cf. anchoredOnMeasured dans l'adaptateur.
  const duplication = analyzeDuplication(
    rootPath,
    [...fast.files, ...fast.vendoredFiles].sort(),
    fast.vendored,
  );
  report.duplication = duplication.report;
  if (!duplication.report.available) return;
  aggregates['duplication.percent'] = duplication.report.statistics.percent;
  aggregates['duplication.lines'] = duplication.report.statistics.duplicatedLines;
  report.findings.push(...duplication.report.findings);
  // Les lignes clonées entrent dans la verbosité : le score AST seul la sous-estime.
  const summary = summarizeSlop(fast.slopHits, fast.sourceFiles, { cloneLines: duplication.cloneLines });
  report.slop = { ...fast.slop, summary };
  aggregates['verbosity.fraction'] = summary.verbosityFraction;
  aggregates['verbosity.lines'] = summary.verboseLines;
}

/**
 * knip juge les dépendances contre le package.json de la racine, faute de workspaces déclarés,
 * et signale un import utilisé seulement comme type. La règle native juge contre le package.json
 * le plus proche et distingue paquet installé et paquet inventé : sur un fichier source qu'elle a
 * pu juger, l'unlisted-dependency de knip est un doublon ou un faux positif. Celui que knip
 * rattache à un package.json (script, config) n'a pas d'équivalent natif : il reste.
 */
export function withoutNativeDuplicates(rootPath: string, files: readonly string[], deadCode: DeadCodeReport): DeadCodeReport {
  const manifestFor = manifestResolver(rootPath);
  const judged = new Set(files);
  const findings = deadCode.findings.filter((finding) => finding.rule !== 'unlisted-dependency'
    || !judged.has(finding.file) || !manifestFor(finding.file).trustworthy);
  return { ...deadCode, findings };
}

/**
 * Un fichier que knip classe `unused-file` est à supprimer, pas à refactorer : sa complexité, sa
 * longueur, son imbrication et son slop ne disent rien de plus que l'unused-file, et demandent
 * l'inverse du bon correctif. Ces findings sont donc rétrogradés sous le seuil de signalement,
 * comme le fait déjà metrics/analyze.ts : masqués du texte sans `--all`, toujours comptés par le
 * cliquet. Les supprimer rendrait le cliquet aveugle sur ces fichiers, et une fonction qui passe
 * de 57 à 302 lignes dans l'un d'eux cesserait d'être une régression.
 *
 * Conditionné à une configuration knip écrite par le dépôt (`reliability.configFile`) : sans
 * elle, knip devine les points d'entrée et classe morts des fichiers bien vivants — sur
 * athena_api, 12 des 15 fichiers concernés restent en place (specs d'une seconde config jest,
 * migrations chargées par un glob, middleware de convention, scripts lancés à la main), soit
 * 46 % des findings visés. La configuration du dépôt est le signal dont l'utilisateur répond ;
 * celle que crap-detector fabrique pour knip n'entre pas dans ce champ, elle vit dans un
 * dossier temporaire (adapters/knip-entries.ts).
 *
 * Seul l'outil `metrics` (métriques AST et règles de slop) est visé. Un paquet non déclaré
 * (`imports`) reste un vrai correctif à faire au package.json même dans un fichier mort, et les
 * clones (`jscpd`) ont un second côté vivant que leur agrégat compte de toute façon.
 */
export function demoteDeadFileMetrics(findings: readonly Finding[], deadCode: DeadCodeReport): Finding[] {
  if (deadCode.reliability?.configFile === undefined) return [...findings];
  const dead = new Set(deadCode.findings
    .filter((finding) => finding.rule === 'unused-file')
    .map((finding) => finding.file));
  if (dead.size === 0) return [...findings];
  return findings.map((finding) => (finding.tool === 'metrics' && dead.has(finding.file)
    ? { ...finding, belowReportThreshold: true as const }
    : finding));
}

/** La masse érodée est incluse dans la masse totale : erosion.fraction ne peut pas dépasser 1. */
const RATIO_BOUNDS: ReadonlyArray<readonly [AggregateKey, number]> = [
  ['verbosity.fraction', 1],
  ['duplication.percent', 100],
];

/**
 * Un ratio au-delà de sa borne veut dire que numérateur et dénominateur ne portent
 * pas sur les mêmes fichiers. L'écrire dans une baseline figerait un chiffre faux.
 */
export function assertRatiosInRange(aggregates: Aggregates): void {
  for (const [key, bound] of RATIO_BOUNDS) {
    const value = aggregates[key];
    if (value !== undefined && value > bound) {
      throw new Error(
        `${key} vaut ${String(value)}, au-delà de ${String(bound)} : ce ratio est impossible, `
          + 'son numérateur ne porte pas sur le même périmètre que son dénominateur. '
          + 'Aucun rapport ni baseline écrit.',
      );
    }
  }
}

/**
 * Lu même avec --no-git : le périmètre ne doit pas dépendre de ce drapeau, sinon
 * `check --no-git` compterait `.next/` face à une baseline qui l'excluait.
 */
async function readIgnored(rootPath: string): Promise<GitIgnoredResult> {
  const { readGitIgnored } = await import('../churn/git.js');
  return readGitIgnored(rootPath);
}

function reportScope(config: ResolvedConfig, ignored: GitIgnoredResult, fast: FastScan): ReportScope {
  const scope: ReportScope = {
    include: [...config.scope.include],
    exclude: [...config.scope.exclude],
    gitignore: ignored.available,
    toolsScoped: true,
    importRules: 3,
    rules: enabledOptionalRules(config.rules),
    vendored: [...fast.vendored],
    vendoredSkipped: { files: fast.vendoredFiles.length, sloc: fast.vendoredSloc },
    subprojects: [...fast.subprojects],
  };
  if (fast.vendoredUnreadableReason !== undefined) {
    scope.vendoredUnreadableReason = fast.vendoredUnreadableReason;
  }
  if (ignored.reason !== undefined) scope.gitignoreUnavailableReason = ignored.reason;
  return scope;
}
