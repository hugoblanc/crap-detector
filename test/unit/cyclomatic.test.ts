import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { functionLikeNodes } from '../../src/metrics/cognitive.js';
import { cyclomaticComplexity } from '../../src/metrics/cyclomatic.js';
import { describeFunction } from '../../src/metrics/sizes.js';

function complexityOf(code: string, symbol: string): number {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sourceFile = project.createSourceFile('sample.ts', code);
  const fn = functionLikeNodes(sourceFile).find((node) => describeFunction(node) === symbol);
  if (fn === undefined) throw new Error(`fonction ${symbol} introuvable dans l'échantillon`);
  return cyclomaticComplexity(fn);
}

describe('cyclomaticComplexity', () => {
  it('vaut 1 sur une fonction sans point de décision', () => {
    expect(complexityOf('function flat(a: number): number { return a + 1; }', 'flat')).toBe(1);
  });

  it('compte un point par structure de contrôle', () => {
    const code = [
      'declare function work(): void;',
      'function control(items: number[], flag: boolean): void {',
      '  if (flag) { work(); } else { work(); }',
      '  for (const item of items) { work(); }',
      '  for (let i = 0; i < 3; i++) { work(); }',
      '  while (flag) { work(); }',
      '  do { work(); } while (flag);',
      '}',
    ].join('\n');
    // 1 + if + for-of + for + while + do = 6 (le else n’ajoute rien en McCabe)
    expect(complexityOf(code, 'control')).toBe(6);
  });

  it('compte chaque case mais pas le default', () => {
    const code = [
      'function pick(n: number): string {',
      '  switch (n) {',
      '    case 1: return "a";',
      '    case 2: return "b";',
      '    default: return "z";',
      '  }',
      '}',
    ].join('\n');
    expect(complexityOf(code, 'pick')).toBe(3);
  });

  it('compte le catch et le ternaire', () => {
    const code = [
      'declare function work(): void;',
      'function guarded(flag: boolean): number {',
      '  try { work(); } catch (error) { work(); } finally { work(); }',
      '  return flag ? 1 : 2;',
      '}',
    ].join('\n');
    // 1 + catch + ternaire = 3
    expect(complexityOf(code, 'guarded')).toBe(3);
  });

  it('compte chaque opérateur &&, || et ?? individuellement', () => {
    const code = [
      'function logic(a: boolean, b: boolean, c: boolean, d: number | undefined): unknown {',
      '  if (a && b && c) { return d ?? 0; }',
      '  return a || b;',
      '}',
    ].join('\n');
    // 1 + if + deux && + ?? + || = 6
    expect(complexityOf(code, 'logic')).toBe(6);
  });

  it('mesure les fonctions imbriquées séparément, pas dans leur parent', () => {
    const code = [
      'declare function each(cb: (n: number) => void): void;',
      'function parent(flag: boolean): void {',
      '  if (flag) { return; }',
      '  const child = (n: number): number => (n > 0 ? 1 : 2);',
      '  each(child);',
      '}',
    ].join('\n');
    expect(complexityOf(code, 'parent')).toBe(2);
    expect(complexityOf(code, 'child')).toBe(2);
  });

  it('mesure une lambda à corps d’expression', () => {
    const code = 'const terse = (a: boolean, b: boolean) => (a && b ? 1 : 2);';
    // 1 + ternaire + && = 3
    expect(complexityOf(code, 'terse')).toBe(3);
  });
});
