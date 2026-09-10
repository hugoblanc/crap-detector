import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAnyGlob } from '../../src/core/glob.js';

describe('globToRegExp', () => {
  it('matches at the root and at any depth with **/', () => {
    const pattern = globToRegExp('**/*.ts');
    expect(pattern.test('a.ts')).toBe(true);
    expect(pattern.test('src/a.ts')).toBe(true);
    expect(pattern.test('src/deep/nested/a.ts')).toBe(true);
    expect(pattern.test('src/a.tsx')).toBe(false);
  });

  it('keeps * inside a single segment', () => {
    const pattern = globToRegExp('src/*.ts');
    expect(pattern.test('src/a.ts')).toBe(true);
    expect(pattern.test('src/sub/a.ts')).toBe(false);
  });

  it('matches a whole subtree with a trailing **', () => {
    const pattern = globToRegExp('node_modules/**');
    expect(pattern.test('node_modules/pkg/index.ts')).toBe(true);
    expect(pattern.test('node_modules')).toBe(false);
    expect(pattern.test('src/node_modules/pkg/a.ts')).toBe(false);
  });

  it('matches exactly one character with ?', () => {
    const pattern = globToRegExp('a?.ts');
    expect(pattern.test('ab.ts')).toBe(true);
    expect(pattern.test('a.ts')).toBe(false);
    expect(pattern.test('a/b.ts')).toBe(false);
  });

  it('escapes regexp metacharacters found in paths', () => {
    const pattern = globToRegExp('**/*.d.ts');
    expect(pattern.test('src/types.d.ts')).toBe(true);
    expect(pattern.test('src/typesXdXts')).toBe(false);
  });

  it('is anchored on both ends', () => {
    const pattern = globToRegExp('src/a.ts');
    expect(pattern.test('vendor/src/a.ts')).toBe(false);
    expect(pattern.test('src/a.ts.bak')).toBe(false);
  });
});

describe('matchesAnyGlob', () => {
  it('is false on an empty pattern list', () => {
    expect(matchesAnyGlob([], 'src/a.ts')).toBe(false);
  });

  it('is true as soon as one pattern matches', () => {
    const patterns = ['dist/**', '**/*.test.ts'].map(globToRegExp);
    expect(matchesAnyGlob(patterns, 'src/a.test.ts')).toBe(true);
    expect(matchesAnyGlob(patterns, 'dist/a.js')).toBe(true);
    expect(matchesAnyGlob(patterns, 'src/a.ts')).toBe(false);
  });
});
