import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultScope, defaultThresholds } from '../../src/core/config.js';
import { makeFinding } from '../../src/core/findings.js';
import type { Aggregates, Baseline, Finding, ScanReport } from '../../src/core/types.js';
import {
  BASELINE_FILENAME,
  activeTools,
  MAX_MEASURED_RULES,
  compareToBaseline,
  debtKey,
  incompatibilityReason,
  makeBaseline,
  readBaseline,
  summarizeDebt,
  writeBaseline,
} from '../../src/baseline/baseline.js';

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() ?? '', { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crap-detector-baseline-'));
  created.push(dir);
  return dir;
}

function finding(overrides: Partial<Finding> & Pick<Finding, 'rule' | 'file'>): Finding {
  return makeFinding({
    tool: overrides.tool ?? 'metrics',
    rule: overrides.rule,
    file: overrides.file,
    symbol: overrides.symbol ?? 'f',
    message: overrides.message ?? 'peu importe',
    ...(overrides.value === undefined ? {} : { value: overrides.value }),
    ...(overrides.threshold === undefined ? {} : { threshold: overrides.threshold }),
  });
}

interface ReportOptions {
  aggregates?: Aggregates;
  findings?: Finding[];
  withKnip?: boolean;
  withDuplication?: boolean;
  withCoupling?: boolean;
  thresholdOverride?: Partial<ReturnType<typeof defaultThresholds>>;
  include?: string[];
  gitignore?: boolean;
}

/** ScanReport minimal : seuls les champs que la baseline lit sont remplis. */
function report(options: ReportOptions = {}): ScanReport {
  const envelope = {
    generatorVersion: '0.1.0',
    generatedAt: '2026-08-26T10:00:00.000Z',
    rootPath: '/repo',
    toolVersion: 'ts-morph',
  };
  const scan = {
    ...envelope,
    filesScanned: 3,
    thresholds: { ...defaultThresholds(), ...options.thresholdOverride },
    scope: {
      include: options.include ?? defaultScope().include,
      exclude: defaultScope().exclude,
      gitignore: options.gitignore ?? true,
      toolsScoped: true,
      importRules: 2,
      subprojects: [],
    },
    metrics: { ...envelope, filesScanned: 3, summary: {} as never, files: [], findings: [] },
    slop: { ...envelope, summary: {} as never, findings: [] },
    imports: { ...envelope, manifestTrusted: true, summary: {} as never, findings: [] },
    dependencies: {
      ...envelope,
      summary: { cycles: 0, orphans: 0, largestCycle: 0 },
      cycles: [],
      orphans: [],
      findings: [],
    },
    aggregates: options.aggregates ?? {},
    findings: options.findings ?? [],
  } as unknown as ScanReport;

  if (options.withKnip === true) {
    scan.deadCode = {
      ...envelope,
      toolVersion: '6.32.2',
      available: true,
      summary: { unusedFiles: 0, unusedExports: 0, unusedTypes: 0, unusedDependencies: 0 },
      findings: [],
      outOfScope: 0,
    };
  }
  if (options.withDuplication === true) {
    scan.duplication = {
      ...envelope,
      toolVersion: '5.0.16',
      available: true,
      statistics: { clones: 0, duplicatedLines: 0, percent: 0 },
      findings: [],
      outOfScope: 0,
    };
  }
  if (options.withCoupling === true) {
    scan.coupling = {
      ...envelope,
      toolVersion: 'git',
      summary: { pairs: 0, hiddenPairs: 0 },
      pairs: [],
      findings: [],
    };
  }
  return scan;
}

describe('debtKey et summarizeDebt', () => {
  it('inclut l’outil, la règle et le fichier, jamais la ligne', () => {
    expect(debtKey(finding({ rule: 'cyclomatic-complexity', file: 'src/a.ts' })))
      .toBe('metrics|cyclomatic-complexity|src/a.ts');
  });

  it('compte les règles booléennes par clé, triées', () => {
    const { counts, maxima } = summarizeDebt([
      finding({ rule: 'empty-catch', file: 'src/a.ts' }),
      finding({ rule: 'boolean-ternary', file: 'src/a.ts', symbol: 'g' }),
      finding({ rule: 'boolean-ternary', file: 'src/a.ts', symbol: 'h' }),
    ]);
    expect(counts).toEqual({
      'metrics|boolean-ternary|src/a.ts': 2,
      'metrics|empty-catch|src/a.ts': 1,
    });
    expect(maxima).toEqual({});
    expect(Object.keys(counts)).toEqual(Object.keys(counts).sort());
  });

  it('retient le pire cas du fichier pour les règles à seuil', () => {
    const { counts, maxima } = summarizeDebt([
      finding({ rule: 'cognitive-complexity', file: 'src/a.ts', symbol: 'f', value: 156 }),
      finding({ rule: 'cognitive-complexity', file: 'src/a.ts', symbol: 'g', value: 32 }),
      finding({ rule: 'function-length', file: 'src/a.ts', symbol: 'f', value: 450 }),
    ]);
    expect(maxima).toEqual({
      'metrics|cognitive-complexity|src/a.ts': 156,
      'metrics|function-length|src/a.ts': 450,
    });
    expect(counts).toEqual({});
  });

  it('classe chaque règle mesurée au maximum du côté des maxima', () => {
    for (const rule of MAX_MEASURED_RULES) {
      const { counts, maxima } = summarizeDebt([finding({ rule, file: 'src/a.ts', value: 42 })]);
      expect(counts, rule).toEqual({});
      expect(maxima[`metrics|${rule}|src/a.ts`], rule).toBe(42);
    }
  });
});

describe('activeTools', () => {
  it('inclut toujours les analyseurs internes', () => {
    expect([...activeTools(report())].sort()).toEqual(['depcruise', 'imports', 'metrics']);
  });

  it('ajoute les outils réellement disponibles', () => {
    const tools = activeTools(report({ withKnip: true, withDuplication: true, withCoupling: true }));
    expect([...tools].sort()).toEqual(['churn', 'depcruise', 'imports', 'jscpd', 'knip', 'metrics']);
  });
});

describe('makeBaseline', () => {
  it('fige seuils, périmètre, agrégats et dette', () => {
    const baseline = makeBaseline(report({
      aggregates: { 'erosion.fraction': 0.412_345_678 },
      findings: [finding({ rule: 'cycle', file: 'src/a.ts' })],
      withKnip: true,
    }));
    expect(baseline.version).toBe(2);
    expect(baseline.generator.name).toBe('crap-detector');
    expect(baseline.toolVersions).toEqual({ 'ts-morph': 'ts-morph', knip: '6.32.2' });
    expect(baseline.aggregates['erosion.fraction']).toBe(0.412_346);
    expect(baseline.debtCounts).toEqual({ 'metrics|cycle|src/a.ts': 1 });
    expect(baseline.debtMaxima).toEqual({});
  });

  it('n’enregistre pas de zéro pour un agrégat non mesuré', () => {
    const baseline = makeBaseline(report({ aggregates: { 'erosion.fraction': 0.1 } }));
    expect(baseline.aggregates['duplication.percent']).toBeUndefined();
  });
});

describe('incompatibilityReason', () => {
  const baseline = makeBaseline(report({ withKnip: true }));

  it('accepte une baseline identique', () => {
    expect(incompatibilityReason(baseline, report({ withKnip: true }))).toBeUndefined();
  });

  it('refuse un changement de seuil', () => {
    const reason = incompatibilityReason(
      baseline,
      report({ withKnip: true, thresholdOverride: { cyclomaticComplexity: 12 } }),
    );
    expect(reason).toMatch(/cyclomaticComplexity/);
  });

  it('refuse un changement de périmètre', () => {
    expect(incompatibilityReason(baseline, report({ withKnip: true, include: ['src/**/*.ts'] })))
      .toMatch(/périmètre/);
  });

  it('refuse une baseline écrite sans le filtrage git, y compris sans le champ', () => {
    const withoutFilter = makeBaseline(report({ withKnip: true, gitignore: false }));
    expect(incompatibilityReason(withoutFilter, report({ withKnip: true })))
      .toMatch(/sans exclure les fichiers ignorés par git/);
    const { include, exclude, importRules } = baseline.scope;
    const legacy = { ...baseline, scope: { include, exclude, toolsScoped: true, importRules } } as unknown as Baseline;
    expect(incompatibilityReason(legacy, report({ withKnip: true })))
      .toMatch(/sans exclure les fichiers ignorés par git/);
  });

  it('refuse une baseline qui comptait knip et jscpd hors du périmètre', () => {
    const { include, exclude, gitignore, importRules } = baseline.scope;
    const legacy = { ...baseline, scope: { include, exclude, gitignore, importRules } } as unknown as Baseline;
    expect(incompatibilityReason(legacy, report({ withKnip: true })))
      .toMatch(/hors du périmètre : refaire la baseline/);
  });

  it('accepte sans ce champ une baseline écrite sans knip ni jscpd', () => {
    const withoutTools = makeBaseline(report());
    const { include, exclude, gitignore, importRules } = withoutTools.scope;
    const legacy = { ...withoutTools, scope: { include, exclude, gitignore, importRules } } as unknown as Baseline;
    expect(incompatibilityReason(legacy, report({ withKnip: true }))).toBeUndefined();
  });

  it('refuse une baseline écrite avec les règles d’imports antérieures, même sans outils', () => {
    const { include, exclude, gitignore, toolsScoped } = baseline.scope;
    const legacy = { ...baseline, scope: { include, exclude, gitignore, toolsScoped } } as unknown as Baseline;
    expect(incompatibilityReason(legacy, report({ withKnip: true }))).toMatch(/règles antérieures/);
    expect(incompatibilityReason({ ...legacy, toolVersions: { 'ts-morph': 'ts-morph' } }, report()))
      .toMatch(/règles antérieures/);
  });

  it('dit pourquoi un scan n’a pas pu appliquer le filtrage de la baseline', () => {
    const withoutGit = report({ withKnip: true, gitignore: false });
    withoutGit.scope.gitignoreUnavailableReason = 'fatal: not a git repository';
    expect(incompatibilityReason(baseline, withoutGit)).toMatch(/not a git repository/);
  });

  it('refuse un changement de version d’outil', () => {
    const upgraded = report({ withKnip: true });
    if (upgraded.deadCode !== undefined) upgraded.deadCode.toolVersion = '7.0.0';
    expect(incompatibilityReason(baseline, upgraded)).toMatch(/knip est passé de 6\.32\.2 à 7\.0\.0/);
  });

  it('tolère l’absence d’un outil (il sera simplement non comparé)', () => {
    expect(incompatibilityReason(baseline, report())).toBeUndefined();
  });

  it('refuse une baseline d’une autre version de format', () => {
    expect(incompatibilityReason({ ...baseline, version: 1 as 2 }, report({ withKnip: true })))
      .toMatch(/version 1/);
  });
});

describe('compareToBaseline', () => {
  it('passe quand rien ne bouge', () => {
    const current = report({
      aggregates: { 'erosion.fraction': 0.4 },
      findings: [
        finding({ rule: 'cycle', file: 'src/a.ts' }),
        finding({ rule: 'cognitive-complexity', file: 'src/a.ts', value: 40 }),
      ],
    });
    const result = compareToBaseline(makeBaseline(current), current);
    expect(result).toMatchObject({ comparable: true, passed: true, regressions: [] });
    // un agrégat, une règle comptée, une règle mesurée au maximum
    expect(result.unchangedCount).toBe(3);
  });

  it('accepte un découpage de fonction qui fait baisser le pire cas', () => {
    // Le cas réel qui a fait échouer le cliquet sur payment-stack : une fonction
    // de complexité cognitive 156 découpée en trois. Le compte d'occurrences
    // triple, le maximum du fichier chute — c'est une amélioration.
    const before = makeBaseline(report({
      findings: [
        finding({ rule: 'cognitive-complexity', file: 'src/big.ts', symbol: 'run', value: 156 }),
        finding({ rule: 'function-length', file: 'src/big.ts', symbol: 'run', value: 450 }),
      ],
    }));
    const after = report({
      findings: [
        finding({ rule: 'cognitive-complexity', file: 'src/big.ts', symbol: 'a', value: 77 }),
        finding({ rule: 'cognitive-complexity', file: 'src/big.ts', symbol: 'b', value: 32 }),
        finding({ rule: 'cognitive-complexity', file: 'src/big.ts', symbol: 'c', value: 18 }),
        finding({ rule: 'function-length', file: 'src/big.ts', symbol: 'a', value: 289 }),
        finding({ rule: 'function-length', file: 'src/big.ts', symbol: 'b', value: 88 }),
        finding({ rule: 'function-length', file: 'src/big.ts', symbol: 'c', value: 90 }),
      ],
    });
    const result = compareToBaseline(before, after);
    expect(result.regressions).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.improvements.map((entry) => entry.message)).toEqual([
      'metrics|cognitive-complexity|src/big.ts : 156 → 77',
      'metrics|function-length|src/big.ts : 450 → 289',
    ]);
  });

  it('refuse toujours une fonction qui empire, même seule dans son fichier', () => {
    const before = makeBaseline(report({
      findings: [finding({ rule: 'cognitive-complexity', file: 'src/a.ts', value: 40 })],
    }));
    const after = report({
      findings: [finding({ rule: 'cognitive-complexity', file: 'src/a.ts', value: 41 })],
    });
    const result = compareToBaseline(before, after);
    expect(result.passed).toBe(false);
    expect(result.regressions[0]).toMatchObject({
      kind: 'debt-increase',
      baselineValue: 40,
      currentValue: 41,
    });
  });

  it('refuse un fichier qui grossit sans gagner de violation', () => {
    // Le compte ne verrait rien : une violation file-length avant, une après.
    const before = makeBaseline(report({
      findings: [finding({ rule: 'file-length', file: 'src/a.ts', value: 301 })],
    }));
    const after = report({
      findings: [finding({ rule: 'file-length', file: 'src/a.ts', value: 3000 })],
    });
    expect(compareToBaseline(before, after).passed).toBe(false);
  });

  it('échoue et explique quand la baseline est incomparable', () => {
    const baseline = makeBaseline(report());
    const result = compareToBaseline(
      baseline,
      report({ thresholdOverride: { maxDepth: 5 } }),
    );
    expect(result).toMatchObject({ comparable: false, passed: false });
    expect(result.incompatibilityReason).toMatch(/maxDepth/);
  });

  it('signale une hausse d’agrégat comme régression', () => {
    const baseline = makeBaseline(report({ aggregates: { 'erosion.fraction': 0.4 } }));
    const result = compareToBaseline(baseline, report({ aggregates: { 'erosion.fraction': 0.45 } }));
    expect(result.passed).toBe(false);
    expect(result.regressions[0]).toMatchObject({
      kind: 'aggregate',
      key: 'erosion.fraction',
      baselineValue: 0.4,
      currentValue: 0.45,
    });
  });

  it('ne bronche pas sur un écart flottant négligeable', () => {
    const baseline = makeBaseline(report({ aggregates: { 'erosion.fraction': 0.4 } }));
    const result = compareToBaseline(
      baseline,
      report({ aggregates: { 'erosion.fraction': 0.400_000_1 } }),
    );
    expect(result.passed).toBe(true);
  });

  it('compte une baisse d’agrégat comme amélioration', () => {
    const baseline = makeBaseline(report({ aggregates: { 'erosion.fraction': 0.4 } }));
    const result = compareToBaseline(baseline, report({ aggregates: { 'erosion.fraction': 0.3 } }));
    expect(result.passed).toBe(true);
    expect(result.improvements[0]?.key).toBe('erosion.fraction');
  });

  it('distingue une nouvelle règle sur un fichier connu d’un fichier jusque-là propre', () => {
    const baseline = makeBaseline(report({
      findings: [finding({ rule: 'cycle', file: 'src/known.ts' })],
    }));
    const result = compareToBaseline(baseline, report({
      findings: [
        finding({ rule: 'cycle', file: 'src/known.ts' }),
        finding({ rule: 'empty-catch', file: 'src/known.ts' }),
        finding({ rule: 'empty-catch', file: 'src/fresh.ts' }),
      ],
    }));
    const kinds = result.regressions.map((regression) => regression.kind).sort();
    expect(kinds).toEqual(['debt-new-entry', 'debt-new-file']);
  });

  it('signale une augmentation du compteur d’une entrée existante', () => {
    const baseline = makeBaseline(report({
      findings: [finding({ rule: 'empty-catch', file: 'src/a.ts', symbol: 'f' })],
    }));
    const result = compareToBaseline(baseline, report({
      findings: [
        finding({ rule: 'empty-catch', file: 'src/a.ts', symbol: 'f' }),
        finding({ rule: 'empty-catch', file: 'src/a.ts', symbol: 'g' }),
      ],
    }));
    expect(result.regressions[0]).toMatchObject({
      kind: 'debt-increase',
      baselineValue: 1,
      currentValue: 2,
    });
  });

  it('ne compte pas comme amélioration la dette d’un outil qui n’a pas tourné', () => {
    const baseline = makeBaseline(report({
      withKnip: true,
      findings: [finding({ tool: 'knip', rule: 'unused-export', file: 'src/a.ts' })],
    }));
    const result = compareToBaseline(baseline, report());
    expect(result.improvements).toEqual([]);
    expect(result.skippedKeys).toContain('knip|unused-export|src/a.ts');
    expect(result.passed).toBe(true);
  });

  it('ne compare pas les orphelins mesurés d’un seul côté, dans un sens comme dans l’autre', () => {
    const orphan = finding({ tool: 'depcruise', rule: 'orphan', file: 'src/lost.ts' });
    const withKnip = makeBaseline(report({ withKnip: true }));
    const noTools = report({ aggregates: { 'orphans.count': 1 }, findings: [orphan] });
    const againstKnip = compareToBaseline(withKnip, noTools);
    expect(againstKnip.passed).toBe(true);
    expect(againstKnip.skippedKeys).toContain('depcruise|orphan|src/lost.ts');

    const againstNoTools = compareToBaseline(makeBaseline(noTools), report({ withKnip: true }));
    expect(againstNoTools.improvements).toEqual([]);
    expect(againstNoTools.skippedKeys).toContain('depcruise|orphan|src/lost.ts');

    const bothMeasured = compareToBaseline(makeBaseline(report({ aggregates: { 'orphans.count': 0 } })), noTools);
    expect(bothMeasured.passed).toBe(false);
  });

  it('compte bien l’amélioration quand l’outil a tourné et ne trouve plus rien', () => {
    const baseline = makeBaseline(report({
      withKnip: true,
      findings: [finding({ tool: 'knip', rule: 'unused-export', file: 'src/a.ts' })],
    }));
    const result = compareToBaseline(baseline, report({ withKnip: true }));
    expect(result.improvements[0]?.key).toBe('knip|unused-export|src/a.ts');
  });

  it('tolère un ratio dilué par la suppression de code sain', () => {
    // Cas réel rencontré sur payment-stack : supprimer une fonction simple et un
    // script trivial fait monter la part de complexité restante, sans que rien
    // n'ait empiré. La masse érodée, elle, n'a pas bougé.
    const baseline = makeBaseline(report({
      aggregates: { 'erosion.fraction': 0.602, 'erosion.mass': 12_000 },
    }));
    const result = compareToBaseline(baseline, report({
      aggregates: { 'erosion.fraction': 0.6023, 'erosion.mass': 12_000 },
    }));
    expect(result.passed).toBe(true);
    expect(result.regressions).toEqual([]);
    expect(result.notes[0]).toMatch(/erosion\.fraction monte à .* erosion\.mass n'a pas augmenté/);
  });

  it('échoue quand le ratio et sa masse montent tous les deux', () => {
    const baseline = makeBaseline(report({
      aggregates: { 'erosion.fraction': 0.602, 'erosion.mass': 12_000 },
    }));
    const result = compareToBaseline(baseline, report({
      aggregates: { 'erosion.fraction': 0.6023, 'erosion.mass': 12_500 },
    }));
    expect(result.passed).toBe(false);
    expect(result.regressions[0]?.key).toBe('erosion.fraction');
    expect(result.notes).toEqual([]);
  });

  it('applique la même tolérance à la verbosité et à la duplication', () => {
    const baseline = makeBaseline(report({
      aggregates: {
        'verbosity.fraction': 0.05,
        'verbosity.lines': 900,
        'duplication.percent': 2.6,
        'duplication.lines': 5000,
      },
    }));
    const result = compareToBaseline(baseline, report({
      aggregates: {
        'verbosity.fraction': 0.052,
        'verbosity.lines': 900,
        'duplication.percent': 2.7,
        'duplication.lines': 4900,
      },
    }));
    expect(result.passed).toBe(true);
    expect(result.notes).toHaveLength(2);
  });

  it('compare strictement le ratio quand la masse manque d’un côté', () => {
    // Baseline antérieure à l'introduction des grandeurs absolues : on ne peut
    // rien conclure, donc on ne relâche pas le gate.
    const baseline = makeBaseline(report({ aggregates: { 'erosion.fraction': 0.602 } }));
    const result = compareToBaseline(baseline, report({
      aggregates: { 'erosion.fraction': 0.61, 'erosion.mass': 12_000 },
    }));
    expect(result.passed).toBe(false);
  });

  it('signale la masse érodée elle-même quand elle augmente', () => {
    const baseline = makeBaseline(report({
      aggregates: { 'erosion.fraction': 0.6, 'erosion.mass': 12_000 },
    }));
    const result = compareToBaseline(baseline, report({
      aggregates: { 'erosion.fraction': 0.6, 'erosion.mass': 13_000 },
    }));
    expect(result.passed).toBe(false);
    expect(result.regressions[0]?.key).toBe('erosion.mass');
  });

  it('ne compare pas un agrégat mesuré d’un seul côté', () => {
    const baseline = makeBaseline(report({ aggregates: { 'duplication.percent': 3 } }));
    const result = compareToBaseline(baseline, report({ aggregates: {} }));
    expect(result.skippedKeys).toContain('duplication.percent');
    expect(result.passed).toBe(true);
  });
});

describe('lecture et écriture', () => {
  it('fait un aller-retour fidèle', () => {
    const dir = tempDir();
    const path = join(dir, BASELINE_FILENAME);
    const baseline = makeBaseline(report({ aggregates: { 'erosion.fraction': 0.4 } }));
    writeBaseline(path, baseline);
    expect(readBaseline(path)).toEqual(baseline);
  });

  it('refuse un fichier qui n’est pas une baseline', () => {
    const dir = tempDir();
    const path = join(dir, 'faux.json');
    writeFileSync(path, JSON.stringify({ hello: 'world' }), 'utf8');
    expect(() => readBaseline(path)).toThrow(/baseline crap-detector valide/);
  });

  it('refuse un JSON qui n’est pas un objet', () => {
    const dir = tempDir();
    const path = join(dir, 'liste.json');
    writeFileSync(path, '[]', 'utf8');
    expect(() => readBaseline(path)).toThrow();
  });
});
