import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { localUsageLookup, usesSymbolLocally } from '../../src/imports/local-usage.js';

function sourceOf(content: string, name = 'src/a.ts'): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  return project.createSourceFile(name, content);
}

describe('usesSymbolLocally', () => {
  it('voit l’usage d’une constante juste en dessous de sa déclaration', () => {
    const source = sourceOf([
      'export const PLATEFORMES = [\'web\', \'ios\'] as const;',
      'export class Dto {',
      '  @IsIn(PLATEFORMES)',
      '  plateforme!: string;',
      '}',
    ].join('\n'));
    expect(usesSymbolLocally(source, 'PLATEFORMES')).toBe(true);
  });

  it('ne voit aucun usage d’un symbole seulement déclaré et exporté', () => {
    const source = sourceOf([
      'export const mort = 1;',
      'const autre = 2;',
      'export { autre };',
      'export function jamaisAppelée(): number { return autre; }',
    ].join('\n'));
    expect(usesSymbolLocally(source, 'mort')).toBe(false);
    expect(usesSymbolLocally(source, 'jamaisAppelée')).toBe(false);
    // `export { autre }` nomme le symbole, il ne l'utilise pas ; son usage vient du corps de la fonction.
    expect(usesSymbolLocally(source, 'autre')).toBe(true);
  });

  it('ne prend pas une propriété homonyme pour un usage', () => {
    const source = sourceOf([
      'export const total = 1;',
      'const panier = { total: 2 };',
      'const lu = panier.total;',
      'interface Ligne { total: number }',
      'export const autreTotal = (ligne: Ligne): number => lu + ligne.total;',
    ].join('\n'));
    expect(usesSymbolLocally(source, 'total')).toBe(false);
  });

  it('voit un usage en position de type et en raccourci d’objet', () => {
    const typeUsage = sourceOf(['export interface Contrat { a: number }', 'const c: Contrat = { a: 1 };', 'void c;'].join('\n'));
    expect(usesSymbolLocally(typeUsage, 'Contrat')).toBe(true);
    const shorthand = sourceOf(['export const jeton = 1;', 'const config = { jeton };', 'void config;'].join('\n'));
    expect(usesSymbolLocally(shorthand, 'jeton')).toBe(true);
  });

  it('se tait sur un symbole vide ou sur `default`', () => {
    const source = sourceOf('export default 1;\n');
    expect(usesSymbolLocally(source, 'default')).toBe(false);
    expect(usesSymbolLocally(source, '')).toBe(false);
  });
});

describe('localUsageLookup', () => {
  it('rend false pour un fichier absent du périmètre et mémorise les réponses', () => {
    const sources = new Map([['src/a.ts', sourceOf('export const x = 1;\nconsole.log(x);\n')]]);
    const lookup = localUsageLookup(sources);
    expect(lookup('src/a.ts', 'x')).toBe(true);
    expect(lookup('src/a.ts', 'x')).toBe(true);
    expect(lookup('src/inconnu.ts', 'x')).toBe(false);
  });
});
