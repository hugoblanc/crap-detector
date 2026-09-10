import { describe, expect, it } from 'vitest';
import { defaultChurn, defaultScope } from '../../src/core/config.js';
import type { ChurnConfig } from '../../src/core/config.js';
import { buildImportGraph } from '../../src/imports/extract.js';
import type { ImportGraph, ImportRef } from '../../src/imports/extract.js';
import type { GitCommit } from '../../src/churn/git.js';
import {
  analyzeCoupling,
  computeCoChanges,
  couplingFindings,
} from '../../src/churn/coupling.js';

const scope = defaultScope();

function config(overrides: Partial<ChurnConfig> = {}): ChurnConfig {
  return { ...defaultChurn(), minCoChangeCommits: 2, minCoChangeDegree: 0.5, ...overrides };
}

/** N commits touchant chacun la liste de fichiers donnée. */
function commits(...touched: string[][]): GitCommit[] {
  return touched.map((files, index) => ({
    hash: `c${index}`,
    date: `2026-08-${String(index + 1).padStart(2, '0')}T10:00:00Z`,
    files: files.map((path) => ({ path, addedLines: 1, deletedLines: 0, binary: false })),
  }));
}

const emptyGraph: ImportGraph = { edges: new Map() };

function graphWith(edges: Record<string, string[]>): ImportGraph {
  const imports = new Map<string, ImportRef[]>();
  for (const file of new Set([...Object.keys(edges), ...Object.values(edges).flat()])) {
    imports.set(file, []);
  }
  for (const [from, targets] of Object.entries(edges)) {
    imports.set(
      from,
      targets.map((target, index) => ({
        specifier: `./${target.split('/').pop()?.replace(/\.ts$/, '.js')}`,
        kind: 'import' as const,
        specifierKind: 'relative' as const,
        line: index + 1,
      })),
    );
  }
  return buildImportGraph(imports);
}

describe('computeCoChanges', () => {
  it('compte les co-modifications et le degré du fichier le moins actif', () => {
    const pairs = computeCoChanges(
      commits(
        ['src/a.ts', 'src/b.ts'],
        ['src/a.ts', 'src/b.ts'],
        ['src/a.ts', 'src/c.ts'],
        ['src/a.ts', 'src/c.ts'],
      ),
      scope,
      config(),
      emptyGraph,
    );
    const ab = pairs.find((pair) => pair.fileB === 'src/b.ts');
    expect(ab).toMatchObject({
      fileA: 'src/a.ts',
      fileB: 'src/b.ts',
      together: 2,
      commitsA: 4,
      commitsB: 2,
      degree: 1,
    });
  });

  it('ignore les commits qui touchent trop de fichiers', () => {
    const wide = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const pairs = computeCoChanges(
      commits(wide, wide, wide),
      scope,
      config({ maxFilesPerCommit: 3 }),
      emptyGraph,
    );
    expect(pairs).toEqual([]);
  });

  it('ignore les commits mono-fichier', () => {
    const pairs = computeCoChanges(
      commits(['src/a.ts'], ['src/a.ts'], ['src/b.ts'], ['src/b.ts']),
      scope,
      config(),
      emptyGraph,
    );
    expect(pairs).toEqual([]);
  });

  it('écarte une paire sous le nombre minimum de co-modifications', () => {
    const pairs = computeCoChanges(
      commits(['src/a.ts', 'src/b.ts']),
      scope,
      config({ minCoChangeCommits: 2 }),
      emptyGraph,
    );
    expect(pairs).toEqual([]);
  });

  it('écarte une paire sous le degré minimum', () => {
    // a et b changent 8 fois chacun mais seulement 2 fois ensemble : degré 0,25.
    const history = [
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts'],
      ...Array.from({ length: 6 }, () => ['src/a.ts', 'src/c.ts']),
      ...Array.from({ length: 6 }, () => ['src/b.ts', 'src/d.ts']),
    ];
    const pairs = computeCoChanges(commits(...history), scope, config(), emptyGraph);
    const ab = pairs.find((pair) => pair.fileA === 'src/a.ts' && pair.fileB === 'src/b.ts');
    expect(ab).toBeUndefined();
    // Le degré se lit sur le fichier le moins actif : c ne bouge qu'avec a, donc 1.
    expect(pairs.find((pair) => pair.fileB === 'src/c.ts')).toMatchObject({ degree: 1 });
  });

  it('applique le scope avant l’appariement', () => {
    const pairs = computeCoChanges(
      commits(
        ['src/a.ts', 'src/b.ts', 'README.md', 'src/a.test.ts'],
        ['src/a.ts', 'src/b.ts', 'README.md', 'src/a.test.ts'],
      ),
      scope,
      config(),
      emptyGraph,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ fileA: 'src/a.ts', fileB: 'src/b.ts' });
  });

  it('marque linked quand un import relie la paire', () => {
    const history = [['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts']];
    const linked = computeCoChanges(
      commits(...history),
      scope,
      config(),
      graphWith({ 'src/a.ts': ['src/b.ts'] }),
    );
    expect(linked[0]?.linked).toBe(true);
    const unlinked = computeCoChanges(commits(...history), scope, config(), emptyGraph);
    expect(unlinked[0]?.linked).toBe(false);
  });

  it('trie par degré puis par nombre de co-modifications', () => {
    const history = [
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts'],
      ['src/c.ts', 'src/d.ts'],
      ['src/c.ts', 'src/d.ts'],
      ['src/c.ts', 'src/e.ts'],
      ['src/c.ts', 'src/e.ts'],
    ];
    const pairs = computeCoChanges(commits(...history), scope, config(), emptyGraph);
    expect(pairs[0]).toMatchObject({ fileA: 'src/a.ts', together: 3, degree: 1 });
  });
});

describe('couplingFindings', () => {
  const history = [['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts']];

  it('ne remonte que les paires sans import', () => {
    const hidden = computeCoChanges(commits(...history), scope, config(), emptyGraph);
    const findings = couplingFindings(hidden, config());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      tool: 'churn',
      rule: 'hidden-coupling',
      file: 'src/a.ts',
      symbol: 'src/b.ts',
      value: 100,
      threshold: 50,
    });
    expect(findings[0]?.message).toContain('2 commits');
  });

  it('se tait sur une paire explicitement liée par un import', () => {
    const linked = computeCoChanges(
      commits(...history),
      scope,
      config(),
      graphWith({ 'src/a.ts': ['src/b.ts'] }),
    );
    expect(couplingFindings(linked, config())).toEqual([]);
  });

  it('garde un id stable quel que soit l’ordre des commits', () => {
    const forward = couplingFindings(
      computeCoChanges(commits(...history), scope, config(), emptyGraph),
      config(),
    );
    const backward = couplingFindings(
      computeCoChanges(commits(...[...history].reverse()), scope, config(), emptyGraph),
      config(),
    );
    expect(backward[0]?.id).toBe(forward[0]?.id);
  });
});

describe('analyzeCoupling', () => {
  it('assemble résumé, paires et findings', () => {
    const report = analyzeCoupling(
      '/repo',
      commits(
        ['src/a.ts', 'src/b.ts'],
        ['src/a.ts', 'src/b.ts'],
        ['src/c.ts', 'src/d.ts'],
        ['src/c.ts', 'src/d.ts'],
      ),
      scope,
      config(),
      graphWith({ 'src/c.ts': ['src/d.ts'] }),
    );
    expect(report.toolVersion).toBe('git');
    expect(report.summary).toEqual({ pairs: 2, hiddenPairs: 1 });
    expect(report.findings.map((finding) => finding.file)).toEqual(['src/a.ts']);
  });

  it('rend un rapport vide sans historique', () => {
    const report = analyzeCoupling('/repo', [], scope, config(), emptyGraph);
    expect(report.summary).toEqual({ pairs: 0, hiddenPairs: 0 });
    expect(report.pairs).toEqual([]);
  });
});
