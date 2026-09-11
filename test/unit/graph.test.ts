import { describe, expect, it } from 'vitest';
import type { ImportGraph } from '../../src/imports/extract.js';
import {
  analyzeGraph,
  findCycles,
  findOrphans,
  graphFindings,
  stronglyConnectedComponents,
  summarizeGraph,
} from '../../src/imports/graph.js';

function graph(edges: Record<string, string[]>): ImportGraph {
  return {
    edges: new Map(Object.entries(edges).map(([file, targets]) => [file, new Set(targets)])),
  };
}

describe('stronglyConnectedComponents', () => {
  it('rend une composante par nœud sur un graphe acyclique', () => {
    const components = stronglyConnectedComponents(
      graph({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'], 'c.ts': [] }),
    );
    expect(components.map((component) => component.length)).toEqual([1, 1, 1]);
  });

  it('regroupe un cycle de trois fichiers', () => {
    const components = stronglyConnectedComponents(
      graph({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'], 'c.ts': ['a.ts'] }),
    );
    expect(components).toEqual([['a.ts', 'b.ts', 'c.ts']]);
  });

  it('sépare deux cycles indépendants', () => {
    const components = stronglyConnectedComponents(
      graph({
        'a.ts': ['b.ts'],
        'b.ts': ['a.ts'],
        'c.ts': ['d.ts'],
        'd.ts': ['c.ts'],
      }),
    );
    expect(components.map((component) => component.join(','))
      .sort()).toEqual(['a.ts,b.ts', 'c.ts,d.ts']);
  });

  it('tient une chaîne profonde sans déborder la pile', () => {
    const edges: Record<string, string[]> = {};
    const depth = 5000;
    for (let i = 0; i < depth; i += 1) {
      edges[`f${i}.ts`] = i + 1 < depth ? [`f${i + 1}.ts`] : [];
    }
    expect(stronglyConnectedComponents(graph(edges))).toHaveLength(depth);
  });
});

describe('findCycles', () => {
  it('ignore les composantes d’un seul fichier sans auto-import', () => {
    expect(findCycles(graph({ 'a.ts': ['b.ts'], 'b.ts': [] }))).toEqual([]);
  });

  it('remonte un auto-import comme cycle', () => {
    expect(findCycles(graph({ 'a.ts': ['a.ts'] }))).toEqual([{ files: ['a.ts'] }]);
  });

  it('classe les cycles du plus gros au plus petit', () => {
    const cycles = findCycles(
      graph({
        'a.ts': ['b.ts'],
        'b.ts': ['a.ts'],
        'x.ts': ['y.ts'],
        'y.ts': ['z.ts'],
        'z.ts': ['x.ts'],
      }),
    );
    expect(cycles.map((cycle) => cycle.files.length)).toEqual([3, 2]);
  });

  it('ignore une arête vers un fichier hors du graphe', () => {
    expect(findCycles(graph({ 'a.ts': ['hors-scope.ts'] }))).toEqual([]);
  });
});

describe('findOrphans', () => {
  it('ne retient que les fichiers sans arête entrante ni sortante', () => {
    const orphans = findOrphans(
      graph({
        'entry.ts': ['used.ts'],
        'used.ts': [],
        'orphan.ts': [],
      }),
    );
    expect(orphans).toEqual(['orphan.ts']);
  });

  it('ne considère pas un point d’entrée comme orphelin', () => {
    expect(findOrphans(graph({ 'cli.ts': ['core.ts'], 'core.ts': [] }))).toEqual([]);
  });

  it('compte les importeurs hors mesure, comme les tests', () => {
    expect(findOrphans(graph({ 'tested.ts': [], 'orphan.ts': [] }), new Set(['tested.ts']))).toEqual(['orphan.ts']);
  });
});

describe('graphFindings', () => {
  it('remonte un finding par cycle, avec une clé stable', () => {
    const findings = graphFindings([{ files: ['a.ts', 'b.ts'] }], []);
    expect(findings[0]).toMatchObject({
      tool: 'depcruise',
      rule: 'cycle',
      file: 'a.ts',
      symbol: 'a.ts,b.ts',
      value: 2,
    });
  });

  it('donne une sévérité croissante avec la taille du cycle', () => {
    const small = graphFindings([{ files: ['a.ts', 'b.ts'] }], [])[0];
    const large = graphFindings([{ files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }], [])[0];
    expect(small?.severity).toBe('major');
    expect(large?.severity).toBe('critical');
  });

  it('remonte les orphelins en mineur', () => {
    const findings = graphFindings([], ['orphan.ts']);
    expect(findings[0]).toMatchObject({ rule: 'orphan', file: 'orphan.ts', severity: 'minor' });
  });
});

describe('analyzeGraph', () => {
  it('assemble résumé, cycles et findings, sans orphelins : ils dépendent de knip', () => {
    const report = analyzeGraph(
      '/repo',
      graph({
        'a.ts': ['b.ts'],
        'b.ts': ['a.ts'],
        'orphan.ts': [],
      }),
    );
    expect(report.summary).toEqual({ cycles: 1, orphans: 0, largestCycle: 2 });
    expect(report.cycles).toEqual([{ files: ['a.ts', 'b.ts'] }]);
    expect(report.orphans).toEqual([]);
    expect(report.findings).toHaveLength(1);
  });

  it('rend un résumé nul sur un graphe sain', () => {
    expect(summarizeGraph([], [])).toEqual({ cycles: 0, orphans: 0, largestCycle: 0 });
  });
});
