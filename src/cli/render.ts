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

/** Ce que le texte affiche : au-delà du seuil de signalement, ou tout avec --all. */
export function visibleFindings(findings: Finding[], all: boolean): Finding[] {
  return all ? findings : findings.filter((finding) => finding.belowReportThreshold !== true);
}

/** Un finding masqué reste compté par le cliquet : le dire, sinon « aucun finding » ment. */
export function hiddenNote(findings: Finding[], shown: Finding[]): string[] {
  const hidden = findings.length - shown.length;
  return hidden === 0
    ? []
    : [`${String(hidden)} finding(s) sous le seuil de signalement, comptés par le cliquet : --all pour les voir`];
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
    ...outOfScopeLine(report),
    `graphe      ${count(aggregates['cycles.count'])} cycles, ${orphanCount(aggregates['orphans.count'])}`,
    `typage      ${count(aggregates['typesafety.escapes.count'])} échappements`,
    `imports     ${count(aggregates['imports.unknown.count'])} paquets introuvables, `
      + `${String(report.findings.filter((finding) => finding.rule === 'unlisted-dependency').length)} `
      + 'installés mais non déclarés',
    `couplage    ${count(aggregates['coupling.hidden.count'])} paires couplées sans import`,
  ];
  for (const note of [...unavailableNotes(report), ...subprojectNote(report)]) lines.push(note);
  return lines;
}

/** Sans compte d'orphelins, knip a tourné : ses fichiers inutilisés en tiennent lieu. */
function orphanCount(value: number | undefined): string {
  return value === undefined ? 'orphelins couverts par knip (fichiers inutilisés)' : `${String(value)} orphelins`;
}

/** Depuis la racine, knip et le graphe lisent mal un sous-projet qui a ses propres dépendances. */
function subprojectNote(report: ScanReport): string[] {
  const { subprojects } = report.scope;
  if (subprojects.length === 0) return [];
  const shown = subprojects.slice(0, 5).join(', ');
  const more = subprojects.length > 5 ? ` et ${String(subprojects.length - 5)} autres` : '';
  return [
    `sous-projets ${shown}${more} ont leur propre package.json : `
      + 'scanner chacun avec --root <dossier> pour des résultats fiables',
  ];
}

/** Ce que les outils externes ont trouvé hors du périmètre, pour ceux qui ont tourné. */
function outOfScopeLine(report: ScanReport): string[] {
  const parts: string[] = [];
  if (report.deadCode?.available === true) {
    parts.push(`${String(report.deadCode.outOfScope)} findings knip`);
  }
  if (report.duplication?.available === true) {
    parts.push(`${String(report.duplication.outOfScope)} clones jscpd`);
  }
  return parts.length === 0 ? [] : [`écartés     ${parts.join(', ')}, hors périmètre`];
}

function unavailableNote(
  label: string,
  part: { available: boolean; unavailableReason?: string } | undefined,
): string[] {
  if (part === undefined || part.available) return [];
  return [`${label} indisponible : ${part.unavailableReason ?? 'raison inconnue'}`];
}

/** Un outil manquant doit se voir : sinon on lit « 0 cycle » là où rien n'a été mesuré. */
function unavailableNotes(report: ScanReport): string[] {
  const notes = [
    ...unavailableNote('churn', report.churn),
    ...unavailableNote('knip', report.deadCode),
    ...unavailableNote('jscpd', report.duplication),
  ];
  const gitignoreReason = report.scope.gitignoreUnavailableReason;
  if (gitignoreReason !== undefined) {
    notes.push(`fichiers ignorés par git non exclus : ${gitignoreReason}`);
  }
  if (!report.imports.manifestTrusted) {
    notes.push(`dépendances non vérifiées : ${report.imports.manifestReason ?? 'manifeste illisible'}`);
  }
  return notes;
}

/**
 * Une liste vide a trois causes qui ne se traitent pas pareil : git non lu,
 * git indisponible, ou historique lu sans commit sur un fichier analysé.
 */
function noHotspotReason(churn: ScanReport['churn']): string {
  if (churn === undefined) return 'historique git non lu (--no-git)';
  if (!churn.available) {
    return `historique git indisponible (${churn.unavailableReason ?? 'raison inconnue'})`;
  }
  const window = churn.since === undefined ? '' : ` (fenêtre : ${churn.since})`;
  return `${String(churn.summary.commitsScanned)} commits lus, aucun sur un fichier analysé${window}`;
}

export function renderHotspots(churn: ScanReport['churn'], top: number): string[] {
  const hotspots: Hotspot[] = churn?.hotspots ?? [];
  if (hotspots.length === 0) return [`aucun hotspot : ${noHotspotReason(churn)}`];
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
