/**
 * Résolution réelle d'un specifier non relatif, avant de crier au paquet inventé.
 *
 * Découper le specifier et prendre le premier segment pour un nom de paquet suffit à
 * lire un import, pas à juger qu'il ne mène nulle part : `@theme/Layout` est un alias
 * que le thème Docusaurus résout, `@docusaurus/Link` un module déclaré en ambiant par
 * `@docusaurus/module-type-aliases`. Ni l'un ni l'autre n'est un paquet npm, et la
 * règle unknown-dependency est critique : elle doit se taire au moindre doute.
 *
 * Deux voies, l'une après l'autre :
 * - la résolution de modules TypeScript, qui applique `paths`, `exports` et les @types ;
 * - les déclarations `declare module '…'` des paquets installés, que la résolution de
 *   modules ne voit pas : elles ne vivent que dans le programme du compilateur.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ts } from 'ts-morph';
import { matchesAliasPattern } from './manifest.js';
import type { Manifest } from './manifest.js';

/**
 * Paquets visités au plus par manifeste. Un dépôt réel en installe des milliers ; le
 * balayage n'existe que pour éviter un faux positif, il ne doit pas coûter un scan complet.
 */
const MAX_PACKAGES = 600;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sans tsconfig, TypeScript retomberait sur la résolution « classic », qui ignore
 * node_modules : `bundler` est ce que font les projets modernes, et ce qui résout
 * le champ `exports`.
 */
function resolutionOptions(manifest: Manifest): ts.CompilerOptions {
  const options = manifest.compilerOptions ?? {};
  if (options.moduleResolution !== undefined || options.module !== undefined) return options;
  return { ...options, moduleResolution: ts.ModuleResolutionKind.Bundler };
}

/** true si TypeScript résout le specifier vers un fichier réel depuis ce fichier. */
export function resolvesAsModule(rootPath: string, manifest: Manifest, file: string, specifier: string): boolean {
  try {
    const resolved = ts.resolveModuleName(specifier, join(rootPath, file), resolutionOptions(manifest), ts.sys);
    return resolved.resolvedModule !== undefined;
  } catch {
    return false;
  }
}

/** Dossier d'un paquet installé, cherché comme Node : node_modules de chaque dossier parent. */
function packageDir(fromDir: string, packageName: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', packageName);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Chemin de types déclaré par `exports['.']`, quelle que soit la profondeur des conditions. */
function typesFromExports(value: unknown): string | undefined {
  if (typeof value === 'string') return undefined;
  if (!isPlainObject(value)) return undefined;
  const types = value['types'];
  if (typeof types === 'string') return types;
  for (const nested of Object.values(value)) {
    const found = typesFromExports(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Fichier de déclarations d'un paquet : `types`, `typings`, `exports`, ou l'index à côté du `main`. */
function typesEntry(dir: string, parsed: Record<string, unknown>): string | undefined {
  const candidates: string[] = [];
  for (const field of ['types', 'typings']) {
    const value = parsed[field];
    if (typeof value === 'string') candidates.push(value);
  }
  const exported = typesFromExports(parsed['exports']);
  if (exported !== undefined) candidates.push(exported);
  const main = parsed['main'];
  if (typeof main === 'string') candidates.push(main.replace(/\.[cm]?js$/, '.d.ts'));
  candidates.push('index.d.ts');
  return candidates.map((candidate) => join(dir, candidate)).find((path) => path.endsWith('.d.ts') && existsSync(path));
}

const DECLARE_MODULE = /declare\s+module\s+['"]([^'"]+)['"]/g;

function declaredModulesIn(path: string): string[] {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return [...content.matchAll(DECLARE_MODULE)].map((match) => match[1] ?? '');
}

/**
 * Motifs `declare module '…'` publiés par les paquets installés, dépendances transitives
 * comprises : `@theme/Heading` est déclaré par `@docusaurus/theme-classic`, que le site
 * ne déclare pas lui-même mais que son preset installe.
 */
export function ambientModulePatterns(rootPath: string, manifest: Manifest): string[] {
  const fromDir = join(rootPath, manifest.dir);
  const patterns: string[] = [];
  const seen = new Set<string>();
  const queue = [...manifest.dependencies];
  while (queue.length > 0 && seen.size < MAX_PACKAGES) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const dir = packageDir(fromDir, name);
    if (dir === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const entry = typesEntry(dir, parsed);
    if (entry !== undefined) patterns.push(...declaredModulesIn(entry));
    const dependencies = parsed['dependencies'];
    if (isPlainObject(dependencies)) queue.push(...Object.keys(dependencies));
  }
  return patterns;
}

/** Résolution complète : `false` seulement quand rien, nulle part, ne couvre ce specifier. */
export function specifierResolver(rootPath: string): (manifest: Manifest, file: string, specifier: string) => boolean {
  const ambient = new Map<string, string[]>();
  return (manifest, file, specifier) => {
    if (resolvesAsModule(rootPath, manifest, file, specifier)) return true;
    const patterns = ambient.get(manifest.dir) ?? ambientModulePatterns(rootPath, manifest);
    ambient.set(manifest.dir, patterns);
    return patterns.some((pattern) => matchesAliasPattern(pattern, specifier));
  };
}
