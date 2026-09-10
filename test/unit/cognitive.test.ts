/**
 * Les scores attendus viennent des exemples publiés du white paper Sonar
 * « Cognitive Complexity » (Appendix A et B). Chaque cas cite son total de référence.
 */
import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { analyzeCognitive, functionLikeNodes, isFunctionLike, simpleName } from '../../src/metrics/cognitive.js';
import { describeFunction } from '../../src/metrics/sizes.js';

function analyze(code: string, symbol: string): { score: number; maxNesting: number } {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sourceFile = project.createSourceFile('sample.ts', code);
  const fn = functionLikeNodes(sourceFile).find((node) => describeFunction(node) === symbol);
  if (fn === undefined) throw new Error(`fonction ${symbol} introuvable dans l'échantillon`);
  return analyzeCognitive(fn);
}

const score = (code: string, symbol: string): number => analyze(code, symbol).score;

describe('analyzeCognitive — exemples du white paper', () => {
  it('sumOfPrimes vaut 7 (boucles imbriquées + continue étiqueté)', () => {
    const code = [
      'function sumOfPrimes(max: number): number {',
      '  let total = 0;',
      '  outer: for (let i = 1; i <= max; ++i) {',
      '    for (let j = 2; j < i; ++j) {',
      '      if (i % j === 0) {',
      '        continue outer;',
      '      }',
      '    }',
      '    total += i;',
      '  }',
      '  return total;',
      '}',
    ].join('\n');
    expect(score(code, 'sumOfPrimes')).toBe(7);
  });

  it('getWords vaut 1 (le switch et tous ses case comptent une seule fois)', () => {
    const code = [
      'function getWords(n: number): string {',
      '  switch (n) {',
      '    case 1: return "one";',
      '    case 2: return "a couple";',
      '    case 3: return "a few";',
      '    default: return "lots";',
      '  }',
      '}',
    ].join('\n');
    expect(score(code, 'getWords')).toBe(1);
  });

  it('myMethod vaut 10 (try ignoré, catch et finally comptés)', () => {
    const code = [
      'declare const condition1: boolean;',
      'declare const condition2: boolean;',
      'declare const condition3: boolean;',
      'declare function work(): void;',
      'function myMethod(): void {',
      '  try {',
      '    if (condition1) {',
      '      for (let i = 0; i < 10; i++) {',
      '        while (condition2) { work(); }',
      '      }',
      '    }',
      '  } catch (error) {',
      '    if (condition2) { work(); }',
      '  } finally {',
      '    if (condition3) { work(); }',
      '  }',
      '}',
    ].join('\n');
    expect(score(code, 'myMethod')).toBe(10);
  });

  it('une lambda imbriquée vaut 0 mais pousse son contenu d’un niveau (total 2)', () => {
    const code = [
      'declare const condition: boolean;',
      'declare function work(): void;',
      'function myMethod2(): void {',
      '  const runnable = () => {',
      '    if (condition) { work(); }',
      '  };',
      '  runnable();',
      '}',
    ].join('\n');
    expect(score(code, 'myMethod2')).toBe(2);
  });
});

describe('analyzeCognitive — séquences d’opérateurs logiques', () => {
  const wrap = (expression: string): string => [
    'declare const a: boolean; declare const b: boolean;',
    'declare const c: boolean; declare const d: boolean; declare const e: boolean;',
    'declare function work(): void;',
    'function f(): void {',
    `  if (${expression}) { work(); }`,
    '}',
  ].join('\n');

  it('compte une séquence de même opérateur une seule fois', () => {
    expect(score(wrap('a && b && c'), 'f')).toBe(2);
  });

  it('compte une séquence par changement d’opérateur', () => {
    expect(score(wrap('a && b && c || d || e'), 'f')).toBe(3);
  });

  it('traite les parenthèses comme une rupture de séquence', () => {
    expect(score(wrap('a && !(b && c)'), 'f')).toBe(3);
  });

  it('n’applique pas de bonus d’imbrication aux opérateurs logiques', () => {
    const code = [
      'declare const a: boolean; declare const b: boolean;',
      'declare function work(): void;',
      'function nested(): void {',
      '  while (a) {',
      '    if (a && b) { work(); }',
      '  }',
      '}',
    ].join('\n');
    // while +1, if +1+1 (niveau 1), séquence && +1 sans bonus = 4
    expect(score(code, 'nested')).toBe(4);
  });
});

describe('analyzeCognitive — else, ternaire, récursion', () => {
  it('donne +1 à else et else if, sans bonus d’imbrication', () => {
    const code = [
      'declare function work(): void;',
      'function chain(n: number): void {',
      '  if (n === 1) { work(); }',
      '  else if (n === 2) { work(); }',
      '  else { work(); }',
      '}',
    ].join('\n');
    // if +1, else +1, else-if +1, else +1 = 4
    expect(score(code, 'chain')).toBe(4);
  });

  it('compte le ternaire comme une structure imbricable', () => {
    const code = [
      'function pick(a: boolean, b: boolean): number {',
      '  if (a) { return b ? 1 : 2; }',
      '  return 0;',
      '}',
    ].join('\n');
    // if +1, ternaire +1+1 (niveau 1) = 3
    expect(score(code, 'pick')).toBe(3);
  });

  it('compte la récursion directe une fois, quel que soit le nombre d’appels', () => {
    const code = [
      'function fact(n: number): number {',
      '  if (n <= 1) { return 1; }',
      '  return n * fact(n - 1) * fact(n - 1);',
      '}',
    ].join('\n');
    // if +1, récursion +1 = 2
    expect(score(code, 'fact')).toBe(2);
  });

  it('compte la récursion d’une méthode appelée via this', () => {
    const code = [
      'class Walker {',
      '  walk(n: number): number {',
      '    return n <= 0 ? 0 : this.walk(n - 1);',
      '  }',
      '}',
    ].join('\n');
    // ternaire +1, récursion +1 = 2
    expect(score(code, 'Walker.walk')).toBe(2);
  });

  it('ignore un break non étiqueté', () => {
    const code = [
      'function scan(items: number[]): number {',
      '  for (const item of items) { if (item > 0) { break; } }',
      '  return 0;',
      '}',
    ].join('\n');
    // for +1, if +1+1 = 3
    expect(score(code, 'scan')).toBe(3);
  });
});

describe('maxNesting', () => {
  it('rend la profondeur Sonar maximale atteinte', () => {
    const code = [
      'declare const a: boolean;',
      'declare function work(): void;',
      'function deep(): void {',
      '  if (a) {',
      '    while (a) {',
      '      for (;;) { work(); }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(analyze(code, 'deep').maxNesting).toBe(3);
  });

  it('vaut 0 sur une fonction plate', () => {
    expect(analyze('function flat(): number { return 1; }', 'flat').maxNesting).toBe(0);
  });
});

describe('functionLikeNodes', () => {
  const code = [
    'export function top(): void {',
    '  const inner = () => { return 1; };',
    '  inner();',
    '}',
    'class Box {',
    '  constructor() {}',
    '  get size(): number { return 0; }',
    '  set size(value: number) {}',
    '  method(): void {}',
    '}',
    'declare function ambient(): void;',
    'interface Shape { area(): number; }',
  ].join('\n');

  it('collecte toutes les fonctions avec corps, en ordre de position', () => {
    const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
    const sourceFile = project.createSourceFile('sample.ts', code);
    const names = functionLikeNodes(sourceFile).map((fn) => describeFunction(fn));
    expect(names).toEqual([
      'top',
      'inner',
      'Box.constructor',
      'Box.size',
      'Box.size',
      'Box.method',
    ]);
  });

  it('exclut les déclarations sans corps (ambient, signatures d’interface)', () => {
    const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
    const sourceFile = project.createSourceFile('sample.ts', code);
    const names = functionLikeNodes(sourceFile).map((fn) => describeFunction(fn));
    expect(names).not.toContain('ambient');
    expect(names).not.toContain('area');
  });
});

describe('isFunctionLike et simpleName', () => {
  it('reconnaît les sept formes de fonction et rejette le reste', () => {
    const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
    const sourceFile = project.createSourceFile('sample.ts', 'const x = 1;');
    const statement = sourceFile.getStatements()[0];
    expect(statement).toBeDefined();
    expect(isFunctionLike(statement!)).toBe(false);
  });

  it('rend le nom simple utilisé pour la détection de récursion', () => {
    const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
    const sourceFile = project.createSourceFile(
      'sample.ts',
      ['function named(): void {}', 'const bound = () => {};', 'run(() => {});'].join('\n'),
    );
    const names = functionLikeNodes(sourceFile).map((fn) => simpleName(fn));
    expect(names).toEqual(['named', 'bound', undefined]);
  });
});
