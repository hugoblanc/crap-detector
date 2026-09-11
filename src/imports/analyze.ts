/**
 * Gate anti-hallucination supply-chain.
 * Un agent qui invente un paquet (« slopsquatting ») écrit un import parfaitement
 * plausible vers un paquet qui n'existe pas, ou pas dans ce projet. C'est
 * déterministe à vérifier : l'AST donne le specifier, le package.json la vérité,
 * node_modules dit si le paquet existe au moins.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SourceFile } from 'ts-morph';
import { compareFindings, envelope, makeFinding } from '../core/findings.js';
import type { Finding, ImportsReport, ImportsSummary, Severity } from '../core/types.js';
import type { ImportGraph, ImportRef } from './extract.js';
import {
  buildImportGraph,
  fileImports,
  isTypesModule,
  normalizeRelative,
  packageNameOf,
  resolveRelativeImport,
  runtimeImports,
  staticRuntimeImports,
} from './extract.js';
import { runtimeGraph } from './graph.js';
import { inDir, isDeclared, manifestResolver, readManifest, typesPackageOf } from './manifest.js';
import type { Manifest } from './manifest.js';

/** Extensions essayées quand un import relatif ne pointe pas sur un fichier du scope. */
const ON_DISK_EXTENSIONS = [
  '', '.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '/index.ts', '/index.tsx', '/index.js', '/index.mjs', '/index.cjs', '/index.json',
];

/** Un import relatif hors scope peut viser un asset ou un fichier généré : on vérifie le disque. */
function existsOnDisk(rootPath: string, fromFile: string, specifier: string): boolean {
  const target = normalizeRelative(fromFile, specifier);
  if (target === undefined) return false;
  const bases = [target];
  const remapped = target.replace(/\.(m|c)?js$/, '');
  if (remapped !== target) bases.push(remapped);
  return bases.some((base) =>
    ON_DISK_EXTENSIONS.some((extension) => existsSync(join(rootPath, `${base}${extension}`))));
}

/** Résolvable comme Node le chercherait : node_modules de chaque dossier parent, jusqu'à la racine du disque. */
function isInstalled(rootPath: string, file: string, packageName: string): boolean {
  let dir = dirname(join(rootPath, file));
  for (;;) {
    if (existsSync(join(dir, 'node_modules', packageName))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Ce qu'il faut pour juger un import de paquet, calculé à la demande et mémorisé. */
export interface DependencyContext {
  rootPath: string;
  manifestFor: (file: string) => Manifest;
  /** false si l'import disparaît une fois les types effacés ; coûte une transpilation par fichier. */
  isRuntimeImport: (file: string, specifier: string) => boolean;
}

export function dependencyContext(rootPath: string, sourceFiles: Map<string, SourceFile>): DependencyContext {
  const manifestFor = manifestResolver(rootPath);
  const runtime = new Map<string, Set<string>>();
  return {
    rootPath,
    manifestFor,
    isRuntimeImport: (file, specifier) => {
      const source = sourceFiles.get(file);
      if (source === undefined) return true;
      const kept = runtime.get(file) ?? runtimeImports(source, manifestFor(file).verbatimModuleSyntax);
      runtime.set(file, kept);
      return kept.has(specifier);
    },
  };
}

interface UndeclaredKind {
  rule: string;
  severity: Severity;
  message: (packageName: string, manifestPath: string) => string;
}

/** Un paquet installé arrive par une dépendance transitive ; introuvable, il est probablement inventé. */
const UNDECLARED: Record<'installed' | 'missing', UndeclaredKind> = {
  installed: {
    rule: 'unlisted-dependency',
    severity: 'major',
    message: (name, path) => `paquet '${name}' installé mais absent de ${path}`,
  },
  missing: {
    rule: 'unknown-dependency',
    severity: 'critical',
    message: (name, path) => `paquet '${name}' absent de ${path} et introuvable dans node_modules`,
  },
};

/** Rien d'inventé : le paquet est installé, ou son seul @types l'est pour un import de types seuls. */
function isResolvable(context: DependencyContext, file: string, specifier: string): boolean {
  const packageName = packageNameOf(specifier);
  if (isInstalled(context.rootPath, file, packageName)) return true;
  return isInstalled(context.rootPath, file, typesPackageOf(packageName)) && !context.isRuntimeImport(file, specifier);
}

/**
 * Import de paquet non déclaré dans le package.json le plus proche du fichier. Un import de
 * types seuls couvert par un `@types/` déclaré ne charge rien à l'exécution : pas de finding.
 */
export function dependencyFinding(context: DependencyContext, file: string, ref: ImportRef): Finding | undefined {
  if (ref.specifierKind !== 'bare' && ref.specifierKind !== 'subpath') return undefined;
  const manifest = context.manifestFor(file);
  // Sans manifeste fiable, la règle se tait plutôt que de produire du bruit.
  if (!manifest.trustworthy) return undefined;
  const packageName = packageNameOf(ref.specifier);
  if (isDeclared(manifest, ref.specifier, packageName)) return undefined;
  const typesDeclared = manifest.dependencies.has(typesPackageOf(packageName));
  if (typesDeclared && !context.isRuntimeImport(file, ref.specifier)) return undefined;
  const installed = ref.specifierKind === 'bare' && isResolvable(context, file, ref.specifier);
  const kind = UNDECLARED[installed ? 'installed' : 'missing'];
  return makeFinding({
    tool: 'imports',
    rule: kind.rule,
    file,
    line: ref.line,
    symbol: packageName,
    symbolKey: packageName,
    severity: kind.severity,
    message: kind.message(packageName, inDir(manifest.dir, 'package.json')),
  });
}

function unresolvedFinding(rootPath: string, file: string, ref: ImportRef, knownFiles: ReadonlySet<string>): Finding | undefined {
  if (resolveRelativeImport(file, ref.specifier, knownFiles) !== undefined) return undefined;
  if (existsOnDisk(rootPath, file, ref.specifier)) return undefined;
  return makeFinding({
    tool: 'imports',
    rule: 'unresolved-import',
    file,
    line: ref.line,
    symbol: ref.specifier,
    symbolKey: ref.specifier,
    severity: 'critical',
    message: `import vers '${ref.specifier}' : aucun fichier correspondant`,
  });
}

export interface ImportAnalysis {
  report: ImportsReport;
  graph: ImportGraph;
  /** Imports présents à l'exécution seulement : ni types effacés, ni `import()` dynamique. */
  cycleGraph: ImportGraph;
  imports: Map<string, ImportRef[]>;
}

/**
 * Un import statique survit-il à l'émission, d'après le tsconfig le plus proche du fichier ?
 * Un `import()` dynamique ne charge le module qu'à l'appel ; un `require` reste compté.
 */
function emittedStatically(
  sourceFiles: Map<string, SourceFile>,
  manifestFor: (file: string) => Manifest,
): (file: string, ref: ImportRef) => boolean {
  const kept = new Map<string, Set<string>>();
  return (file, ref) => {
    if (ref.kind === 'dynamic') return false;
    const source = sourceFiles.get(file);
    if (ref.kind === 'require' || source === undefined) return true;
    const emitted = kept.get(file) ?? staticRuntimeImports(source, manifestFor(file).verbatimModuleSyntax);
    kept.set(file, emitted);
    return emitted.has(ref.specifier);
  };
}

export function collectImports(sourceFiles: Map<string, SourceFile>): Map<string, ImportRef[]> {
  const imports = new Map<string, ImportRef[]>();
  for (const [file, sourceFile] of sourceFiles) {
    imports.set(file, fileImports(sourceFile));
  }
  return imports;
}

export function importFindings(context: DependencyContext, imports: Map<string, ImportRef[]>): Finding[] {
  const knownFiles = new Set(imports.keys());
  const findings: Finding[] = [];
  for (const [file, refs] of imports) {
    for (const ref of refs) {
      const finding = ref.specifierKind === 'relative'
        ? unresolvedFinding(context.rootPath, file, ref, knownFiles)
        : dependencyFinding(context, file, ref);
      if (finding !== undefined) findings.push(finding);
    }
  }
  return findings.sort(compareFindings);
}

export function summarizeImports(
  imports: Map<string, ImportRef[]>,
  graph: ImportGraph,
  findings: Finding[],
): ImportsSummary {
  const externals = new Set<string>();
  for (const refs of imports.values()) {
    for (const ref of refs) {
      if (ref.specifierKind === 'bare') externals.add(packageNameOf(ref.specifier));
    }
  }
  let internalEdges = 0;
  for (const targets of graph.edges.values()) internalEdges += targets.size;
  return {
    filesScanned: imports.size,
    internalEdges,
    externalPackages: externals.size,
    unknownDependencies: findings.filter((finding) => finding.rule === 'unknown-dependency').length,
    unresolvedImports: findings.filter((finding) => finding.rule === 'unresolved-import').length,
  };
}

export function analyzeImports(
  rootPath: string,
  sourceFiles: Map<string, SourceFile>,
): ImportAnalysis {
  const context = dependencyContext(rootPath, sourceFiles);
  const imports = collectImports(sourceFiles);
  // Les alias du graphe restent ceux de la racine : pas de résolution par sous-projet.
  const manifest = readManifest(rootPath);
  const typesModules = new Set([...sourceFiles].filter(([, source]) => isTypesModule(source)).map(([file]) => file));
  const graph: ImportGraph = { ...buildImportGraph(imports, manifest), typesModules };
  const cycleGraph = runtimeGraph(graph, imports, manifest, emittedStatically(sourceFiles, context.manifestFor));
  const findings = importFindings(context, imports);
  const untrusted = [...imports.keys()].map(context.manifestFor).find((manifest) => !manifest.trustworthy);
  const report: ImportsReport = {
    ...envelope(rootPath, 'ts-morph'),
    manifestTrusted: untrusted === undefined,
    summary: summarizeImports(imports, graph, findings),
    findings,
  };
  if (untrusted?.untrustworthyReason !== undefined) {
    report.manifestReason = untrusted.untrustworthyReason;
  }
  return { report, graph, cycleGraph, imports };
}
