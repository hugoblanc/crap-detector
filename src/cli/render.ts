/**
 * Rendu texte, pensé pour deux lecteurs : un humain qui lit un log de CI et un
 * agent qui reçoit la sortie d'un hook. D'où le format `fichier:ligne` en tête de
 * chaque ligne, cliquable dans un terminal et directement exploitable par l'agent.
 *
 * Pas de couleur ni de caractères de contrôle : la sortie transite par des logs
 * de CI et par des transcripts d'agent, où les codes ANSI ne font que du bruit.
 */
import type {
  CompareResult,
  Finding,
  Hotspot,
  ScanReport,
  Severity,
} from '../core/types.js';

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'CRITIQUE',
  major: 'MAJEUR  ',
  minor: 'MINEUR  ',
  info: 'INFO    ',
};

export function renderFinding(finding: Finding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${String(finding.line)}`;
  return `${SEVERITY_LABEL[finding.severity]} ${location}  [${finding.rule}] ${finding.message}`;
}

export function renderFindings(findings: Finding[], limit?: number): string[] {
  const shown = limit === undefined ? findings : findings.slice(0, limit);
  const lines = shown.map(renderFinding);
  if (limit !== undefined && findings.length > limit) {
    lines.push(`… et ${String(findings.length - limit)} autres (--json pour tout voir)`);
  }
  return lines;
}

function fraction(value: number | undefined): string {
  return value === undefined ? 'non mesuré' : value.toFixed(3);
}

function count(value: number | undefined): string {
  return value === undefined ? 'non mesuré' : String(value);
}

export function renderSummary(report: ScanReport): string[] {
  const metrics = report.metrics.summary;
  const aggregates = report.aggregates;
  const lines = [
    `${String(report.filesScanned)} fichiers, ${String(metrics.totalSloc)} lignes, `
      + `${String(metrics.totalFunctions)} fonctions`,
    `complexité  cyclomatique max ${String(metrics.maxCyclomatic)}, cognitive max `
      + `${String(metrics.maxCognitive)}, médiane ${String(metrics.medianCyclomatic)}`,
    `érosion     ${fraction(aggregates['erosion.fraction'])} `
      + '(repères SlopCodeBench : 0,31 humain / 0,68 agentique)',
    `verbosité   ${fraction(aggregates['verbosity.fraction'])} `
      + '(repères : 0,15 humain / 0,33 agentique)',
    `duplication ${fraction(aggregates['duplication.percent'])} %`,
    `code mort   ${count(aggregates['deadcode.exports.count'])} exports, `
      + `${count(aggregates['deadcode.files.count'])} fichiers`,
    `graphe      ${count(aggregates['cycles.count'])} cycles, `
      + `${count(aggregates['orphans.count'])} orphelins`,
    `typage      ${count(aggregates['typesafety.escapes.count'])} échappements`,
    `imports     ${count(aggregates['imports.unknown.count'])} paquets non déclarés`,
    `couplage    ${count(aggregates['coupling.hidden.count'])} paires couplées sans import`,
  ];
  for (const note of unavailableNotes(report)) lines.push(note);
  return lines;
}

/** Un outil manquant doit se voir : sinon on lit « 0 cycle » là où rien n'a été mesuré. */
function unavailableNotes(report: ScanReport): string[] {
  const notes: string[] = [];
  if (report.churn !== undefined && !report.churn.available) {
    notes.push(`churn indisponible : ${report.churn.unavailableReason ?? 'raison inconnue'}`);
  }
  if (report.deadCode !== undefined && !report.deadCode.available) {
    notes.push(`knip indisponible : ${report.deadCode.unavailableReason ?? 'raison inconnue'}`);
  }
  if (report.duplication !== undefined && !report.duplication.available) {
    notes.push(`jscpd indisponible : ${report.duplication.unavailableReason ?? 'raison inconnue'}`);
  }
  if (!report.imports.manifestTrusted) {
    notes.push(`dépendances non vérifiées : ${report.imports.manifestReason ?? 'manifeste illisible'}`);
  }
  return notes;
}

export function renderHotspots(hotspots: Hotspot[], top: number): string[] {
  if (hotspots.length === 0) return ['aucun hotspot : pas d\'historique git exploitable'];
  return hotspots.slice(0, top).map((hotspot, index) =>
    `${String(index + 1).padStart(2)}. ${hotspot.file}  score ${String(hotspot.score)}`
    + `  (${String(hotspot.commits)} commits × complexité `
    + `${String(Math.max(hotspot.maxCyclomatic, hotspot.maxCognitive))})`);
}

export function renderCompare(result: CompareResult): string[] {
  if (!result.comparable) {
    return [
      'baseline incomparable, il faut la refaire',
      `  ${result.incompatibilityReason ?? 'raison inconnue'}`,
      '  → crap-detector baseline',
    ];
  }
  const lines: string[] = [];
  if (result.regressions.length === 0) {
    lines.push(`aucune régression (${String(result.unchangedCount)} mesures inchangées)`);
  } else {
    lines.push(`${String(result.regressions.length)} régression(s) :`);
    for (const regression of result.regressions) {
      lines.push(`  [${regression.kind}] ${regression.message}`);
    }
  }
  if (result.improvements.length > 0) {
    lines.push(`${String(result.improvements.length)} amélioration(s) :`);
    for (const improvement of result.improvements.slice(0, 10)) {
      lines.push(`  ${improvement.message}`);
    }
    if (result.improvements.length > 10) {
      lines.push(`  … et ${String(result.improvements.length - 10)} autres`);
    }
  }
  for (const note of result.notes) {
    lines.push(`toléré : ${note}`);
  }
  for (const key of result.skippedKeys) {
    lines.push(`non comparé : ${key} (mesuré d'un seul côté)`);
  }
  return lines;
}
