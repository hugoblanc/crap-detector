/**
 * Fiabilité d'un rapport knip. Sans point d'entrée connu, knip juge morts des fichiers atteignables :
 * sur un serveur lancé par son script `dev`, 376 fichiers sur 744 signalés inutilisés, et les 8
 * vérifiés à la main l'étaient tous (docs/PRECISION-2026-09.md). Ses findings de joignabilité
 * mesurent alors sa configuration : les compter figerait cette erreur dans la baseline.
 *
 * La règle tient sur la part de fichiers du périmètre signalés inutilisés. Sur les cinq dépôts
 * mesurés, sans configuration knip, elle va de 0,5 % à 14,5 % quand knip trouve ses points
 * d'entrée, et monte à 50,5 % quand il les rate : un tiers laisse de la marge des deux côtés.
 */
import type { KnipConfig } from '../core/config.js';
import type { KnipReliability } from '../core/dead-code.js';
import type { DeadCodeReport } from '../core/types.js';
import { findKnipConfig } from './knip-entries.js';

/** Règles qui dépendent des points d'entrée : un fichier non atteint rend morts ses exports et ses dépendances. */
const REACHABILITY_RULES: ReadonlySet<string> = new Set([
  'unused-file',
  'unused-export',
  'superfluous-export',
  'unused-type',
  'unused-dependency',
]);

const CONFIG_DOC = 'https://github.com/hugoblanc/crap-detector#configurer-knip';

/** Une décimale : 2 fichiers sur 6 arrondis à « 33 % » paraîtraient ne pas dépasser un seuil de 33 %. */
function percent(fraction: number): string {
  return `${String(Math.round(fraction * 1000) / 10).replace('.', ',')} %`;
}

function noteOf(
  reliability: KnipReliability,
  unusedFiles: number,
  filesScanned: number,
  declaredEntries: number,
): string | undefined {
  const { configFile } = reliability;
  if (reliability.trusted) {
    if (configFile !== undefined) return undefined;
    return `knip sans configuration du dépôt : ${String(declaredEntries)} points d'entrée lui ont été déclarés `
      + '(cibles des scripts npm, dossiers scripts/ et bin/, secondes configurations de test). Un point d\'entrée '
      + `lancé autrement, en sous-processus ou par un workflow de CI, reste invisible, voir ${CONFIG_DOC}`;
  }
  const action = configFile === undefined
    ? 'Déclarer les points d\'entrée dans un knip.json'
    : `Vérifier les points d'entrée déclarés dans ${configFile}, ou relever knip.maxUnusedFileFraction `
      + 'dans crap-detector.json si ce code est vraiment mort';
  return `knip jugé non fiable : ${String(unusedFiles)} fichiers sur ${String(filesScanned)} `
    + `(${percent(reliability.unusedFileFraction)}) signalés inutilisés, au-delà de ${percent(reliability.maxUnusedFileFraction)} ; `
    + `${String(reliability.discarded)} findings de fichiers, exports et dépendances inutilisés écartés, ni affichés ni comptés. `
    + `${action}, voir ${CONFIG_DOC}`;
}

/** Juge le rapport et, s'il est dégradé, écarte les findings qui dépendent des points d'entrée. */
export function judgeKnipReport(
  rootPath: string,
  deadCode: DeadCodeReport,
  filesScanned: number,
  config: KnipConfig,
): DeadCodeReport {
  if (!deadCode.available) return deadCode;
  const { unusedFiles } = deadCode.summary;
  const fraction = filesScanned === 0 ? 0 : unusedFiles / filesScanned;
  const trusted = unusedFiles < config.minUnusedFiles || fraction <= config.maxUnusedFileFraction;
  const findings = trusted ? deadCode.findings : deadCode.findings.filter((finding) => !REACHABILITY_RULES.has(finding.rule));
  const reliability: KnipReliability = {
    trusted,
    unusedFileFraction: fraction,
    maxUnusedFileFraction: config.maxUnusedFileFraction,
    minUnusedFiles: config.minUnusedFiles,
    discarded: deadCode.findings.length - findings.length,
  };
  const configFile = findKnipConfig(rootPath);
  if (configFile !== undefined) reliability.configFile = configFile;
  const note = noteOf(reliability, unusedFiles, filesScanned, deadCode.declaredEntries ?? 0);
  if (note !== undefined) reliability.note = note;
  return { ...deadCode, findings, reliability };
}
