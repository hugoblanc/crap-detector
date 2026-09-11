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
import { analyzeImports, dependencyContext, dependencyFinding } from '../imports/analyze.js';
import { analyzeGraph } from '../imports/graph.js';
import type { ImportGraph } from '../imports/extract.js';
import { fileImports } from '../imports/extract.js';
import { analyzeSlop, slopFindings } from '../slop/analyze.js';
import { slopHits } from '../slop/rules.js';
import type { SlopHit } from '../slop/rules.js';

export interface FastScan {
  files: string[];
  sourceFiles: Map<string, SourceFile>;
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

export function scanFast(rootPath: string, config: ResolvedConfig, ignored?: IgnoredPaths): FastScan {
  const files = collectFiles(rootPath, config.scope, ignored);
  const sourceFiles = loadSourceFiles(rootPath, files);

  const fileMetrics: FileMetrics[] = [];
  for (const [relative, sourceFile] of sourceFiles) {
    fileMetrics.push(analyzeFile(sourceFile, relative));
  }
  const summary = summarizeFiles(fileMetrics, config);
  const metrics: MetricsReport = {
    ...envelope(rootPath, 'ts-morph'),
    filesScanned: files.length,
    summary,
    files: fileMetrics,
    findings: findingsForFiles(fileMetrics, config),
  };

  const slopAnalysis = analyzeSlop(rootPath, sourceFiles, config.rules);
  const slop = slopAnalysis.report;
  const importAnalysis = analyzeImports(rootPath, sourceFiles);
  const dependencies = analyzeGraph(rootPath, importAnalysis.graph);

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
    files,
    sourceFiles,
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
