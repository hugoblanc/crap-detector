import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { functionLikeNodes } from '../../src/metrics/cognitive.js';
import { callbackDepth, describeFunction, fileSloc, functionSloc } from '../../src/metrics/sizes.js';

function parse(code: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  return project.createSourceFile('sample.ts', code);
}

function symbols(code: string): string[] {
  return functionLikeNodes(parse(code)).map((fn) => describeFunction(fn));
}

describe('describeFunction', () => {
  it('nomme les déclarations, classes et accesseurs', () => {
    const code = [
      'function declared(): void {}',
      'class Box {',
      '  constructor() {}',
      '  method(): void {}',
      '  get size(): number { return 0; }',
      '}',
    ].join('\n');
    expect(symbols(code)).toEqual(['declared', 'Box.constructor', 'Box.method', 'Box.size']);
  });

  it('nomme les fonctions portées par une variable, une propriété ou une affectation', () => {
    const code = [
      'const bound = () => {};',
      'const holder = { save: () => {}, nested: { deep: () => {} } };',
      'Box.prototype.run = function () {};',
    ].join('\n');
    expect(symbols(code)).toEqual(['bound', 'holder.save', 'holder.nested.deep', 'Box.prototype.run']);
  });

  it('nomme un export default et les méthodes d’un littéral objet', () => {
    expect(symbols('export default () => {};')).toEqual(['default']);
    expect(symbols('const api = { fetch() {} };')).toEqual(['api.fetch']);
  });

  it('retombe sur un nom positionnel pour les fonctions anonymes', () => {
    const code = ['declare function run(cb: () => void): void;', '', 'run(() => {});'].join('\n');
    expect(symbols(code)).toEqual(['#arrow@L3']);
    expect(symbols('export default function () {}')).toEqual(['#fn@L1']);
  });

  it('marque #object quand le littéral n’est rattaché à aucune déclaration nommée', () => {
    const code = ['declare function send(payload: unknown): void;', 'send({ hook: () => {} });'].join('\n');
    expect(symbols(code)).toEqual(['#object.hook']);
  });
});

describe('functionSloc et fileSloc', () => {
  it('compte le span physique de la fonction, bornes incluses', () => {
    const code = ['function f(): void {', '  const a = 1;', '', '  void a;', '}'].join('\n');
    const fn = functionLikeNodes(parse(code))[0];
    expect(fn).toBeDefined();
    expect(functionSloc(fn!)).toBe(5);
  });

  it('compte les lignes non vides du fichier', () => {
    const code = ['// entête', '', 'const a = 1;', '   ', 'const b = 2;', ''].join('\n');
    expect(fileSloc(parse(code))).toBe(3);
  });
});

describe('callbackDepth', () => {
  it('vaut 0 sans fonction imbriquée', () => {
    const fn = functionLikeNodes(parse('function f(): number { return 1; }'))[0];
    expect(callbackDepth(fn!)).toBe(0);
  });

  it('compte la plus longue chaîne de fonctions imbriquées, racine exclue', () => {
    const code = [
      'declare function run(cb: () => void): void;',
      'function pyramid(): void {',
      '  run(() => {',
      '    run(() => {',
      '      run(() => {});',
      '    });',
      '  });',
      '}',
    ].join('\n');
    const fn = functionLikeNodes(parse(code)).find((node) => describeFunction(node) === 'pyramid');
    expect(callbackDepth(fn!)).toBe(3);
  });

  it('prend la profondeur maximale, pas le nombre total de callbacks', () => {
    const code = [
      'declare function run(cb: () => void): void;',
      'function wide(): void {',
      '  run(() => {});',
      '  run(() => {});',
      '  run(() => {});',
      '}',
    ].join('\n');
    const fn = functionLikeNodes(parse(code)).find((node) => describeFunction(node) === 'wide');
    expect(callbackDepth(fn!)).toBe(1);
  });
});
