/**
 * Métrique Verbosity de SlopCodeBench (arXiv 2603.24755) : part des lignes
 * inutiles ou dupliquées dans le total. Repères de l'étude : ~0,15 pour du code
 * humain, ~0,33 pour du code agentique, et elle augmente sur 89,8 % des
 * trajectoires — c'est le signal de dégradation le plus fréquent des deux,
 * devant l'érosion.
 *
 * L'union est faite sur les numéros de ligne : une ligne à la fois clonée et
 * inutile ne compte qu'une fois.
 */
import type { SourceFile } from 'ts-morph';
import { compareFindings, envelope, makeFinding } from '../core/findings.js';
import type { Finding, Severity, SlopReport, SlopSummary } from '../core/types.js';
import type { SlopHit } from './rules.js';
import { TYPE_ESCAPE_RULES, VERBOSITY_RULES, slopHits } from './rules.js';

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

/** Lignes couvertes par les règles de verbosité, par fichier. */
export function verbosityLines(hits: SlopHit[]): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  for (const entry of hits) {
    if (!VERBOSITY_RULES.has(entry.rule)) continue;
    let lines = byFile.get(entry.file);
    if (lines === undefined) {
      lines = new Set();
      byFile.set(entry.file, lines);
    }
    for (let line = entry.line; line <= entry.endLine; line += 1) lines.add(line);
  }
  return byFile;
}

/** Fusionne deux ensembles de lignes par fichier (verbosité AST + clones jscpd). */
export function mergeLineSets(
  ...sources: Array<Map<string, Set<number>>>
): Map<string, Set<number>> {
  const merged = new Map<string, Set<number>>();
  for (const source of sources) {
    for (const [file, lines] of source) {
      const target = merged.get(file);
      if (target === undefined) {
        merged.set(file, new Set(lines));
        continue;
      }
      for (const line of lines) target.add(line);
    }
  }
  return merged;
}

export function countLines(byFile: Map<string, Set<number>>): number {
  let total = 0;
  for (const lines of byFile.values()) total += lines.size;
  return total;
}

/**
 * Regroupe les occurrences par règle, fichier et fonction englobante.
 * Sans regroupement, dix `any` dans une fonction produiraient dix findings
 * partageant le même id, puisque l'id ignore volontairement le numéro de ligne.
 */
export function slopFindings(hits: SlopHit[]): Finding[] {
  const groups = new Map<string, { hits: SlopHit[] }>();
  for (const entry of hits) {
    const key = `${entry.rule}|${entry.file}|${entry.symbol}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { hits: [entry] });
      continue;
    }
    group.hits.push(entry);
  }

  const findings: Finding[] = [];
  for (const { hits: grouped } of groups.values()) {
    const first = grouped[0];
    if (first === undefined) continue;
    const severity = grouped.reduce<Severity>(
      (worst, entry) => (SEVERITY_ORDER[entry.severity] > SEVERITY_ORDER[worst] ? entry.severity : worst),
      'info',
    );
    const suffix = grouped.length > 1 ? ` (${grouped.length} occurrences)` : '';
    findings.push(
      makeFinding({
        tool: 'metrics',
        rule: first.rule,
        file: first.file,
        line: first.line,
        symbol: first.symbol,
        symbolKey: first.symbol,
        value: grouped.length,
        severity,
        message: `${first.message}${suffix}`,
      }),
    );
  }
  return findings.sort(compareFindings);
}

export interface SlopOptions {
  /** Lignes dupliquées remontées par jscpd, à unir aux lignes inutiles. */
  cloneLines?: Map<string, Set<number>>;
}

export function summarizeSlop(
  hits: SlopHit[],
  totalSloc: number,
  options: SlopOptions = {},
): SlopSummary {
  const verbose = mergeLineSets(verbosityLines(hits), options.cloneLines ?? new Map());
  const verboseLines = countLines(verbose);
  const byRule: Record<string, number> = {};
  for (const entry of hits) byRule[entry.rule] = (byRule[entry.rule] ?? 0) + 1;
  return {
    totalSloc,
    verboseLines,
    verbosityFraction: totalSloc > 0 ? verboseLines / totalSloc : 0,
    typeEscapes: hits.filter((entry) => TYPE_ESCAPE_RULES.has(entry.rule)).length,
    hitsByRule: byRule,
  };
}

export interface SlopAnalysis {
  report: SlopReport;
  /** Occurrences brutes, pour recalculer la verbosité une fois les clones connus. */
  hits: SlopHit[];
}

/** Passe complète sur les fichiers déjà chargés par le scan. */
export function analyzeSlop(
  rootPath: string,
  sourceFiles: Map<string, SourceFile>,
  totalSloc: number,
  options: SlopOptions = {},
): SlopAnalysis {
  const hits: SlopHit[] = [];
  for (const [file, sourceFile] of sourceFiles) {
    hits.push(...slopHits(sourceFile, file));
  }
  return {
    report: {
      ...envelope(rootPath, 'ts-morph'),
      summary: summarizeSlop(hits, totalSloc, options),
      findings: slopFindings(hits),
    },
    hits,
  };
}
