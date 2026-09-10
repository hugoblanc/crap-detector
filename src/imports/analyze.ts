/**
 * Gate anti-hallucination supply-chain.
 * Un agent qui invente un paquet (« slopsquatting ») écrit un import parfaitement
 * plausible vers un paquet qui n'existe pas, ou pas dans ce projet. C'est
 * déterministe à vérifier : l'AST donne le specifier, le package.json la vérité.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceFile } from 'ts-morph';
import { compareFindings, envelope, makeFinding } from '../core/findings.js';
import type { Finding, ImportsReport, ImportsSummary } from '../core/types.js';
import type { ImportGraph, ImportRef } from './extract.js';
import {
  buildImportGraph,
  fileImports,
  normalizeRelative,
  packageNameOf,
  resolveRelativeImport,
} from './extract.js';
import { isDeclared, readManifest } from './manifest.js';
import type { Manifest } from './manifest.js';

/** Extensions essayées quand un import relatif ne pointe pas sur un fichier du scope. */
const ON_DISK_EXTENSIONS = [
  '', '.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '/index.ts', '/index.tsx', '/index.js', '/index.mjs', '/index.cjs', '/index.json',
];

/** Un import relatif hors scope peut viser un asset ou un fichier généré : on vérifie le disque. */
function existsOnDisk(rootPath: string, fromFile: string, specifier: string): boolean {
  const target = normalizeRelative(fromFile, specifier);
  if (target === undefined) return false;
  const bases = [target];
  const remapped = target.replace(/\.(m|c)?js$/, '');
  if (remapped !== target) bases.push(remapped);
  return bases.some((base) =>
    ON_DISK_EXTENSIONS.some((extension) => existsSync(join(rootPath, `${base}${extension}`))));
}

export interface ImportAnalysis {
  report: ImportsReport;
  graph: ImportGraph;
  imports: Map<string, ImportRef[]>;
}

export function collectImports(sourceFiles: Map<string, SourceFile>): Map<string, ImportRef[]> {
  const imports = new Map<string, ImportRef[]>();
  for (const [file, sourceFile] of sourceFiles) {
    imports.set(file, fileImports(sourceFile));
  }
  return imports;
}

export function importFindings(
  rootPath: string,
  imports: Map<string, ImportRef[]>,
  manifest: Manifest,
): Finding[] {
  const knownFiles = new Set(imports.keys());
  const findings: Finding[] = [];
  for (const [file, refs] of imports) {
    for (const ref of refs) {
      if (ref.specifierKind === 'relative') {
        const resolved = resolveRelativeImport(file, ref.specifier, knownFiles);
        if (resolved !== undefined) continue;
        if (existsOnDisk(rootPath, file, ref.specifier)) continue;
        findings.push(
          makeFinding({
            tool: 'imports',
            rule: 'unresolved-import',
            file,
            line: ref.line,
            symbol: ref.specifier,
            symbolKey: ref.specifier,
            severity: 'critical',
            message: `import vers '${ref.specifier}' : aucun fichier correspondant`,
          }),
        );
        continue;
      }
      if (ref.specifierKind !== 'bare' && ref.specifierKind !== 'subpath') continue;
      // Sans manifeste fiable, la règle se tait plutôt que de produire du bruit.
      if (!manifest.trustworthy) continue;
      const packageName = packageNameOf(ref.specifier);
      if (isDeclared(manifest, ref.specifier, packageName)) continue;
      findings.push(
        makeFinding({
          tool: 'imports',
          rule: 'unknown-dependency',
          file,
          line: ref.line,
          symbol: packageName,
          symbolKey: packageName,
          severity: 'critical',
          message: `paquet '${packageName}' importé mais absent du package.json`,
        }),
      );
    }
  }
  return findings.sort(compareFindings);
}

export function summarizeImports(
  imports: Map<string, ImportRef[]>,
  graph: ImportGraph,
  findings: Finding[],
): ImportsSummary {
  const externals = new Set<string>();
  for (const refs of imports.values()) {
    for (const ref of refs) {
      if (ref.specifierKind === 'bare') externals.add(packageNameOf(ref.specifier));
    }
  }
  let internalEdges = 0;
  for (const targets of graph.edges.values()) internalEdges += targets.size;
  return {
    filesScanned: imports.size,
    internalEdges,
    externalPackages: externals.size,
    unknownDependencies: findings.filter((finding) => finding.rule === 'unknown-dependency').length,
    unresolvedImports: findings.filter((finding) => finding.rule === 'unresolved-import').length,
  };
}

export function analyzeImports(
  rootPath: string,
  sourceFiles: Map<string, SourceFile>,
): ImportAnalysis {
  const manifest = readManifest(rootPath);
  const imports = collectImports(sourceFiles);
  const graph = buildImportGraph(imports, manifest);
  const findings = importFindings(rootPath, imports, manifest);
  const report: ImportsReport = {
    ...envelope(rootPath, 'ts-morph'),
    manifestTrusted: manifest.trustworthy,
    summary: summarizeImports(imports, graph, findings),
    findings,
  };
  if (manifest.untrustworthyReason !== undefined) {
    report.manifestReason = manifest.untrustworthyReason;
  }
  return { report, graph, imports };
}
