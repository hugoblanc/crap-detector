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

/**
 * Motifs qui ne prouvent rien. `declare module '*'` couvre n'importe quel specifier :
 * un seul paquet installé qui le publie, fût-ce une dépendance transitive que
 * l'utilisateur n'a pas choisie, éteindrait la seule règle critique du produit pour
 * tout le manifeste. Un motif doit porter un préfixe ou un suffixe qui le restreint.
 *
 * Limite connue de cette garde : un seul caractère lui suffit, donc `declare module '@*'`
 * blanchit tous les paquets scopés. Aucune occurrence réelle sur les dépôts mesurés, et
 * exiger davantage écarterait des motifs légitimes comme `*.svg`.
 */
function isRestrictive(pattern: string): boolean {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern !== '';
  return pattern.slice(0, star) !== '' || pattern.slice(star + 1) !== '';
}

/**
 * Occurrences qui ressemblent à une déclaration de module ambiant. `declare` est optionnel
 * dans un fichier de déclarations, où `module 'x' { … }` est valide : la forme courte est
 * reconnue comme candidate, pour ne pas rater la déclaration, mais jamais crue sur parole,
 * elle part à l'arbitrage de l'AST. Cas d'école, aucune occurrence sur les dépôts mesurés.
 */
const DECLARE_MODULE = /(?:declare\s+)?module\s+['"]([^'"]+)['"]/g;

function occurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

/**
 * true si au moins un candidat n'est pas sûrement du code : forme courte sans `declare`, ou
 * occurrence prise dans un commentaire de ligne ou de bloc. Un seul parcours pour tous les
 * candidats, qui arrivent dans l'ordre : un fichier de déclarations en porte jusqu'à
 * plusieurs milliers, et les compter chacun depuis le début du fichier serait quadratique.
 *
 * Sur-approximé sans risque : un `//` ou un `/*` dans une chaîne de caractères fait conclure
 * au commentaire, ce qui ne coûte qu'un passage par l'AST, lui exact.
 */
function needsArbitration(content: string, candidates: RegExpExecArray[]): boolean {
  let cursor = 0;
  let depth = 0;
  for (const candidate of candidates) {
    const index = candidate.index;
    const segment = content.slice(cursor, index);
    depth += occurrences(segment, '/*') - occurrences(segment, '*/');
    cursor = index;
    if (depth > 0 || !candidate[0].startsWith('declare')) return true;
    const slashes = content.indexOf('//', content.lastIndexOf('\n', index) + 1);
    if (slashes !== -1 && slashes < index) return true;
  }
  return false;
}

/** Déclarations de modules ambiants du fichier, lues sur l'AST : la seule lecture exacte. */
function parsedModulesIn(path: string, content: string): string[] {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name)) {
      names.push(statement.name.text);
    }
  }
  return names;
}

/**
 * Lecture en deux temps. L'expression régulière ne sert qu'à trouver les candidats : sans
 * candidat, le fichier n'est pas parsé, et c'est le cas de la grande majorité des fichiers
 * de déclarations d'un dépôt réel. L'AST, quatre fois plus cher, n'arbitre que les fichiers
 * où un candidat pourrait ne pas être du code : `declare module '*'` dans un bloc `@example`
 * existe pour de vrai, deux fois dans les dépendances des dépôts mesurés.
 */
function declaredModulesIn(path: string): string[] {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const candidates = [...content.matchAll(DECLARE_MODULE)];
  if (candidates.length === 0) return [];
  return needsArbitration(content, candidates)
    ? parsedModulesIn(path, content)
    : candidates.map((candidate) => candidate[1] ?? '');
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
    if (entry !== undefined) patterns.push(...declaredModulesIn(entry).filter(isRestrictive));
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
