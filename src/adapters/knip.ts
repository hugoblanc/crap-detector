/**
 * Adaptateur knip : fichiers, exports, types et dépendances non utilisés.
 * Les agents laissent beaucoup de code orphelin derrière eux ; c'est le
 * nettoyeur déterministe le plus rentable de la pile.
 *
 * Le parsing est séparé de l'exécution : `mapKnipReport` est testable sans knip.
 */
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
}

export function mapKnipReport(parsed: unknown): KnipMapping {
  const findings: Finding[] = [];
  const summary: DeadCodeSummary = {
    unusedFiles: 0,
    unusedExports: 0,
    unusedTypes: 0,
    unusedDependencies: 0,
  };
  const issues = (parsed as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return { summary, findings };

  for (const raw of issues) {
    if (typeof raw !== 'object' || raw === null) continue;
    const issue = raw as Record<string, unknown>;
    const file = typeof issue['file'] === 'string' ? issue['file'] : '';
    if (file === '') continue;

    if (isUnusedFile(issue)) {
      summary.unusedFiles += 1;
      findings.push(
        makeFinding({
          tool: 'knip',
          rule: 'unused-file',
          file,
          severity: 'major',
          message: 'fichier jamais importé',
        }),
      );
    }

    for (const kind of ISSUE_KINDS) {
      for (const entry of entriesOf(issue, kind.key)) {
        const name = typeof entry.name === 'string' ? entry.name : '#anonyme';
        if (kind.key === 'exports') summary.unusedExports += 1;
        if (kind.key === 'types') summary.unusedTypes += 1;
        if (kind.key === 'dependencies' || kind.key === 'devDependencies') {
          summary.unusedDependencies += 1;
        }
        const finding = makeFinding({
          tool: 'knip',
          rule: kind.rule,
          file,
          symbol: name,
          symbolKey: name,
          severity: kind.key === 'unresolved' ? 'critical' : 'major',
          message: `${kind.label} : ${name}`,
          ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
        });
        findings.push(finding);
      }
    }
  }
  return { summary, findings: findings.sort(compareFindings) };
}

export function analyzeDeadCode(rootPath: string): DeadCodeReport {
  // knip sort 1 dès qu'il trouve quelque chose : ce n'est pas un échec.
  const result = runTool('knip', 'knip', ['--reporter', 'json', '--no-progress'], rootPath, {
    successExitCodes: [1],
  });
  const base = {
    ...envelope(rootPath, result.version),
    available: result.ok,
  };
  if (!result.ok) {
    return {
      ...base,
      unavailableReason: result.reason ?? 'knip indisponible',
      summary: { unusedFiles: 0, unusedExports: 0, unusedTypes: 0, unusedDependencies: 0 },
      findings: [],
    };
  }
  try {
    const mapping = mapKnipReport(parseJsonOutput(result.stdout));
    return { ...base, ...mapping };
  } catch (error) {
    return {
      ...base,
      available: false,
      unavailableReason: `sortie knip illisible : ${error instanceof Error ? error.message : String(error)}`,
      summary: { unusedFiles: 0, unusedExports: 0, unusedTypes: 0, unusedDependencies: 0 },
      findings: [],
    };
  }
}
