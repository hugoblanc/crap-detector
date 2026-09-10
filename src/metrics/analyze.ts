/**
 * Orchestration des métriques AST : collecte des fichiers (globs du scope),
 * analyse par fichier, résumé et findings par seuils.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Project } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { globToRegExp, matchesAnyGlob } from '../core/glob.js';
import { compareFindings, envelope, makeFinding } from '../core/findings.js';
import type { ResolvedConfig } from '../core/config.js';
import type {
  FileMetrics,
  Finding,
  FunctionMetrics,
  MetricsReport,
  MetricsSummary,
} from '../core/types.js';
import { analyzeCognitive, functionLikeNodes } from './cognitive.js';
import { cyclomaticComplexity } from './cyclomatic.js';
import { erosionStats } from './erosion.js';
import { callbackDepth, describeFunction, fileSloc, functionSloc } from './sizes.js';

/** Fichiers du scope, triés, en chemins POSIX relatifs au rootPath. */
export function collectFiles(rootPath: string, scope: ResolvedConfig['scope']): string[] {
  const includePatterns = scope.include.map(globToRegExp);
  const excludePatterns = scope.exclude.map(globToRegExp);
  const files: string[] = [];
  const walk = (dir: string, relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relEntry = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        const excluded = matchesAnyGlob(excludePatterns, relEntry)
          || matchesAnyGlob(excludePatterns, `${relEntry}/`);
        if (!excluded) walk(join(dir, entry.name), relEntry);
      } else if (entry.isFile()) {
        if (
          matchesAnyGlob(includePatterns, relEntry)
          && !matchesAnyGlob(excludePatterns, relEntry)
        ) {
          files.push(relEntry);
        }
      }
    }
  };
  walk(rootPath, '');
  return files.sort();
}

export function analyzeFile(sourceFile: SourceFile, relPath: string): FileMetrics {
  const functions: FunctionMetrics[] = functionLikeNodes(sourceFile).map((fn) => {
    const cognitive = analyzeCognitive(fn);
    return {
      symbol: describeFunction(fn),
      file: relPath,
      line: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
      sloc: functionSloc(fn),
      cyclomatic: cyclomaticComplexity(fn),
      cognitive: cognitive.score,
      params: fn.getParameters().length,
      nestingDepth: cognitive.maxNesting,
      callbackDepth: callbackDepth(fn),
    };
  });
  return {
    file: relPath,
    sloc: fileSloc(sourceFile),
    functionCount: functions.length,
    maxNestingDepth: functions.reduce((max, fn) => Math.max(max, fn.nestingDepth), 0),
    functions,
  };
}

/** Analyse d'un texte source en mémoire (utilisé par les tests et les outils ciblés). */
export function analyzeSourceText(content: string, relPath = 'sample.ts'): FileMetrics {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sourceFile = project.createSourceFile(relPath, content);
  return analyzeFile(sourceFile, relPath);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function summarizeFiles(files: FileMetrics[], config: ResolvedConfig): MetricsSummary {
  const functions = files.flatMap((file) => file.functions);
  const cyclomatics = functions.map((fn) => fn.cyclomatic);
  const erosion = erosionStats(functions, config.thresholds.cyclomaticComplexity);
  return {
    totalFiles: files.length,
    totalSloc: files.reduce((sum, file) => sum + file.sloc, 0),
    totalFunctions: functions.length,
    maxCyclomatic: cyclomatics.reduce((max, cc) => Math.max(max, cc), 0),
    maxCognitive: functions.reduce((max, fn) => Math.max(max, fn.cognitive), 0),
    highCcFunctionCount: cyclomatics.filter((cc) => cc > config.thresholds.cyclomaticComplexity)
      .length,
    medianCyclomatic: median(cyclomatics),
    erosionFraction: erosion.fraction,
    erodedMass: erosion.erodedMass,
    medianFunctionSloc: median(functions.map((fn) => fn.sloc)),
    functionsPerFile: files.length > 0 ? functions.length / files.length : 0,
  };
}

export function findingsForFiles(files: FileMetrics[], config: ResolvedConfig): Finding[] {
  const thresholds = config.thresholds;
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.sloc > thresholds.maxFileLines) {
      findings.push(
        makeFinding({
          tool: 'metrics',
          rule: 'file-length',
          file: file.file,
          value: file.sloc,
          threshold: thresholds.maxFileLines,
          message: `fichier de ${file.sloc} lignes (max ${thresholds.maxFileLines})`,
        }),
      );
    }
    for (const fn of file.functions) {
      const push = (rule: string, value: number, threshold: number, unit: string): void => {
        findings.push(
          makeFinding({
            tool: 'metrics',
            rule,
            file: fn.file,
            line: fn.line,
            symbol: fn.symbol,
            value,
            threshold,
            message: `${fn.symbol} : ${unit} ${value} > ${threshold}`,
          }),
        );
      };
      if (fn.cyclomatic > thresholds.cyclomaticComplexity) {
        push('cyclomatic-complexity', fn.cyclomatic, thresholds.cyclomaticComplexity, 'complexité cyclomatique');
      }
      if (fn.cognitive > thresholds.cognitiveComplexity) {
        push('cognitive-complexity', fn.cognitive, thresholds.cognitiveComplexity, 'complexité cognitive');
      }
      if (fn.sloc > thresholds.maxLinesPerFunction) {
        push('function-length', fn.sloc, thresholds.maxLinesPerFunction, 'lignes');
      }
      if (fn.params > thresholds.maxParams) {
        push('too-many-params', fn.params, thresholds.maxParams, 'paramètres');
      }
      if (fn.nestingDepth > thresholds.maxDepth) {
        push('nesting-depth', fn.nestingDepth, thresholds.maxDepth, 'profondeur d\'imbrication');
      }
      if (fn.callbackDepth > thresholds.maxNestedCallbacks) {
        push('nested-callbacks', fn.callbackDepth, thresholds.maxNestedCallbacks, 'callbacks imbriqués');
      }
    }
  }
  return findings.sort(compareFindings);
}

export function analyzeProject(rootPath: string, config: ResolvedConfig): MetricsReport {
  const relFiles = collectFiles(rootPath, config.scope);
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const files: FileMetrics[] = relFiles.map((rel) => {
    const content = readFileSync(join(rootPath, rel), 'utf8');
    return analyzeFile(project.createSourceFile(rel, content), rel);
  });
  return {
    ...envelope(rootPath, 'ts-morph'),
    filesScanned: relFiles.length,
    summary: summarizeFiles(files, config),
    files,
    findings: findingsForFiles(files, config),
  };
}
