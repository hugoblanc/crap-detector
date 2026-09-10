/**
 * Lancement des outils externes (knip, jscpd).
 *
 * Deux contraintes :
 * - Ce module ne doit jamais être importé par le chemin rapide (`crap-detector file`),
 *   qui vise moins de 200 ms et n'a pas le droit de lancer un sous-processus.
 * - Un outil absent, en échec ou dont la sortie n'est pas du JSON n'est pas une
 *   erreur fatale : le rapport le dit et l'analyse continue sans lui.
 *
 * Les binaires sont résolus sur le disque plutôt que par `require.resolve`, que le
 * champ `exports` des paquets modernes empêche d'utiliser sur leur package.json.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ToolResult {
  ok: boolean;
  stdout: string;
  /** Version du paquet, ou 'inconnue' si le package.json n'a pas pu être lu. */
  version: string;
  reason?: string;
}

interface ResolvedTool {
  binPath: string;
  version: string;
}

/** Remonte les répertoires parents à la recherche de node_modules/<paquet>. */
export function findPackageDir(packageName: string, startDir: string): string | undefined {
  let current = startDir;
  for (;;) {
    const candidate = join(current, 'node_modules', packageName);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readBinPath(packageDir: string, binName: string): ResolvedTool | undefined {
  let parsed: { bin?: unknown; version?: unknown };
  try {
    parsed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as typeof parsed;
  } catch {
    return undefined;
  }
  const version = typeof parsed.version === 'string' ? parsed.version : 'inconnue';
  const bin = parsed.bin;
  const relative = typeof bin === 'string'
    ? bin
    : (bin !== null && typeof bin === 'object'
      ? (bin as Record<string, unknown>)[binName]
      : undefined);
  if (typeof relative !== 'string') return undefined;
  const binPath = join(packageDir, relative);
  return existsSync(binPath) ? { binPath, version } : undefined;
}

/** Cherche le binaire d'abord près du projet analysé, puis près de crap-detector. */
export function resolveTool(
  packageName: string,
  binName: string,
  rootPath: string,
): ResolvedTool | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const start of [rootPath, here]) {
    const packageDir = findPackageDir(packageName, start);
    if (packageDir === undefined) continue;
    const resolved = readBinPath(packageDir, binName);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

export interface RunOptions {
  /** Codes de sortie considérés comme normaux. knip sort 1 dès qu'il trouve quelque chose. */
  successExitCodes?: number[];
  timeoutMs?: number;
}

/** Exécute le binaire avec le node courant ; ne lève jamais. */
export function runTool(
  packageName: string,
  binName: string,
  args: string[],
  rootPath: string,
  options: RunOptions = {},
): ToolResult {
  const tool = resolveTool(packageName, binName, rootPath);
  if (tool === undefined) {
    return {
      ok: false,
      stdout: '',
      version: 'inconnue',
      reason: `${packageName} introuvable dans node_modules`,
    };
  }
  try {
    const stdout = execFileSync(process.execPath, [tool.binPath, ...args], {
      cwd: rootPath,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: options.timeoutMs ?? 300_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, version: tool.version };
  } catch (error) {
    const status = statusOf(error);
    const stdout = String((error as { stdout?: unknown }).stdout ?? '');
    if (status !== undefined && (options.successExitCodes ?? []).includes(status)) {
      return { ok: true, stdout, version: tool.version };
    }
    return {
      ok: false,
      stdout,
      version: tool.version,
      reason: `${binName} a échoué${status === undefined ? '' : ` (code ${status})`} : ${firstLine(error)}`,
    };
  }
}

function statusOf(error: unknown): number | undefined {
  if (error !== null && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function firstLine(error: unknown): string {
  const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
  if (stderr !== '') return stderr.split('\n')[0] ?? stderr;
  return error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
}

/** Extrait le premier objet JSON de la sortie, en ignorant d'éventuelles lignes de log. */
export function parseJsonOutput(stdout: string): unknown {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('sortie sans objet JSON');
  return JSON.parse(stdout.slice(start, end + 1));
}
