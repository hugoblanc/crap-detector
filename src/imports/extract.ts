/**
 * Extraction et résolution des imports, à partir de l'AST uniquement.
 * Sert deux usages : le graphe de dépendances internes (couplage caché)
 * et la détection de paquets hallucinés (slopsquatting).
 */
import { Node } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { resolveAliasTargets } from './manifest.js';
import type { Manifest } from './manifest.js';

export type ImportKind = 'import' | 'export-from' | 'dynamic' | 'require';

export type SpecifierKind = 'relative' | 'absolute' | 'builtin' | 'subpath' | 'bare';

export interface ImportRef {
  /** Texte du module tel qu'écrit dans le source. */
  specifier: string;
  kind: ImportKind;
  specifierKind: SpecifierKind;
  line: number;
}

const BUILTIN_MODULES = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'sea', 'stream', 'string_decoder', 'sys', 'test', 'timers',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

export function classifySpecifier(specifier: string): SpecifierKind {
  if (specifier.startsWith('.')) return 'relative';
  if (specifier.startsWith('/')) return 'absolute';
  if (specifier.startsWith('node:')) return 'builtin';
  if (specifier.startsWith('#')) return 'subpath';
  const root = specifier.split('/')[0] ?? specifier;
  return BUILTIN_MODULES.has(root) ? 'builtin' : 'bare';
}

/**
 * Nom du paquet porté par un specifier bare.
 * 'lodash/merge' → 'lodash' ; '@scope/pkg/sub' → '@scope/pkg'.
 */
export function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) return segments.slice(0, 2).join('/');
  return segments[0] ?? specifier;
}

/** Tous les modules référencés par le fichier, dans l'ordre du source. */
export function fileImports(sourceFile: SourceFile): ImportRef[] {
  const refs: ImportRef[] = [];
  const push = (specifier: string, kind: ImportKind, line: number): void => {
    refs.push({ specifier, kind, specifierKind: classifySpecifier(specifier), line });
  };

  for (const declaration of sourceFile.getImportDeclarations()) {
    push(declaration.getModuleSpecifierValue(), 'import', declaration.getStartLineNumber());
  }
  for (const declaration of sourceFile.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier !== undefined) {
      push(specifier, 'export-from', declaration.getStartLineNumber());
    }
  }
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expression = node.getExpression();
    const isRequire = Node.isIdentifier(expression) && expression.getText() === 'require';
    const isImportCall = expression.getText() === 'import';
    if (!isRequire && !isImportCall) return;
    const [argument] = node.getArguments();
    if (argument === undefined || !Node.isStringLiteral(argument)) return;
    push(argument.getLiteralValue(), isRequire ? 'require' : 'dynamic', node.getStartLineNumber());
  });

  return refs.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

/** Normalise un chemin POSIX en résolvant '.' et '..' ; rend undefined s'il sort de la racine. */
export function normalizeRelative(fromFile: string, specifier: string): string | undefined {
  const base = fromFile.split('/').slice(0, -1);
  const segments = [...base, ...specifier.split('/')];
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

/**
 * Résout un import relatif vers un fichier du projet.
 * En TypeScript ESM le source écrit './x.js' pour './x.ts' : l'extension de sortie
 * est remappée avant d'essayer les extensions de source et le fichier d'index.
 */
export function resolveRelativeImport(
  fromFile: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  const target = normalizeRelative(fromFile, specifier);
  if (target === undefined) return undefined;
  const candidates: string[] = [target];
  const remapped = target.replace(/\.(m|c)?js$/, '');
  if (remapped !== target) {
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${remapped}${extension}`);
  }
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${target}${extension}`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${target}/index${extension}`);
  return candidates.find((candidate) => knownFiles.has(candidate));
}

/** Essaie les extensions de source et le fichier d'index sur un chemin de base. */
function tryExtensions(base: string, knownFiles: ReadonlySet<string>): string | undefined {
  if (knownFiles.has(base)) return base;
  const remapped = base.replace(/\.(m|c)?js$/, '');
  const bases = remapped === base ? [base] : [remapped, base];
  for (const candidate of bases) {
    for (const extension of SOURCE_EXTENSIONS) {
      if (knownFiles.has(`${candidate}${extension}`)) return `${candidate}${extension}`;
    }
    for (const extension of SOURCE_EXTENSIONS) {
      if (knownFiles.has(`${candidate}/index${extension}`)) return `${candidate}/index${extension}`;
    }
  }
  return undefined;
}

/**
 * Résout un import passant par un alias `paths` du tsconfig.
 * Sans ça, un projet qui écrit '@app/core' au lieu de '../core' aurait
 * un graphe de dépendances vide, donc ni cycle ni couplage explicite détectés.
 */
export function resolveAliasImport(
  specifier: string,
  knownFiles: ReadonlySet<string>,
  manifest: Manifest,
): string | undefined {
  for (const base of resolveAliasTargets(manifest, specifier)) {
    const resolved = tryExtensions(base, knownFiles);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** Résout n'importe quel import vers un fichier du projet, relatif ou aliasé. */
export function resolveImport(
  fromFile: string,
  ref: ImportRef,
  knownFiles: ReadonlySet<string>,
  manifest?: Manifest,
): string | undefined {
  if (ref.specifierKind === 'relative') {
    return resolveRelativeImport(fromFile, ref.specifier, knownFiles);
  }
  if (manifest === undefined) return undefined;
  if (ref.specifierKind !== 'bare' && ref.specifierKind !== 'subpath') return undefined;
  return resolveAliasImport(ref.specifier, knownFiles, manifest);
}

export interface ImportGraph {
  /** Fichier → fichiers du projet qu'il importe. */
  edges: Map<string, Set<string>>;
}

/** Graphe des dépendances internes, arêtes limitées aux fichiers du scope. */
export function buildImportGraph(
  imports: Map<string, ImportRef[]>,
  manifest?: Manifest,
): ImportGraph {
  const knownFiles = new Set(imports.keys());
  const edges = new Map<string, Set<string>>();
  for (const [file, refs] of imports) {
    const targets = new Set<string>();
    for (const ref of refs) {
      const resolved = resolveImport(file, ref, knownFiles, manifest);
      if (resolved !== undefined && resolved !== file) targets.add(resolved);
    }
    edges.set(file, targets);
  }
  return { edges };
}

/** true si l'un des deux fichiers importe l'autre, directement. */
export function areLinked(graph: ImportGraph, fileA: string, fileB: string): boolean {
  return (graph.edges.get(fileA)?.has(fileB) ?? false)
    || (graph.edges.get(fileB)?.has(fileA) ?? false);
}
