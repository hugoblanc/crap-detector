import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILENAME,
  loadProjectConfig,
  resolveConfig,
} from '../../src/core/config.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crap-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadProjectConfig', () => {
  it('returns an empty config when no file exists', () => {
    expect(loadProjectConfig(makeTempDir())).toEqual({});
  });

  it('reads partial thresholds and scope from the file', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        thresholds: { cyclomaticComplexity: 8 },
        scope: { exclude: ['vendor/**'] },
      }),
      'utf8',
    );
    const config = loadProjectConfig(dir);
    expect(config.thresholds).toEqual({ cyclomaticComplexity: 8 });
    expect(config.scope).toEqual({ exclude: ['vendor/**'] });
  });

  it('throws on malformed JSON', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), '{ not json', 'utf8');
    expect(() => loadProjectConfig(dir)).toThrow();
  });

  it('throws on a non-object root or a non-number threshold', () => {
    const arrayDir = makeTempDir();
    writeFileSync(join(arrayDir, CONFIG_FILENAME), '[]', 'utf8');
    expect(() => loadProjectConfig(arrayDir)).toThrow(/objet/);

    const badThresholdDir = makeTempDir();
    writeFileSync(
      join(badThresholdDir, CONFIG_FILENAME),
      JSON.stringify({ thresholds: { maxDepth: 'three' } }),
      'utf8',
    );
    expect(() => loadProjectConfig(badThresholdDir)).toThrow(/maxDepth/);
  });
});

describe('règles optionnelles et seuils de signalement', () => {
  function configFile(content: unknown): string {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify(content), 'utf8');
    return dir;
  }

  it('désactive les règles optionnelles et fixe le signalement à environ deux fois le cliquet', () => {
    const resolved = resolveConfig({});
    expect(Object.values(resolved.rules).every((enabled) => !enabled)).toBe(true);
    expect(resolved.reportThresholds).toEqual({
      cyclomaticComplexity: 25,
      cognitiveComplexity: 30,
      maxLinesPerFunction: 100,
      maxFileLines: 600,
      maxDepth: 5,
      maxParams: 6,
    });
  });

  it('réactive une règle et règle un seuil de signalement par le fichier de config', () => {
    const dir = configFile({ rules: { 'redundant-else': true }, reportThresholds: { maxLinesPerFunction: 80 } });
    const resolved = resolveConfig(loadProjectConfig(dir));
    expect(resolved.rules['redundant-else']).toBe(true);
    expect(resolved.rules['passthrough-wrapper']).toBe(false);
    expect(resolved.reportThresholds).toMatchObject({ maxLinesPerFunction: 80, maxFileLines: 600 });
    expect(resolved.thresholds.maxLinesPerFunction).toBe(50);
  });

  it('refuse une règle inconnue, une valeur non booléenne ou un seuil de signalement inconnu', () => {
    expect(() => loadProjectConfig(configFile({ rules: { 'empty-catch': false } }))).toThrow(/rules\.empty-catch inconnu/);
    expect(() => loadProjectConfig(configFile({ rules: { 'redundant-else': 'oui' } }))).toThrow(/true ou false/);
    expect(() => loadProjectConfig(configFile({ reportThresholds: { maxNestedCallbacks: 5 } })))
      .toThrow(/reportThresholds\.maxNestedCallbacks inconnu/);
  });

  it('juge knip non fiable au-delà d’un tiers de fichiers inutilisés, seuil réglable par la section knip', () => {
    expect(resolveConfig({}).knip).toEqual({ maxUnusedFileFraction: 0.33, minUnusedFiles: 10 });
    expect(resolveConfig(loadProjectConfig(configFile({ knip: { maxUnusedFileFraction: 0.5 } }))).knip)
      .toEqual({ maxUnusedFileFraction: 0.5, minUnusedFiles: 10 });
    expect(() => loadProjectConfig(configFile({ knip: { entry: 1 } }))).toThrow(/knip\.entry inconnu/);
  });
});

describe('resolveConfig', () => {
  it('fills unspecified fields with defaults', () => {
    const resolved = resolveConfig({});
    expect(resolved.thresholds).toMatchObject({
      cyclomaticComplexity: 10,
      cognitiveComplexity: 15,
      erosionFraction: 0.35,
    });
    expect(resolved.scope.include).toContain('**/*.ts');
  });

  it('overrides only the fields present in the project config', () => {
    const resolved = resolveConfig({
      thresholds: { cyclomaticComplexity: 12 },
      scope: { include: ['src/**/*.ts'] },
    });
    expect(resolved.thresholds.cyclomaticComplexity).toBe(12);
    expect(resolved.thresholds.cognitiveComplexity).toBe(15);
    expect(resolved.scope.include).toEqual(['src/**/*.ts']);
    // L'exclusion par défaut est conservée si le projet ne la redéfinit pas.
    expect(resolved.scope.exclude.length).toBeGreaterThan(0);
  });
});

describe('resolveConfig — churn', () => {
  it('fournit la fenêtre et les garde-fous de couplage par défaut', () => {
    expect(resolveConfig({}).churn).toEqual({
      windowDays: 365,
      maxFilesPerCommit: 20,
      minCoChangeCommits: 5,
      minCoChangeDegree: 0.5,
      minHistoryCommits: 50,
    });
  });

  it('ne remplace que les champs churn fournis', () => {
    const resolved = resolveConfig({ churn: { windowDays: 90 } });
    expect(resolved.churn.windowDays).toBe(90);
    expect(resolved.churn.maxFilesPerCommit).toBe(20);
  });
});
