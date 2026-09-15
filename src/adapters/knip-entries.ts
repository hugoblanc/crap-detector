/**
 * Points d'entrée qu'un analyseur d'imports ne peut pas deviner, déclarés à knip.
 *
 * knip ne se trompe pas d'analyse : il ne connaît pas l'entrée. Un fichier lancé par un
 * script npm, une seconde configuration de tests, un dossier `scripts/` : rien ne les
 * importe, donc tout ce qu'ils touchent passe pour mort. Sur cinq dépôts réels, 19 des
 * 24 faux positifs d'un échantillon de 497 alertes vérifiées à la main venaient de là.
 *
 * Ce qui est déclaré ici est ce que le dépôt affirme lui-même : la cible d'un de ses
 * scripts, une config de test que ses scripts citent, son dossier de scripts. Rien n'est
 * deviné. Un dépôt qui a sa propre configuration knip n'est pas touché : elle fait foi.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Fichiers de configuration que knip 6 cherche, dans son ordre, à la racine seulement (constants.js). */
const CONFIG_FILES = [
  'knip.json',
  'knip.jsonc',
  '.knip.json',
  '.knip.jsonc',
  'knip.ts',
  'knip.js',
  'knip.config.ts',
  'knip.config.js',
];

/** Extensions que knip considère par défaut comme des sources. */
const SOURCE_EXTENSIONS = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts'];

const EXTENSIONS_GLOB = `{${SOURCE_EXTENSIONS.join(',')}}`;

/** Entrées par défaut de knip, à reconduire : déclarer `entry` remplace sa liste. */
const DEFAULT_ENTRIES = [
  `{index,cli,main}.${EXTENSIONS_GLOB}`,
  `src/{index,cli,main}.${EXTENSIONS_GLOB}`,
];

/**
 * Dossiers d'exécutables maison : lintés et formatés comme le reste du dépôt, jamais importés.
 * Volontairement limité à ce que la convention rend non ambigu ; un `tools/` peut contenir
 * du code de bibliothèque, qu'on ne veut pas soustraire à la détection de code mort.
 */
const SCRIPT_DIRS = ['scripts', 'bin'];

/** Un chemin sous ces dossiers n'est pas du code du dépôt. */
const OUTSIDE = ['node_modules/', 'dist/', 'build/', 'out/', 'coverage/'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Configuration knip que le dépôt fournit lui-même : fichier dédié, ou clé `knip` du package.json. */
export function findKnipConfig(rootPath: string): string | undefined {
  const file = CONFIG_FILES.find((name) => existsSync(join(rootPath, name)));
  if (file !== undefined) return file;
  const manifest = readJson(join(rootPath, 'package.json'));
  if (!isPlainObject(manifest)) return undefined;
  return manifest['knip'] === undefined ? undefined : 'package.json#knip';
}

/** Scripts npm de la racine, valeurs brutes. */
function packageScripts(rootPath: string): string[] {
  const manifest = readJson(join(rootPath, 'package.json'));
  if (!isPlainObject(manifest)) return [];
  const scripts = manifest['scripts'];
  if (!isPlainObject(scripts)) return [];
  return Object.values(scripts).filter((value): value is string => typeof value === 'string');
}

/** Découpe une ligne de commande en arguments plausibles, quotes et séparateurs shell retirés. */
function tokensOf(command: string): string[] {
  return command
    .split(/[\s;|&=]+/)
    .map((token) => token.replace(/^['"]|['"]$/g, '').replace(/^\.\//, ''))
    .filter((token) => token !== '');
}

function isInsideProject(path: string): boolean {
  return !path.startsWith('.') && !OUTSIDE.some((prefix) => path.startsWith(prefix));
}

/** Fichiers source nommés par un script npm : la cible d'un `dev`, un script lancé par `tsx`. */
function scriptTargets(rootPath: string, scripts: string[]): string[] {
  const pattern = new RegExp(`\\.(${SOURCE_EXTENSIONS.join('|')})$`);
  const targets = new Set<string>();
  for (const script of scripts) {
    for (const token of tokensOf(script)) {
      if (!pattern.test(token) || !isInsideProject(token)) continue;
      if (existsSync(join(rootPath, token))) targets.add(token);
    }
  }
  return [...targets];
}

/**
 * Commandes qu'un script npm lance sans les écrire : `nodemon` prend la sienne dans
 * `nodemon.json`. C'est le même point d'entrée que la cible d'un script `dev`, une
 * indirection plus loin ; sur un dépôt mesuré, il rendait 36 fichiers joignables.
 */
function indirectCommands(rootPath: string, scripts: string[]): string[] {
  if (!scripts.some((script) => tokensOf(script).includes('nodemon'))) return [];
  const manifest = readJson(join(rootPath, 'package.json'));
  const sources = [
    readJson(join(rootPath, 'nodemon.json')),
    isPlainObject(manifest) ? manifest['nodemonConfig'] : undefined,
  ];
  const commands: string[] = [];
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const field of ['exec', 'script']) {
      const value = source[field];
      if (typeof value === 'string') commands.push(value);
    }
  }
  return commands;
}

/**
 * Dossiers de scripts, à la racine et sous n'importe quel dossier du périmètre : un dépôt
 * qui range ses scripts de maintenance dans `server/scripts/` ou `evals/scripts/` a la même
 * convention et le même problème. Le premier segment `scripts` ou `bin` d'un chemin suffit,
 * ce qui replie du même coup les sous-dossiers d'un dossier déjà retenu.
 */
function scriptDirPatterns(rootPath: string, files: readonly string[]): string[] {
  const dirs = new Set(SCRIPT_DIRS.filter((dir) => existsSync(join(rootPath, dir))));
  for (const file of files) {
    const segments = file.split('/').slice(0, -1);
    const depth = segments.findIndex((segment) => SCRIPT_DIRS.includes(segment));
    if (depth !== -1) dirs.add(segments.slice(0, depth + 1).join('/'));
  }
  return [...dirs].map((dir) => `${dir}/**/*.${EXTENSIONS_GLOB}`);
}

/** Chemin de config cité par un script, relatif à la racine, qui existe et se lit en JSON. */
function testConfigPaths(rootPath: string, scripts: string[]): string[] {
  const paths = new Set<string>();
  for (const script of scripts) {
    for (const token of tokensOf(script)) {
      if (!token.endsWith('.json') || !isInsideProject(token)) continue;
      if (existsSync(join(rootPath, token))) paths.add(token);
    }
  }
  return [...paths];
}

/** `<rootDir>` de jest, rendu relatif à la racine du dépôt. */
function configRootDir(configPath: string, config: Record<string, unknown>): string {
  const dir = posix.dirname(configPath);
  const declared = config['rootDir'];
  if (typeof declared !== 'string') return dir === '.' ? '' : dir;
  return posix.normalize(posix.join(dir, declared)).replace(/^\.\/?/, '');
}

function inRoot(rootDir: string, path: string): string {
  return rootDir === '' ? path : `${rootDir}/${path}`;
}

/**
 * Fichiers de test d'une seconde configuration jest : `testMatch` donne des motifs,
 * `testRegex` une expression appliquée aux chemins, que seuls les fichiers du périmètre
 * peuvent trancher. Les deux sont rendus en chemins ou motifs relatifs à la racine.
 */
function jestEntries(config: Record<string, unknown>, rootDir: string, files: readonly string[]): string[] {
  const entries: string[] = [];
  const match = config['testMatch'];
  for (const pattern of Array.isArray(match) ? match : []) {
    if (typeof pattern !== 'string') continue;
    entries.push(pattern.replace('<rootDir>/', inRoot(rootDir, '')).replace('<rootDir>', rootDir));
  }
  const regexes = config['testRegex'];
  const list = (Array.isArray(regexes) ? regexes : [regexes]).filter((value): value is string => typeof value === 'string');
  for (const source of list) {
    let regex: RegExp;
    try {
      regex = new RegExp(source);
    } catch {
      continue;
    }
    const prefix = rootDir === '' ? '' : `${rootDir}/`;
    entries.push(...files.filter((file) => file.startsWith(prefix) && regex.test(file)));
  }
  return entries;
}

/** Fichiers que jest charge avant les tests : ils n'ont pas d'importeur non plus. */
function jestSetupEntries(config: Record<string, unknown>, rootDir: string): string[] {
  const entries: string[] = [];
  for (const key of ['setupFiles', 'setupFilesAfterEnv', 'globalSetup', 'globalTeardown']) {
    const value = config[key];
    for (const path of Array.isArray(value) ? value : [value]) {
      if (typeof path !== 'string' || !path.startsWith('<rootDir>')) continue;
      entries.push(path.replace('<rootDir>/', inRoot(rootDir, '')).replace('<rootDir>', rootDir));
    }
  }
  return entries;
}

/** Points d'entrée tirés des configurations de test que les scripts citent, hors celle du package.json. */
function testConfigEntries(rootPath: string, scripts: string[], files: readonly string[]): string[] {
  const entries: string[] = [];
  for (const path of testConfigPaths(rootPath, scripts)) {
    const config = readJson(join(rootPath, path));
    if (!isPlainObject(config)) continue;
    if (config['testMatch'] === undefined && config['testRegex'] === undefined) continue;
    const rootDir = configRootDir(path, config);
    entries.push(...jestEntries(config, rootDir, files), ...jestSetupEntries(config, rootDir));
  }
  return entries;
}

export interface DeclaredEntries {
  /** Motifs passés à knip, entrées par défaut comprises ; vide si le dépôt configure knip lui-même. */
  patterns: string[];
  /** Nombre de motifs ajoutés par crap-detector, hors entrées par défaut de knip. */
  added: number;
  /** Configuration knip du dépôt, qui fait foi et suspend toute déclaration. */
  configFile?: string;
}

/**
 * Ce que crap-detector déclare à knip pour ce dépôt. `files` sert à trancher les
 * `testRegex`, qui ne se traduisent pas en motifs de fichiers.
 */
export function declaredEntries(rootPath: string, files: readonly string[]): DeclaredEntries {
  const configFile = findKnipConfig(rootPath);
  if (configFile !== undefined) return { patterns: [], added: 0, configFile };
  const scripts = packageScripts(rootPath);
  const commands = [...scripts, ...indirectCommands(rootPath, scripts)];
  const added = [
    ...scriptTargets(rootPath, commands),
    ...scriptDirPatterns(rootPath, files),
    ...testConfigEntries(rootPath, scripts, files),
  ];
  const unique = [...new Set(added)].sort();
  return { patterns: [...DEFAULT_ENTRIES, ...unique], added: unique.length };
}

/** Champs par lesquels un paquet s'importe ; aucun, et il ne s'invoque qu'en binaire. */
const IMPORTABLE_FIELDS = ['main', 'module', 'exports', 'types', 'typings', 'browser'];

/**
 * Paquet qui n'expose qu'un binaire : aucun analyseur d'imports ne peut le voir, il est
 * lancé à la main, par la CI ou par un workflow. Le déclarer inutilisé est toujours faux.
 */
export function isBinaryOnlyPackage(rootPath: string, fromDir: string, packageName: string): boolean {
  const segments = fromDir === '.' || fromDir === '' ? [] : fromDir.split('/');
  // Le paquet peut être remonté à la racine par le gestionnaire : on le cherche comme Node.
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const dir = join(rootPath, ...segments.slice(0, depth));
    const parsed = readJson(join(dir, 'node_modules', packageName, 'package.json'));
    if (!isPlainObject(parsed)) continue;
    return parsed['bin'] !== undefined && IMPORTABLE_FIELDS.every((field) => parsed[field] === undefined);
  }
  return false;
}
