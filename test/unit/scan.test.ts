import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeBaseline } from '../../src/baseline/baseline.js';
import { renderSummary } from '../../src/cli/render.js';
import { resolveConfig } from '../../src/core/config.js';
import { makeFinding } from '../../src/core/findings.js';
import { subprojectDirs } from '../../src/imports/manifest.js';
import { scanFast, scanFile } from '../../src/scan/fast.js';
import {
  assertRatiosInRange,
  scanFull,
  withoutDeadFileMetrics,
  withoutNativeDuplicates,
} from '../../src/scan/full.js';

const created: string[] = [];
const config = resolveConfig({});

function makeRoot(files: Record<string, string>, gitInit = false): string {
  const root = mkdtempSync(join(tmpdir(), 'crap-detector-scan-'));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content, 'utf8');
  }
  if (gitInit) {
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('add', '-A');
    git('commit', '-qm', 'initial');
  }
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() ?? '', { recursive: true, force: true });
  }
});

const PROJECT = {
  'package.json': JSON.stringify({ name: 'fixture', dependencies: {} }),
  'src/entry.ts': [
    "import { helper } from './helper.js';",
    'export const run = (): number => helper(1);',
  ].join('\n'),
  'src/helper.ts': [
    'export async function helper(value: any): Promise<number> {',
    '  try { return (await value) + 1; } catch (error) {}',
    '  return 0;',
    '}',
  ].join('\n'),
};

describe('scanFast', () => {
  it('couvre métriques, slop, imports et graphe en une passe', () => {
    const result = scanFast(makeRoot(PROJECT), config);
    expect(result.files).toEqual(['src/entry.ts', 'src/helper.ts']);
    expect(result.metrics.filesScanned).toBe(2);
    expect(result.imports.summary.internalEdges).toBe(1);
    expect(result.dependencies.summary.cycles).toBe(0);
    expect(result.slop.summary.typeEscapes).toBe(1);
  });

  it('remplit les agrégats calculables sans git ni outil externe', () => {
    const result = scanFast(makeRoot(PROJECT), config);
    expect(Object.keys(result.aggregates).sort()).toEqual([
      'cycles.count',
      'erosion.fraction',
      'erosion.mass',
      'imports.unknown.count',
      'typesafety.escapes.count',
      'verbosity.fraction',
      'verbosity.lines',
    ]);
    expect(result.aggregates['duplication.percent']).toBeUndefined();
  });

  it('ne mesure pas une règle désactivée par défaut, la compte une fois activée', () => {
    const root = makeRoot({
      ...PROJECT,
      'src/pick.ts': 'export function pick(flag: boolean): number {\n  if (flag) { return 1; } else { return 2; }\n}\n',
    });
    const byDefault = scanFast(root, config);
    expect(byDefault.slop.summary.hitsByRule['redundant-else']).toBeUndefined();
    expect(byDefault.findings.map((finding) => finding.rule)).not.toContain('redundant-else');
    const enabled = scanFast(root, resolveConfig({ rules: { 'redundant-else': true } }));
    expect(enabled.slop.summary.hitsByRule['redundant-else']).toBe(1);
    expect(enabled.aggregates['verbosity.lines']).toBe((byDefault.aggregates['verbosity.lines'] ?? 0) + 1);
  });

  it('fusionne les findings de tous les analyseurs', () => {
    const rules = new Set(scanFast(makeRoot(PROJECT), config).findings.map((f) => f.rule));
    expect(rules.has('empty-catch')).toBe(true);
    expect(rules.has('type-escape-any')).toBe(true);
  });
});

describe('scanFile', () => {
  it('analyse un fichier isolé et remonte ses violations', () => {
    const root = makeRoot(PROJECT);
    const report = scanFile(root, 'src/helper.ts', config);
    expect(report.file).toBe('src/helper.ts');
    expect(report.metrics.functionCount).toBe(1);
    const rules = report.findings.map((finding) => finding.rule).sort();
    expect(rules).toEqual(['empty-catch', 'type-escape-any']);
  });

  it('détecte un paquet non déclaré sans construire le graphe', () => {
    const root = makeRoot({
      ...PROJECT,
      'src/rogue.ts': "import { pad } from 'left-pad';\nexport const use = () => pad;\n",
    });
    const report = scanFile(root, 'src/rogue.ts', config);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ rule: 'unknown-dependency', symbol: 'left-pad' });
  });

  it('ne remonte rien sur un fichier propre', () => {
    const root = makeRoot(PROJECT);
    expect(scanFile(root, 'src/entry.ts', config).findings).toEqual([]);
  });

  it('se tait sur les dépendances quand le package.json manque', () => {
    const root = makeRoot({ 'src/rogue.ts': "import 'left-pad';\n" });
    expect(scanFile(root, 'src/rogue.ts', config).findings).toEqual([]);
  });

  it('ne signale pas un paquet utilisé seulement comme type quand son @types est déclaré', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ devDependencies: { '@types/express': '5.0.0' } }),
      'src/typed.ts': "import { Request } from 'express';\nexport const path = (req: Request): string => req.path;\n",
      'src/runtime.ts': "import { json } from 'express';\nexport const parser = json();\n",
    });
    expect(scanFile(root, 'src/typed.ts', config).findings).toEqual([]);
    expect(scanFile(root, 'src/runtime.ts', config).findings.map((finding) => finding.rule))
      .toEqual(['unknown-dependency']);
  });

  it('juge comme valeur un import de type non marqué quand le projet active verbatimModuleSyntax', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ devDependencies: { '@types/express': '5.0.0' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
      'src/typed.ts': "import { Request } from 'express';\nexport const path = (req: Request): string => req.path;\n",
    });
    expect(scanFile(root, 'src/typed.ts', config).findings.map((finding) => finding.rule))
      .toEqual(['unknown-dependency']);
  });

  it('ne prend pas un package.json marqueur de format pour un sous-projet', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ name: 'p4', dependencies: { 'real-dep': '1.0.0' } }),
      'src/esm/package.json': JSON.stringify({ type: 'module' }),
      'src/esm/worker.ts': "import { run } from 'real-dep';\nexport const work = run;\n",
    });
    expect(scanFile(root, 'src/esm/worker.ts', config).findings).toEqual([]);
    expect(subprojectDirs(root, ['src/esm/worker.ts'])).toEqual([]);
  });
});

describe('scanFull', () => {
  it('omet churn et outils externes quand on les saute', async () => {
    const report = await scanFull(makeRoot(PROJECT), config, {
      skipChurn: true,
      skipExternalTools: true,
    });
    expect(report.churn).toBeUndefined();
    expect(report.coupling).toBeUndefined();
    expect(report.deadCode).toBeUndefined();
    expect(report.duplication).toBeUndefined();
    expect(report.filesScanned).toBe(2);
    expect(report.thresholds.cyclomaticComplexity).toBe(10);
  });

  it('ajoute churn et couplage sur un dépôt git, sauf si l’historique est trop court', async () => {
    const root = makeRoot(PROJECT, true);
    const options = { skipExternalTools: true, now: new Date() };
    const report = await scanFull(root, resolveConfig({ churn: { minHistoryCommits: 1 } }), options);
    expect(report.churn?.available).toBe(true);
    expect(report.churn?.summary.commitsScanned).toBe(1);
    expect(report.coupling?.summary).toEqual({ pairs: 0, hiddenPairs: 0 });
    expect(report.aggregates['coupling.hidden.count']).toBe(0);

    const tooShort = await scanFull(root, config, options);
    expect(tooShort.coupling).toBeUndefined();
    expect(tooShort.aggregates['coupling.hidden.count']).toBeUndefined();
    expect(renderSummary(tooShort)).toContain('couplage non mesuré : 1 commits lus, historique trop court (churn.minHistoryCommits)');
  }, 60_000);

  it('joint historique et AST quand la racine est un sous-dossier du dépôt', async () => {
    const appFiles: Record<string, string> = Object.fromEntries(
      Object.entries(PROJECT).map(([rel, content]) => [`app/${rel}`, content]),
    );
    const repo = makeRoot({
      ...appFiles,
      '.gitignore': 'generated/\n',
      'app/generated/client.ts': 'export const client = (value: any): any => value;\n',
    }, true);
    for (const rel of ['app/src/entry.ts', 'app/src/helper.ts']) {
      writeFileSync(join(repo, rel), `${appFiles[rel] ?? ''}\n// retouche\n`, 'utf8');
    }
    execFileSync('git', ['commit', '-qam', 'retouche'], { cwd: repo, stdio: 'ignore' });

    const pairsFromTwoCommits = resolveConfig({ churn: { minCoChangeCommits: 2, minHistoryCommits: 2 } });
    const report = await scanFull(join(repo, 'app'), pairsFromTwoCommits, {
      skipExternalTools: true,
      now: new Date(),
    });
    expect(report.scope.gitignore).toBe(true);
    expect(report.metrics.files.map((file) => file.file)).toEqual(['src/entry.ts', 'src/helper.ts']);
    expect(report.churn?.hotspots.map((hotspot) => hotspot.file).sort())
      .toEqual(['src/entry.ts', 'src/helper.ts']);
    // entry.ts importe helper.ts : la paire est couplée, mais pas en caché.
    expect(report.coupling?.summary).toEqual({ pairs: 1, hiddenPairs: 0 });
  }, 60_000);

  it('marque le churn indisponible hors dépôt git, sans échouer', async () => {
    const report = await scanFull(makeRoot(PROJECT), config, { skipExternalTools: true });
    expect(report.churn?.available).toBe(false);
    expect(report.churn?.unavailableReason).toBeDefined();
    expect(report.coupling).toBeUndefined();
    expect(report.aggregates['coupling.hidden.count']).toBeUndefined();
    expect(report.scope.gitignore).toBe(false);
    expect(report.scope.gitignoreUnavailableReason).toBeDefined();
  }, 60_000);

  it('renseigne duplication et code mort quand les outils tournent', async () => {
    const report = await scanFull(makeRoot(PROJECT), config, { skipChurn: true });
    expect(report.duplication?.available).toBe(true);
    expect(report.aggregates['duplication.percent']).toBeDefined();
    expect(report.deadCode).toBeDefined();
  }, 180_000);

  it('ne compte ni duplication ni code mort dans une copie du code hors du périmètre', async () => {
    const block = [
      'export function compute(values: number[]): number {',
      '  let total = 0;',
      '  for (const value of values) {',
      '    if (value > 0) { total += value; }',
      '    if (value < 0) { total -= value; }',
      '  }',
      '  return total;',
      '}',
    ].join('\n');
    // Copie non ignorée par git et hors include, comme un worktree d'agent.
    const copy = Object.fromEntries(
      Object.entries({ ...PROJECT, 'src/compute.ts': block })
        .map(([rel, content]) => [`copie/${rel}`, content]),
    );
    const root = makeRoot({ ...PROJECT, 'src/compute.ts': block, ...copy });
    const srcOnly = resolveConfig({ scope: { include: ['src/**/*.ts'] } });

    const report = await scanFull(root, srcOnly, { skipChurn: true });
    expect(report.duplication?.available).toBe(true);
    expect(report.duplication?.statistics.clones).toBe(0);
    expect(report.aggregates['verbosity.fraction']).toBeLessThanOrEqual(1);
    expect(report.deadCode?.available).toBe(true);
    expect(report.deadCode?.findings.filter((finding) => finding.file.startsWith('copie/'))).toEqual([]);
    expect(report.deadCode?.outOfScope).toBeGreaterThan(0);
    expect(renderSummary(report).join('\n'))
      .toContain(`écartés     ${String(report.deadCode?.outOfScope)} findings knip, 0 clones jscpd`);
    if (report.deadCode !== undefined) report.deadCode.available = false;
    expect(renderSummary(report).join('\n')).not.toContain('findings knip');
  }, 180_000);

  it('laisse les orphelins à knip et ne garde qu’un finding par paquet non déclaré', async () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ name: 'web', dependencies: { next: '15.0.0' } }),
      'node_modules/express/package.json': JSON.stringify({ name: 'express', main: 'index.js' }),
      'node_modules/express/index.js': 'module.exports = {};\n',
      'app/settings/page.tsx': [
        "import { redirect } from 'next/navigation';",
        'export default function Page(): never { return redirect("/"); }',
      ].join('\n'),
      'app/api/route.ts': [
        "import express from 'express';",
        "import ghost from 'ghost-pkg';",
        'export const GET = (): unknown => [express, ghost];',
      ].join('\n'),
    });
    const report = await scanFull(root, config, { skipChurn: true });
    expect(report.deadCode?.available).toBe(true);
    expect(report.aggregates['orphans.count']).toBeUndefined();
    const rules = report.findings.map((finding) => [finding.tool, finding.rule, finding.symbol, finding.severity]);
    expect(rules.filter(([, rule]) => rule === 'orphan' || rule === 'unused-file')).toEqual([]);
    expect(rules.filter(([, rule]) => String(rule).endsWith('-dependency')).sort()).toEqual([
      ['imports', 'unknown-dependency', 'ghost-pkg', 'critical'],
      ['imports', 'unlisted-dependency', 'express', 'major'],
    ]);
    expect(renderSummary(report).join('\n')).toContain('1 paquets introuvables, 1 installés mais non déclarés');
  }, 180_000);

  it('sans knip, compte les tests comme importeurs sans les mesurer', async () => {
    const root = makeRoot({
      ...PROJECT,
      'src/tested.ts': 'export const tested = 1;\n',
      'src/tested.test.ts': "import { tested } from './tested.js';\nvoid tested;\n",
      'src/lost.ts': 'export const lost = 1;\n',
    });
    const report = await scanFull(root, config, { skipChurn: true, skipExternalTools: true });
    expect(report.filesScanned).toBe(4);
    expect(report.dependencies.orphans).toEqual(['src/lost.ts']);
    expect(report.aggregates['orphans.count']).toBe(1);
    expect(report.findings.filter((finding) => finding.rule === 'orphan').map((finding) => finding.file))
      .toEqual(['src/lost.ts']);
  });

  it('signale les sous-dossiers qui ont leur propre package.json', async () => {
    const root = makeRoot({
      ...PROJECT,
      'package.json': JSON.stringify({ name: 'fixture', workspaces: ['dashboard'], dependencies: {} }),
      'dashboard/package.json': JSON.stringify({ dependencies: { chart: '1.0.0' } }),
      'dashboard/node_modules/chart/package.json': '{}',
      'dashboard/src/view.ts': "import { draw } from 'chart';\nexport const view = draw;\n",
    });
    const report = await scanFull(root, config, { skipChurn: true, skipExternalTools: true });
    expect(report.scope.subprojects).toEqual(['dashboard']);
    expect(report.scope.vendored).toEqual([]);
    expect(report.findings.filter((finding) => finding.rule.endsWith('-dependency'))).toEqual([]);
    expect(renderSummary(report).join('\n'))
      .toContain('sous-projets dashboard ont leur propre package.json : scanner chacun avec --root');
  });

  it('écarte du périmètre un sous-projet que personne n’importe', async () => {
    const root = makeRoot({
      ...PROJECT,
      'src/vendor/package.json': JSON.stringify({ name: 'scraper', dependencies: { axios: '1.0.0' } }),
      'src/vendor/scrape.ts': 'export function scrape(value: any): any { return value; }\n',
    });
    const report = await scanFull(root, config, { skipChurn: true, skipExternalTools: true });
    expect(report.scope.vendored).toEqual(['src/vendor']);
    expect(report.filesScanned).toBe(2);
    expect(report.findings.some((finding) => finding.file.startsWith('src/vendor/'))).toBe(false);
    expect(report.aggregates['typesafety.escapes.count']).toBe(1);
    expect(renderSummary(report).join('\n')).toContain('sous-projets src/vendor écartés du périmètre');
  });

  it('mesure un sous-projet dès qu’un fichier du dépôt l’importe', async () => {
    const root = makeRoot({
      ...PROJECT,
      'src/entry.ts': [
        "import { helper } from './helper.js';",
        "import { scrape } from './vendor/scrape.js';",
        'export const run = (): number => helper(scrape(1));',
      ].join('\n'),
      'src/vendor/package.json': JSON.stringify({ name: 'scraper', dependencies: { axios: '1.0.0' } }),
      'src/vendor/scrape.ts': 'export function scrape(value: any): any { return value; }\n',
    });
    const report = await scanFull(root, config, { skipChurn: true, skipExternalTools: true });
    expect(report.scope.subprojects).toEqual(['src/vendor']);
    expect(report.scope.vendored).toEqual([]);
    expect(report.filesScanned).toBe(3);
  });

  it('garde la verbosité sous 1 quand les clones couvrent des lignes blanches', async () => {
    const documented = Array.from({ length: 42 }, (_, i) => [
      '/**',
      ` * Ajuste la valeur autour du pivot ${String(i)}.`,
      ' *',
      ' * @param value valeur à ajuster',
      ' */',
      `export function adjust${String(i)}(value: number): number {`,
      `  if (value > ${String(i)}) { return value - ${String(i)} * 2 + (value % 3); }`,
      `  return value + ${String(i)} * 3 - (value % 5);`,
      '}',
      '',
    ].join('\n')).join('\n');
    const root = makeRoot({
      'package.json': PROJECT['package.json'],
      'src/a.ts': documented,
      'src/b.ts': documented,
    });
    const report = await scanFull(root, config, { skipChurn: true });
    expect(report.duplication?.statistics.clones).toBeGreaterThanOrEqual(1);
    expect(report.aggregates['verbosity.fraction']).toBeGreaterThan(0.9);
    expect(report.aggregates['verbosity.fraction']).toBeLessThanOrEqual(1);
  }, 180_000);

  it('garde la verbosité sous 1 sans jscpd quand un catch vide couvre des lignes blanches', async () => {
    const swallowed = Array.from({ length: 10 }, (_, i) => [
      `export async function attempt${String(i)}(): Promise<void> {`,
      '  try { await risky(); } catch {',
      ...Array.from({ length: 9 }, () => ''),
      '  }',
      '}',
    ].join('\n')).join('\n');
    const root = makeRoot({
      'package.json': PROJECT['package.json'],
      'src/risky.ts': `declare function risky(): Promise<void>;\n${swallowed}\n`,
    });
    const report = await scanFull(root, config, { skipChurn: true, skipExternalTools: true });
    expect(report.aggregates['verbosity.fraction']).toBeGreaterThan(0);
    expect(report.aggregates['verbosity.fraction']).toBeLessThanOrEqual(1);
  });
});

describe('fiabilité de knip', () => {
  /** Serveur dont knip ne trouve pas l'entrée : ni main, ni script, ni fichier index. */
  const routes = Array.from({ length: 10 }, (_, i) => i);
  const UNREACHED: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'server', dependencies: { 'left-pad': '1.3.0' } }),
    'src/server.ts': `${routes.map((i) => `import { route${String(i)} } from './route${String(i)}.js';`).join('\n')}\n`
      + `export const start = (): string[] => [${routes.map((i) => `route${String(i)}()`).join(', ')}];\n`,
    'src/helper.ts': "export const helper = (): string => 'ok';\n",
    ...Object.fromEntries(routes.map((i) => [
      `src/route${String(i)}.ts`,
      `import { helper } from './helper.js';\nexport const route${String(i)} = (): string => helper();\n`,
    ])),
  };

  it('écarte le code mort d’un rapport dégradé, hors agrégats et baseline, et dit quoi faire', async () => {
    const report = await scanFull(makeRoot(UNREACHED), config, { skipChurn: true });
    expect(report.deadCode?.reliability).toMatchObject({ trusted: false, unusedFileFraction: 1, discarded: 13 });
    expect(report.deadCode?.summary.unusedFiles).toBe(12);
    expect(report.findings.filter((finding) => finding.tool === 'knip')).toEqual([]);
    expect(report.aggregates['deadcode.files.count']).toBeUndefined();
    expect(report.aggregates['deadcode.exports.count']).toBeUndefined();
    expect(report.duplication?.available).toBe(true);
    const baseline = makeBaseline(report);
    expect(baseline.scope.knipTrusted).toBe(false);
    expect(Object.keys(baseline.debtCounts).filter((key) => key.startsWith('knip|'))).toEqual([]);
    const summary = renderSummary(report).join('\n');
    expect(summary).toContain('code mort   non mesuré exports, non mesuré fichiers');
    expect(summary).toContain('knip jugé non fiable : 12 fichiers sur 12 (100 %) signalés inutilisés, au-delà de 33 % ; 13 findings');
    expect(summary).toContain('comptés. Déclarer les points d\'entrée dans un knip.json, voir https://github.com/hugoblanc/crap-detector#configurer-knip');
  }, 180_000);

  it('garde un rapport sain, signalé tant que le dépôt n’a pas de configuration knip', async () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ name: 'lib', main: 'src/index.ts' }),
      'src/index.ts': "import { a } from './a.js';\nimport { b } from './b.js';\nexport const run = (): number => a + b;\n",
      'src/a.ts': 'export const a = 1;\nexport const unusedExport = 2;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/lost.ts': 'export const lost = 1;\n',
    });
    const unconfigured = await scanFull(root, config, { skipChurn: true });
    expect(unconfigured.deadCode?.reliability).toMatchObject({ trusted: true, unusedFileFraction: 0.25, discarded: 0 });
    expect(unconfigured.scope.knipTrusted).toBe(true);
    expect(unconfigured.aggregates['deadcode.files.count']).toBe(1);
    expect(unconfigured.findings.filter((finding) => finding.tool === 'knip').map((finding) => finding.rule).sort())
      .toEqual(['unused-export', 'unused-file']);
    const summary = renderSummary(unconfigured).join('\n');
    expect(summary).toContain('knip sans configuration du dépôt : 0 points d\'entrée lui ont été déclarés');
    expect(summary).toContain('entrées     0 points d\'entrée déclarés à knip');

    writeFileSync(join(root, 'knip.json'), JSON.stringify({ entry: ['src/index.ts'] }), 'utf8');
    const configured = await scanFull(root, config, { skipChurn: true });
    expect(configured.deadCode?.reliability).toMatchObject({ trusted: true, configFile: 'knip.json' });
    expect(configured.deadCode?.reliability?.note).toBeUndefined();
    expect(renderSummary(configured).join('\n')).not.toMatch(/knip sans configuration|knip jugé non fiable/);
  }, 180_000);
});

describe('withoutNativeDuplicates', () => {
  it('écarte l’unlisted-dependency de knip seulement sur un fichier source que la règle native a jugé', () => {
    const unlisted = (file: string) => makeFinding({
      tool: 'knip', rule: 'unlisted-dependency', file, symbol: 'express', message: 'non déclaré',
    });
    const root = makeRoot({ 'app/package.json': '{"name":"app"}', 'app/a.ts': '', 'loose/b.ts': '' });
    const deadCode = {
      generatorVersion: '0.1.0', generatedAt: '', rootPath: root, toolVersion: '6.32.2', available: true,
      summary: { unusedFiles: 0, unusedExports: 0, unusedTypes: 0, unusedDependencies: 0 },
      findings: [unlisted('app/a.ts'), unlisted('app/package.json'), unlisted('loose/b.ts')],
      outOfScope: 0,
    };
    const kept = withoutNativeDuplicates(root, ['app/a.ts', 'loose/b.ts'], deadCode).findings;
    expect(kept.map((finding) => finding.file)).toEqual(['app/package.json', 'loose/b.ts']);
  });
});

describe('withoutDeadFileMetrics', () => {
  const dead = [makeFinding({ tool: 'knip', rule: 'unused-file', file: 'src/dead.ts', message: 'jamais importé' })];
  const on = (tool: 'metrics' | 'imports' | 'jscpd', rule: string, file: string) =>
    makeFinding({ tool, rule, file, symbol: 'f', message: 'peu importe' });

  it('écarte les métriques et le slop d’un fichier que knip signale mort', () => {
    const kept = withoutDeadFileMetrics([
      on('metrics', 'cognitive-complexity', 'src/dead.ts'),
      on('metrics', 'type-escape-any', 'src/dead.ts'),
      on('metrics', 'cognitive-complexity', 'src/live.ts'),
      ...dead,
    ], dead);
    expect(kept.map((finding) => `${finding.tool}|${finding.rule}|${finding.file}`))
      .toEqual(['metrics|cognitive-complexity|src/live.ts', 'knip|unused-file|src/dead.ts']);
  });

  it('garde le paquet non déclaré et le clone, qui demandent un autre correctif', () => {
    const kept = withoutDeadFileMetrics([
      on('imports', 'unlisted-dependency', 'src/dead.ts'),
      on('jscpd', 'duplicate-block', 'src/dead.ts'),
      ...dead,
    ], dead);
    expect(kept).toHaveLength(3);
  });

  it('ne touche à rien sans fichier mort signalé', () => {
    const findings = [on('metrics', 'file-length', 'src/live.ts')];
    expect(withoutDeadFileMetrics(findings, [])).toEqual(findings);
  });
});

describe('assertRatiosInRange', () => {
  it('fait échouer un ratio impossible en nommant l’agrégat', () => {
    expect(() => assertRatiosInRange({ 'verbosity.fraction': 11.67 })).toThrow(/verbosity\.fraction vaut 11\.67/);
    expect(() => assertRatiosInRange({ 'duplication.percent': 100.5 })).toThrow(/duplication\.percent/);
  });

  it('laisse passer les ratios à leur borne et les grandeurs absolues', () => {
    expect(() => assertRatiosInRange({
      'verbosity.fraction': 1,
      'duplication.percent': 100,
      'verbosity.lines': 187_000,
      'duplication.lines': 1_860_000,
    })).not.toThrow();
  });
});
