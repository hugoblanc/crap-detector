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
import { readFileSync } from 'node:fs';
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

function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Champ `workspaces` du package.json racine : tableau, ou objet `{ packages: [...] }` (Yarn). */
function packageWorkspaces(rootPath: string): string[] {
  const parsed = parseJsonFile(join(rootPath, 'package.json'));
  if (typeof parsed !== 'object' || parsed === null) return [];
  const declared = (parsed as { workspaces?: unknown }).workspaces;
  if (typeof declared === 'object' && declared !== null && !Array.isArray(declared)) {
    return asStringList((declared as { packages?: unknown }).packages);
  }
  return asStringList(declared);
}

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').trim();
}

/**
 * Liste `packages:` d'un pnpm-workspace.yaml, forme bloc (`- 'apps/*'`) ou en ligne
 * (`['apps/*']`). Lecture ligne à ligne : ajouter un analyseur YAML pour un seul champ
 * coûterait une dépendance de plus à un CLI qui n'en a que trois.
 */
export function pnpmWorkspaceGlobs(raw: string): string[] {
  const lines = raw.split('\n');
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  const header = lines[start];
  if (start === -1 || header === undefined) return [];
  const inline = header.slice(header.indexOf(':') + 1).trim();
  if (inline.startsWith('[')) {
    return inline.replace(/^\[/, '').replace(/\]$/, '').split(',').map(unquote).filter((glob) => glob !== '');
  }
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (item === null) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      break;
    }
    globs.push(unquote(item[1] ?? ''));
  }
  return globs.filter((glob) => glob !== '');
}

const PNPM_WORKSPACE_FILES = ['pnpm-workspace.yaml', 'pnpm-workspace.yml'];

/** Globs d'espaces de travail déclarés à la racine, npm/yarn/bun et pnpm confondus. */
function workspaceGlobs(rootPath: string): string[] {
  const globs = packageWorkspaces(rootPath);
  for (const name of PNPM_WORKSPACE_FILES) {
    try {
      globs.push(...pnpmWorkspaceGlobs(readFileSync(join(rootPath, name), 'utf8')));
    } catch {
      continue;
    }
  }
  return globs;
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

/**
 * Parmi les sous-projets détectés, ceux à écarter du périmètre. Le parcours des imports n'a
 * lieu que s'il reste un candidat : sur un dépôt sans sous-projet, la détection ne coûte rien.
 */
export function vendoredSubprojects(
  rootPath: string,
  subprojects: readonly string[],
  sourceFiles: Map<string, SourceFile>,
): string[] {
  const workspaces = workspaceGlobs(rootPath).map(globToRegExp);
  const candidates = subprojects.filter((dir) => dir !== '' && !matchesAnyGlob(workspaces, dir));
  if (candidates.length === 0) return [];
  const imported = importedFromOutside(rootPath, candidates, sourceFiles);
  return candidates.filter((dir) => !imported.has(dir)).sort();
}

/** Fichiers hors des sous-projets vendorisés : le périmètre réellement mesuré. */
export function withoutVendored(files: readonly string[], vendored: readonly string[]): string[] {
  if (vendored.length === 0) return [...files];
  return files.filter((file) => !vendored.some((dir) => isUnder(dir, file)));
}
