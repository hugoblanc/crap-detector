/**
 * Espaces de travail qu'un dépôt déclare : champ `workspaces` du package.json (npm, yarn, bun)
 * et champ `packages` du pnpm-workspace.yaml.
 *
 * Le lecteur YAML est maison, limité à ce seul champ : un analyseur complet coûterait une
 * dépendance de plus à un CLI qui n'en a que trois. Le prix de ce choix est `unreadable`, qui
 * sépare « aucun espace de travail déclaré » de « je n'ai pas su lire » — deux réponses qui
 * n'appellent pas la même conduite chez l'appelant, et dont la confusion a déjà fait sortir du
 * périmètre des espaces de travail parfaitement déclarés.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Ce que la racine déclare, et ce que le lecteur n'a pas compris. */
export interface WorkspaceDeclaration {
  globs: string[];
  /** Ce qui n'a pas pu être lu, cité tel qu'un message d'erreur le nomme. */
  unreadable?: string;
}

/** Lecture JSON tolérante, partagée avec la détection de sous-projets : undefined si illisible. */
export function readJsonFile(path: string): unknown {
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
  const parsed = readJsonFile(path);
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

/** true si l'item est écrit entre guillemets : son contenu est un scalaire ordinaire, quel qu'il soit. */
function isQuoted(item: string): boolean {
  const first = item.charAt(0);
  return (first === '\'' || first === '"') && item.length > 1 && item.endsWith(first);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return isQuoted(trimmed) ? trimmed.slice(1, -1) : trimmed;
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
 *
 * Jugé sur l'item tel qu'il est écrit, guillemets compris : `- '!**\/test\/**'` est une
 * négation documentée par pnpm, donc un scalaire ordinaire, alors que le même `!` nu ouvrirait
 * un tag. Même raison pour les deux-points, licites dans un glob entre guillemets.
 */
function isPlainScalar(item: string): boolean {
  if (isQuoted(item)) return true;
  return !/[:{}[\]]/.test(item) && !YAML_INDICATOR.test(item);
}

/** `items` : les items tels qu'écrits, encore entre guillemets — c'est ce que juge isPlainScalar. */
function itemsOrUnreadable(items: string[], form: string): WorkspaceDeclaration {
  const unknown = items.find((item) => !isPlainScalar(item));
  return unknown === undefined
    ? { globs: items.map(unquote) }
    : { globs: [], unreadable: `item ${form} de pnpm-workspace.yaml d'une forme inconnue : ${unknown}` };
}

function splitFlowItems(inner: string): WorkspaceDeclaration {
  return itemsOrUnreadable(inner.split(',').map((item) => item.trim()).filter((item) => item !== ''), 'de packages');
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
    const written = (item[1] ?? '').trim();
    if (written !== '') items.push(written);
  }
  return itemsOrUnreadable(items, 'de la séquence packages');
}

/**
 * Liste `packages:` d'un pnpm-workspace.yaml. Trois formes lues : séquence en bloc
 * (`- 'apps/*'`), séquence de flux sur une ligne (`['apps/*']`) et sur plusieurs, commentaires
 * de fin de ligne compris.
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

/**
 * Globs d'espaces de travail déclarés à la racine, npm/yarn/bun et pnpm confondus.
 *
 * Deux limites connues, toutes deux du côté conservateur — elles protègent un dossier de trop,
 * jamais l'inverse, puisqu'un motif de cette liste ne peut qu'ajouter une protection.
 * Une négation pnpm (`!**\/test\/**`) est lue puis inerte : `globToRegExp` l'ancre sur un `!`
 * littéral, aucun dossier ne matche, donc un dossier que pnpm retire de l'espace de travail
 * reste protégé par le motif positif qui le couvre, et mesuré au lieu d'être écarté.
 * Un alias YAML (`*ancre`) en item rend de même un glob qui ne matche rien, sans lever
 * `unreadable` : construction jamais rencontrée dans un pnpm-workspace.yaml, laissée telle quelle.
 */
export function workspaceGlobs(rootPath: string): WorkspaceDeclaration {
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
