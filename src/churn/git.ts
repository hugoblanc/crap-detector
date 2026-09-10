/**
 * Extraction de l'historique git : un commit = une date et une liste de fichiers touchés.
 * Le parsing est séparé de l'exécution pour être testable sans dépôt.
 *
 * Format demandé : `--numstat -z --format=%x01<hash>%x1f<date>`.
 * Les enregistrements sont séparés par NUL. Un enregistrement de commit commence
 * par U+0001 ; un enregistrement de fichier vaut `ajouts\tsuppressions\tchemin`.
 * Sur un renommage, le chemin est vide et les deux enregistrements suivants
 * portent l'ancien puis le nouveau chemin.
 */
import { execFileSync } from 'node:child_process';

export interface GitFileChange {
  /** Chemin POSIX au moment du commit (destination pour un renommage). */
  path: string;
  /** Chemin d'origine si le commit renomme le fichier. */
  previousPath?: string;
  addedLines: number;
  deletedLines: number;
  /** git rend '-' au lieu d'un décompte sur les fichiers binaires. */
  binary: boolean;
}

export interface GitCommit {
  hash: string;
  /** Date d'auteur ISO 8601. */
  date: string;
  files: GitFileChange[];
}

const COMMIT_MARKER = '\u0001';
const FIELD_SEPARATOR = '\u001f';

export const GIT_LOG_FORMAT = '%x01%H%x1f%aI';

/** Découpe la sortie brute de `git log --numstat -z` en commits. */
export function parseGitLog(raw: string): GitCommit[] {
  const records = raw.split('\0');
  const commits: GitCommit[] = [];
  let current: GitCommit | undefined;
  let index = 0;
  while (index < records.length) {
    const record = records[index]?.replace(/^[\r\n]+/, '') ?? '';
    index += 1;
    if (record === '') continue;
    if (record.startsWith(COMMIT_MARKER)) {
      const [hash, date] = record.slice(1).split(FIELD_SEPARATOR);
      current = { hash: hash ?? '', date: date ?? '', files: [] };
      commits.push(current);
      continue;
    }
    if (current === undefined) continue;
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    const addedRaw = parts[0] ?? '';
    const deletedRaw = parts[1] ?? '';
    const pathRaw = parts.slice(2).join('\t');
    const binary = addedRaw === '-' || deletedRaw === '-';
    const change: GitFileChange = {
      path: pathRaw,
      addedLines: binary ? 0 : Number(addedRaw),
      deletedLines: binary ? 0 : Number(deletedRaw),
      binary,
    };
    if (pathRaw === '') {
      // Renommage : les deux enregistrements suivants sont l'ancien et le nouveau chemin.
      change.previousPath = records[index] ?? '';
      change.path = records[index + 1] ?? '';
      index += 2;
    }
    if (change.path !== '') current.files.push(change);
  }
  return commits;
}

export interface GitLogOptions {
  /** Borne basse de la fenêtre, au format accepté par `git log --since`. */
  since?: string;
  /** Plage de révisions, ex. 'main..HEAD'. Exclusif avec since côté appelant. */
  range?: string;
}

export interface GitLogResult {
  available: boolean;
  reason?: string;
  commits: GitCommit[];
}

/** Lance git dans rootPath ; ne lève jamais, l'absence de dépôt est un état normal. */
export function readGitLog(rootPath: string, options: GitLogOptions = {}): GitLogResult {
  const args = ['log', '--no-merges', '--numstat', '-z', `--format=${GIT_LOG_FORMAT}`];
  if (options.since !== undefined) args.push(`--since=${options.since}`);
  if (options.range !== undefined) args.push(options.range);
  try {
    const raw = execFileSync('git', args, {
      cwd: rootPath,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { available: true, commits: parseGitLog(raw) };
  } catch (error) {
    return { available: false, reason: gitErrorReason(error), commits: [] };
  }
}

function gitErrorReason(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'stderr' in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    if (stderr !== '') return stderr.split('\n')[0] ?? stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Date ISO (jour) située windowDays avant la référence, pour `git log --since`. */
export function windowStartDate(windowDays: number, now: Date): string {
  const start = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 10);
}
