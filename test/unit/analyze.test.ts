import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveConfig } from '../../src/core/config.js';
import type { ResolvedConfig } from '../../src/core/config.js';
import type { FileMetrics, FunctionMetrics } from '../../src/core/types.js';
import {
  analyzeProject,
  analyzeSourceText,
  collectFiles,
  findingsForFiles,
  summarizeFiles,
} from '../../src/metrics/analyze.js';

const config: ResolvedConfig = resolveConfig({});

function fn(overrides: Partial<FunctionMetrics> = {}): FunctionMetrics {
  return {
    symbol: 'f',
    file: 'src/a.ts',
    line: 1,
    endLine: 2,
    sloc: 2,
    cyclomatic: 1,
    cognitive: 0,
    params: 0,
    nestingDepth: 0,
    callbackDepth: 0,
    ...overrides,
  };
}

function file(overrides: Partial<FileMetrics> = {}): FileMetrics {
  const functions = overrides.functions ?? [];
  return {
    file: 'src/a.ts',
    sloc: 10,
    functionCount: functions.length,
    maxNestingDepth: 0,
    ...overrides,
    functions,
  };
}

describe('collectFiles', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'crap-detector-collect-'));
    const write = (rel: string, content: string): void => {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content, 'utf8');
    };
    write('src/a.ts', 'export const a = 1;\n');
    write('src/nested/b.tsx', 'export const b = 2;\n');
    write('src/types.d.ts', 'export declare const c: number;\n');
    write('src/a.test.ts', 'export const t = 1;\n');
    write('src/readme.md', '# hello\n');
    write('dist/built.ts', 'export const d = 4;\n');
    write('node_modules/pkg/index.ts', 'export const e = 5;\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rend des chemins POSIX relatifs, triés', () => {
    expect(collectFiles(root, config.scope)).toEqual(['src/a.ts', 'src/nested/b.tsx']);
  });

  it('exclut dist et node_modules sans descendre dedans', () => {
    const files = collectFiles(root, config.scope);
    expect(files.some((path) => path.startsWith('dist/'))).toBe(false);
    expect(files.some((path) => path.startsWith('node_modules/'))).toBe(false);
  });

  it('respecte un scope personnalisé', () => {
    expect(collectFiles(root, { include: ['src/*.ts'], exclude: [] }))
      .toEqual(['src/a.test.ts', 'src/a.ts', 'src/types.d.ts']);
  });

  it('écarte les dossiers et fichiers que git ignore', () => {
    expect(collectFiles(root, config.scope, { directories: new Set(['src/nested']), files: new Set() }))
      .toEqual(['src/a.ts']);
    expect(collectFiles(root, config.scope, { directories: new Set(), files: new Set(['src/a.ts']) }))
      .toEqual(['src/nested/b.tsx']);
  });

  it('rend une liste vide sur un répertoire inexistant', () => {
    expect(collectFiles(join(root, 'absent'), config.scope)).toEqual([]);
  });
});

describe('analyzeSourceText', () => {
  it('remonte une métrique par fonction, dans l’ordre du fichier', () => {
    const metrics = analyzeSourceText(
      [
        'export function loop(items: number[]): number {',
        '  let total = 0;',
        '  for (const item of items) {',
        '    if (item > 0) { total += item; }',
        '  }',
        '  return total;',
        '}',
        '',
        'export const noop = (): void => {};',
      ].join('\n'),
      'src/loop.ts',
    );
    expect(metrics.file).toBe('src/loop.ts');
    expect(metrics.functionCount).toBe(2);
    expect(metrics.sloc).toBe(8);
    const [loop, noop] = metrics.functions;
    expect(loop).toMatchObject({
      symbol: 'loop',
      file: 'src/loop.ts',
      line: 1,
      endLine: 7,
      sloc: 7,
      cyclomatic: 3,
      cognitive: 3,
      params: 1,
      nestingDepth: 2,
      callbackDepth: 0,
    });
    expect(noop?.symbol).toBe('noop');
    expect(metrics.maxNestingDepth).toBe(2);
  });
});

describe('summarizeFiles', () => {
  it('agrège compteurs, maxima et médiane', () => {
    const files = [
      file({ file: 'src/a.ts', sloc: 30, functions: [fn({ cyclomatic: 1 }), fn({ cyclomatic: 4 })] }),
      file({ file: 'src/b.ts', sloc: 12, functions: [fn({ cyclomatic: 12, cognitive: 20 })] }),
    ];
    expect(summarizeFiles(files, config)).toMatchObject({
      totalFiles: 2,
      totalSloc: 42,
      totalFunctions: 3,
      maxCyclomatic: 12,
      maxCognitive: 20,
      highCcFunctionCount: 1,
      medianCyclomatic: 4,
      medianFunctionSloc: 2,
      functionsPerFile: 1.5,
    });
  });

  it('prend la moyenne des deux valeurs centrales sur un effectif pair', () => {
    const files = [
      file({
        functions: [
          fn({ cyclomatic: 1 }),
          fn({ cyclomatic: 2 }),
          fn({ cyclomatic: 3 }),
          fn({ cyclomatic: 6 }),
        ],
      }),
    ];
    expect(summarizeFiles(files, config).medianCyclomatic).toBe(2.5);
  });

  it('rend des zéros sur un projet vide', () => {
    expect(summarizeFiles([], config)).toEqual({
      totalFiles: 0,
      totalSloc: 0,
      totalFunctions: 0,
      maxCyclomatic: 0,
      maxCognitive: 0,
      highCcFunctionCount: 0,
      medianCyclomatic: 0,
      erosionFraction: 0,
      erodedMass: 0,
      medianFunctionSloc: 0,
      functionsPerFile: 0,
    });
  });
});

describe('findingsForFiles', () => {
  const thresholds = config.thresholds;

  it('ne remonte rien quand tout est exactement au seuil', () => {
    const files = [
      file({
        sloc: thresholds.maxFileLines,
        functions: [
          fn({
            sloc: thresholds.maxLinesPerFunction,
            cyclomatic: thresholds.cyclomaticComplexity,
            cognitive: thresholds.cognitiveComplexity,
            params: thresholds.maxParams,
            nestingDepth: thresholds.maxDepth,
            callbackDepth: thresholds.maxNestedCallbacks,
          }),
        ],
      }),
    ];
    expect(findingsForFiles(files, config)).toEqual([]);
  });

  it('remonte une règle par dépassement, avec valeur et seuil', () => {
    const files = [
      file({
        sloc: thresholds.maxFileLines + 1,
        functions: [
          fn({
            symbol: 'big',
            sloc: thresholds.maxLinesPerFunction + 1,
            cyclomatic: thresholds.cyclomaticComplexity + 1,
            cognitive: thresholds.cognitiveComplexity + 1,
            params: thresholds.maxParams + 1,
            nestingDepth: thresholds.maxDepth + 1,
            callbackDepth: thresholds.maxNestedCallbacks + 1,
          }),
        ],
      }),
    ];
    const rules = (active: ResolvedConfig): string[] =>
      findingsForFiles(files, active).map((finding) => finding.rule).sort();
    expect(rules(config)).toEqual([
      'cognitive-complexity',
      'cyclomatic-complexity',
      'file-length',
      'function-length',
      'nesting-depth',
      'too-many-params',
    ]);
    expect(rules(resolveConfig({ rules: { 'nested-callbacks': true } }))).toContain('nested-callbacks');
  });

  it('marque ce qui dépasse le seuil du cliquet sans dépasser celui de signalement', () => {
    const files = [
      file({ functions: [fn({ symbol: 'long', sloc: 60 }), fn({ symbol: 'huge', line: 2, sloc: 120 })] }),
    ];
    const marks = findingsForFiles(files, config).map((finding) => [finding.symbol, finding.belowReportThreshold]);
    expect(marks.sort()).toEqual([['huge', undefined], ['long', true]]);
  });

  it('porte tool, file, symbol, ligne, valeur et seuil sur un finding de complexité', () => {
    const files = [
      file({ functions: [fn({ symbol: 'hot', line: 42, cyclomatic: 25 })] }),
    ];
    const finding = findingsForFiles(files, config)
      .find((entry) => entry.rule === 'cyclomatic-complexity');
    expect(finding).toMatchObject({
      tool: 'metrics',
      file: 'src/a.ts',
      symbol: 'hot',
      line: 42,
      value: 25,
      threshold: thresholds.cyclomaticComplexity,
      severity: 'critical',
    });
  });

  it('trie par sévérité décroissante', () => {
    const files = [
      file({
        sloc: 1,
        functions: [
          fn({ symbol: 'mild', line: 1, cyclomatic: thresholds.cyclomaticComplexity + 1 }),
          fn({ symbol: 'severe', line: 2, cyclomatic: thresholds.cyclomaticComplexity * 3 }),
        ],
      }),
    ];
    const findings = findingsForFiles(files, config);
    expect(findings.map((finding) => finding.symbol)).toEqual(['severe', 'mild']);
  });
});

describe('analyzeProject', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'crap-detector-project-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src/hot.ts'),
      [
        'export function hot(items: number[], flag: boolean): number {',
        '  let total = 0;',
        '  for (const item of items) {',
        '    if (flag && item > 0) {',
        '      while (item > total) { total += 1; }',
        '    }',
        '  }',
        '  return total;',
        '}',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(join(root, 'src/calm.ts'), 'export const calm = (): number => 1;\n', 'utf8');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('analyse tout le scope et remplit l’enveloppe de provenance', () => {
    const report = analyzeProject(root, config);
    expect(report.filesScanned).toBe(2);
    expect(report.rootPath).toBe(root);
    expect(report.toolVersion).toBe('ts-morph');
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.files.map((entry) => entry.file)).toEqual(['src/calm.ts', 'src/hot.ts']);
    expect(report.summary.totalFunctions).toBe(2);
  });

  it('ne remonte aucun finding sur un code sous les seuils par défaut', () => {
    expect(analyzeProject(root, config).findings).toEqual([]);
  });

  it('remonte des findings dès que les seuils sont abaissés', () => {
    const strict = resolveConfig({ thresholds: { cyclomaticComplexity: 2, maxDepth: 1 } });
    const findings = analyzeProject(root, strict).findings;
    expect(findings.map((finding) => finding.rule).sort())
      .toEqual(['cyclomatic-complexity', 'nesting-depth']);
    expect(findings.every((finding) => finding.file === 'src/hot.ts')).toBe(true);
  });
});
