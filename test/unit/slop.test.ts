import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { resolveConfig } from '../../src/core/config.js';
import { TYPE_ESCAPE_RULES, VERBOSITY_RULES, slopHits } from '../../src/slop/rules.js';
import type { SlopHit } from '../../src/slop/rules.js';
import {
  analyzeSlop,
  countLines,
  mergeLineSets,
  slopFindings,
  summarizeSlop,
  verbosityLines,
} from '../../src/slop/analyze.js';

const ALL_RULES = resolveConfig({
  rules: { 'redundant-else': true, 'assign-then-return': true, 'boolean-ternary': true, 'passthrough-wrapper': true },
}).rules;

function parse(code: string, file = 'src/sample.ts'): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  return project.createSourceFile(file, code);
}

function rulesOf(code: string): string[] {
  return slopHits(parse(code), 'src/sample.ts', ALL_RULES).map((entry) => entry.rule);
}

describe('catch masquant l’erreur', () => {
  it('signale un catch vide', () => {
    const code = [
      'declare function work(): void;',
      'export function run(): void {',
      '  try { work(); } catch (error) {}',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual(['empty-catch']);
  });

  it('signale un catch qui ne fait que logger', () => {
    const code = [
      'declare function work(): void;',
      'export function run(): void {',
      '  try { work(); } catch (error) { console.error(error); console.log("bis"); }',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual(['console-only-catch']);
  });

  it('laisse passer un catch qui relance ou traite', () => {
    const code = [
      'declare function work(): void;',
      'declare function report(error: unknown): void;',
      'export function run(): void {',
      '  try { work(); } catch (error) { report(error); throw error; }',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual([]);
  });
});

describe('else redondant', () => {
  it('signale un else après un then qui sort', () => {
    const code = [
      'export function pick(flag: boolean): number {',
      '  if (flag) { return 1; } else { return 2; }',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toContain('redundant-else');
  });

  it('accepte un else quand le then continue', () => {
    const code = [
      'declare function work(): void;',
      'export function run(flag: boolean): void {',
      '  if (flag) { work(); } else { work(); }',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual([]);
  });

  it('ne vise pas le else final quand une branche précédente de la chaîne continue (#6)', () => {
    const code = [
      'declare function work(): void;',
      'export function pick(a: boolean, b: boolean): number {',
      '  if (a) { work(); } else if (b) { return 1; } else { work(); }',
      '  return 0;',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual([]);
  });

  it('signale le else final quand toutes les branches de la chaîne sortent', () => {
    const code = [
      'export function pick(a: boolean, b: boolean): number {',
      '  if (a) { return 1; } else if (b) { return 2; } else { return 3; }',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual(['redundant-else']);
  });

  it('ne vise pas un else if', () => {
    const code = [
      'export function pick(n: number): number {',
      '  if (n === 1) { return 1; }',
      '  else if (n === 2) { return 2; }',
      '  return 0;',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual([]);
  });
});

describe('assignation puis retour', () => {
  it('signale const x = …; return x;', () => {
    const code = [
      'export function total(a: number, b: number): number {',
      '  const sum = a + b;',
      '  return sum;',
      '}',
    ].join('\n');
    const hits = slopHits(parse(code), 'src/sample.ts', ALL_RULES);
    expect(hits[0]).toMatchObject({
      rule: 'assign-then-return',
      line: 2,
      endLine: 3,
      symbol: 'total',
    });
  });

  it('accepte une variable réutilisée avant le retour', () => {
    const code = [
      'declare function log(value: number): void;',
      'export function total(a: number, b: number): number {',
      '  const sum = a + b;',
      '  log(sum);',
      '  return sum;',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual([]);
  });

  it('accepte une déstructuration', () => {
    const code = [
      'export function first(pair: { a: number }): number {',
      '  const { a } = pair;',
      '  return a;',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual([]);
  });
});

describe('ternaire booléen', () => {
  it('signale les deux ordres', () => {
    expect(rulesOf('export const a = (x: number) => (x > 0 ? true : false);'))
      .toContain('boolean-ternary');
    expect(rulesOf('export const b = (x: number) => (x > 0 ? false : true);'))
      .toContain('boolean-ternary');
  });

  it('laisse passer un ternaire qui rend autre chose', () => {
    expect(rulesOf('export const c = (x: number) => (x > 0 ? 1 : 0);')).toEqual([]);
  });
});

describe('wrapper transparent', () => {
  it('signale une fonction qui transmet ses paramètres à l’identique', () => {
    const code = [
      'declare function send(a: number, b: string): void;',
      'export function forward(a: number, b: string): void {',
      '  return send(a, b);',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toContain('passthrough-wrapper');
  });

  it('accepte un wrapper qui ajoute un argument ou réordonne', () => {
    const code = [
      'declare function send(a: number, b: string, c: boolean): void;',
      'export function withDefault(a: number, b: string): void {',
      '  return send(a, b, true);',
      '}',
      'export function swapped(a: number, b: string): void {',
      '  return send(0, b, true);',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual([]);
  });

  it('ne vise pas une fonction sans paramètre', () => {
    const code = ['declare function work(): void;', 'export const run = () => work();'].join('\n');
    expect(rulesOf(code)).toEqual([]);
  });

  it('ne vise pas un callback inline passé à une méthode (#5)', () => {
    const code = [
      'declare function save(item: string): void;',
      'export function run(items: string[]): void {',
      '  items.forEach((item) => save(item));',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual([]);
  });

  it('ne vise pas un appel de méthode, qui perdrait sa liaison de this (#5)', () => {
    const code = [
      'declare const formatter: { format(value: number): string };',
      'export const format = (value: number): string => formatter.format(value);',
      'export class View {',
      '  render(value: number): string { return this.format(value); }',
      '  format(value: number): string { return value.toFixed(2); }',
      '}',
    ].join('\n');
    expect(rulesOf(code)).toEqual([]);
  });

  it('ne vise pas une lambda qui restreint l’arité transmise, ni une garde de type (#5)', () => {
    const code = [
      'declare const allowed: string[];',
      'declare function retry(task: (attempt: number, error: unknown) => void): void;',
      'declare function connect(attempt: number, timeout?: number): void;',
      'declare function isText(value: unknown): value is string;',
      'export const kept = (list: string[]) => list.filter((x) => allowed.includes(x));',
      'export const run = () => retry((attempt) => connect(attempt));',
      'export const guard = (value: unknown): value is string => isText(value);',
    ].join('\n');
    expect(rulesOf(code)).toEqual([]);
  });
});

describe('règles optionnelles', () => {
  it('ne parcourt pas une règle désactivée par défaut, la mesure une fois activée', () => {
    const code = [
      'export function pick(flag: boolean): number {',
      '  if (flag) { return 1; } else { return 2; }',
      '}',
    ].join('\n');
    expect(slopHits(parse(code), 'src/sample.ts', resolveConfig({}).rules)).toEqual([]);
    const enabled = resolveConfig({ rules: { 'redundant-else': true } }).rules;
    expect(slopHits(parse(code), 'src/sample.ts', enabled).map((entry) => entry.rule)).toEqual(['redundant-else']);
  });
});

describe('échappements de typage', () => {
  it('signale chaque any explicite', () => {
    const code = [
      'export function loose(input: any): any {',
      '  return input as any;',
      '}',
    ].join('\n');
    const hits = rulesOf(code).filter((rule) => rule === 'type-escape-any');
    expect(hits).toHaveLength(3);
  });

  it('signale une double assertion as unknown as', () => {
    const code = 'export const cast = (value: string) => (value as unknown as number);';
    expect(rulesOf(code)).toContain('type-escape-assertion');
  });

  it('accepte une assertion simple', () => {
    expect(rulesOf('export const cast = (value: unknown) => (value as string);')).toEqual([]);
  });

  it('signale @ts-ignore et @ts-nocheck mais pas @ts-expect-error', () => {
    const code = [
      '// @ts-nocheck',
      'export function a(): number {',
      '  // @ts-ignore',
      '  // @ts-expect-error volontaire',
      '  return 1;',
      '}',
    ].join('\n');
    const rules = rulesOf(code);
    expect(rules.filter((rule) => rule === 'type-escape-comment')).toHaveLength(2);
  });
});

describe('enclosingSymbol', () => {
  it('rend la fonction englobante, ou #module au niveau du fichier', () => {
    const code = [
      'declare function work(): void;',
      'export function outer(): void {',
      '  try { work(); } catch (error) {}',
      '}',
      'try { work(); } catch (error) {}',
    ].join('\n');
    const hits = slopHits(parse(code), 'src/sample.ts', ALL_RULES);
    expect(hits.map((entry) => entry.symbol)).toEqual(['outer', '#module']);
  });

  it('rend la lambda la plus proche, pas la fonction racine', () => {
    const code = [
      'declare function each(cb: () => void): void;',
      'export function outer(): void {',
      '  const inner = () => { try { each(inner); } catch (error) {} };',
      '  inner();',
      '}',
    ].join('\n');
    expect(slopHits(parse(code), 'src/sample.ts', ALL_RULES)[0]?.symbol).toBe('inner');
  });
});

describe('verbosityLines et mergeLineSets', () => {
  const hits: SlopHit[] = [
    { rule: 'assign-then-return', file: 'a.ts', line: 2, endLine: 3, symbol: 'f', severity: 'minor', message: '' },
    { rule: 'redundant-else', file: 'a.ts', line: 3, endLine: 4, symbol: 'f', severity: 'minor', message: '' },
    { rule: 'type-escape-any', file: 'a.ts', line: 9, endLine: 9, symbol: 'f', severity: 'major', message: '' },
  ];

  it('ne retient que les règles de verbosité et déduplique les lignes', () => {
    const lines = verbosityLines(hits);
    expect([...(lines.get('a.ts') ?? [])].sort((x, y) => x - y)).toEqual([2, 3, 4]);
  });

  it('unit les lignes AST et les lignes de clones', () => {
    const clones = new Map([['a.ts', new Set([4, 5])], ['b.ts', new Set([1])]]);
    const merged = mergeLineSets(verbosityLines(hits), clones);
    expect([...(merged.get('a.ts') ?? [])].sort((x, y) => x - y)).toEqual([2, 3, 4, 5]);
    expect(countLines(merged)).toBe(5);
  });
});

describe('slopFindings', () => {
  it('regroupe les occurrences par règle, fichier et fonction', () => {
    const code = [
      'export function loose(a: any, b: any): void {',
      '  void a; void b;',
      '}',
      'export function other(c: any): void { void c; }',
    ].join('\n');
    const findings = slopFindings(slopHits(parse(code), 'src/sample.ts', ALL_RULES));
    expect(findings).toHaveLength(2);
    const loose = findings.find((finding) => finding.symbol === 'loose');
    expect(loose).toMatchObject({ rule: 'type-escape-any', value: 2, severity: 'major' });
    expect(loose?.message).toContain('2 occurrences');
  });

  it('produit des ids distincts pour deux fonctions du même fichier', () => {
    const code = [
      'export function one(a: any): void { void a; }',
      'export function two(a: any): void { void a; }',
    ].join('\n');
    const findings = slopFindings(slopHits(parse(code), 'src/sample.ts', ALL_RULES));
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(2);
  });
});

describe('summarizeSlop', () => {
  /** Fichier dont les lignes `blank` sont vides et toutes les autres portent du code. */
  function sources(lines: number, blank: number[] = []): Map<string, SourceFile> {
    const text = Array.from({ length: lines }, (_, index) =>
      (blank.includes(index + 1) ? '' : `const v${String(index)} = ${String(index)};`)).join('\n');
    return new Map([['a.ts', parse(text, 'a.ts')]]);
  }

  it('calcule la fraction de verbosité sur le SLOC total', () => {
    const hits: SlopHit[] = [
      { rule: 'assign-then-return', file: 'a.ts', line: 1, endLine: 2, symbol: 'f', severity: 'minor', message: '' },
      { rule: 'type-escape-any', file: 'a.ts', line: 5, endLine: 5, symbol: 'f', severity: 'major', message: '' },
    ];
    const summary = summarizeSlop(hits, sources(20));
    expect(summary.totalSloc).toBe(20);
    expect(summary.verboseLines).toBe(2);
    expect(summary.verbosityFraction).toBeCloseTo(0.1, 10);
    expect(summary.typeEscapes).toBe(1);
    expect(summary.hitsByRule).toEqual({ 'assign-then-return': 1, 'type-escape-any': 1 });
  });

  it('ajoute les lignes de clones à la verbosité', () => {
    const hits: SlopHit[] = [
      { rule: 'assign-then-return', file: 'a.ts', line: 1, endLine: 2, symbol: 'f', severity: 'minor', message: '' },
    ];
    const summary = summarizeSlop(hits, sources(20), {
      cloneLines: new Map([['a.ts', new Set([2, 3, 4])]]),
    });
    expect(summary.verboseLines).toBe(4);
  });

  it('ne compte pas les lignes blanches des plages, ni pour un hit ni pour un clone', () => {
    const hits: SlopHit[] = [
      { rule: 'empty-catch', file: 'a.ts', line: 1, endLine: 10, symbol: 'f', severity: 'major', message: '' },
    ];
    const summary = summarizeSlop(hits, sources(12, [2, 3, 4, 5, 6, 7, 8, 9, 11]), {
      cloneLines: new Map([['a.ts', new Set([10, 11, 12])]]),
    });
    expect(summary.totalSloc).toBe(3);
    expect(summary.verboseLines).toBe(3);
    expect(summary.verbosityFraction).toBe(1);
  });

  it('rend 0 sur un projet vide sans diviser par zéro', () => {
    expect(summarizeSlop([], new Map()).verbosityFraction).toBe(0);
  });
});

describe('analyzeSlop', () => {
  it('assemble rapport et findings sur plusieurs fichiers', () => {
    const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
    const sources = new Map([
      ['src/a.ts', project.createSourceFile('src/a.ts', 'export function f(x: any): any { return x; }\n')],
      ['src/b.ts', project.createSourceFile('src/b.ts', 'export const clean = (n: number): number => n + 1;\n')],
    ]);
    const { report, hits } = analyzeSlop('/repo', sources, ALL_RULES);
    expect(hits).toHaveLength(2);
    expect(report.toolVersion).toBe('ts-morph');
    expect(report.summary.typeEscapes).toBe(2);
    expect(report.findings.every((finding) => finding.file === 'src/a.ts')).toBe(true);
  });
});

describe('classement des règles', () => {
  it('sépare verbosité et typage sans recouvrement', () => {
    const overlap = [...VERBOSITY_RULES].filter((rule) => TYPE_ESCAPE_RULES.has(rule));
    expect(overlap).toEqual([]);
  });
});
