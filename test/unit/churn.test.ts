import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultScope, resolveConfig } from '../../src/core/config.js';
import type { FileChurn, FileMetrics } from '../../src/core/types.js';
import { parseGitLog, windowStartDate } from '../../src/churn/git.js';
import {
  aggregateChurn,
  analyzeChurn,
  computeHotspots,
  summarizeChurn,
} from '../../src/churn/analyze.js';

const MARKER = '\u0001';
const SEPARATOR = '\u001f';

/** Construit une sortie `git log --numstat -z` synthétique. */
function log(...commits: Array<{ hash: string; date: string; records: string[] }>): string {
  return commits
    .map(({ hash, date, records }) =>
      `${MARKER}${hash}${SEPARATOR}${date}\0\n${records.map((record) => `${record}\0`).join('')}`)
    .join('');
}

describe('parseGitLog', () => {
  it('lit hash, date et numstat d’un commit simple', () => {
    const commits = parseGitLog(
      log({ hash: 'abc', date: '2026-08-26T10:00:00+02:00', records: ['12\t3\tsrc/a.ts'] }),
    );
    expect(commits).toEqual([
      {
        hash: 'abc',
        date: '2026-08-26T10:00:00+02:00',
        files: [{ path: 'src/a.ts', addedLines: 12, deletedLines: 3, binary: false }],
      },
    ]);
  });

  it('reconstitue un renommage à partir des trois enregistrements', () => {
    const commits = parseGitLog(
      log({
        hash: 'abc',
        date: '2026-08-26T10:00:00Z',
        records: ['1\t0\t', 'src/old.ts', 'src/new.ts'],
      }),
    );
    expect(commits[0]?.files).toEqual([
      {
        path: 'src/new.ts',
        previousPath: 'src/old.ts',
        addedLines: 1,
        deletedLines: 0,
        binary: false,
      },
    ]);
  });

  it('marque les fichiers binaires sans compter de lignes', () => {
    const commits = parseGitLog(
      log({ hash: 'abc', date: '2026-08-26T10:00:00Z', records: ['-\t-\tlogo.png'] }),
    );
    expect(commits[0]?.files[0]).toEqual({
      path: 'logo.png',
      addedLines: 0,
      deletedLines: 0,
      binary: true,
    });
  });

  it('accepte un commit sans fichier et une sortie vide', () => {
    expect(parseGitLog('')).toEqual([]);
    const commits = parseGitLog(
      log(
        { hash: 'empty', date: '2026-08-26T10:00:00Z', records: [] },
        { hash: 'next', date: '2026-08-25T10:00:00Z', records: ['1\t1\tsrc/a.ts'] },
      ),
    );
    expect(commits.map((commit) => commit.hash)).toEqual(['empty', 'next']);
    expect(commits[0]?.files).toEqual([]);
  });

  it('préserve une tabulation présente dans le chemin', () => {
    const commits = parseGitLog(
      log({ hash: 'abc', date: '2026-08-26T10:00:00Z', records: ['1\t0\tsrc/we\tird.ts'] }),
    );
    expect(commits[0]?.files[0]?.path).toBe('src/we\tird.ts');
  });
});

describe('aggregateChurn', () => {
  const scope = defaultScope();

  it('additionne commits et lignes par fichier', () => {
    const commits = parseGitLog(
      log(
        { hash: 'c2', date: '2026-08-26T10:00:00Z', records: ['10\t2\tsrc/a.ts', '1\t0\tsrc/b.ts'] },
        { hash: 'c1', date: '2026-08-20T10:00:00Z', records: ['5\t1\tsrc/a.ts'] },
      ),
    );
    expect(aggregateChurn(commits, scope)).toEqual([
      {
        file: 'src/a.ts',
        commits: 2,
        addedLines: 15,
        deletedLines: 3,
        firstChange: '2026-08-20T10:00:00Z',
        lastChange: '2026-08-26T10:00:00Z',
      },
      {
        file: 'src/b.ts',
        commits: 1,
        addedLines: 1,
        deletedLines: 0,
        firstChange: '2026-08-26T10:00:00Z',
        lastChange: '2026-08-26T10:00:00Z',
      },
    ]);
  });

  it('suit les renommages et attribue l’historique au nom actuel', () => {
    const commits = parseGitLog(
      log(
        { hash: 'c3', date: '2026-08-26T10:00:00Z', records: ['1\t1\tsrc/new.ts'] },
        {
          hash: 'c2',
          date: '2026-08-25T10:00:00Z',
          records: ['0\t0\t', 'src/old.ts', 'src/new.ts'],
        },
        { hash: 'c1', date: '2026-08-24T10:00:00Z', records: ['30\t0\tsrc/old.ts'] },
      ),
    );
    const churn = aggregateChurn(commits, scope);
    expect(churn).toHaveLength(1);
    expect(churn[0]).toMatchObject({
      file: 'src/new.ts',
      commits: 3,
      addedLines: 31,
      firstChange: '2026-08-24T10:00:00Z',
    });
  });

  it('applique le scope : ni tests, ni node_modules, ni fichiers non TypeScript', () => {
    const commits = parseGitLog(
      log({
        hash: 'c1',
        date: '2026-08-26T10:00:00Z',
        records: [
          '1\t0\tsrc/a.ts',
          '1\t0\tsrc/a.test.ts',
          '1\t0\tnode_modules/pkg/index.ts',
          '1\t0\tREADME.md',
        ],
      }),
    );
    expect(aggregateChurn(commits, scope).map((entry) => entry.file)).toEqual(['src/a.ts']);
  });

  it('trie par nombre de commits décroissant', () => {
    const commits = parseGitLog(
      log(
        { hash: 'c2', date: '2026-08-26T10:00:00Z', records: ['1\t0\tsrc/a.ts', '1\t0\tsrc/b.ts'] },
        { hash: 'c1', date: '2026-08-25T10:00:00Z', records: ['1\t0\tsrc/b.ts'] },
      ),
    );
    expect(aggregateChurn(commits, scope).map((entry) => entry.file))
      .toEqual(['src/b.ts', 'src/a.ts']);
  });
});

describe('computeHotspots', () => {
  function metrics(file: string, cyclomatic: number, cognitive: number): FileMetrics {
    return {
      file,
      sloc: 10,
      functionCount: 1,
      maxNestingDepth: 0,
      functions: [
        {
          symbol: 'f',
          file,
          line: 1,
          endLine: 2,
          sloc: 2,
          cyclomatic,
          cognitive,
          params: 0,
          nestingDepth: 0,
          callbackDepth: 0,
        },
      ],
    };
  }

  function churnEntry(file: string, commits: number): FileChurn {
    return { file, commits, addedLines: 0, deletedLines: 0, firstChange: '', lastChange: '' };
  }

  const churn = [
    churnEntry('src/simple.ts', 40),
    churnEntry('src/hot.ts', 12),
    churnEntry('src/gone.ts', 99),
  ];

  it('classe par commits × max(cyclomatique, cognitive)', () => {
    const hotspots = computeHotspots(churn, [
      metrics('src/simple.ts', 2, 1),
      metrics('src/hot.ts', 8, 20),
    ]);
    expect(hotspots.map((hotspot) => [hotspot.file, hotspot.score])).toEqual([
      ['src/hot.ts', 240],
      ['src/simple.ts', 80],
    ]);
  });

  it('ignore un fichier absent des métriques (supprimé ou hors scope)', () => {
    const hotspots = computeHotspots(churn, [metrics('src/hot.ts', 8, 20)]);
    expect(hotspots.map((hotspot) => hotspot.file)).toEqual(['src/hot.ts']);
  });

  it('donne un score nul à un fichier sans fonction mesurée', () => {
    const barrel: FileMetrics = {
      file: 'src/simple.ts',
      sloc: 5,
      functionCount: 0,
      maxNestingDepth: 0,
      functions: [],
    };
    expect(computeHotspots(churn, [barrel])[0]).toMatchObject({ score: 0, maxCyclomatic: 0 });
  });
});

describe('summarizeChurn', () => {
  it('totalise commits, fichiers et lignes', () => {
    const summary = summarizeChurn(7, [
      { file: 'a.ts', commits: 2, addedLines: 10, deletedLines: 4, firstChange: '', lastChange: '' },
      { file: 'b.ts', commits: 1, addedLines: 3, deletedLines: 0, firstChange: '', lastChange: '' },
    ]);
    expect(summary).toEqual({ commitsScanned: 7, filesChanged: 2, addedLines: 13, deletedLines: 4 });
  });
});

describe('windowStartDate', () => {
  it('recule de la fenêtre demandée et rend une date ISO courte', () => {
    expect(windowStartDate(30, new Date('2026-08-26T12:00:00Z'))).toBe('2026-07-27');
    expect(windowStartDate(0, new Date('2026-08-26T12:00:00Z'))).toBe('2026-08-26');
  });
});

describe('analyzeChurn', () => {
  const config = resolveConfig({});
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'crap-detector-churn-'));
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), 'export const a = (): number => 1;\n', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'premier');
    writeFileSync(
      join(root, 'src/a.ts'),
      [
        'export const a = (flag: boolean): number => {',
        '  if (flag) { return 1; }',
        '  return 2;',
        '};',
      ].join('\n'),
      'utf8',
    );
    git('add', '-A');
    git('commit', '-qm', 'second');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lit un vrai dépôt et remonte le churn du fichier', () => {
    const report = analyzeChurn(root, config, [], { now: new Date() });
    expect(report.available).toBe(true);
    expect(report.toolVersion).toBe('git');
    expect(report.summary.commitsScanned).toBe(2);
    expect(report.files).toHaveLength(1);
    expect(report.files[0]).toMatchObject({ file: 'src/a.ts', commits: 2 });
    expect(report.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('signale l’absence de dépôt sans lever', () => {
    const outside = mkdtempSync(join(tmpdir(), 'crap-detector-nogit-'));
    try {
      const report = analyzeChurn(outside, config, []);
      expect(report.available).toBe(false);
      expect(report.unavailableReason).toBeDefined();
      expect(report.files).toEqual([]);
      expect(report.hotspots).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('accepte une plage de révisions au lieu de la fenêtre en jours', () => {
    const report = analyzeChurn(root, config, [], { range: 'HEAD~1..HEAD' });
    expect(report.since).toBe('HEAD~1..HEAD');
    expect(report.summary.commitsScanned).toBe(1);
  });
});
