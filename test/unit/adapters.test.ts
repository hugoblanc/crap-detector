import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findPackageDir, parseJsonOutput, resolveTool, runTool } from '../../src/adapters/run.js';
import { analyzeDeadCode, mapKnipReport } from '../../src/adapters/knip.js';
import { analyzeDuplication, mapJscpdReport } from '../../src/adapters/jscpd.js';
import { judgeKnipReport } from '../../src/adapters/knip-reliability.js';
import { declaredEntries, isBinaryOnlyPackage } from '../../src/adapters/knip-entries.js';
import type { ExportOrigin } from '../../src/imports/local-usage.js';
import { resolveConfig } from '../../src/core/config.js';
import { makeFinding } from '../../src/core/findings.js';

const created: string[] = [];
const withTypes = resolveConfig({ rules: { 'unused-type': true } }).rules;

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'crap-detector-adapters-'));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content, 'utf8');
  }
  return root;
}

/** Faux paquet installé dans un node_modules temporaire, pour piloter le code de sortie. */
function fakeTool(script: string): string {
  return makeRoot({
    'node_modules/faux-outil/package.json': JSON.stringify({
      name: 'faux-outil',
      version: '9.9.9',
      bin: { 'faux-outil': './run.js' },
    }),
    'node_modules/faux-outil/run.js': script,
  });
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() ?? '', { recursive: true, force: true });
  }
});

describe('résolution des binaires', () => {
  it('trouve un paquet installé en remontant les répertoires', () => {
    expect(findPackageDir('knip', process.cwd())).toContain('node_modules/knip');
  });

  it('rend undefined pour un paquet absent', () => {
    expect(findPackageDir('paquet-qui-nexiste-pas', process.cwd())).toBeUndefined();
  });

  it('résout le binaire et sa version', () => {
    const tool = resolveTool('jscpd', 'jscpd', process.cwd());
    expect(tool?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(tool?.binPath).toContain('jscpd');
  });
});

describe('runTool', () => {
  it('signale un outil absent sans lever', () => {
    const result = runTool('paquet-absent', 'bidon', [], process.cwd());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/introuvable/);
  });

  it('lance le binaire résolu par le chemin du paquet', () => {
    const root = fakeTool('process.stdout.write("bonjour"); process.exit(0);');
    const result = runTool('faux-outil', 'faux-outil', [], root);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('bonjour');
    expect(result.version).toBe('9.9.9');
  });

  it('traite comme un succès un code de sortie déclaré normal', () => {
    const root = fakeTool('process.stdout.write("{}"); process.exit(1);');
    const strict = runTool('faux-outil', 'faux-outil', [], root);
    expect(strict.ok).toBe(false);
    expect(strict.reason).toMatch(/code 1/);
    const tolerant = runTool('faux-outil', 'faux-outil', [], root, { successExitCodes: [1] });
    expect(tolerant.ok).toBe(true);
    expect(tolerant.stdout).toBe('{}');
  });
});

describe('parseJsonOutput', () => {
  it('extrait l’objet JSON même précédé de lignes de log', () => {
    expect(parseJsonOutput('chargement…\n{"a":1}\n')).toEqual({ a: 1 });
  });

  it('lève sur une sortie sans objet', () => {
    expect(() => parseJsonOutput('rien du tout')).toThrow(/JSON/);
  });
});

describe('mapKnipReport', () => {
  const scope = ['src/a.ts', 'src/orphan.ts'];
  const report = {
    issues: [
      {
        file: 'package.json',
        dependencies: [{ name: 'left-pad', line: 12 }],
        devDependencies: [{ name: 'old-tool', line: 20 }],
        exports: [],
        types: [],
      },
      {
        file: 'src/a.ts',
        exports: [{ name: 'unusedHelper', line: 30 }],
        types: [{ name: 'UnusedType', line: 5 }],
        unlisted: [{ name: 'ghost-pkg' }],
      },
      { file: 'src/orphan.ts', files: true },
    ],
  };

  it('compte chaque catégorie dans le résumé', () => {
    expect(mapKnipReport(report, scope, withTypes).summary).toEqual({
      unusedFiles: 1,
      unusedExports: 1,
      unusedTypes: 1,
      unusedDependencies: 2,
    });
  });

  it('produit un finding par entrée, avec règle et ligne', () => {
    const findings = mapKnipReport(report, scope, withTypes).findings;
    const unusedExport = findings.find((finding) => finding.symbol === 'unusedHelper');
    expect(unusedExport).toMatchObject({
      tool: 'knip',
      rule: 'unused-export',
      file: 'src/a.ts',
      line: 30,
    });
    expect(findings.find((finding) => finding.rule === 'unused-file')?.file).toBe('src/orphan.ts');
    expect(findings.find((finding) => finding.symbol === 'ghost-pkg')?.rule)
      .toBe('unlisted-dependency');
  });

  it('écarte les findings hors périmètre et recalcule le résumé sur ceux qui restent', () => {
    const copy = '.claude/worktrees/copie';
    const mapping = mapKnipReport({
      issues: [
        ...report.issues,
        { file: `${copy}/src/orphan.ts`, files: true },
        { file: `${copy}/src/a.ts`, exports: [{ name: 'unusedHelper', line: 30 }] },
        { file: `${copy}/package.json`, dependencies: [{ name: 'left-pad', line: 12 }] },
        { file: 'packages/web/package.json', dependencies: [{ name: 'react', line: 4 }] },
        { file: 'src/a.test.ts', exports: [{ name: 'fixture', line: 1 }] },
      ],
    }, [...scope, 'packages/web/src/page.tsx'], withTypes);
    expect(mapping.outOfScope).toBe(4);
    expect(mapping.summary).toEqual({
      unusedFiles: 1,
      unusedExports: 1,
      unusedTypes: 1,
      unusedDependencies: 3,
    });
    expect(mapping.findings.filter((finding) => finding.file.includes('copie'))).toEqual([]);
  });

  it('ne garde aucun finding, pas même de dépendance, sur un périmètre vide', () => {
    expect(mapKnipReport(report, [], withTypes).findings).toEqual([]);
  });

  it('ne mesure pas les types inutilisés tant que unused-type n’est pas activée', () => {
    const mapping = mapKnipReport(report, scope, resolveConfig({}).rules);
    expect(mapping.findings.some((finding) => finding.rule === 'unused-type')).toBe(false);
    expect(mapping.summary.unusedTypes).toBeUndefined();
    expect(mapping.summary.unusedExports).toBe(1);
  });

  it('garde un id stable quand la ligne change', () => {
    const before = mapKnipReport(report, scope, withTypes).findings
      .find((finding) => finding.symbol === 'unusedHelper');
    const moved = mapKnipReport({
      issues: [{ file: 'src/a.ts', exports: [{ name: 'unusedHelper', line: 99 }] }],
    }, scope, withTypes).findings[0];
    expect(moved?.id).toBe(before?.id);
  });

  it('sépare le symbole mort, le ré-export et l’export superflu, et ne rend le dernier que si la règle est active', () => {
    const exported = {
      issues: [{
        file: 'src/a.ts',
        exports: [{ name: 'TABLE', line: 3 }, { name: 'mort', line: 9 }, { name: 'relayé', line: 1 }],
      }],
    };
    const origins: Record<string, ExportOrigin> = { TABLE: 'local-usage', relayé: 'reexport', mort: 'dead' };
    const exportOrigin = (_file: string, symbol: string): ExportOrigin => origins[symbol] ?? 'dead';
    const parDéfaut = mapKnipReport(exported, ['src/a.ts'], withTypes, { exportOrigin });
    expect(parDéfaut.findings.map((finding) => [finding.rule, finding.symbol, finding.severity]))
      .toEqual([['unused-export', 'mort', 'major'], ['unused-export', 'relayé', 'major']]);
    expect(parDéfaut.findings[0]?.message).toContain('symbole mort, supprimable');
    // Un ré-export vit dans son module d'origine : seule sa ligne est retirable.
    expect(parDéfaut.findings[1]?.message).toContain('ré-export jamais importé, la ligne peut être retirée');
    expect(parDéfaut.summary.unusedExports).toBe(2);

    const activée = resolveConfig({ rules: { 'superfluous-export': true } }).rules;
    const complet = mapKnipReport(exported, ['src/a.ts'], activée, { exportOrigin });
    expect(complet.findings.map((finding) => [finding.rule, finding.symbol, finding.severity]))
      .toEqual([
        ['unused-export', 'mort', 'major'],
        ['unused-export', 'relayé', 'major'],
        ['superfluous-export', 'TABLE', 'minor'],
      ]);
    expect(complet.findings[2]?.message).toContain('l\'export peut être retiré');
    // Le compteur du cliquet ne suit pas l'export superflu.
    expect(complet.summary.unusedExports).toBe(2);
  });

  it('traite un export sans importeur comme du code mort quand l’AST n’a pas été lu', () => {
    const mapping = mapKnipReport({ issues: [{ file: 'src/a.ts', exports: [{ name: 'x', line: 1 }] }] }, ['src/a.ts'], withTypes);
    expect(mapping.findings[0]?.message).toContain('symbole mort, supprimable');
  });

  it('tolère une sortie vide ou malformée', () => {
    expect(mapKnipReport({}, scope, withTypes).findings).toEqual([]);
    expect(mapKnipReport({ issues: 'pas un tableau' }, scope, withTypes).findings).toEqual([]);
    expect(mapKnipReport({ issues: [{ exports: [{ name: 'x' }] }] }, scope, withTypes).findings).toEqual([]);
  });
});

describe('déclaration des points d’entrée', () => {
  it('déclare la cible d’un script npm, les dossiers de scripts et les specs d’une seconde config jest', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({
        name: 'app',
        scripts: {
          dev: 'tsx ./src/server.ts',
          'test:e2e': 'jest --config ./test/jest-e2e.json --forceExit',
          build: 'node dist/main.js',
        },
      }),
      'src/server.ts': '',
      'scripts/seed.ts': '',
      'test/jest-e2e.json': JSON.stringify({ rootDir: '../src', testRegex: '.e2e-spec.ts$' }),
    });
    const entries = declaredEntries(root, ['src/server.ts', 'src/a.e2e-spec.ts', 'src/a.ts', 'scripts/seed.ts']);
    expect(entries.configFile).toBeUndefined();
    expect(entries.patterns).toContain('src/server.ts');
    expect(entries.patterns).toContain('src/a.e2e-spec.ts');
    expect(entries.patterns).toContain(`scripts/**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}`);
    // Ni la cible compilée d'un script, ni un fichier du périmètre sans point d'entrée.
    expect(entries.patterns).not.toContain('dist/main.js');
    expect(entries.patterns).not.toContain('src/a.ts');
    expect(entries.added).toBe(3);
  });

  it('déclare aussi les dossiers de scripts imbriqués, une seule fois par racine', () => {
    const root = makeRoot({ 'package.json': '{}', 'scripts/racine.ts': '' });
    const entries = declaredEntries(root, [
      'scripts/racine.ts',
      'scripts/lot/imbriqué.ts',
      'server/scripts/audit.ts',
      'evals/scripts/run.ts',
      'src/app.ts',
    ]);
    const sources = '{js,mjs,cjs,jsx,ts,tsx,mts,cts}';
    expect(entries.patterns.slice(2)).toEqual([
      `evals/scripts/**/*.${sources}`,
      `scripts/**/*.${sources}`,
      `server/scripts/**/*.${sources}`,
    ]);
  });

  it('suit la cible lancée par nodemon, seulement si un script npm lance nodemon', () => {
    const files = { 'nodemon.json': JSON.stringify({ exec: 'node -r ts-node/register server/index.ts' }), 'server/index.ts': '' };
    const lancé = makeRoot({ ...files, 'package.json': JSON.stringify({ scripts: { 'start:dev': 'nodemon' } }) });
    expect(declaredEntries(lancé, ['server/index.ts']).patterns).toContain('server/index.ts');
    const inerte = makeRoot({ ...files, 'package.json': JSON.stringify({ scripts: { start: 'node dist/main.js' } }) });
    expect(declaredEntries(inerte, ['server/index.ts']).added).toBe(0);
  });

  it('ne déclare rien quand le dépôt configure knip lui-même', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ name: 'app', scripts: { dev: 'tsx src/server.ts' } }),
      'src/server.ts': '',
      'knip.json': JSON.stringify({ entry: ['src/server.ts'] }),
    });
    expect(declaredEntries(root, ['src/server.ts'])).toEqual({ patterns: [], added: 0, configFile: 'knip.json' });
  });

  it('reconnaît un paquet qui n’expose qu’un binaire', () => {
    const root = makeRoot({
      'node_modules/cli-pur/package.json': JSON.stringify({ name: 'cli-pur', bin: { 'cli-pur': './run.js' } }),
      'node_modules/outil/package.json': JSON.stringify({ name: 'outil', bin: './run.js', main: './index.js' }),
      'apps/web/package.json': '{}',
    });
    expect(isBinaryOnlyPackage(root, '.', 'cli-pur')).toBe(true);
    // Un paquet importable, même avec un binaire, reste jugeable : nodemon, tsx, concurrently.
    expect(isBinaryOnlyPackage(root, '.', 'outil')).toBe(false);
    expect(isBinaryOnlyPackage(root, 'apps/web', 'cli-pur')).toBe(true);
    expect(isBinaryOnlyPackage(root, '.', 'absent')).toBe(false);
  });

  it('écarte la dépendance inutilisée d’un paquet qui n’expose qu’un binaire', () => {
    const report = {
      issues: [{ file: 'package.json', dependencies: [{ name: 'vercel', line: 2 }, { name: 'axios', line: 3 }] }],
    };
    const mapping = mapKnipReport(report, ['src/a.ts'], withTypes, { isBinaryOnly: (_dir, name) => name === 'vercel' });
    expect(mapping.findings.map((finding) => finding.symbol)).toEqual(['axios']);
  });
});

describe('judgeKnipReport', () => {
  const knipFinding = (rule: string, file: string) => makeFinding({ tool: 'knip', rule, file, symbol: file, message: rule });
  const deadCode = {
    generatorVersion: '0.1.0', generatedAt: '', rootPath: '/repo', toolVersion: '6.32.2', available: true,
    summary: { unusedFiles: 2, unusedExports: 1, unusedDependencies: 0 },
    findings: [
      knipFinding('unused-file', 'src/a.ts'),
      knipFinding('unused-file', 'src/b.ts'),
      knipFinding('unused-export', 'src/c.ts'),
      knipFinding('unlisted-dependency', 'src/c.ts'),
    ],
    outOfScope: 0,
  };

  it('lit la clé knip du package.json, conseille alors de vérifier ses points d’entrée, et suit les seuils configurés', () => {
    const root = makeRoot({ 'package.json': JSON.stringify({ name: 'app', knip: { entry: ['src/main.ts'] } }) });
    const degraded = judgeKnipReport(root, deadCode, 6, resolveConfig({ knip: { minUnusedFiles: 2 } }).knip);
    expect(degraded.reliability).toMatchObject({ trusted: false, discarded: 3, configFile: 'package.json#knip' });
    expect(degraded.findings.map((finding) => finding.rule)).toEqual(['unlisted-dependency']);
    expect(degraded.reliability?.note).toContain('2 fichiers sur 6 (33,3 %) signalés inutilisés, au-delà de 33 %');
    expect(degraded.reliability?.note).toContain('Vérifier les points d\'entrée déclarés dans package.json#knip');

    const raised = judgeKnipReport(root, deadCode, 6, resolveConfig({ knip: { minUnusedFiles: 2, maxUnusedFileFraction: 1 } }).knip);
    expect(raised.reliability).toMatchObject({ trusted: true, discarded: 0 });
    expect(raised.findings).toHaveLength(4);
    expect(raised.reliability?.note).toBeUndefined();
  });

  it('garde fiable un petit dépôt dont un fichier sur deux est vraiment mort, sous le minimum de fichiers', () => {
    const root = makeRoot({ 'knip.json': JSON.stringify({ entry: ['src/main.ts'] }) });
    const small = {
      ...deadCode,
      summary: { unusedFiles: 1, unusedExports: 0, unusedDependencies: 0 },
      findings: [knipFinding('unused-file', 'src/dead.ts')],
    };
    const judged = judgeKnipReport(root, small, 2, resolveConfig({}).knip);
    expect(judged.reliability).toMatchObject({ trusted: true, unusedFileFraction: 0.5, minUnusedFiles: 10, discarded: 0 });
    expect(judged.findings.map((finding) => finding.file)).toEqual(['src/dead.ts']);
  });
});

describe('mapJscpdReport', () => {
  const scope = { root: '/repo', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] };
  const report = {
    statistics: { total: { clones: 2, duplicatedLines: 23, percentage: 0.81 } },
    duplicates: [
      {
        lines: 5,
        firstFile: { name: '/repo/src/a.ts', start: 10, end: 14 },
        secondFile: { name: '/repo/src/b.ts', start: 40, end: 44 },
      },
      {
        lines: 3,
        firstFile: { name: '/repo/src/a.ts', start: 12, end: 14 },
        secondFile: { name: '/repo/src/c.ts', start: 1, end: 3 },
      },
    ],
  };

  it('reprend les statistiques globales', () => {
    expect(mapJscpdReport(report, 5, scope).statistics)
      .toEqual({ clones: 2, duplicatedLines: 23, percent: 0.81 });
  });

  it('accumule les lignes clonées des deux côtés, sans doublon, en chemins relatifs', () => {
    const { cloneLines } = mapJscpdReport(report, 5, scope);
    expect([...(cloneLines.get('src/a.ts') ?? [])].sort((x, y) => x - y))
      .toEqual([10, 11, 12, 13, 14]);
    expect([...(cloneLines.get('src/c.ts') ?? [])]).toEqual([1, 2, 3]);
  });

  it('produit un finding par clone, pointant les deux emplacements', () => {
    const findings = mapJscpdReport(report, 5, scope).findings;
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ tool: 'jscpd', rule: 'duplicate-block', file: 'src/a.ts' });
    expect(findings[0]?.message).toContain('src/');
  });

  it('écarte un clone dont un seul côté est hors périmètre', () => {
    const mapping = mapJscpdReport({
      ...report,
      duplicates: [
        ...report.duplicates,
        {
          lines: 8,
          firstFile: { name: '/repo/src/a.ts', start: 50, end: 57 },
          secondFile: { name: '/repo/.claude/worktrees/copie/src/a.ts', start: 50, end: 57 },
        },
      ],
    }, 5, scope);
    expect(mapping.outOfScope).toBe(1);
    expect(mapping.findings).toHaveLength(2);
    expect([...mapping.cloneLines.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(mapping.cloneLines.get('src/a.ts')?.has(50)).toBe(false);
  });

  it('ignore un doublon dont un côté est incomplet', () => {
    const partial = { duplicates: [{ lines: 5, firstFile: { name: '/repo/src/a.ts', start: 1 } }] };
    expect(mapJscpdReport(partial, 5, scope).clones).toEqual([]);
  });

  it('tolère un rapport vide', () => {
    expect(mapJscpdReport({}, 5, scope).statistics)
      .toEqual({ clones: 0, duplicatedLines: 0, percent: 0 });
  });
});

describe('analyzeDeadCode sur un vrai projet', () => {
  it('remonte un export inutilisé', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({
        name: 'fixture',
        type: 'module',
        main: 'src/index.ts',
        dependencies: {},
      }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'nodenext', strict: true } }),
      'src/index.ts': "export { used } from './helpers.js';\n",
      'src/helpers.ts': ['export const used = 1;', 'export const neverUsed = 2;'].join('\n'),
    });
    const report = analyzeDeadCode(root, ['src/helpers.ts', 'src/index.ts'], resolveConfig({}).rules);
    expect(report.available).toBe(true);
    expect(report.summary.unusedExports).toBeGreaterThanOrEqual(1);
    expect(report.findings.some((finding) => finding.symbol === 'neverUsed')).toBe(true);
  }, 120_000);
});

describe('analyzeDuplication sur un vrai projet', () => {
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

  it('détecte un bloc copié-collé et rend des chemins relatifs', () => {
    const root = makeRoot({
      'src/a.ts': `${block}\n`,
      'src/b.ts': `${block.replace('compute', 'computeAgain')}\n`,
    });
    const { report, cloneLines } = analyzeDuplication(root, ['src/a.ts', 'src/b.ts']);
    expect(report.available).toBe(true);
    expect(report.statistics.clones).toBeGreaterThanOrEqual(1);
    expect(report.outOfScope).toBe(0);
    expect([...cloneLines.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  }, 120_000);

  it('ne lit que les fichiers du périmètre, pas le reste de la racine', () => {
    const root = makeRoot({
      'src/a.ts': `${block}\n`,
      'copie/src/a.ts': `${block}\n`,
      'copie/src/b.ts': `${block.replace('compute', 'computeAgain')}\n`,
    });
    const { report, cloneLines } = analyzeDuplication(root, ['src/a.ts']);
    expect(report.available).toBe(true);
    expect(report.statistics).toEqual({ clones: 0, duplicatedLines: 0, percent: 0 });
    expect(cloneLines.size).toBe(0);
  }, 120_000);

  it('reprend la config jscpd du dépôt : .jscpd.json, ou à défaut la clé jscpd du package.json', () => {
    const sources = {
      'src/a.ts': `${block}\n`,
      'src/b.ts': `${block.replace('compute', 'computeAgain')}\n`,
    };
    const ignoreB = { ignore: ['**/src/b.ts'] };
    const configs: Array<Record<string, string>> = [
      { '.jscpd.json': JSON.stringify(ignoreB) },
      { 'package.json': JSON.stringify({ name: 'fixture', jscpd: ignoreB }) },
    ];
    for (const config of configs) {
      const { report } = analyzeDuplication(makeRoot({ ...sources, ...config }), ['src/a.ts', 'src/b.ts']);
      const label = Object.keys(config).join();
      expect(report.available, label).toBe(true);
      expect(report.statistics.clones, label).toBe(0);
    }
  }, 120_000);

  it('neutralise exitCode et threshold du dépôt, qui feraient passer jscpd pour en échec', () => {
    const root = makeRoot({
      'src/a.ts': `${block}\n`,
      'src/b.ts': `${block.replace('compute', 'computeAgain')}\n`,
      '.jscpd.json': JSON.stringify({ exitCode: 3, threshold: 0 }),
    });
    const { report } = analyzeDuplication(root, ['src/a.ts', 'src/b.ts']);
    expect(report.available).toBe(true);
    expect(report.statistics.clones).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('ne lance pas jscpd sur un périmètre vide, qui lui ferait lire toute la racine', () => {
    const root = makeRoot({ 'copie/a.ts': `${block}\n`, 'copie/b.ts': `${block}\n` });
    const { report } = analyzeDuplication(root, []);
    expect(report.available).toBe(false);
    expect(report.unavailableReason).toMatch(/aucun fichier/);
  });
});
