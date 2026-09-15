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
import { join, posix, relative } from 'node:path';
import { ts } from 'ts-morph';

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
  /** compilerOptions.verbatimModuleSyntax : un import non marqué `type` survit à l'émission. */
  verbatimModuleSyntax: boolean;
  /** compilerOptions.emitDecoratorMetadata : un type de paramètre décoré survit à l'émission. */
  emitDecoratorMetadata: boolean;
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

/**
 * Hôte de lecture des tsconfig. `readDirectory` rend une liste vide : seules les options
 * comptent ici, pas les fichiers du projet, et les énumérer coûterait un parcours du dépôt.
 */
const PARSE_CONFIG_HOST: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: () => [],
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
};

/**
 * Options effectives du tsconfig, chaîne `extends` suivie : une option héritée d'un
 * `tsconfig.base.json` gouverne l'émission autant que si elle était écrite en clair.
 * Les diagnostics de contenu sont ignorés — un dépôt analysé n'est pas forcément sain,
 * et une option inconnue ne doit pas faire taire la résolution des alias.
 */
function effectiveCompilerOptions(configPath: string, dir: string): ts.CompilerOptions {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, ' '));
  }
  return ts.parseJsonConfigFileContent(read.config, PARSE_CONFIG_HOST, dir, undefined, configPath).options;
}

/**
 * Dossier contre lequel les cibles de `paths` se résolvent, rendu relatif à la racine :
 * `baseUrl` s'il est déclaré, sinon le dossier du tsconfig qui déclare `paths`.
 */
function pathsBase(rootPath: string, configDir: string, options: ts.CompilerOptions): string {
  // pathsBasePath : dossier du tsconfig qui déclare `paths`, renseigné par TypeScript faute de baseUrl.
  const declared = options.baseUrl ?? options.pathsBasePath;
  const base = typeof declared === 'string' ? declared : configDir;
  return relative(rootPath, base).split(/[\\/]/).join('/');
}

/** Remplit options d'émission, alias et baseUrl ; un tsconfig absent n'est pas une erreur. */
function readTsconfig(rootPath: string, dir: string, manifest: Manifest): string | undefined {
  const label = inDir(dir, 'tsconfig.json');
  const configDir = join(rootPath, dir);
  const configPath = join(configDir, 'tsconfig.json');
  if (!existsSync(configPath)) return undefined;
  try {
    const options = effectiveCompilerOptions(configPath, configDir);
    manifest.verbatimModuleSyntax = options.verbatimModuleSyntax === true;
    manifest.emitDecoratorMetadata = options.emitDecoratorMetadata === true;
    const paths = options.paths;
    if (paths === undefined) return undefined;
    manifest.baseUrl = pathsBase(rootPath, configDir, options);
    manifest.pathAliases = Object.keys(paths);
    // TypeScript rend `paths` tel qu'écrit : une cible qui n'est pas un tableau de chaînes est ignorée.
    manifest.pathMappings = Object.entries(paths)
      .filter(([, targets]) => Array.isArray(targets))
      .map(([pattern, targets]) => ({
        pattern,
        targets: targets.filter((target) => typeof target === 'string'),
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
    verbatimModuleSyntax: false,
    emitDecoratorMetadata: false,
    trustworthy: true,
  };
  const failure = readPackage(rootPath, packageDir, manifest) ?? readTsconfig(rootPath, tsconfigDir, manifest);
  if (failure !== undefined) {
    manifest.trustworthy = false;
    manifest.untrustworthyReason = failure;
  }
  return manifest;
}

/**
 * Un package.json sans `name` ni section de dépendances, comme `{"type":"module"}`, règle
 * seulement le format des modules d'un dossier : ce n'est pas un projet.
 */
function isProjectPackage(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainObject(parsed)) return true;
    return parsed['name'] !== undefined || DEPENDENCY_SECTIONS.some((section) => parsed[section] !== undefined);
  } catch {
    // Illisible : il compte quand même, et son manifeste non fiable fait taire la règle.
    return true;
  }
}

/** Dossier le plus proche au-dessus de `file` dont le fichier `name` est retenu, sans sortir de la racine. */
function nearestDir(rootPath: string, file: string, name: string, retains: (path: string) => boolean): string | undefined {
  const segments = file.split('/').slice(0, -1);
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const dir = segments.slice(0, depth).join('/');
    if (retains(join(rootPath, dir, name))) return dir;
  }
  return undefined;
}

/**
 * Manifeste qui gouverne chaque fichier : package.json de projet le plus proche pour les
 * dépendances, tsconfig.json le plus proche pour les alias. Un sous-projet est jugé contre ses
 * propres déclarations, pas contre celles de la racine.
 */
export function manifestResolver(rootPath: string): (file: string) => Manifest {
  const byDirs = new Map<string, Manifest>();
  const byDirectory = new Map<string, Manifest>();
  return (file) => {
    const directory = posix.dirname(file);
    const known = byDirectory.get(directory);
    if (known !== undefined) return known;
    const packageDir = nearestDir(rootPath, file, 'package.json', isProjectPackage) ?? '';
    const tsconfigDir = nearestDir(rootPath, file, 'tsconfig.json', existsSync) ?? packageDir;
    const key = `${packageDir}\n${tsconfigDir}`;
    const manifest = byDirs.get(key) ?? readManifest(rootPath, packageDir, tsconfigDir);
    byDirs.set(key, manifest);
    byDirectory.set(directory, manifest);
    return manifest;
  };
}

/** Sous-dossiers qui portent le package.json d'au moins un fichier : autant de projets à scanner à part. */
export function subprojectDirs(rootPath: string, files: readonly string[]): string[] {
  const manifestFor = manifestResolver(rootPath);
  const dirs = new Set(files.map((file) => manifestFor(file).dir));
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
