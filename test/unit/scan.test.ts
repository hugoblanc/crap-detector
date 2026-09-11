import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderSummary } from '../../src/cli/render.js';
import { resolveConfig } from '../../src/core/config.js';
import { scanFast, scanFile } from '../../src/scan/fast.js';
import { assertRatiosInRange, scanFull } from '../../src/scan/full.js';

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
    'export function helper(value: any): number {',
    '  try { return value + 1; } catch (error) {}',
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
      'orphans.count',
      'typesafety.escapes.count',
      'verbosity.fraction',
      'verbosity.lines',
    ]);
    expect(result.aggregates['duplication.percent']).toBeUndefined();
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

  it('ajoute churn et couplage sur un dépôt git', async () => {
    const report = await scanFull(makeRoot(PROJECT, true), config, {
      skipExternalTools: true,
      now: new Date(),
    });
    expect(report.churn?.available).toBe(true);
    expect(report.churn?.summary.commitsScanned).toBe(1);
    expect(report.coupling?.summary).toEqual({ pairs: 0, hiddenPairs: 0 });
    expect(report.aggregates['coupling.hidden.count']).toBe(0);
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

    const pairsFromTwoCommits = resolveConfig({ churn: { minCoChangeCommits: 2 } });
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
  }, 180_000);
});

describe('assertRatiosInRange', () => {
  it('fait échouer un ratio impossible en nommant l’agrégat', () => {
    expect(() => assertRatiosInRange({ 'verbosity.fraction': 11.67 })).toThrow(/verbosity\.fraction vaut 11\.67/);
    expect(() => assertRatiosInRange({ 'erosion.fraction': 1.2 })).toThrow(/erosion\.fraction/);
    expect(() => assertRatiosInRange({ 'duplication.percent': 100.5 })).toThrow(/duplication\.percent/);
  });

  it('laisse passer les ratios à leur borne et les grandeurs absolues', () => {
    expect(() => assertRatiosInRange({
      'erosion.fraction': 1,
      'verbosity.fraction': 0.4,
      'duplication.percent': 80,
      'verbosity.lines': 187_000,
      'duplication.lines': 1_860_000,
    })).not.toThrow();
  });
});
