/**
 * Chemin rapide : tout ce qui se calcule sur l'AST seul.
 * Ni git, ni sous-processus, ni parcours de node_modules — c'est ce qui permet au
 * hook PostToolUse de tourner après chaque édition d'un agent sans le ralentir.
 * Seul un paquet non déclaré y est cherché, par son chemin.
 *
 * Ce module ne doit jamais importer src/adapters ni src/churn, même pour un type
 * seul : un `import` statique de l'adaptateur suffirait à charger knip au démarrage.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Project } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { compareFindings, envelope } from '../core/findings.js';
import type { ResolvedConfig } from '../core/config.js';
import type {
  Aggregates,
  FileScanReport,
  Finding,
  FileMetrics,
  IgnoredPaths,
  ImportsReport,
  DependencyReport,
  MetricsReport,
  SlopReport,
} from '../core/types.js';
import { analyzeFile, collectFiles, findingsForFiles, summarizeFiles } from '../metrics/analyze.js';
import { fileSloc } from '../metrics/sizes.js';
import { collectTestFiles } from './test-files.js';
import { analyzeImports, dependencyContext, dependencyFinding } from '../imports/analyze.js';
import { analyzeGraph } from '../imports/graph.js';
import type { ImportGraph } from '../imports/extract.js';
import { fileImports } from '../imports/extract.js';
import { subprojectDirs } from '../imports/manifest.js';
import { vendoredSubprojects, withoutVendored } from '../imports/vendored.js';
import { analyzeSlop, slopFindings } from '../slop/analyze.js';
import { slopHits } from '../slop/rules.js';
import type { SlopHit } from '../slop/rules.js';

export interface FastScan {
  /** Fichiers mesurés : le périmètre, moins les sous-projets vendorisés. */
  files: string[];
  sourceFiles: Map<string, SourceFile>;
  /** Sous-dossiers qui portent leur propre package.json de projet, vendorisés compris. */
  subprojects: string[];
  /** Sous-projets écartés du périmètre : package.json propre, aucun importeur, pas un espace de travail. */
  vendored: string[];
  /** Fichiers de ces sous-projets, hors mesure mais transmis à jscpd pour garder les clones du code vivant. */
  vendoredFiles: string[];
  /** Lignes de code de ces fichiers, pour recouper un filesScanned plus bas que prévu. */
  vendoredSloc: number;
  /** Détection désactivée faute d'avoir lu les espaces de travail déclarés ; aucun dossier écarté. */
  vendoredUnreadableReason?: string;
  metrics: MetricsReport;
  slop: SlopReport;
  /** Occurrences brutes, réutilisées par le scan complet pour y ajouter les clones. */
  slopHits: SlopHit[];
  imports: ImportsReport;
  dependencies: DependencyReport;
  graph: ImportGraph;
  aggregates: Aggregates;
  findings: Finding[];
}

/** Charge tous les fichiers du scope dans un projet ts-morph en mémoire. */
export function loadSourceFiles(rootPath: string, files: string[]): Map<string, SourceFile> {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sources = new Map<string, SourceFile>();
  for (const relative of files) {
    const content = readFileSync(join(rootPath, relative), 'utf8');
    sources.set(relative, project.createSourceFile(relative, content));
  }
  return sources;
}

/** Ce que le scan mesure, une fois les sous-projets vendorisés retirés des fichiers collectés. */
type MeasuredScope = Pick<
  FastScan,
  'files' | 'sourceFiles' | 'subprojects' | 'vendored' | 'vendoredFiles' | 'vendoredSloc' | 'vendoredUnreadableReason'
>;

interface ScopeInput {
  rootPath: string;
  config: ResolvedConfig;
  ignored?: IgnoredPaths;
  /** Fichiers du périmètre avant retrait des sous-projets vendorisés, et leurs sources. */
  collected: string[];
  loaded: Map<string, SourceFile>;
}

/**
 * Importeurs à considérer : les fichiers mesurés, plus les tests, exclus de la mesure mais pas
 * de la question « quelqu'un s'en sert-il ? ». Les tests ne sont chargés que s'il y a un
 * sous-projet à juger : sur un dépôt sans sous-projet, ce second parcours n'a pas lieu.
 */
function importerSources(input: ScopeInput): Map<string, SourceFile> {
  const tests = collectTestFiles(input.rootPath, input.config.scope, input.collected, input.ignored);
  if (tests.length === 0) return input.loaded;
  return new Map([...input.loaded, ...loadSourceFiles(input.rootPath, tests)]);
}

function measuredScope(input: ScopeInput): MeasuredScope {
  const { rootPath, collected, loaded } = input;
  const subprojects = subprojectDirs(rootPath, collected);
  const scan = subprojects.length === 0
    ? { dirs: [] }
    : vendoredSubprojects(rootPath, subprojects, importerSources(input));
  const files = withoutVendored(collected, scan.dirs);
  const kept = new Set(files);
  const vendoredFiles = collected.filter((file) => !kept.has(file));
  const scope: MeasuredScope = {
    files,
    sourceFiles: scan.dirs.length === 0 ? loaded : new Map([...loaded].filter(([file]) => kept.has(file))),
    subprojects,
    vendored: scan.dirs,
    vendoredFiles,
    vendoredSloc: vendoredFiles.reduce((total, file) => {
      const source = loaded.get(file);
      return source === undefined ? total : total + fileSloc(source);
    }, 0),
  };
  if (scan.unreadableReason !== undefined) scope.vendoredUnreadableReason = scan.unreadableReason;
  return scope;
}

/** Métriques AST des fichiers mesurés, dans l'ordre du périmètre. */
function metricsReport(rootPath: string, scope: MeasuredScope, config: ResolvedConfig): MetricsReport {
  const fileMetrics: FileMetrics[] = [];
  for (const [relative, sourceFile] of scope.sourceFiles) {
    fileMetrics.push(analyzeFile(sourceFile, relative));
  }
  return {
    ...envelope(rootPath, 'ts-morph'),
    filesScanned: scope.files.length,
    summary: summarizeFiles(fileMetrics, config),
    files: fileMetrics,
    findings: findingsForFiles(fileMetrics, config),
  };
}

export function scanFast(rootPath: string, config: ResolvedConfig, ignored?: IgnoredPaths): FastScan {
  const collected = collectFiles(rootPath, config.scope, ignored);
  const loaded = loadSourceFiles(rootPath, collected);
  const scope = measuredScope({ rootPath, config, ignored, collected, loaded });
  const { sourceFiles } = scope;

  const metrics = metricsReport(rootPath, scope, config);
  const { summary } = metrics;
  const slopAnalysis = analyzeSlop(rootPath, sourceFiles, config.rules);
  const slop = slopAnalysis.report;
  const importAnalysis = analyzeImports(rootPath, sourceFiles);
  const dependencies = analyzeGraph(rootPath, importAnalysis.cycleGraph);

  const aggregates: Aggregates = {
    'erosion.fraction': summary.erosionFraction,
    'erosion.mass': summary.erodedMass,
    'verbosity.fraction': slop.summary.verbosityFraction,
    'verbosity.lines': slop.summary.verboseLines,
    'typesafety.escapes.count': slop.summary.typeEscapes,
    'imports.unknown.count': importAnalysis.report.summary.unknownDependencies,
    'cycles.count': dependencies.summary.cycles,
  };

  const findings = [
    ...metrics.findings,
    ...slop.findings,
    ...importAnalysis.report.findings,
    ...dependencies.findings,
  ].sort(compareFindings);

  return {
    ...scope,
    metrics,
    slop,
    slopHits: slopAnalysis.hits,
    imports: importAnalysis.report,
    dependencies,
    graph: importAnalysis.graph,
    aggregates,
    findings,
  };
}

/**
 * Analyse d'un seul fichier, pour le hook d'agent.
 * Le graphe d'imports n'a pas de sens sur un fichier isolé, donc ni cycle ni
 * orphelin ici ; seul le paquet non déclaré reste vérifiable, le package.json
 * le plus proche étant une seule lecture.
 */
export function scanFile(
  rootPath: string,
  relativePath: string,
  config: ResolvedConfig,
): FileScanReport {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const content = readFileSync(join(rootPath, relativePath), 'utf8');
  const sourceFile = project.createSourceFile(relativePath, content);
  const metrics = analyzeFile(sourceFile, relativePath);

  const findings: Finding[] = [
    ...findingsForFiles([metrics], config),
    ...slopFindings(slopHits(sourceFile, relativePath, config.rules)),
  ];

  const context = dependencyContext(rootPath, new Map([[relativePath, sourceFile]]));
  for (const ref of fileImports(sourceFile)) {
    const finding = dependencyFinding(context, relativePath, ref);
    if (finding !== undefined) findings.push(finding);
  }

  return {
    ...envelope(rootPath, 'ts-morph'),
    file: relativePath,
    metrics,
    findings: findings.sort(compareFindings),
  };
}
