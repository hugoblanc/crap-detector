import { describe, expect, it } from 'vitest';
import { erosionFraction } from '../../src/metrics/erosion.js';

describe('erosionFraction', () => {
  it('vaut 0 sans fonction mesurée', () => {
    expect(erosionFraction([], 10)).toBe(0);
  });

  it('vaut 0 quand aucune fonction ne dépasse le seuil', () => {
    expect(erosionFraction([{ cyclomatic: 10, sloc: 25 }, { cyclomatic: 1, sloc: 4 }], 10)).toBe(0);
  });

  it('vaut 1 quand toute la masse est au-delà du seuil', () => {
    expect(erosionFraction([{ cyclomatic: 11, sloc: 9 }], 10)).toBe(1);
  });

  it('pondère par CC × racine(SLOC), pas par le nombre de fonctions', () => {
    // érodée : 20 × 10 = 200 ; saine : 2 × 10 = 20 ; 200 / 220
    const fraction = erosionFraction(
      [{ cyclomatic: 20, sloc: 100 }, { cyclomatic: 2, sloc: 100 }],
      10,
    );
    expect(fraction).toBeCloseTo(200 / 220, 10);
  });

  it('ne compte pas une fonction exactement au seuil comme érodée', () => {
    expect(erosionFraction([{ cyclomatic: 10, sloc: 16 }, { cyclomatic: 11, sloc: 16 }], 10))
      .toBeCloseTo(44 / 84, 10);
  });

  it('ignore une fonction de masse nulle sans diviser par zéro', () => {
    expect(erosionFraction([{ cyclomatic: 5, sloc: 0 }], 1)).toBe(0);
  });
});
