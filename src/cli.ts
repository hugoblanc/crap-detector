#!/usr/bin/env node
/**
 * Point d'entrée du CLI, en deux vitesses.
 *
 * `file` est le chemin rapide : un seul fichier, AST seul, aucun sous-processus.
 * C'est ce que le hook PostToolUse appelle après chaque édition d'un agent, et
 * c'est la raison pour laquelle git et les outils externes sont chargés par
 * import dynamique dans `scan/full.ts` plutôt qu'en tête de ce fichier.
 *
 * Codes de sortie :
 *   0  rien à signaler
 *   1  le gate échoue (régression par rapport à la baseline, ou seuil dépassé)
 *   2  violation sur le fichier analysé — convention des hooks Claude Code,
 *      qui bloquent l'action et renvoient stderr à l'agent
 *   3  erreur d'usage ou d'exécution
 */
import { relative, resolve } from 'node:path';
import { loadProjectConfig, resolveConfig } from './core/config.js';
import type { ResolvedConfig } from './core/config.js';
import { appVersion } from './core/version.js';
import type { CompareResult, Finding, ScanReport } from './core/types.js';
import { numberOption, parseArgs } from './cli/args.js';
import type { ParsedArgs } from './cli/args.js';
import {
  renderCompare,
  renderFindings,
  renderHotspots,
  renderSummary,
} from './cli/render.js';
import { scanFile } from './scan/fast.js';
import { scanFull } from './scan/full.js';
import type { ScanOptions } from './scan/full.js';
import {
  BASELINE_FILENAME,
  compareToBaseline,
  debtKey,
  makeBaseline,
  readBaseline,
  writeBaseline,
} from './baseline/baseline.js';

const USAGE = `crap-detector ${appVersion()}

  crap-detector scan               analyse complète du dépôt
  crap-detector file <chemin>      analyse d'un seul fichier (chemin rapide, pour les hooks)
  crap-detector baseline           écrit ${BASELINE_FILENAME} à partir de l'état courant
  crap-detector check              compare à la baseline ; sort 1 sur régression
  crap-detector hotspots           classe les fichiers par churn × complexité
  crap-detector explain <chemin>   ce qui est reproché à un fichier

Options
  --root <chemin>    racine du projet analysé (défaut : répertoire courant)
  --json             sortie JSON brute au lieu du texte
  --since <ref>      restreint le churn à une plage de révisions, ex. main..HEAD
  --no-git           saute churn, hotspots et couplage temporel
  --no-tools         saute knip et jscpd
  --top <n>          nombre de hotspots affichés (défaut 10)
  --limit <n>        nombre de findings affichés (défaut 20)
  --baseline <chemin> emplacement du fichier de baseline
`;

interface Context {
  args: ParsedArgs;
  rootPath: string;
  config: ResolvedConfig;
  json: boolean;
}

function scanOptions(args: ParsedArgs): ScanOptions {
  const options: ScanOptions = {
    skipChurn: args.flags.has('no-git'),
    skipExternalTools: args.flags.has('no-tools'),
  };
  const since = args.values.get('since');
  if (since !== undefined) options.range = since;
  return options;
}

function baselinePath(context: Context): string {
  const custom = context.args.values.get('baseline');
  return custom === undefined
    ? resolve(context.rootPath, BASELINE_FILENAME)
    : resolve(context.rootPath, custom);
}

function print(lines: string[]): void {
  if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runScan(context: Context): Promise<number> {
  const report = await scanFull(context.rootPath, context.config, scanOptions(context.args));
  if (context.json) {
    printJson(report);
    return 0;
  }
  print(renderSummary(report));
  print(['']);
  print(renderFindings(report.findings, numberOption(context.args, 'limit', 20)));
  print(['', `${String(report.findings.length)} finding(s) au total`]);
  return 0;
}

function runFile(context: Context): number {
  const target = context.args.positionals[0];
  if (target === undefined) {
    process.stderr.write('crap-detector file attend un chemin de fichier\n');
    return 3;
  }
  const relativePath = toRelative(context.rootPath, target);
  const report = scanFile(context.rootPath, relativePath, context.config);
  if (context.json) {
    printJson(report);
    return report.findings.length > 0 ? 2 : 0;
  }
  if (report.findings.length === 0) return 0;
  // stderr : c'est ce que le hook renvoie à l'agent quand il sort en code 2.
  process.stderr.write(`${renderFindings(report.findings).join('\n')}\n`);
  return 2;
}

async function runBaseline(context: Context): Promise<number> {
  const report = await scanFull(context.rootPath, context.config, scanOptions(context.args));
  const baseline = makeBaseline(report);
  const path = baselinePath(context);
  writeBaseline(path, baseline);
  if (context.json) {
    printJson(baseline);
    return 0;
  }
  print([
    `baseline écrite dans ${relative(context.rootPath, path) || path}`,
    `${String(Object.keys(baseline.debtCounts).length)} entrées de dette figées, `
      + `${String(Object.keys(baseline.aggregates).length)} agrégats suivis`,
    'commiter ce fichier : c\'est lui qui rend la CI incrémentale',
  ]);
  return 0;
}

async function runCheck(context: Context): Promise<number> {
  const path = baselinePath(context);
  let baseline;
  try {
    baseline = readBaseline(path);
  } catch (error) {
    process.stderr.write(
      `baseline illisible (${error instanceof Error ? error.message : String(error)})\n`
      + 'lancer d\'abord : crap-detector baseline\n',
    );
    return 3;
  }
  const report = await scanFull(context.rootPath, context.config, scanOptions(context.args));
  const result = compareToBaseline(baseline, report);
  if (context.json) {
    printJson(result);
    return result.passed ? 0 : 1;
  }
  print(renderCompare(result));
  if (!result.passed && result.regressions.length > 0) {
    print(['', 'findings correspondants :']);
    print(renderFindings(findingsBehind(result, report), numberOption(context.args, 'limit', 20)));
  }
  return result.passed ? 0 : 1;
}

/** Findings correspondant aux clés de dette signalées en régression. */
function findingsBehind(result: CompareResult, report: ScanReport): Finding[] {
  const keys = new Set(result.regressions.map((regression) => regression.key));
  return report.findings.filter((finding) => keys.has(debtKey(finding)));
}

async function runHotspots(context: Context): Promise<number> {
  const report = await scanFull(context.rootPath, context.config, {
    ...scanOptions(context.args),
    skipExternalTools: true,
  });
  const hotspots = report.churn?.hotspots ?? [];
  if (context.json) {
    printJson(hotspots);
    return 0;
  }
  print(renderHotspots(report.churn, numberOption(context.args, 'top', 10)));
  return 0;
}

async function runExplain(context: Context): Promise<number> {
  const target = context.args.positionals[0];
  if (target === undefined) {
    process.stderr.write('crap-detector explain attend un chemin de fichier\n');
    return 3;
  }
  const relativePath = toRelative(context.rootPath, target);
  const report = await scanFull(context.rootPath, context.config, {
    ...scanOptions(context.args),
    skipExternalTools: true,
  });
  const findings = report.findings.filter((finding) => finding.file === relativePath);
  const hotspot = report.churn?.hotspots.find((entry) => entry.file === relativePath);
  if (context.json) {
    printJson({ file: relativePath, findings, hotspot });
    return findings.length > 0 ? 1 : 0;
  }
  const metrics = report.metrics.files.find((entry) => entry.file === relativePath);
  if (metrics === undefined) {
    process.stderr.write(`${relativePath} n'est pas dans le périmètre analysé\n`);
    return 3;
  }
  print([
    `${relativePath} : ${String(metrics.sloc)} lignes, ${String(metrics.functionCount)} fonctions, `
      + `imbrication max ${String(metrics.maxNestingDepth)}`,
    hotspot === undefined
      ? 'hotspot : non classé (aucun commit lu sur ce fichier, ou historique git indisponible)'
      : `hotspot : score ${String(hotspot.score)} (${String(hotspot.commits)} commits)`,
    '',
  ]);
  print(findings.length === 0 ? ['aucun finding'] : renderFindings(findings));
  return findings.length > 0 ? 1 : 0;
}

/** Accepte un chemin absolu ou relatif au répertoire courant, rend un chemin POSIX du scope. */
function toRelative(rootPath: string, target: string): string {
  const absolute = resolve(target);
  return relative(rootPath, absolute).split('\\').join('/');
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
  if (args.command === '' || args.flags.has('help') || args.command === 'help') {
    process.stdout.write(USAGE);
    return args.command === '' && !args.flags.has('help') ? 3 : 0;
  }
  if (args.flags.has('version')) {
    process.stdout.write(`${appVersion()}\n`);
    return 0;
  }

  const rootPath = resolve(args.values.get('root') ?? process.cwd());
  let config: ResolvedConfig;
  try {
    config = resolveConfig(loadProjectConfig(rootPath));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
  const context: Context = { args, rootPath, config, json: args.flags.has('json') };

  try {
    switch (args.command) {
      case 'scan': return await runScan(context);
      case 'file': return runFile(context);
      case 'baseline': return await runBaseline(context);
      case 'check': return await runCheck(context);
      case 'hotspots': return await runHotspots(context);
      case 'explain': return await runExplain(context);
      default:
        process.stderr.write(`commande inconnue : ${args.command}\n\n${USAGE}`);
        return 3;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 3;
    });
}
