import { createHash } from 'node:crypto';
import { appVersion } from './version.js';

export type Severity = 'info' | 'minor' | 'major' | 'critical';

export type ToolId =
  | 'metrics'
  | 'churn'
  | 'imports'
  | 'knip'
  | 'jscpd'
  | 'depcruise';

/** Un constat ponctuel, localisé et actionnable. */
export interface Finding {
  /** Stable si le code bouge dans le fichier : sha1(tool|rule|file|symbolKey), 12 hex. */
  id: string;
  tool: ToolId;
  /** Ex. 'cyclomatic-complexity', 'duplicate-block', 'unused-export', 'cycle'. */
  rule: string;
  severity: Severity;
  /** Chemin POSIX relatif à rootPath. */
  file: string;
  line?: number;
  /** 'Class.method' | 'fnName' ; fallback '#arrow@L<n>' pour les fonctions anonymes. */
  symbol?: string;
  value?: number;
  threshold?: number;
  message: string;
  /** Au-delà du seuil du cliquet, donc compté, mais pas du seuil de signalement : masqué du texte sans --all. */
  belowReportThreshold?: true;
}

/**
 * Id stable aux décalages de lignes dans le fichier :
 * sha1(tool|rule|file|symbolKey) tronqué. Le numéro de ligne n'y participe jamais.
 */
export function findingId(tool: ToolId, rule: string, file: string, symbolKey: string): string {
  return createHash('sha1')
    .update([tool, rule, file, symbolKey].join('|'))
    .digest('hex')
    .slice(0, 12);
}

export interface FindingInput {
  tool: ToolId;
  rule: string;
  file: string;
  line?: number;
  symbol?: string;
  symbolKey?: string;
  value?: number;
  threshold?: number;
  message: string;
  /** Force la sévérité pour les violations booléennes qui ne sont pas « major » par défaut. */
  severity?: Severity;
}

/**
 * Fabrique un Finding avec id et sévérité calculée.
 * Avec un seuil comparable : minor/major/critical selon la distance au seuil.
 * Sans valeur mesurable (violation booléenne type export inutilisé) : major par défaut.
 */
export function makeFinding(input: FindingInput): Finding {
  const symbolKey = input.symbolKey ?? input.symbol ?? '';
  const finding: Finding = {
    id: findingId(input.tool, input.rule, input.file, symbolKey),
    tool: input.tool,
    rule: input.rule,
    severity: 'major',
    file: input.file,
    message: input.message,
  };
  if (input.line !== undefined) finding.line = input.line;
  if (input.symbol !== undefined) finding.symbol = input.symbol;
  if (input.threshold !== undefined) finding.threshold = input.threshold;
  if (input.value !== undefined) {
    finding.value = input.value;
    if (input.threshold !== undefined) {
      finding.severity = severityForValue(input.value, input.threshold);
    }
  }
  if (input.severity !== undefined) finding.severity = input.severity;
  return finding;
}

export function severityForValue(value: number, threshold: number): Severity {
  const ratio = value / threshold;
  if (ratio <= 1.25) return 'minor';
  if (ratio <= 2) return 'major';
  return 'critical';
}

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

/** Tri d'affichage : sévérité décroissante puis ratio valeur/seuil décroissant. */
export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  if (bySeverity !== 0) return bySeverity;
  const ratioOf = (f: Finding): number =>
    f.value !== undefined && f.threshold !== undefined && f.threshold > 0
      ? f.value / f.threshold
      : 0;
  const byRatio = ratioOf(b) - ratioOf(a);
  if (byRatio !== 0) return byRatio;
  return a.id.localeCompare(b.id);
}

export function envelope(rootPath: string, toolVersion: string): {
  generatorVersion: string;
  generatedAt: string;
  rootPath: string;
  toolVersion: string;
} {
  return {
    generatorVersion: appVersion(),
    generatedAt: new Date().toISOString(),
    rootPath,
    toolVersion,
  };
}
