import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { numberOption, parseArgs } from '../../src/cli/args.js';
import {
  renderCompare,
  renderFinding,
  renderFindings,
  renderHotspots,
} from '../../src/cli/render.js';
import { makeFinding } from '../../src/core/findings.js';
import type { CompareResult, Hotspot } from '../../src/core/types.js';
import { main } from '../../src/cli.js';

describe('parseArgs', () => {
  it('sépare commande, positionnels, drapeaux et valeurs', () => {
    const args = parseArgs(['scan', 'src/a.ts', '--json', '--root', '/repo', '--top=5']);
    expect(args.command).toBe('scan');
    expect(args.positionals).toEqual(['src/a.ts']);
    expect(args.flags.has('json')).toBe(true);
    expect(args.values.get('root')).toBe('/repo');
    expect(args.values.get('top')).toBe('5');
  });

  it('traite une option inconnue comme un drapeau, pas comme une valeur', () => {
    const args = parseArgs(['scan', '--no-git', '--no-tools']);
    expect(args.flags.has('no-git')).toBe(true);
    expect(args.flags.has('no-tools')).toBe(true);
    expect(args.positionals).toEqual([]);
  });

  it('lève quand une option à valeur n’en reçoit pas', () => {
    expect(() => parseArgs(['scan', '--root'])).toThrow(/--root/);
  });

  it('rend une commande vide sur une invocation sans argument', () => {
    expect(parseArgs([]).command).toBe('');
  });
});

describe('numberOption', () => {
  it('rend la valeur par défaut quand l’option est absente', () => {
    expect(numberOption(parseArgs(['scan']), 'top', 10)).toBe(10);
  });

  it('refuse une valeur non numérique ou négative', () => {
    expect(() => numberOption(parseArgs(['scan', '--top', 'beaucoup']), 'top', 10)).toThrow(/--top/);
    expect(() => numberOption(parseArgs(['scan', '--top', '-3']), 'top', 10)).toThrow(/--top/);
  });
});

describe('rendu', () => {
  const finding = makeFinding({
    tool: 'metrics',
    rule: 'cyclomatic-complexity',
    file: 'src/a.ts',
    line: 42,
    symbol: 'hot',
    value: 25,
    threshold: 10,
    message: 'hot : complexité cyclomatique 25 > 10',
  });

  it('préfixe chaque ligne par fichier:ligne', () => {
    expect(renderFinding(finding)).toContain('src/a.ts:42');
    expect(renderFinding(finding)).toContain('[cyclomatic-complexity]');
  });

  it('tronque et annonce le reste au-delà de la limite', () => {
    const lines = renderFindings([finding, finding, finding], 1);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('2 autres');
  });

  it('annonce l’absence de hotspots plutôt qu’une liste vide', () => {
    expect(renderHotspots([], 10)[0]).toMatch(/aucun hotspot/);
  });

  it('classe les hotspots avec leur score', () => {
    const hotspot: Hotspot = {
      file: 'src/hot.ts',
      commits: 12,
      addedLines: 0,
      deletedLines: 0,
      maxCyclomatic: 8,
      maxCognitive: 20,
      score: 240,
    };
    expect(renderHotspots([hotspot], 10)[0]).toContain('src/hot.ts  score 240');
  });

  it('dirige vers un nouveau snapshot quand la baseline est incomparable', () => {
    const result: CompareResult = {
      comparable: false,
      incompatibilityReason: 'seuil maxDepth modifié',
      passed: false,
      regressions: [],
      improvements: [],
      unchangedCount: 0,
      skippedKeys: [],
      notes: [],
    };
    expect(renderCompare(result).join('\n')).toContain('crap-detector baseline');
  });
});

describe('main', () => {
  const created: string[] = [];
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (created.length > 0) {
      rmSync(created.pop() ?? '', { recursive: true, force: true });
    }
  });

  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'crap-detector-cli-'));
    created.push(root);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'fixture', dependencies: {} }),
      'src/clean.ts': 'export const add = (a: number, b: number): number => a + b;\n',
      'src/dirty.ts': [
        'export function dirty(value: any): number {',
        '  try { return value; } catch (error) {}',
        '  return 0;',
        '}',
      ].join('\n'),
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content, 'utf8');
    }
    return root;
  }

  it('affiche l’aide et sort en erreur d’usage sans commande', async () => {
    expect(await main([])).toBe(3);
    expect(out.join('')).toContain('crap-detector scan');
  });

  it('affiche l’aide et sort 0 sur --help', async () => {
    expect(await main(['help'])).toBe(0);
  });

  it('refuse une commande inconnue', async () => {
    expect(await main(['danser'])).toBe(3);
    expect(err.join('')).toContain('commande inconnue');
  });

  it('sort 2 et écrit sur stderr quand un fichier viole une règle', async () => {
    const root = fixture();
    const code = await main(['file', join(root, 'src/dirty.ts'), '--root', root]);
    expect(code).toBe(2);
    expect(err.join('')).toContain('empty-catch');
    expect(out.join('')).toBe('');
  });

  it('sort 0 sans rien écrire sur un fichier propre', async () => {
    const root = fixture();
    expect(await main(['file', join(root, 'src/clean.ts'), '--root', root])).toBe(0);
    expect(err.join('')).toBe('');
  });

  it('exige un chemin pour file', async () => {
    expect(await main(['file'])).toBe(3);
  });

  it('rend un rapport JSON complet sur scan --json', async () => {
    const root = fixture();
    const code = await main(['scan', '--root', root, '--json', '--no-git', '--no-tools']);
    expect(code).toBe(0);
    const report = JSON.parse(out.join('')) as { filesScanned: number; findings: unknown[] };
    expect(report.filesScanned).toBe(2);
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('écrit une baseline puis la valide, et échoue après ajout de dette', async () => {
    const root = fixture();
    const baselineFile = join(root, 'baseline.json');
    const options = ['--root', root, '--baseline', baselineFile, '--no-git', '--no-tools'];

    expect(await main(['baseline', ...options])).toBe(0);
    expect(existsSync(baselineFile)).toBe(true);
    expect(await main(['check', ...options])).toBe(0);

    writeFileSync(
      join(root, 'src/worse.ts'),
      'export function worse(v: any): any { return v as unknown as string; }\n',
      'utf8',
    );
    out = [];
    expect(await main(['check', ...options])).toBe(1);
    expect(out.join('')).toContain('régression');
  }, 60_000);

  it('signale une baseline absente au lieu de la créer en silence', async () => {
    const root = fixture();
    const code = await main(['check', '--root', root, '--baseline', join(root, 'absent.json')]);
    expect(code).toBe(3);
    expect(err.join('')).toContain('crap-detector baseline');
  });

  it('explique un fichier et sort 1 s’il a des findings', async () => {
    const root = fixture();
    const code = await main([
      'explain', join(root, 'src/dirty.ts'), '--root', root, '--no-git', '--no-tools',
    ]);
    expect(code).toBe(1);
    expect(out.join('')).toContain('empty-catch');
  });

  it('refuse d’expliquer un fichier hors périmètre', async () => {
    const root = fixture();
    const code = await main(['explain', join(root, 'package.json'), '--root', root, '--no-git']);
    expect(code).toBe(3);
    expect(err.join('')).toContain('périmètre');
  }, 60_000);

  it('remonte une config de projet invalide au lieu de l’ignorer', async () => {
    const root = fixture();
    writeFileSync(join(root, 'crap-detector.json'), '{ "thresholds": { "maxDepth": "trois" } }', 'utf8');
    expect(await main(['scan', '--root', root])).toBe(3);
    expect(err.join('')).toContain('maxDepth');
  });
});
