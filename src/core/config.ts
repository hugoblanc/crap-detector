/**
 * Seuils canoniques issus des rapports de veille (docs/ETAT-DE-L-ART-2026.md).
 * Les défauts ESLint sont volontairement plus laxistes : ici ce sont des garde-fous
 * pensés pour brider les agents, pas pour éviter les erreurs du compilateur.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Thresholds {
  /** McCabe. Défaut ESLint 20, cutoff historique 10. */
  cyclomaticComplexity: number;
  /** Sonar. Défaut eslint-plugin-sonarjs 15. */
  cognitiveComplexity: number;
  maxLinesPerFunction: number;
  maxFileLines: number;
  maxDepth: number;
  maxParams: number;
  maxNestedCallbacks: number;
  /** Gate d'agrégat jscpd en % du projet. */
  duplicationPercent: number;
  /** SlopCodeBench : ~0,31 code humain, ~0,68 agentique. */
  erosionFraction: number;
  /** SlopCodeBench : ~0,15 code humain, ~0,33 agentique. */
  verbosityFraction: number;
}

export type ThresholdsSnapshot = Thresholds;

/**
 * Règle à deux niveaux → son seuil. Celui de `thresholds` reste le seuil du cliquet : tout ce
 * qui le dépasse est compté dans la baseline. Celui de `reportThresholds` décide de ce que
 * `scan`, `explain` et le hook `file` affichent par défaut. Sur cinq dépôts réels, les alertes
 * jugées utiles avaient une valeur médiane proche du double de celle des alertes exactes mais
 * inutiles (docs/PRECISION-2026-09.md).
 */
const REPORTED_RULES = {
  'cyclomatic-complexity': 'cyclomaticComplexity',
  'cognitive-complexity': 'cognitiveComplexity',
  'function-length': 'maxLinesPerFunction',
  'file-length': 'maxFileLines',
  'nesting-depth': 'maxDepth',
  'too-many-params': 'maxParams',
} as const satisfies Record<string, keyof Thresholds>;

export type ReportThresholds = Record<(typeof REPORTED_RULES)[keyof typeof REPORTED_RULES], number>;

/**
 * Règles désactivées par défaut : exactes, mais presque jamais utiles à corriger d'après la
 * mesure de précision (docs/PRECISION-2026-09.md). Désactivées, elles ne sont pas mesurées.
 * `superfluous-export` en fait partie : un `export` en trop noyait le vrai code mort.
 */
const OPTIONAL_RULES = [
  'assign-then-return',
  'boolean-ternary',
  'nested-callbacks',
  'passthrough-wrapper',
  'redundant-else',
  'superfluous-export',
  'unused-type',
] as const;

export type OptionalRule = (typeof OPTIONAL_RULES)[number];

export type RuleSwitches = Record<OptionalRule, boolean>;

/**
 * Paramètres de l'analyse comportementale (churn git, hotspots, couplage temporel).
 * windowDays suit la pratique CodeScene : douze mois d'historique.
 */
export interface ChurnConfig {
  /** Fenêtre d'historique analysée, en jours. */
  windowDays: number;
  /**
   * Commits touchant plus de fichiers que ça : ignorés pour le couplage temporel. Mesuré sur trois
   * dépôts, 90 % des commits touchent au plus 10 à 17 fichiers : au-delà de 20, c'est une refonte
   * transverse, qui relie tout à tout sans rien dire de la conception.
   */
  maxFilesPerCommit: number;
  /** Nombre minimum de co-modifications avant de considérer une paire. */
  minCoChangeCommits: number;
  /** Part minimale de co-modification (together / min(commitsA, commitsB)). */
  minCoChangeDegree: number;
  /**
   * Commits minimum dans la fenêtre pour mesurer le couplage. Sous 50, les 5 co-modifications
   * exigées pèsent plus de 10 % de l'historique : un projet jeune change ses fichiers centraux ensemble.
   */
  minHistoryCommits: number;
}

/** Fiabilité du rapport knip (adapters/knip-reliability.ts). */
export interface KnipConfig {
  /**
   * Au-delà de cette part de fichiers du périmètre signalés inutilisés, knip est jugé non fiable et son
   * code mort n'est pas compté. Sur cinq dépôts sans configuration knip : 14,5 % au plus quand il trouve
   * ses points d'entrée, 50,5 % quand il les rate. 1 le juge toujours fiable.
   */
  maxUnusedFileFraction: number;
  /**
   * Sous ce nombre de fichiers signalés inutilisés, la part n'est pas jugée : sur un petit dépôt, un seul
   * fichier vraiment mort dépasserait le tiers et se lirait en baseline incomparable plutôt qu'en régression.
   * Un point d'entrée raté en produit des centaines.
   */
  minUnusedFiles: number;
}

/** Périmètre analysé, en globs relatifs au rootPath. */
export interface ScopeConfig {
  include: string[];
  exclude: string[];
}

const DEFAULT_THRESHOLDS: Thresholds = {
  cyclomaticComplexity: 10,
  cognitiveComplexity: 15,
  maxLinesPerFunction: 50,
  maxFileLines: 300,
  maxDepth: 3,
  maxParams: 4,
  maxNestedCallbacks: 3,
  duplicationPercent: 3,
  erosionFraction: 0.35,
  verbosityFraction: 0.2,
};

const DEFAULT_REPORT_THRESHOLDS: ReportThresholds = {
  cyclomaticComplexity: 25,
  cognitiveComplexity: 30,
  maxLinesPerFunction: 100,
  maxFileLines: 600,
  maxDepth: 5,
  maxParams: 6,
};

const DEFAULT_CHURN: ChurnConfig = {
  windowDays: 365,
  maxFilesPerCommit: 20,
  minCoChangeCommits: 5,
  minCoChangeDegree: 0.5,
  minHistoryCommits: 50,
};

/** Plus d'un tiers des fichiers signalés inutilisés, et au moins 10 : voir KnipConfig. */
const DEFAULT_KNIP: KnipConfig = {
  maxUnusedFileFraction: 0.33,
  minUnusedFiles: 10,
};

const DEFAULT_SCOPE: ScopeConfig = {
  include: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
  exclude: [
    'node_modules/**',
    'dist/**',
    'build/**',
    'out/**',
    'coverage/**',
    '.git/**',
    '**/*.d.ts',
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/*.spec.ts',
    '**/__tests__/**',
  ],
};

/** crap-detector.json du repo cible : tout est optionnel, fusionné sur les défauts. */
export interface ProjectConfig {
  thresholds?: Partial<Thresholds>;
  reportThresholds?: Partial<ReportThresholds>;
  rules?: Partial<RuleSwitches>;
  scope?: Partial<ScopeConfig>;
  churn?: Partial<ChurnConfig>;
  knip?: Partial<KnipConfig>;
}

export const CONFIG_FILENAME = 'crap-detector.json';

export function defaultThresholds(): Thresholds {
  return { ...DEFAULT_THRESHOLDS };
}

export function defaultChurn(): ChurnConfig {
  return { ...DEFAULT_CHURN };
}

export function defaultScope(): ScopeConfig {
  return {
    include: [...DEFAULT_SCOPE.include],
    exclude: [...DEFAULT_SCOPE.exclude],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNumbers(prefix: string, partial: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(partial)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${CONFIG_FILENAME}: ${prefix}.${key} doit être un nombre positif fini`);
    }
  }
}

/** Une clé mal orthographiée ferait croire à un réglage qui ne s'applique pas. */
function assertKnownKeys(prefix: string, partial: Record<string, unknown>, known: readonly string[]): void {
  for (const key of Object.keys(partial)) {
    if (!known.includes(key)) {
      throw new Error(`${CONFIG_FILENAME}: ${prefix}.${key} inconnu, clés acceptées : ${known.join(', ')}`);
    }
  }
}

function assertStringArray(field: string, value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${CONFIG_FILENAME}: ${field} doit être un tableau de chaînes`);
  }
}

function section(parsed: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = parsed[field];
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`${CONFIG_FILENAME}: ${field} doit être un objet`);
  }
  return value;
}

function numberSection(parsed: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = section(parsed, field);
  if (value !== undefined) assertNumbers(field, value);
  return value;
}

function rulesSection(parsed: Record<string, unknown>): Partial<RuleSwitches> | undefined {
  const rules = section(parsed, 'rules');
  if (rules === undefined) return undefined;
  assertKnownKeys('rules', rules, OPTIONAL_RULES);
  for (const [rule, enabled] of Object.entries(rules)) {
    if (typeof enabled !== 'boolean') {
      throw new Error(`${CONFIG_FILENAME}: rules.${rule} doit valoir true ou false`);
    }
  }
  return rules as Partial<RuleSwitches>;
}

function scopeSection(parsed: Record<string, unknown>): Partial<ScopeConfig> | undefined {
  const scope = section(parsed, 'scope');
  if (scope === undefined) return undefined;
  const resolved: Partial<ScopeConfig> = {};
  if (scope['include'] !== undefined) {
    assertStringArray('scope.include', scope['include']);
    resolved.include = scope['include'];
  }
  if (scope['exclude'] !== undefined) {
    assertStringArray('scope.exclude', scope['exclude']);
    resolved.exclude = scope['exclude'];
  }
  return resolved;
}

/**
 * Lit <rootPath>/crap-detector.json s'il existe ; sinon config vide.
 * Lève une erreur explicite sur un fichier mal formé (jamais de fallback silencieux).
 */
export function loadProjectConfig(rootPath: string): ProjectConfig {
  let raw: string;
  try {
    raw = readFileSync(join(rootPath, CONFIG_FILENAME), 'utf8');
  } catch {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(`${CONFIG_FILENAME} doit contenir un objet JSON`);
  }
  const reportThresholds = numberSection(parsed, 'reportThresholds');
  if (reportThresholds !== undefined) {
    assertKnownKeys('reportThresholds', reportThresholds, Object.values(REPORTED_RULES));
  }
  return {
    thresholds: numberSection(parsed, 'thresholds') as Partial<Thresholds> | undefined,
    reportThresholds: reportThresholds as Partial<ReportThresholds> | undefined,
    rules: rulesSection(parsed),
    churn: numberSection(parsed, 'churn') as Partial<ChurnConfig> | undefined,
    scope: scopeSection(parsed),
    knip: knipSection(parsed),
  };
}

function knipSection(parsed: Record<string, unknown>): Partial<KnipConfig> | undefined {
  const knip = numberSection(parsed, 'knip');
  if (knip !== undefined) assertKnownKeys('knip', knip, Object.keys(DEFAULT_KNIP));
  return knip as Partial<KnipConfig> | undefined;
}

export interface ResolvedConfig {
  thresholds: Thresholds;
  reportThresholds: ReportThresholds;
  rules: RuleSwitches;
  scope: ScopeConfig;
  churn: ChurnConfig;
  knip: KnipConfig;
}

export function resolveConfig(config: ProjectConfig): ResolvedConfig {
  const allDisabled = Object.fromEntries(OPTIONAL_RULES.map((rule) => [rule, false])) as RuleSwitches;
  return {
    thresholds: { ...defaultThresholds(), ...config.thresholds },
    reportThresholds: { ...DEFAULT_REPORT_THRESHOLDS, ...config.reportThresholds },
    rules: { ...allDisabled, ...config.rules },
    churn: { ...defaultChurn(), ...config.churn },
    knip: { ...DEFAULT_KNIP, ...config.knip },
    scope: {
      include: config.scope?.include ?? defaultScope().include,
      exclude: config.scope?.exclude ?? defaultScope().exclude,
    },
  };
}

/** Une règle hors de OPTIONAL_RULES est toujours active. */
export function isRuleEnabled(rules: RuleSwitches, rule: string): boolean {
  return !(OPTIONAL_RULES as readonly string[]).includes(rule) || rules[rule as OptionalRule];
}

/** Règles optionnelles activées, triées : ce qui rend deux baselines comparables. */
export function enabledOptionalRules(rules: RuleSwitches): string[] {
  return OPTIONAL_RULES.filter((rule) => rules[rule]);
}

/** Seuil de signalement d'une règle, undefined pour une règle à un seul niveau. */
export function reportThresholdOf(reportThresholds: ReportThresholds, rule: string): number | undefined {
  return Object.hasOwn(REPORTED_RULES, rule)
    ? reportThresholds[REPORTED_RULES[rule as keyof typeof REPORTED_RULES]]
    : undefined;
}
