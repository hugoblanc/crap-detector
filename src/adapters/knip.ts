/**
 * Adaptateur knip : fichiers, exports, types et dépendances non utilisés.
 * Les agents laissent beaucoup de code orphelin derrière eux ; c'est le
 * nettoyeur déterministe le plus rentable de la pile.
 *
 * knip lit tout le projet : les tests, les conventions de framework et les points
 * d'entrée doivent compter comme importeurs, sinon un module importé seulement par
 * ses tests paraît mort. Seuls ses findings sont ramenés au périmètre mesuré.
 *
 * Le parsing est séparé de l'exécution : `mapKnipReport` est testable sans knip.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { isRuleEnabled } from '../core/config.js';
import type { RuleSwitches } from '../core/config.js';
import { compareFindings, envelope, makeFinding } from '../core/findings.js';
import type { DeadCodeReport, DeadCodeSummary, Finding, Severity } from '../core/types.js';
import { declaredEntries, isBinaryOnlyPackage } from './knip-entries.js';
import type { DeclaredEntries } from './knip-entries.js';
import { parseJsonOutput, runTool } from './run.js';

/** Catégories d'issues knip retenues, avec la règle et le message associés. */
const ISSUE_KINDS = [
  { key: 'exports', rule: 'unused-export', label: 'symbole mort, supprimable', severity: 'major' },
  { key: 'types', rule: 'unused-type', label: 'type inutilisé', severity: 'major' },
  { key: 'dependencies', rule: 'unused-dependency', label: 'dépendance inutilisée', severity: 'major' },
  { key: 'devDependencies', rule: 'unused-dependency', label: 'dépendance de dev inutilisée', severity: 'major' },
  { key: 'unlisted', rule: 'unlisted-dependency', label: 'dépendance utilisée mais non déclarée', severity: 'major' },
  { key: 'unresolved', rule: 'unresolved-import', label: 'import non résolu', severity: 'critical' },
] as const satisfies ReadonlyArray<{ key: string; rule: string; label: string; severity: Severity }>;

/**
 * knip range sous le même verdict le symbole mort et celui qui sert dans son propre fichier,
 * où seul le mot-clé `export` est en trop. Le second se corrige en retirant un mot, pas en
 * supprimant du code : sur 32 alertes vérifiées à la main, 19 étaient de cette forme et
 * aucune n'a été jugée utile à corriger. Deux règles, deux sévérités, deux gestes.
 */
const SUPERFLUOUS_EXPORT = {
  key: 'exports',
  rule: 'superfluous-export',
  label: 'exporté sans importeur, l\'export peut être retiré',
  severity: 'minor',
} as const;

interface KnipEntry {
  name?: unknown;
  line?: unknown;
}

function entriesOf(issue: Record<string, unknown>, key: string): KnipEntry[] {
  const value = issue[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is KnipEntry => typeof entry === 'object' && entry !== null);
}

/** knip signale un fichier entier inutilisé par `files: true` sur l'entrée du fichier. */
function isUnusedFile(issue: Record<string, unknown>): boolean {
  const files = issue['files'];
  return files === true || (Array.isArray(files) && files.length > 0);
}

export interface KnipMapping {
  summary: DeadCodeSummary;
  findings: Finding[];
  outOfScope: number;
}

function summarize(findings: Finding[], rules: RuleSwitches): DeadCodeSummary {
  const count = (rule: string): number => findings.filter((finding) => finding.rule === rule).length;
  const summary: DeadCodeSummary = {
    unusedFiles: count('unused-file'),
    unusedExports: count('unused-export'),
    unusedDependencies: count('unused-dependency'),
  };
  if (rules['unused-type']) summary.unusedTypes = count('unused-type');
  return summary;
}

/**
 * knip rattache les dépendances inutilisées au package.json, qui n'est jamais un
 * fichier mesuré. Le manifeste compte s'il gouverne au moins un fichier du périmètre.
 */
function isScopeManifest(file: string, files: readonly string[]): boolean {
  if (posix.basename(file) !== 'package.json') return false;
  const dir = posix.dirname(file);
  return files.some((scoped) => dir === '.' || scoped.startsWith(`${dir}/`));
}

type IssueKind = (typeof ISSUE_KINDS)[number] | typeof SUPERFLUOUS_EXPORT;

/** Ce que le mapping ne peut pas lire dans la sortie de knip : le disque et l'AST. */
export interface KnipMapOptions {
  /** true si ce paquet n'expose qu'un binaire : il n'est jamais importé, donc jamais « inutilisé ». */
  isBinaryOnly?: (manifestDir: string, packageName: string) => boolean;
  /** true si le symbole exporté sert dans son propre fichier : l'export est superflu, pas mort. */
  usedInOwnFile?: (file: string, symbol: string) => boolean;
}

function variantOf(file: string, kind: IssueKind, name: string, options: KnipMapOptions): IssueKind {
  if (kind.key !== 'exports') return kind;
  return options.usedInOwnFile?.(file, name) === true ? SUPERFLUOUS_EXPORT : kind;
}

function entryFinding(file: string, kind: IssueKind, entry: KnipEntry, options: KnipMapOptions): Finding {
  const name = typeof entry.name === 'string' ? entry.name : '#anonyme';
  const variant = variantOf(file, kind, name, options);
  return makeFinding({
    tool: 'knip',
    rule: variant.rule,
    file,
    symbol: name,
    symbolKey: name,
    severity: variant.severity,
    message: `${variant.label} : ${name}`,
    ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
  });
}

/** Une dépendance signalée inutilisée qui n'expose qu'un binaire est un faux positif de principe. */
function isDeniable(file: string, kind: IssueKind, entry: KnipEntry, options: KnipMapOptions): boolean {
  if (kind.rule !== 'unused-dependency' || typeof entry.name !== 'string') return false;
  return options.isBinaryOnly?.(posix.dirname(file), entry.name) === true;
}

function readFindings(parsed: unknown, kinds: readonly IssueKind[], options: KnipMapOptions): Finding[] {
  const issues = (parsed as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  const findings: Finding[] = [];
  for (const raw of issues) {
    if (typeof raw !== 'object' || raw === null) continue;
    const issue = raw as Record<string, unknown>;
    const file = typeof issue['file'] === 'string' ? issue['file'] : '';
    if (file === '') continue;
    if (isUnusedFile(issue)) {
      findings.push(
        makeFinding({ tool: 'knip', rule: 'unused-file', file, severity: 'major', message: 'fichier jamais importé' }),
      );
    }
    for (const kind of kinds) {
      findings.push(...entriesOf(issue, kind.key)
        .filter((entry) => !isDeniable(file, kind, entry, options))
        .map((entry) => entryFinding(file, kind, entry, options)));
    }
  }
  return findings;
}

/**
 * Catégories à lire : celles dont la règle est active. Les exports se lisent dès que l'une
 * des deux règles qu'ils peuvent produire l'est ; le tri se fait sur le finding.
 */
function enabledKinds(rules: RuleSwitches): IssueKind[] {
  return ISSUE_KINDS.filter((kind) => kind.key === 'exports'
    ? isRuleEnabled(rules, kind.rule) || isRuleEnabled(rules, SUPERFLUOUS_EXPORT.rule)
    : isRuleEnabled(rules, kind.rule));
}

/** `files` : fichiers du périmètre, relatifs à la racine comme les chemins de knip. */
export function mapKnipReport(
  parsed: unknown,
  files: readonly string[],
  rules: RuleSwitches,
  options: KnipMapOptions = {},
): KnipMapping {
  const findings = readFindings(parsed, enabledKinds(rules), options)
    .filter((finding) => isRuleEnabled(rules, finding.rule));
  const inScope = new Set(files);
  const kept = findings.filter((finding) =>
    inScope.has(finding.file) || isScopeManifest(finding.file, files));
  return {
    summary: summarize(kept, rules),
    findings: kept.sort(compareFindings),
    outOfScope: findings.length - kept.length,
  };
}

const EMPTY_SUMMARY: DeadCodeSummary = {
  unusedFiles: 0,
  unusedExports: 0,
  unusedTypes: 0,
  unusedDependencies: 0,
};

/**
 * Lance knip avec les points d'entrée déclarés, écrits dans une configuration temporaire
 * hors du dépôt analysé : crap-detector n'écrit jamais dans le dépôt qu'il mesure. Les
 * motifs restent relatifs à la racine, que knip prend comme répertoire de travail.
 */
function runKnip(rootPath: string, entries: DeclaredEntries): ReturnType<typeof runTool> {
  const args = ['--reporter', 'json', '--no-progress'];
  if (entries.patterns.length === 0) {
    // knip sort 1 dès qu'il trouve quelque chose : ce n'est pas un échec.
    return runTool('knip', 'knip', args, rootPath, { successExitCodes: [1] });
  }
  const dir = mkdtempSync(join(tmpdir(), 'crap-detector-knip-'));
  const configPath = join(dir, 'knip.json');
  try {
    writeFileSync(configPath, JSON.stringify({ entry: entries.patterns }), 'utf8');
    return runTool('knip', 'knip', [...args, '--config', configPath], rootPath, { successExitCodes: [1] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function analyzeDeadCode(
  rootPath: string,
  files: readonly string[],
  rules: RuleSwitches,
  options: KnipMapOptions = {},
): DeadCodeReport {
  const entries = declaredEntries(rootPath, files);
  const result = runKnip(rootPath, entries);
  const base = {
    ...envelope(rootPath, result.version),
    available: result.ok,
    declaredEntries: entries.added,
  };
  const unavailable = (reason: string): DeadCodeReport => ({
    ...base,
    available: false,
    unavailableReason: reason,
    summary: { ...EMPTY_SUMMARY },
    findings: [],
    outOfScope: 0,
  });
  if (!result.ok) return unavailable(result.reason ?? 'knip indisponible');
  try {
    const mapping = mapKnipReport(parseJsonOutput(result.stdout), files, rules, {
      isBinaryOnly: (dir, name) => isBinaryOnlyPackage(rootPath, dir, name),
      ...options,
    });
    return { ...base, ...mapping };
  } catch (error) {
    return unavailable(`sortie knip illisible : ${error instanceof Error ? error.message : String(error)}`);
  }
}
