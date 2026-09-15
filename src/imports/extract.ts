/**
 * Extraction et résolution des imports, à partir de l'AST uniquement.
 * Sert deux usages : le graphe de dépendances internes (couplage caché)
 * et la détection de paquets hallucinés (slopsquatting).
 */
import { Node, ts } from 'ts-morph';
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

/**
 * Options du projet qui décident qu'un import survit à l'émission : `import { X }` non marqué
 * `type` avec `verbatimModuleSyntax`, type d'un paramètre de constructeur décoré avec
 * `emitDecoratorMetadata` (`design:paramtypes`, cas d'une injection NestJS).
 */
export interface EmitOptions {
  verbatimModuleSyntax: boolean;
  emitDecoratorMetadata: boolean;
}

const NO_EMIT_OPTIONS: EmitOptions = { verbatimModuleSyntax: false, emitDecoratorMetadata: false };

/**
 * Sortie JavaScript du fichier, types effacés : un import utilisé seulement en position de type
 * disparaît. Transpilation d'un fichier seul, sous les options d'émission du projet.
 */
function emitWithoutTypes(sourceFile: SourceFile, emit: EmitOptions): string {
  return ts.transpileModule(sourceFile.getFullText(), {
    fileName: sourceFile.getBaseName(),
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      jsx: ts.JsxEmit.Preserve,
      experimentalDecorators: true,
      verbatimModuleSyntax: emit.verbatimModuleSyntax,
      emitDecoratorMetadata: emit.emitDecoratorMetadata,
    },
  }).outputText;
}

/** Modules encore importés une fois les types effacés : leur paquet est chargé à l'exécution. */
export function runtimeImports(sourceFile: SourceFile, emit: EmitOptions = NO_EMIT_OPTIONS): Set<string> {
  const outputText = emitWithoutTypes(sourceFile, emit);
  return new Set(ts.preProcessFile(outputText, true, true).importedFiles.map((ref) => ref.fileName));
}

/**
 * Modules importés ou réexportés en tête de module une fois les types effacés. Un `import()`
 * dynamique n'y figure pas, même vers un module aussi importé pour ses types.
 */
export function staticRuntimeImports(sourceFile: SourceFile, emit: EmitOptions = NO_EMIT_OPTIONS): Set<string> {
  const output = ts.createSourceFile(
    sourceFile.getBaseName(),
    emitWithoutTypes(sourceFile, emit),
    ts.ScriptTarget.ESNext,
    false,
    sourceFile.getExtension() === '.tsx' ? ts.ScriptKind.JSX : ts.ScriptKind.JS,
  );
  const kept = new Set<string>();
  for (const statement of output.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier !== undefined && ts.isStringLiteral(specifier)) kept.add(specifier.text);
  }
  return kept;
}

function hasModifier(statement: ts.Statement, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(statement)
    && (ts.getModifiers(statement)?.some((modifier) => modifier.kind === kind) ?? false);
}

function declaresType(statement: ts.Statement): boolean {
  return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
}

/** true si le réexport laisse quelque chose à l'exécution : `export type` et `export { type X }` non. */
function reexportsValue(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return false;
  const clause = statement.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

/**
 * true si le statement laisse une valeur à l'exécution : variable, classe, fonction, enum non
 * `const`, namespace, réexport. Un `declare` ambiant ne produit rien.
 */
function emitsValue(statement: ts.Statement): boolean {
  if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return false;
  if (declaresType(statement) || ts.isImportDeclaration(statement) || ts.isEmptyStatement(statement)) return false;
  if (ts.isExportDeclaration(statement)) return reexportsValue(statement);
  if (ts.isEnumDeclaration(statement)) return !hasModifier(statement, ts.SyntaxKind.ConstKeyword);
  return true;
}

/**
 * Module de types : il déclare au moins un type et n'exporte aucune valeur à l'exécution.
 * Ses importeurs partagent un contrat, pas du code, et changent ensemble pour cette raison.
 * Un schéma zod ou une table de constantes exporte bien une valeur : c'est du couplage réel.
 */
export function isTypesModule(sourceFile: SourceFile): boolean {
  const root = sourceFile.compilerNode;
  if (!root.statements.some(declaresType)) return false;
  return root.isDeclarationFile || !root.statements.some(emitsValue);
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
  /** Modules de types, au sens de isTypesModule ; absent quand les sources n'ont pas été lues. */
  typesModules?: ReadonlySet<string>;
}

/**
 * Graphe des dépendances internes, arêtes limitées aux fichiers du scope. `keep` écarte des
 * imports ; ils sont résolus contre tout le scope, pour que le même specifier vise le même fichier.
 */
export function buildImportGraph(
  imports: Map<string, ImportRef[]>,
  manifest?: Manifest,
  keep: (file: string, ref: ImportRef) => boolean = () => true,
): ImportGraph {
  const knownFiles = new Set(imports.keys());
  const edges = new Map<string, Set<string>>();
  for (const [file, refs] of imports) {
    const targets = new Set<string>();
    for (const ref of refs.filter((candidate) => keep(file, candidate))) {
      const resolved = resolveImport(file, ref, knownFiles, manifest);
      if (resolved !== undefined && resolved !== file) targets.add(resolved);
    }
    edges.set(file, targets);
  }
  return { edges };
}

/** true si `from` atteint `to` en un ou deux imports : directement, par un barrel ou un intermédiaire. */
function reachesInTwo(graph: ImportGraph, from: string, to: string): boolean {
  const targets = graph.edges.get(from) ?? new Set<string>();
  return targets.has(to) || [...targets].some((middle) => graph.edges.get(middle)?.has(to) === true);
}

/**
 * true si un lien d'imports explique que les deux fichiers changent ensemble : un chemin d'au
 * plus deux imports, dans un sens ou dans l'autre, ou un module de types importé par les deux.
 */
export function areLinked(graph: ImportGraph, fileA: string, fileB: string): boolean {
  if (reachesInTwo(graph, fileA, fileB) || reachesInTwo(graph, fileB, fileA)) return true;
  const targetsB = graph.edges.get(fileB) ?? new Set<string>();
  return [...(graph.edges.get(fileA) ?? [])]
    .some((target) => targetsB.has(target) && graph.typesModules?.has(target) === true);
}
