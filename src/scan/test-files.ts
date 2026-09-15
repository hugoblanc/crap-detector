/**
 * Fichiers de tests : hors mesure, mais importeurs à part entière.
 *
 * Deux règles en dépendent, et elles doivent dire la même chose : un module utilisé seulement
 * par ses tests n'est pas orphelin (scan/orphans.ts), et un sous-projet utilisé seulement par
 * ses tests n'est pas du code tiers sans usage (imports/vendored.ts).
 */
import type { ScopeConfig } from '../core/config.js';
import type { IgnoredPaths } from '../core/types.js';
import { collectFiles } from '../metrics/analyze.js';

/** Globs d'exclusion qui visent des tests : suffixes `.test.ts`, `.spec.ts`, `.e2e-spec.ts`, dossiers `__tests__` et `test`. */
const TEST_GLOB = /(?:^|[/.])(?:tests?|spec|e2e-spec)(?:[/.]|$)|__tests__/;

/** Fichiers que le périmètre exclut seulement parce que ce sont des tests. */
export function collectTestFiles(
  rootPath: string,
  scope: ScopeConfig,
  measured: readonly string[],
  ignored?: IgnoredPaths,
): string[] {
  const exclude = scope.exclude.filter((glob) => !TEST_GLOB.test(glob));
  const inScope = new Set(measured);
  return collectFiles(rootPath, { include: scope.include, exclude }, ignored)
    .filter((file) => !inScope.has(file));
}
