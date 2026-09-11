/**
 * Ce que le projet déclare pouvoir importer : dépendances du package.json,
 * subpath imports (`#interne/...`) et alias de chemins du tsconfig.
 *
 * Objectif : ne jamais signaler un import légitime. Le rapport d'état de l'art
 * est explicite là-dessus — une règle trop large inonde les PR de faux positifs
 * et tue la confiance en une semaine. En cas de doute sur la config du projet,
 * la règle se désactive au lieu de deviner.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Manifest {
  /** Dossier du package.json, relatif à la racine ; '' pour la racine. */
  dir: string;
  /** Noms de paquets déclarés, toutes sections de dépendances confondues. */
  dependencies: Set<string>;
  /** Clés du champ `imports` du package.json, ex. '#core/*'. */
  subpathImports: string[];
  /** Clés de compilerOptions.paths du tsconfig, ex. '@app/*'. */
  pathAliases: string[];
  /** Motifs d'alias avec leurs cibles, pour résoudre les arêtes du graphe. */
  pathMappings: PathMapping[];
  /** compilerOptions.baseUrl, relatif à la racine du projet. */
  baseUrl: string;
  /**
   * false quand un fichier de config existe mais n'a pas pu être lu :
   * la détection de dépendances inconnues est alors désactivée.
   */
  trustworthy: boolean;
  untrustworthyReason?: string;
}

export interface PathMapping {
  /** Motif côté specifier, ex. '@app/*'. */
  pattern: string;
  /** Cibles côté disque, relatives au baseUrl, ex. ['./src/*']. */
  targets: string[];
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Retire commentaires et virgules traînantes d'un JSONC (format des tsconfig.json).
 * Les chaînes sont préservées : un `//` dans une valeur ne doit pas couper la ligne.
 */
export function stripJsonComments(raw: string): string {
  let output = '';
  let index = 0;
  let inString = false;
  while (index < raw.length) {
    const char = raw[index] ?? '';
    const next = raw[index + 1] ?? '';
    if (inString) {
      output += char;
      if (char === '\\') {
        output += next;
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < raw.length && raw[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < raw.length && !(raw[index] === '*' && raw[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output.replace(/,(\s*[}\]])/g, '$1');
}

/** Chemin d'un fichier de config tel qu'un message le cite : 'package.json' ou 'app/package.json'. */
export function inDir(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** Remplit dépendances et subpaths ; rend la raison de l'échec, ou undefined. */
function readPackage(rootPath: string, dir: string, manifest: Manifest): string | undefined {
  const label = inDir(dir, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(join(rootPath, dir, 'package.json'), 'utf8');
  } catch {
    return `${label} introuvable`;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error(`${label} ne contient pas un objet`);
    const sections = DEPENDENCY_SECTIONS.map((section) => parsed[section]).filter(isPlainObject);
    manifest.dependencies = new Set(sections.flatMap(Object.keys));
    const subpaths = parsed['imports'];
    if (isPlainObject(subpaths)) manifest.subpathImports = Object.keys(subpaths);
    return undefined;
  } catch (error) {
    return `${label} illisible : ${messageOf(error)}`;
  }
}

/** Remplit alias et baseUrl ; un tsconfig absent n'est pas une erreur. */
function readTsconfig(rootPath: string, dir: string, manifest: Manifest): string | undefined {
  const label = inDir(dir, 'tsconfig.json');
  let raw: string;
  try {
    raw = readFileSync(join(rootPath, dir, 'tsconfig.json'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(raw));
    if (!isPlainObject(parsed)) throw new Error(`${label} ne contient pas un objet`);
    const compilerOptions = parsed['compilerOptions'];
    if (!isPlainObject(compilerOptions)) return undefined;
    const baseUrl = compilerOptions['baseUrl'];
    if (typeof baseUrl === 'string') manifest.baseUrl = baseUrl;
    const paths = compilerOptions['paths'];
    if (!isPlainObject(paths)) return undefined;
    manifest.pathAliases = Object.keys(paths);
    manifest.pathMappings = Object.entries(paths)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([pattern, targets]) => ({
        pattern,
        targets: targets.filter((target): target is string => typeof target === 'string'),
      }));
    return undefined;
  } catch (error) {
    return `${label} illisible : ${messageOf(error)}`;
  }
}

/** Lit package.json et tsconfig.json, à la racine par défaut. */
export function readManifest(rootPath: string, packageDir = '', tsconfigDir = packageDir): Manifest {
  const manifest: Manifest = {
    dir: packageDir,
    dependencies: new Set(),
    subpathImports: [],
    pathAliases: [],
    pathMappings: [],
    baseUrl: '',
    trustworthy: true,
  };
  const failure = readPackage(rootPath, packageDir, manifest) ?? readTsconfig(rootPath, tsconfigDir, manifest);
  if (failure !== undefined) {
    manifest.trustworthy = false;
    manifest.untrustworthyReason = failure;
  }
  return manifest;
}

/** Dossier du fichier `name` le plus proche au-dessus de `file`, sans sortir de la racine. */
function nearestDir(rootPath: string, file: string, name: string): string | undefined {
  const segments = file.split('/').slice(0, -1);
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const dir = segments.slice(0, depth).join('/');
    if (existsSync(join(rootPath, dir, name))) return dir;
  }
  return undefined;
}

/**
 * Manifeste qui gouverne chaque fichier : package.json le plus proche pour les dépendances,
 * tsconfig.json le plus proche pour les alias. Un sous-projet est jugé contre ses propres
 * déclarations, pas contre celles de la racine.
 */
export function manifestResolver(rootPath: string): (file: string) => Manifest {
  const cache = new Map<string, Manifest>();
  return (file) => {
    const packageDir = nearestDir(rootPath, file, 'package.json') ?? '';
    const tsconfigDir = nearestDir(rootPath, file, 'tsconfig.json') ?? packageDir;
    const key = `${packageDir}\n${tsconfigDir}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const manifest = readManifest(rootPath, packageDir, tsconfigDir);
    cache.set(key, manifest);
    return manifest;
  };
}

/** Sous-dossiers qui portent le package.json d'au moins un fichier : autant de projets à scanner à part. */
export function subprojectDirs(rootPath: string, files: readonly string[]): string[] {
  const dirs = new Set(files.map((file) => nearestDir(rootPath, file, 'package.json') ?? ''));
  dirs.delete('');
  return [...dirs].sort();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Applique un motif d'alias tsconfig (`@app/*` ou `@app`) à un specifier. */
export function matchesAliasPattern(pattern: string, specifier: string): boolean {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.length >= prefix.length + suffix.length
    && specifier.startsWith(prefix)
    && specifier.endsWith(suffix);
}

/** true si le projet déclare pouvoir résoudre ce specifier non relatif. */
export function isDeclared(manifest: Manifest, specifier: string, packageName: string): boolean {
  if (manifest.dependencies.has(packageName)) return true;
  if (manifest.pathAliases.some((pattern) => matchesAliasPattern(pattern, specifier))) return true;
  return manifest.subpathImports.some((pattern) => matchesAliasPattern(pattern, specifier));
}

/** Paquet de types DefinitelyTyped d'un paquet : 'express' → '@types/express', '@scope/pkg' → '@types/scope__pkg'. */
export function typesPackageOf(packageName: string): string {
  return `@types/${packageName.startsWith('@') ? packageName.slice(1).replace('/', '__') : packageName}`;
}

/**
 * Chemins candidats d'un specifier passant par un alias tsconfig.
 * '@app/core' avec { '@app/*': ['./src/*'] } et baseUrl '.' → 'src/core'.
 */
export function resolveAliasTargets(manifest: Manifest, specifier: string): string[] {
  const candidates: string[] = [];
  for (const mapping of manifest.pathMappings) {
    if (!matchesAliasPattern(mapping.pattern, specifier)) continue;
    const star = mapping.pattern.indexOf('*');
    const captured = star === -1
      ? ''
      : specifier.slice(star, specifier.length - (mapping.pattern.length - star - 1));
    for (const target of mapping.targets) {
      candidates.push(joinPosix(manifest.baseUrl, target.replace('*', captured)));
    }
  }
  return candidates;
}

/** Concaténation POSIX qui normalise './' et les segments vides. */
function joinPosix(base: string, path: string): string {
  const segments = [...base.split('/'), ...path.split('/')];
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}
