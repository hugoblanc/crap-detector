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
 * Paramètres de l'analyse comportementale (churn git, hotspots, couplage temporel).
 * windowDays suit la pratique CodeScene : douze mois d'historique.
 */
export interface ChurnConfig {
  /** Fenêtre d'historique analysée, en jours. */
  windowDays: number;
  /**
   * Commits touchant plus de fichiers que ça : ignorés pour le couplage temporel.
   * Un commit de 500 fichiers produirait 125 000 paires et ne dit rien de la conception.
   */
  maxFilesPerCommit: number;
  /** Nombre minimum de co-modifications avant de considérer une paire. */
  minCoChangeCommits: number;
  /** Part minimale de co-modification (together / min(commitsA, commitsB)). */
  minCoChangeDegree: number;
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

const DEFAULT_CHURN: ChurnConfig = {
  windowDays: 365,
  maxFilesPerCommit: 50,
  minCoChangeCommits: 5,
  minCoChangeDegree: 0.5,
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
  scope?: Partial<ScopeConfig>;
  churn?: Partial<ChurnConfig>;
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

function assertStringArray(field: string, value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${CONFIG_FILENAME}: ${field} doit être un tableau de chaînes`);
  }
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
  const config: ProjectConfig = {};
  const thresholds = parsed['thresholds'];
  if (thresholds !== undefined) {
    if (!isPlainObject(thresholds)) {
      throw new Error(`${CONFIG_FILENAME}: thresholds doit être un objet`);
    }
    assertNumbers('thresholds', thresholds);
    config.thresholds = thresholds as Partial<Thresholds>;
  }
  const churn = parsed['churn'];
  if (churn !== undefined) {
    if (!isPlainObject(churn)) {
      throw new Error(`${CONFIG_FILENAME}: churn doit être un objet`);
    }
    assertNumbers('churn', churn);
    config.churn = churn as Partial<ChurnConfig>;
  }
  const scope = parsed['scope'];
  if (scope !== undefined) {
    if (!isPlainObject(scope)) {
      throw new Error(`${CONFIG_FILENAME}: scope doit être un objet`);
    }
    const resolved: Partial<ScopeConfig> = {};
    if (scope['include'] !== undefined) {
      assertStringArray('scope.include', scope['include']);
      resolved.include = scope['include'];
    }
    if (scope['exclude'] !== undefined) {
      assertStringArray('scope.exclude', scope['exclude']);
      resolved.exclude = scope['exclude'];
    }
    config.scope = resolved;
  }
  return config;
}

export interface ResolvedConfig {
  thresholds: Thresholds;
  scope: ScopeConfig;
  churn: ChurnConfig;
}

export function resolveConfig(config: ProjectConfig): ResolvedConfig {
  return {
    thresholds: { ...defaultThresholds(), ...config.thresholds },
    churn: { ...defaultChurn(), ...config.churn },
    scope: {
      include: config.scope?.include ?? defaultScope().include,
      exclude: config.scope?.exclude ?? defaultScope().exclude,
    },
  };
}
