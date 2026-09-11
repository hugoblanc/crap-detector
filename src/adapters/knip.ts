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
import { posix } from 'node:path';
import { isRuleEnabled } from '../core/config.js';
import type { RuleSwitches } from '../core/config.js';
import { compareFindings, envelope, makeFinding } from '../core/findings.js';
import type { DeadCodeReport, DeadCodeSummary, Finding } from '../core/types.js';
import { parseJsonOutput, runTool } from './run.js';

/** Catégories d'issues knip retenues, avec la règle et le message associés. */
const ISSUE_KINDS = [
  { key: 'exports', rule: 'unused-export', label: 'export inutilisé' },
  { key: 'types', rule: 'unused-type', label: 'type inutilisé' },
  { key: 'dependencies', rule: 'unused-dependency', label: 'dépendance inutilisée' },
  { key: 'devDependencies', rule: 'unused-dependency', label: 'dépendance de dev inutilisée' },
  { key: 'unlisted', rule: 'unlisted-dependency', label: 'dépendance utilisée mais non déclarée' },
  { key: 'unresolved', rule: 'unresolved-import', label: 'import non résolu' },
] as const;

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

function entryFinding(file: string, kind: (typeof ISSUE_KINDS)[number], entry: KnipEntry): Finding {
  const name = typeof entry.name === 'string' ? entry.name : '#anonyme';
  return makeFinding({
    tool: 'knip',
    rule: kind.rule,
    file,
    symbol: name,
    symbolKey: name,
    severity: kind.key === 'unresolved' ? 'critical' : 'major',
    message: `${kind.label} : ${name}`,
    ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
  });
}

function readFindings(parsed: unknown, kinds: ReadonlyArray<(typeof ISSUE_KINDS)[number]>): Finding[] {
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
      findings.push(...entriesOf(issue, kind.key).map((entry) => entryFinding(file, kind, entry)));
    }
  }
  return findings;
}

/** `files` : fichiers du périmètre, relatifs à la racine comme les chemins de knip. */
export function mapKnipReport(parsed: unknown, files: readonly string[], rules: RuleSwitches): KnipMapping {
  const findings = readFindings(parsed, ISSUE_KINDS.filter((kind) => isRuleEnabled(rules, kind.rule)));
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

export function analyzeDeadCode(rootPath: string, files: readonly string[], rules: RuleSwitches): DeadCodeReport {
  // knip sort 1 dès qu'il trouve quelque chose : ce n'est pas un échec.
  const result = runTool('knip', 'knip', ['--reporter', 'json', '--no-progress'], rootPath, {
    successExitCodes: [1],
  });
  const base = {
    ...envelope(rootPath, result.version),
    available: result.ok,
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
    return { ...base, ...mapKnipReport(parseJsonOutput(result.stdout), files, rules) };
  } catch (error) {
    return unavailable(`sortie knip illisible : ${error instanceof Error ? error.message : String(error)}`);
  }
}
