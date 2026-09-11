import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findPackageDir, parseJsonOutput, resolveTool, runTool } from '../../src/adapters/run.js';
import { analyzeDeadCode, mapKnipReport } from '../../src/adapters/knip.js';
import { analyzeDuplication, mapJscpdReport } from '../../src/adapters/jscpd.js';
import { resolveConfig } from '../../src/core/config.js';

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

  it('tolère une sortie vide ou malformée', () => {
    expect(mapKnipReport({}, scope, withTypes).findings).toEqual([]);
    expect(mapKnipReport({ issues: 'pas un tableau' }, scope, withTypes).findings).toEqual([]);
    expect(mapKnipReport({ issues: [{ exports: [{ name: 'x' }] }] }, scope, withTypes).findings).toEqual([]);
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
