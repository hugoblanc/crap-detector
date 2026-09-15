/**
 * Contrat de données partagé par tous les analyseurs, le CLI et (plus tard) le MCP.
 * Aucune logique ici : uniquement des types.
 */
import type { ThresholdsSnapshot } from './config.js';
import type { DeadCodeSummary, KnipReliability } from './dead-code.js';
import type { Finding } from './findings.js';
import type { BaselineScope, ReportScope } from './scope.js';

export type { Finding, Severity, ToolId } from './findings.js';
export type { DeadCodeSummary } from './dead-code.js';

export interface FunctionMetrics {
  symbol: string;
  file: string;
  line: number;
  endLine: number;
  sloc: number;
  cyclomatic: number;
  cognitive: number;
  params: number;
  nestingDepth: number;
  /** Profondeur maximale de fonctions imbriquées (callback hell), racine exclue. */
  callbackDepth: number;
}

export interface FileMetrics {
  file: string;
  sloc: number;
  functionCount: number;
  maxNestingDepth: number;
  functions: FunctionMetrics[];
}

export interface MetricsSummary {
  totalFiles: number;
  totalSloc: number;
  totalFunctions: number;
  maxCyclomatic: number;
  maxCognitive: number;
  highCcFunctionCount: number;
  medianCyclomatic: number;
  erosionFraction: number;
  /** Numérateur de erosionFraction : masse des fonctions au-delà du seuil. */
  erodedMass: number;
  /**
   * Contre-mesures au découpage artificiel : un agent qui saucissonne pour passer
   * sous un seuil de complexité fait monter functionsPerFile et chuter
   * medianFunctionSloc, alors qu'un vrai refactoring déplace du code sans créer
   * vingt fonctions de trois lignes.
   */
  medianFunctionSloc: number;
  functionsPerFile: number;
}

export interface MetricsReport extends ReportEnvelope {
  filesScanned: number;
  summary: MetricsSummary;
  files: FileMetrics[];
  findings: Finding[];
}

export interface SlopSummary {
  totalSloc: number;
  /** Lignes distinctes couvertes par les règles de verbosité et les clones. */
  verboseLines: number;
  /** SlopCodeBench : ~0,15 code humain, ~0,33 code agentique. */
  verbosityFraction: number;
  typeEscapes: number;
  /** Nombre d'occurrences par règle, pour lire d'où vient le score. */
  hitsByRule: Record<string, number>;
}

export interface SlopReport extends ReportEnvelope {
  summary: SlopSummary;
  findings: Finding[];
}

export interface ImportsSummary {
  filesScanned: number;
  /** Arêtes du graphe interne (fichier du scope → fichier du scope). */
  internalEdges: number;
  /** Paquets externes distincts référencés. */
  externalPackages: number;
  unknownDependencies: number;
  unresolvedImports: number;
}

export interface ImportsReport extends ReportEnvelope {
  /**
   * false quand package.json ou tsconfig.json n'a pas pu être lu :
   * la règle unknown-dependency est alors désactivée pour éviter les faux positifs.
   */
  manifestTrusted: boolean;
  manifestReason?: string;
  summary: ImportsSummary;
  findings: Finding[];
}

export interface DeadCodeReport extends ReportEnvelope {
  /** false = outil absent ou sortie illisible ; l'analyse continue sans lui. */
  available: boolean;
  unavailableReason?: string;
  /** Ce que knip signale dans le périmètre, fiable ou non ; `findings` ne garde que ce qui est compté. */
  summary: DeadCodeSummary;
  findings: Finding[];
  /** Findings écartés parce que leur fichier est hors du périmètre ; knip, lui, lit tout le projet. */
  outOfScope: number;
  /** Points d'entrée déclarés à knip par crap-detector ; 0 quand le dépôt configure knip lui-même. */
  declaredEntries?: number;
  reliability?: KnipReliability;
}

export interface DuplicationStatistics {
  clones: number;
  duplicatedLines: number;
  percent: number;
}

export interface DuplicationReport extends ReportEnvelope {
  available: boolean;
  unavailableReason?: string;
  statistics: DuplicationStatistics;
  findings: Finding[];
  /** Clones dont un côté est hors du périmètre ; 0 attendu, jscpd ne reçoit que ses fichiers. */
  outOfScope: number;
}

export interface DependencySummary {
  cycles: number;
  orphans: number;
  /** Taille de la plus grosse composante cyclique : un cycle de 12 fichiers ne se casse pas comme un de 2. */
  largestCycle: number;
}

export interface DependencyReport extends ReportEnvelope {
  summary: DependencySummary;
  /** Composantes fortement connexes du graphe d'imports. */
  cycles: Array<{ files: string[] }>;
  orphans: string[];
  findings: Finding[];
}

/** Activité d'un fichier sur la fenêtre d'historique analysée. */
export interface FileChurn {
  file: string;
  commits: number;
  addedLines: number;
  deletedLines: number;
  /** Date ISO du plus ancien commit de la fenêtre touchant ce fichier. */
  firstChange: string;
  lastChange: string;
}

export interface ChurnSummary {
  commitsScanned: number;
  filesChanged: number;
  addedLines: number;
  deletedLines: number;
}

export interface ChurnReport extends ReportEnvelope {
  /** false = pas de dépôt git exploitable ; ce n'est pas une erreur, juste une absence. */
  available: boolean;
  unavailableReason?: string;
  windowDays: number;
  /** Borne basse effective de la fenêtre (date ISO) ou plage de révisions. */
  since?: string;
  summary: ChurnSummary;
  files: FileChurn[];
  hotspots: Hotspot[];
}

/** Paire de fichiers co-modifiés sur la fenêtre d'historique. */
export interface CoChange {
  fileA: string;
  fileB: string;
  /** Commits où les deux fichiers changent. */
  together: number;
  commitsA: number;
  commitsB: number;
  /** together / min(commitsA, commitsB) : part de co-modification du moins actif. */
  degree: number;
  /** true si deux imports au plus, ou un module de types commun, les relient : couplage explicite. */
  linked: boolean;
}

export interface CouplingSummary {
  pairs: number;
  hiddenPairs: number;
}

export interface CouplingReport extends ReportEnvelope {
  summary: CouplingSummary;
  pairs: CoChange[];
  findings: Finding[];
}

export interface Hotspot {
  file: string;
  commits: number;
  addedLines: number;
  deletedLines: number;
  maxCyclomatic: number;
  maxCognitive: number;
  /** commits × max(cyclomatic, cognitive), 0 si le fichier n'a pas de fonction mesurée. */
  score: number;
}

/** Champs comments à tous les rapports : provenance indispensable aux baselines. */
export interface ReportEnvelope {
  generatorVersion: string;
  generatedAt: string;
  rootPath: string;
  toolVersion: string;
}

/** Clés d'agrégats suivies par la baseline — toutes « lower is better ». */
export type AggregateKey =
  | 'erosion.fraction'
  | 'erosion.mass'
  | 'verbosity.fraction'
  | 'verbosity.lines'
  | 'duplication.percent'
  | 'duplication.lines'
  | 'deadcode.exports.count'
  | 'deadcode.files.count'
  | 'cycles.count'
  | 'orphans.count'
  | 'coupling.hidden.count'
  | 'imports.unknown.count'
  | 'typesafety.escapes.count';

export const AGGREGATE_KEYS = [
  'erosion.fraction',
  'erosion.mass',
  'verbosity.fraction',
  'verbosity.lines',
  'duplication.percent',
  'duplication.lines',
  'deadcode.exports.count',
  'deadcode.files.count',
  'cycles.count',
  'orphans.count',
  'coupling.hidden.count',
  'imports.unknown.count',
  'typesafety.escapes.count',
] as const satisfies readonly AggregateKey[];

/**
 * Une clé absente signifie « non mesuré », jamais « zéro ».
 * Enregistrer 0 pour un outil indisponible transformerait son retour en régression.
 */
export type Aggregates = Partial<Record<AggregateKey, number>>;

export interface BaselineGenerator {
  name: string;
  version: string;
}

/** Entrées ignorées par git, relatives à rootPath ; un dossier listé l'est en entier. */
export interface IgnoredPaths {
  directories: ReadonlySet<string>;
  files: ReadonlySet<string>;
}

/**
 * Baseline versionnée, committée dans le repo cible.
 * Volontairement sans numéros de ligne ni ids : stable aux décalages et renames.
 */
export interface Baseline {
  version: 2;
  generator: BaselineGenerator;
  toolVersions: Record<string, string>;
  createdAt: string;
  thresholds: ThresholdsSnapshot;
  scope: BaselineScope;
  aggregates: Aggregates;
  /**
   * Règles booléennes : clé `${tool}|${rule}|${file}` → nombre de violations tolérées.
   * Une occurrence de plus est strictement pire (catch vide, export mort, cycle).
   */
  debtCounts: Record<string, number>;
  /**
   * Règles à seuil : clé `${tool}|${rule}|${file}` → pire valeur tolérée du fichier.
   *
   * Compter les occurrences serait faux ici. Découper une fonction de complexité
   * cognitive 156 en trois fonctions à 77, 32 et 18 fait passer le compte de 1 à 3
   * alors que le fichier est devenu meilleur : mesuré au compte, le cliquet
   * rejetterait exactement le refactoring qu'il réclame. Le maximum, lui, baisse.
   * Il attrape aussi ce que le compte rate : un fichier qui grossit de 301 à 3000
   * lignes reste une seule violation, mais son maximum triple.
   */
  debtMaxima: Record<string, number>;
}

export type RegressionKind =
  | 'aggregate'
  | 'debt-increase'
  | 'debt-new-entry'
  | 'debt-new-file';

export interface Regression {
  kind: RegressionKind;
  key: string;
  baselineValue?: number;
  currentValue?: number;
  message: string;
}

export interface Improvement {
  key: string;
  baselineValue?: number;
  currentValue?: number;
  message: string;
}

export interface CompareResult {
  /** false = baseline incomparable (seuils/scope/outils divergents) : re-snapshot requis. */
  comparable: boolean;
  incompatibilityReason?: string;
  passed: boolean;
  regressions: Regression[];
  improvements: Improvement[];
  unchangedCount: number;
  /**
   * Agrégats présents d'un seul côté : outil devenu indisponible, ou métrique
   * ajoutée par une version plus récente. Ni régression ni amélioration.
   */
  skippedKeys: string[];
  /**
   * Mouvements constatés qui ne font pas échouer le gate, avec leur raison.
   * Un ratio qui monte parce qu'on a supprimé du code sain atterrit ici.
   */
  notes: string[];
}

/** Rapport complet : tous les sous-rapports, les agrégats et les findings fusionnés. */
export interface ScanReport extends ReportEnvelope {
  filesScanned: number;
  thresholds: ThresholdsSnapshot;
  scope: ReportScope;
  metrics: MetricsReport;
  slop: SlopReport;
  imports: ImportsReport;
  dependencies: DependencyReport;
  churn?: ChurnReport;
  coupling?: CouplingReport;
  deadCode?: DeadCodeReport;
  duplication?: DuplicationReport;
  aggregates: Aggregates;
  /** Tous les findings de tous les analyseurs, triés par sévérité. */
  findings: Finding[];
}

/** Rapport du chemin rapide : un seul fichier, sans git ni outil externe. */
export interface FileScanReport extends ReportEnvelope {
  file: string;
  metrics: FileMetrics;
  findings: Finding[];
}
