/**
 * Cliquet (ratchet) : la CI n'échoue que si une métrique empire par rapport à la
 * baseline commitée. La dette existante devient de la dette figée au lieu de dette
 * croissante — c'est la seule stratégie applicable à un dépôt déjà en désordre,
 * puisqu'un gate absolu y échouerait dès le premier jour et serait désactivé.
 *
 * La baseline ne contient ni numéros de ligne ni ids : elle survit aux décalages
 * et aux renommages. Elle compte des violations par règle et par fichier.
 *
 * Tous les agrégats suivis sont « plus bas c'est mieux » ; une clé absente veut
 * dire non mesurée, jamais zéro.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { scopeIncompatibility } from '../core/scope.js';
import { appVersion } from '../core/version.js';
import { AGGREGATE_KEYS } from '../core/types.js';
import type {
  AggregateKey,
  Aggregates,
  Baseline,
  CompareResult,
  Finding,
  Improvement,
  Regression,
  ScanReport,
  ToolId,
} from '../core/types.js';

export const BASELINE_FILENAME = 'crap-detector-baseline.json';

/** Sous ce seuil, deux flottants sont considérés identiques. */
const EPSILON = 1e-6;

/**
 * Agrégats exprimés en ratio, et la grandeur absolue qui en est le numérateur.
 *
 * Un ratio monte dès qu'on supprime du code sain, sans que rien n'ait empiré :
 * la part de code au-delà du seuil augmente mécaniquement quand le dénominateur
 * baisse. Faire échouer le gate là-dessus punirait la suppression de code mort,
 * que l'outil réclame par ailleurs. Un ratio ne fait donc échouer le gate que si
 * sa grandeur absolue monte aussi — ce qui reste vrai dès qu'on ajoute vraiment
 * de la complexité, de la duplication ou des lignes inutiles.
 */
const RATIO_COMPANIONS: Partial<Record<AggregateKey, AggregateKey>> = {
  'erosion.fraction': 'erosion.mass',
  'verbosity.fraction': 'verbosity.lines',
  'duplication.percent': 'duplication.lines',
};

/**
 * Clé de dette : l'outil, la règle et le fichier — jamais la ligne ni le symbole.
 * L'outil fait partie de la clé pour pouvoir ignorer les entrées d'un outil qui
 * n'a pas tourné : sans ça, lancer `check --no-tools` ferait passer toute la
 * dette knip pour des améliorations, puis pour des régressions au retour.
 */
export function debtKey(finding: Finding): string {
  return `${finding.tool}|${finding.rule}|${finding.file}`;
}

/** Outils dont les résultats sont présents dans ce rapport. */
export function activeTools(report: ScanReport): Set<ToolId> {
  const tools = new Set<ToolId>(['metrics', 'imports', 'depcruise']);
  if (report.coupling !== undefined) tools.add('churn');
  if (report.deadCode?.available === true) tools.add('knip');
  if (report.duplication?.available === true) tools.add('jscpd');
  return tools;
}

function toolOfKey(key: string): string {
  return key.split('|')[0] ?? '';
}

/**
 * Règles dont la dette d'un fichier se lit à son pire cas, pas au nombre
 * d'occurrences. Ce sont celles qui mesurent une fonction : découper une
 * fonction trop complexe en fait mécaniquement plusieurs, ce qui ferait monter
 * un compteur alors que le fichier s'améliore.
 *
 * Toute autre règle reste comptée : pour un catch vide, un export mort ou un
 * paquet non déclaré, une occurrence de plus est strictement pire.
 */
export const MAX_MEASURED_RULES: ReadonlySet<string> = new Set([
  'cyclomatic-complexity',
  'cognitive-complexity',
  'function-length',
  'file-length',
  'nesting-depth',
  'too-many-params',
  'nested-callbacks',
]);

export interface DebtSnapshot {
  counts: Record<string, number>;
  maxima: Record<string, number>;
}

function sortedEntries(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** Répartit les findings entre règles comptées et règles mesurées au maximum. */
export function summarizeDebt(findings: Finding[]): DebtSnapshot {
  const counts: Record<string, number> = {};
  const maxima: Record<string, number> = {};
  for (const finding of findings) {
    const key = debtKey(finding);
    if (MAX_MEASURED_RULES.has(finding.rule)) {
      const value = finding.value ?? 0;
      maxima[key] = Math.max(maxima[key] ?? Number.NEGATIVE_INFINITY, value);
      continue;
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { counts: sortedEntries(counts), maxima: sortedEntries(maxima) };
}

/** Arrondi des agrégats : sans ça, le bruit flottant produirait de fausses régressions. */
function roundAggregates(aggregates: Aggregates): Aggregates {
  const rounded: Aggregates = {};
  for (const key of AGGREGATE_KEYS) {
    const value = aggregates[key];
    if (value !== undefined) rounded[key] = Math.round(value * 1e6) / 1e6;
  }
  return rounded;
}

/** Versions des outils ayant produit les chiffres : elles conditionnent la comparabilité. */
export function toolVersionsOf(report: ScanReport): Record<string, string> {
  const versions: Record<string, string> = {
    'ts-morph': report.metrics.toolVersion,
  };
  if (report.deadCode?.available === true) versions['knip'] = report.deadCode.toolVersion;
  if (report.duplication?.available === true) versions['jscpd'] = report.duplication.toolVersion;
  return versions;
}

export function makeBaseline(report: ScanReport): Baseline {
  const debt = summarizeDebt(report.findings);
  return {
    version: 2,
    generator: { name: 'crap-detector', version: appVersion() },
    toolVersions: toolVersionsOf(report),
    createdAt: report.generatedAt,
    thresholds: { ...report.thresholds },
    scope: {
      include: [...report.scope.include],
      exclude: [...report.scope.exclude],
      gitignore: report.scope.gitignore,
      toolsScoped: report.scope.toolsScoped,
    },
    aggregates: roundAggregates(report.aggregates),
    debtCounts: debt.counts,
    debtMaxima: debt.maxima,
  };
}

/**
 * Une baseline n'est comparable que si les seuils, le périmètre et les versions
 * d'outils sont identiques. Comparer à travers un changement de seuil ferait
 * passer pour une régression ce qui n'est qu'un changement de règle du jeu.
 */
export function incompatibilityReason(baseline: Baseline, report: ScanReport): string | undefined {
  if (baseline.version !== 2) {
    return `baseline en version ${String(baseline.version)}, attendu 2 : refaire la baseline`;
  }
  const previousThresholds: Record<string, unknown> = { ...baseline.thresholds };
  for (const [key, value] of Object.entries(report.thresholds)) {
    const previous = previousThresholds[key];
    if (previous !== value) {
      return `seuil ${key} modifié (${String(previous)} → ${String(value)}) : refaire la baseline`;
    }
  }
  const scopeReason = scopeIncompatibility(baseline, report.scope);
  if (scopeReason !== undefined) return scopeReason;
  const current = toolVersionsOf(report);
  for (const [tool, version] of Object.entries(baseline.toolVersions)) {
    const now = current[tool];
    if (now !== undefined && now !== version) {
      return `${tool} est passé de ${version} à ${now} : les chiffres ne sont pas comparables`;
    }
  }
  return undefined;
}

/**
 * true quand la hausse d'un ratio s'explique par un dénominateur qui rétrécit,
 * pas par une aggravation : sa grandeur absolue n'a pas augmenté.
 */
function isDilutedRatio(
  key: AggregateKey,
  before: Aggregates,
  after: Aggregates,
): boolean {
  const companion = RATIO_COMPANIONS[key];
  if (companion === undefined) return false;
  const massBefore = before[companion];
  const massAfter = after[companion];
  // Sans les deux grandeurs (baseline antérieure à leur introduction), on ne
  // peut rien conclure : le ratio est comparé strictement, comme avant.
  if (massBefore === undefined || massAfter === undefined) return false;
  return massAfter <= massBefore + EPSILON;
}

function aggregateRegressions(
  baseline: Baseline,
  aggregates: Aggregates,
): {
  regressions: Regression[];
  improvements: Improvement[];
  skipped: string[];
  unchanged: number;
  notes: string[];
} {
  const regressions: Regression[] = [];
  const improvements: Improvement[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  let unchanged = 0;

  for (const key of AGGREGATE_KEYS) {
    const before = baseline.aggregates[key];
    const now = aggregates[key];
    if (before === undefined || now === undefined) {
      if (before !== undefined || now !== undefined) skipped.push(key);
      continue;
    }
    if (now > before + EPSILON) {
      if (isDilutedRatio(key, baseline.aggregates, aggregates)) {
        const companion = RATIO_COMPANIONS[key];
        notes.push(
          `${key} monte à ${format(now)} sans régression : `
          + `${String(companion)} n'a pas augmenté, du code sain a été supprimé`,
        );
        unchanged += 1;
        continue;
      }
      regressions.push({
        kind: 'aggregate',
        key,
        baselineValue: before,
        currentValue: now,
        message: `${key} : ${format(before)} → ${format(now)}`,
      });
      continue;
    }
    if (now < before - EPSILON) {
      improvements.push({
        key,
        baselineValue: before,
        currentValue: now,
        message: `${key} : ${format(before)} → ${format(now)}`,
      });
      continue;
    }
    unchanged += 1;
  }
  return { regressions, improvements, skipped, unchanged, notes };
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

/** Nature de l'unité comparée, qui change la formulation des messages. */
type DebtKind = 'count' | 'max';

function describeNew(kind: DebtKind, file: string, rule: string, value: number): string {
  return kind === 'count'
    ? `${file} : ${String(value)} violation(s) ${rule} dans un fichier jusque-là propre`
    : `${file} : ${rule} à ${String(value)} dans un fichier jusque-là propre`;
}

function debtComparison(
  before: Record<string, number>,
  after: Record<string, number>,
  knownFiles: ReadonlySet<string>,
  tools: Set<ToolId>,
  kind: DebtKind,
): {
  regressions: Regression[];
  improvements: Improvement[];
  unchanged: number;
  skipped: string[];
} {
  const regressions: Regression[] = [];
  const improvements: Improvement[] = [];
  const skipped: string[] = [];
  let unchanged = 0;

  for (const [key, value] of Object.entries(after)) {
    const previous = before[key];
    const file = key.split('|')[2] ?? '';
    const rule = key.split('|')[1] ?? '';
    if (previous === undefined) {
      const isNewFile = !knownFiles.has(file);
      regressions.push({
        kind: isNewFile ? 'debt-new-file' : 'debt-new-entry',
        key,
        currentValue: value,
        message: isNewFile
          ? describeNew(kind, file, rule, value)
          : `${file} : nouvelle règle en échec, ${rule} (${String(value)})`,
      });
      continue;
    }
    if (value > previous) {
      regressions.push({
        kind: 'debt-increase',
        key,
        baselineValue: previous,
        currentValue: value,
        message: `${key} : ${String(previous)} → ${String(value)}`,
      });
      continue;
    }
    if (value < previous) {
      improvements.push({
        key,
        baselineValue: previous,
        currentValue: value,
        message: `${key} : ${String(previous)} → ${String(value)}`,
      });
      continue;
    }
    unchanged += 1;
  }

  for (const [key, previous] of Object.entries(before)) {
    if (after[key] !== undefined) continue;
    if (!tools.has(toolOfKey(key) as ToolId)) {
      // L'outil n'a pas tourné : ni régression ni amélioration, juste non mesuré.
      skipped.push(key);
      continue;
    }
    improvements.push({
      key,
      baselineValue: previous,
      currentValue: 0,
      message: `${key} : ${String(previous)} → plus aucune violation`,
    });
  }
  return { regressions, improvements, unchanged, skipped };
}

/** Fichiers déjà porteurs d'une dette quelconque dans la baseline. */
function filesWithDebt(baseline: Baseline): Set<string> {
  const files = new Set<string>();
  for (const key of [...Object.keys(baseline.debtCounts), ...Object.keys(baseline.debtMaxima)]) {
    files.add(key.split('|')[2] ?? '');
  }
  return files;
}

export function compareToBaseline(baseline: Baseline, report: ScanReport): CompareResult {
  const reason = incompatibilityReason(baseline, report);
  if (reason !== undefined) {
    return {
      comparable: false,
      incompatibilityReason: reason,
      passed: false,
      regressions: [],
      improvements: [],
      unchangedCount: 0,
      skippedKeys: [],
      notes: [],
    };
  }
  const aggregate = aggregateRegressions(baseline, roundAggregates(report.aggregates));
  const current = summarizeDebt(report.findings);
  const tools = activeTools(report);
  const known = filesWithDebt(baseline);
  const counts = debtComparison(baseline.debtCounts, current.counts, known, tools, 'count');
  const maxima = debtComparison(baseline.debtMaxima, current.maxima, known, tools, 'max');
  const regressions = [...aggregate.regressions, ...counts.regressions, ...maxima.regressions];
  return {
    comparable: true,
    passed: regressions.length === 0,
    regressions,
    improvements: [...aggregate.improvements, ...counts.improvements, ...maxima.improvements],
    unchangedCount: aggregate.unchanged + counts.unchanged + maxima.unchanged,
    skippedKeys: [...aggregate.skipped, ...counts.skipped, ...maxima.skipped],
    notes: aggregate.notes,
  };
}

export function writeBaseline(path: string, baseline: Baseline): void {
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

/** Lit la baseline ; lève un message explicite plutôt que de retomber sur un défaut. */
export function readBaseline(path: string): Baseline {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} ne contient pas un objet JSON`);
  }
  const baseline = parsed as Partial<Baseline>;
  if (
    baseline.version !== 2
    || typeof baseline.debtCounts !== 'object'
    || typeof baseline.debtMaxima !== 'object'
  ) {
    throw new Error(`${path} n'est pas une baseline crap-detector valide (version 2 attendue)`);
  }
  return baseline as Baseline;
}

/** Clés d'agrégats reconnues, pour valider une baseline éditée à la main. */
export function knownAggregateKeys(): readonly AggregateKey[] {
  return AGGREGATE_KEYS;
}
