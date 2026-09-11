/**
 * Règle orphan, repli de unused-file quand knip n'a pas tourné. knip connaît les points
 * d'entrée par convention (pages Next.js, fichiers chargés par ses plugins) ; ce graphe ne
 * voit que les imports écrits, il ne remplace donc pas knip quand knip est là.
 *
 * Les tests restent hors mesure mais comptent comme importeurs : un module utilisé
 * seulement par ses tests n'est pas orphelin.
 */
import { compareFindings } from '../core/findings.js';
import type { ScopeConfig } from '../core/config.js';
import type { IgnoredPaths, ScanReport } from '../core/types.js';
import { collectImports } from '../imports/analyze.js';
import { resolveImport } from '../imports/extract.js';
import { findOrphans, graphFindings } from '../imports/graph.js';
import { readManifest } from '../imports/manifest.js';
import { collectFiles } from '../metrics/analyze.js';
import { loadSourceFiles } from './fast.js';
import type { FastScan } from './fast.js';

/** Globs d'exclusion qui visent des tests : suffixes `.test.ts`, `.spec.ts`, `.e2e-spec.ts`, dossiers `__tests__` et `test`. */
const TEST_GLOB = /(?:^|[/.])(?:tests?|spec|e2e-spec)(?:[/.]|$)|__tests__/;

/** Fichiers que le périmètre exclut seulement parce que ce sont des tests. */
function collectTestFiles(
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

/** Fichiers mesurés qu'au moins un test importe, par chemin relatif ou alias de la racine. */
function importedByTests(rootPath: string, tests: string[], measured: ReadonlySet<string>): Set<string> {
  const manifest = readManifest(rootPath);
  const targets = new Set<string>();
  for (const [file, refs] of collectImports(loadSourceFiles(rootPath, tests))) {
    for (const ref of refs) {
      const target = resolveImport(file, ref, measured, manifest);
      if (target !== undefined) targets.add(target);
    }
  }
  return targets;
}

/** Complète le rapport en place : orphelins, leur agrégat et leurs findings. */
export function addOrphans(report: ScanReport, fast: FastScan, scope: ScopeConfig, ignored?: IgnoredPaths): void {
  const tests = collectTestFiles(report.rootPath, scope, fast.files, ignored);
  const orphans = findOrphans(fast.graph, importedByTests(report.rootPath, tests, new Set(fast.files)));
  const findings = graphFindings([], orphans);
  const { dependencies } = report;
  report.dependencies = {
    ...dependencies,
    summary: { ...dependencies.summary, orphans: orphans.length },
    orphans,
    findings: [...dependencies.findings, ...findings].sort(compareFindings),
  };
  report.aggregates['orphans.count'] = orphans.length;
  report.findings.push(...findings);
}
