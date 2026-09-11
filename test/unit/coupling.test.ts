import { describe, expect, it } from 'vitest';
import { defaultChurn, defaultScope } from '../../src/core/config.js';
import type { ChurnConfig } from '../../src/core/config.js';
import { buildImportGraph } from '../../src/imports/extract.js';
import type { ImportGraph, ImportRef } from '../../src/imports/extract.js';
import type { GitCommit, GitFileChange } from '../../src/churn/git.js';
import {
  analyzeCoupling,
  computeCoChanges,
  couplingFindings,
} from '../../src/churn/coupling.js';

const scope = defaultScope();

function config(overrides: Partial<ChurnConfig> = {}): ChurnConfig {
  return { ...defaultChurn(), minCoChangeCommits: 2, minCoChangeDegree: 0.5, minHistoryCommits: 0, ...overrides };
}

/** N commits touchant chacun la liste de fichiers donnée. */
function commits(...touched: string[][]): GitCommit[] {
  return touched.map((files, index) => ({
    hash: `c${index}`,
    date: `2026-08-${String(index + 1).padStart(2, '0')}T10:00:00Z`,
    files: files.map((path) => ({ path, addedLines: 1, deletedLines: 0, binary: false })),
  }));
}

/** Fichiers présents dans le périmètre courant, sauf mention contraire. */
const PRESENT = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/index.ts', 'src/types.ts'];

function graphWith(edges: Record<string, string[]>): ImportGraph {
  const imports = new Map<string, ImportRef[]>(PRESENT.map((file) => [file, []]));
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

const unlinked = graphWith({});

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
      unlinked,
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
      unlinked,
    );
    expect(pairs).toEqual([]);
  });

  it('ignore les commits mono-fichier', () => {
    const pairs = computeCoChanges(
      commits(['src/a.ts'], ['src/a.ts'], ['src/b.ts'], ['src/b.ts']),
      scope,
      config(),
      unlinked,
    );
    expect(pairs).toEqual([]);
  });

  it('écarte une paire sous le nombre minimum de co-modifications', () => {
    const pairs = computeCoChanges(
      commits(['src/a.ts', 'src/b.ts']),
      scope,
      config({ minCoChangeCommits: 2 }),
      unlinked,
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
    const pairs = computeCoChanges(commits(...history), scope, config(), unlinked);
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
      unlinked,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ fileA: 'src/a.ts', fileB: 'src/b.ts' });
  });

  it('ignore une paire dont un fichier n’existe plus dans le périmètre', () => {
    const history = [['src/a.ts', 'src/deleted.ts'], ['src/a.ts', 'src/deleted.ts']];
    expect(computeCoChanges(commits(...history), scope, config(), unlinked)).toEqual([]);
  });

  it('ramène un fichier renommé depuis à son nom actuel', () => {
    const history = commits(['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/old.ts']);
    // Le plus récent d'abord : le premier commit renomme old.ts en b.ts.
    const rename: GitFileChange = { path: 'src/b.ts', previousPath: 'src/old.ts', addedLines: 1, deletedLines: 0, binary: false };
    history[0]?.files.splice(1, 1, rename);
    const pairs = computeCoChanges(history, scope, config(), unlinked);
    expect(pairs).toEqual([expect.objectContaining({ fileA: 'src/a.ts', fileB: 'src/b.ts', together: 2 })]);
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
    const hidden = computeCoChanges(commits(...history), scope, config(), unlinked);
    expect(hidden[0]?.linked).toBe(false);
  });

  it('marque linked une paire reliée par un barrel ou un intermédiaire, pas au-delà de deux imports', () => {
    const history = commits(['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts']);
    const barrel = graphWith({ 'src/a.ts': ['src/index.ts'], 'src/index.ts': ['src/b.ts'] });
    expect(computeCoChanges(history, scope, config(), barrel)[0]?.linked).toBe(true);
    const tooFar = graphWith({ 'src/a.ts': ['src/c.ts'], 'src/c.ts': ['src/d.ts'], 'src/d.ts': ['src/b.ts'] });
    expect(computeCoChanges(history, scope, config(), tooFar)[0]?.linked).toBe(false);
  });

  it('marque linked deux importeurs d’un même module de types, pas d’un module ordinaire', () => {
    const history = commits(['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts']);
    const shared = graphWith({ 'src/a.ts': ['src/types.ts'], 'src/b.ts': ['src/types.ts'] });
    expect(computeCoChanges(history, scope, config(), shared)[0]?.linked).toBe(false);
    const contract = { ...shared, typesModules: new Set(['src/types.ts']) };
    expect(computeCoChanges(history, scope, config(), contract)[0]?.linked).toBe(true);
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
    const pairs = computeCoChanges(commits(...history), scope, config(), unlinked);
    expect(pairs[0]).toMatchObject({ fileA: 'src/a.ts', together: 3, degree: 1 });
  });
});

describe('couplingFindings', () => {
  const history = [['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts']];

  it('ne remonte que les paires sans import', () => {
    const hidden = computeCoChanges(commits(...history), scope, config(), unlinked);
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
      computeCoChanges(commits(...history), scope, config(), unlinked),
      config(),
    );
    const backward = couplingFindings(
      computeCoChanges(commits(...[...history].reverse()), scope, config(), unlinked),
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
    expect(report?.toolVersion).toBe('git');
    expect(report?.summary).toEqual({ pairs: 2, hiddenPairs: 1 });
    expect(report?.findings.map((finding) => finding.file)).toEqual(['src/a.ts']);
  });

  it('rend un rapport vide sans historique', () => {
    const report = analyzeCoupling('/repo', [], scope, config(), unlinked);
    expect(report?.summary).toEqual({ pairs: 0, hiddenPairs: 0 });
    expect(report?.pairs).toEqual([]);
  });

  it('ne mesure rien sur un historique trop court, même avec une paire à 100 %', () => {
    const history = commits(...Array.from({ length: 5 }, () => ['src/a.ts', 'src/b.ts']));
    expect(analyzeCoupling('/repo', history, scope, config({ minHistoryCommits: 5 }), unlinked)?.findings).toHaveLength(1);
    expect(analyzeCoupling('/repo', history, scope, config({ minHistoryCommits: 6 }), unlinked)).toBeUndefined();
  });
});
