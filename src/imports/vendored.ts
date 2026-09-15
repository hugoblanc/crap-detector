/**
 * Sous-projet vendorisé : un dossier qui porte son propre package.json de projet, qu'aucun
 * fichier du dépôt n'importe, et que la racine ne déclare pas comme espace de travail. C'est
 * du code tiers embarqué : le mesurer gonfle les agrégats et la baseline sans qu'aucune
 * décision ne s'ensuive, puisque la seule action possible est de le supprimer en bloc.
 *
 * Le critère croise toujours les trois conditions. Un package.json réduit à `{"type":"module"}`
 * règle le format des modules d'un dossier sans en faire un projet — isProjectPackage l'écarte
 * déjà, et ce dossier n'apparaît donc pas ici. Un dossier importé depuis l'extérieur est du code
 * du projet, quel que soit son manifeste.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceFile } from 'ts-morph';
import { globToRegExp, matchesAnyGlob } from '../core/glob.js';
import { fileImports, packageNameOf, resolveImport } from './extract.js';
import type { ImportRef } from './extract.js';
import { readManifest } from './manifest.js';
import type { Manifest } from './manifest.js';

/** true si `file` est dans `dir` ou l'un de ses sous-dossiers. */
function isUnder(dir: string, file: string): boolean {
  return file.startsWith(`${dir}/`);
}

/**
 * Espaces de travail déclarés par la racine.
 *
 * `unreadable` porte le prix de l'analyseur maison : une déclaration existe, elle n'a pas été
 * comprise, et personne ne doit le découvrir à un `filesScanned` qui a baissé. Dans ce cas la
 * détection se désactive entièrement — écarter un espace de travail déclaré serait pire que
 * mesurer un sous-projet vendorisé de trop.
 */
export interface WorkspaceDeclaration {
  globs: string[];
  /** Ce qui n'a pas pu être lu, cité tel qu'un message d'erreur le nomme. */
  unreadable?: string;
}

function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined;
}

/**
 * Champ `workspaces` du package.json racine : tableau, ou objet `{ packages: [...] }` (Yarn).
 * Un package.json illisible ne vaut pas « aucun espace de travail » : c'est une inconnue.
 */
function packageWorkspaces(rootPath: string): WorkspaceDeclaration {
  const path = join(rootPath, 'package.json');
  if (!existsSync(path)) return { globs: [] };
  const parsed = parseJsonFile(path);
  if (typeof parsed !== 'object' || parsed === null) return { globs: [], unreadable: 'package.json illisible' };
  const declared = (parsed as { workspaces?: unknown }).workspaces;
  if (declared === undefined) return { globs: [] };
  const list = Array.isArray(declared)
    ? asStringList(declared)
    : asStringList((declared as { packages?: unknown }).packages);
  return list === undefined
    ? { globs: [], unreadable: 'champ workspaces du package.json d\'une forme inconnue' }
    : { globs: list };
}

/**
 * Coupe un commentaire de fin de ligne, en respectant les guillemets : dans `- 'apps/*' # le site`,
 * le `#` ouvre un commentaire ; dans `- 'a#b'`, il fait partie du glob.
 */
export function stripYamlComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i);
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '\'' || char === '"') {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(line.charAt(i - 1)))) return line.slice(0, i);
  }
  return line;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed.charAt(0);
  return (first === '\'' || first === '"') && trimmed.length > 1 && trimmed.endsWith(first)
    ? trimmed.slice(1, -1)
    : trimmed;
}

/**
 * Indicateurs YAML qui ouvrent autre chose qu'un glob : scalaire plié ou littéral (`- >-`,
 * `- |`, dont la valeur est sur les lignes suivantes), ancre, tag, directive. Volontairement
 * sans `*` : `**\/pkg` est un glob légitime, et une ancre en valeur de `packages` est déjà
 * refusée par pnpmWorkspaceGlobs, qui n'accepte que la séquence en bloc ou en flux.
 */
const YAML_INDICATOR = /^[>|&!%]/;

/**
 * Un item de `packages` est un glob, donc un scalaire d'une seule ligne. Tout ce qui ressemble
 * à une structure imbriquée ou à un scalaire à continuer est refusé plutôt que pris pour un
 * glob qui ne matcherait jamais : un espace de travail déclaré sortirait du périmètre sans que
 * rien ne le dise.
 */
function isPlainScalar(item: string): boolean {
  return !/[:{}[\]]/.test(item) && !YAML_INDICATOR.test(item);
}

function itemsOrUnreadable(items: string[], form: string): WorkspaceDeclaration {
  const unknown = items.find((item) => !isPlainScalar(item));
  return unknown === undefined
    ? { globs: items }
    : { globs: [], unreadable: `item ${form} de pnpm-workspace.yaml d'une forme inconnue : ${unknown}` };
}

function splitFlowItems(inner: string): WorkspaceDeclaration {
  return itemsOrUnreadable(inner.split(',').map(unquote).filter((glob) => glob !== ''), 'de packages');
}

/** Index du `]` qui ferme la séquence, hors guillemets ; -1 s'il n'y en a pas. */
function flowEnd(text: string): number {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '\'' || char === '"') quote = char;
    else if (char === ']') return i;
  }
  return -1;
}

/** Séquence de flux `[...]`, sur une ligne ou plusieurs : tout est concaténé jusqu'au `]`. */
function flowSequence(first: string, rest: readonly string[]): WorkspaceDeclaration {
  let text = first;
  for (const line of rest) {
    if (flowEnd(text) !== -1) break;
    text += ` ${stripYamlComment(line).trim()}`;
  }
  const end = flowEnd(text);
  return end === -1
    ? { globs: [], unreadable: 'séquence packages non fermée dans pnpm-workspace.yaml' }
    : splitFlowItems(text.slice(1, end));
}

/** Séquence en bloc : des lignes `- <glob>`, jusqu'à la première ligne qui n'en est pas une. */
function blockSequence(lines: readonly string[]): WorkspaceDeclaration {
  const items: string[] = [];
  for (const raw of lines) {
    const line = stripYamlComment(raw);
    if (line.trim() === '') continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item === null) break;
    const glob = unquote(item[1] ?? '');
    if (glob !== '') items.push(glob);
  }
  return itemsOrUnreadable(items, 'de la séquence packages');
}

/**
 * Liste `packages:` d'un pnpm-workspace.yaml. Trois formes lues : séquence en bloc
 * (`- 'apps/*'`), séquence de flux sur une ligne (`['apps/*']`) et sur plusieurs, commentaires
 * de fin de ligne compris. Ajouter un analyseur YAML pour un seul champ coûterait une
 * dépendance de plus à un CLI qui n'en a que trois ; tout ce qu'il ne sait pas lire est
 * signalé, jamais rendu comme une liste vide.
 *
 * Découpage sur `\r?\n` : un fichier en CRLF laissait sinon un `\r` en fin de ligne, que la
 * regex d'item de blockSequence ne matche pas. Le lecteur sortait à la première ligne, rendait
 * une liste vide sans rien signaler, et les espaces de travail déclarés sortaient du périmètre.
 */
export function pnpmWorkspaceGlobs(raw: string): WorkspaceDeclaration {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  const header = lines[start];
  if (start === -1 || header === undefined) return { globs: [] };
  const value = stripYamlComment(header.slice(header.indexOf(':') + 1)).trim();
  const rest = lines.slice(start + 1);
  if (value === '') return blockSequence(rest);
  if (value.startsWith('[')) return flowSequence(value, rest);
  return { globs: [], unreadable: `champ packages de pnpm-workspace.yaml d'une forme inconnue : ${value}` };
}

const PNPM_WORKSPACE_FILES = ['pnpm-workspace.yaml', 'pnpm-workspace.yml'];

/** Globs d'espaces de travail déclarés à la racine, npm/yarn/bun et pnpm confondus. */
function workspaceGlobs(rootPath: string): WorkspaceDeclaration {
  const declarations = [packageWorkspaces(rootPath)];
  for (const name of PNPM_WORKSPACE_FILES) {
    if (!existsSync(join(rootPath, name))) continue;
    try {
      declarations.push(pnpmWorkspaceGlobs(readFileSync(join(rootPath, name), 'utf8')));
    } catch (error) {
      declarations.push({ globs: [], unreadable: `${name} illisible : ${messageOf(error)}` });
    }
  }
  const unreadable = declarations.find((declaration) => declaration.unreadable !== undefined)?.unreadable;
  const globs = declarations.flatMap((declaration) => declaration.globs);
  return unreadable === undefined ? { globs } : { globs, unreadable };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Nom de paquet déclaré par le package.json d'un sous-projet, pour les imports qui le citent. */
function packageNames(rootPath: string, dirs: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const dir of dirs) {
    const parsed = parseJsonFile(join(rootPath, dir, 'package.json'));
    const name = (parsed as { name?: unknown } | undefined)?.name;
    if (typeof name === 'string' && name !== '') names.set(name, dir);
  }
  return names;
}

/** Ce qu'il faut pour rattacher un import à l'un des sous-projets candidats. */
interface Lookup {
  /** Fichiers connus, pour résoudre un import relatif ou aliasé. */
  known: ReadonlySet<string>;
  /** Manifeste de la racine : ses alias tsconfig résolvent les imports non relatifs. */
  manifest: Manifest;
  /** Nom de paquet déclaré → dossier du sous-projet qui le déclare. */
  names: Map<string, string>;
  candidates: readonly string[];
}

/** Sous-projet candidat visé par cet import : par le nom de paquet déclaré, ou par chemin résolu. */
function referencedDir(lookup: Lookup, file: string, ref: ImportRef): string | undefined {
  if (ref.specifierKind === 'bare') {
    const byName = lookup.names.get(packageNameOf(ref.specifier));
    if (byName !== undefined) return byName;
  }
  const target = resolveImport(file, ref, lookup.known, lookup.manifest);
  if (target === undefined) return undefined;
  return lookup.candidates.find((dir) => isUnder(dir, target));
}

/**
 * Sous-projets qu'au moins un fichier extérieur importe. Un import venu de l'intérieur du
 * dossier ne compte pas : sinon un scraper vendorisé se garderait vivant tout seul.
 */
function importedFromOutside(
  rootPath: string,
  candidates: readonly string[],
  sourceFiles: Map<string, SourceFile>,
): Set<string> {
  const lookup: Lookup = {
    known: new Set(sourceFiles.keys()),
    manifest: readManifest(rootPath),
    names: packageNames(rootPath, candidates),
    candidates,
  };
  const found = new Set<string>();
  for (const [file, source] of sourceFiles) {
    for (const ref of fileImports(source)) {
      const dir = referencedDir(lookup, file, ref);
      if (dir !== undefined && !isUnder(dir, file)) found.add(dir);
    }
  }
  return found;
}

export interface VendoredScan {
  /** Sous-projets à écarter du périmètre, triés. */
  dirs: string[];
  /** Renseigné quand la détection s'est désactivée faute de lire les espaces de travail déclarés. */
  unreadableReason?: string;
}

/**
 * Parmi les sous-projets détectés, ceux à écarter du périmètre. Le parcours des imports n'a
 * lieu que s'il reste un candidat : sur un dépôt sans sous-projet, la détection ne coûte rien.
 *
 * `sourceFiles` doit contenir les importeurs, pas seulement les fichiers mesurés : un
 * sous-projet utilisé seulement par des tests n'est pas du code sans usage, même promesse que
 * la règle orphan (scan/orphans.ts).
 */
export function vendoredSubprojects(
  rootPath: string,
  subprojects: readonly string[],
  sourceFiles: Map<string, SourceFile>,
): VendoredScan {
  const declared = workspaceGlobs(rootPath);
  if (declared.unreadable !== undefined) return { dirs: [], unreadableReason: declared.unreadable };
  const workspaces = declared.globs.map(globToRegExp);
  const candidates = subprojects.filter((dir) => dir !== '' && !matchesAnyGlob(workspaces, dir));
  if (candidates.length === 0) return { dirs: [] };
  const imported = importedFromOutside(rootPath, candidates, sourceFiles);
  return { dirs: candidates.filter((dir) => !imported.has(dir)).sort() };
}

/** Fichiers hors des sous-projets vendorisés : le périmètre réellement mesuré. */
export function withoutVendored(files: readonly string[], vendored: readonly string[]): string[] {
  if (vendored.length === 0) return [...files];
  return files.filter((file) => !vendored.some((dir) => isUnder(dir, file)));
}
