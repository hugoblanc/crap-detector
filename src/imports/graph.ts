/**
 * Cycles et orphelins, calculés sur notre propre graphe d'imports.
 *
 * Pourquoi pas dependency-cruiser : il faudrait un sous-processus et un fichier
 * de règles dans le dépôt cible pour obtenir la même information, alors que le
 * graphe est déjà construit pour le couplage temporel. dependency-cruiser reste
 * le bon outil le jour où il faudra des règles de frontières entre couches
 * (boundaries), ce que ce module ne fait pas.
 *
 * Les cycles sont rendus sous forme de composantes fortement connexes (Tarjan) :
 * une composante de taille n contient au moins un cycle et tous ses membres sont
 * mutuellement atteignables, donc c'est l'unité à casser. Parcours itératif,
 * pour ne pas dépendre de la profondeur de pile sur un gros dépôt.
 */
import { compareFindings, envelope, makeFinding } from '../core/findings.js';
import type { DependencyReport, DependencySummary, Finding } from '../core/types.js';
import type { ImportGraph } from './extract.js';

export interface Cycle {
  /** Membres de la composante, triés : c'est aussi la clé stable du finding. */
  files: string[];
}

interface TarjanState {
  index: number;
  indices: Map<string, number>;
  lowLinks: Map<string, number>;
  onStack: Set<string>;
  stack: string[];
  components: string[][];
}

interface Frame {
  node: string;
  successors: string[];
  next: number;
}

/** Composantes fortement connexes, algorithme de Tarjan en version itérative. */
export function stronglyConnectedComponents(graph: ImportGraph): string[][] {
  const state: TarjanState = {
    index: 0,
    indices: new Map(),
    lowLinks: new Map(),
    onStack: new Set(),
    stack: [],
    components: [],
  };
  for (const node of [...graph.edges.keys()].sort()) {
    if (state.indices.has(node)) continue;
    walk(node, graph, state);
  }
  return state.components;
}

function walk(root: string, graph: ImportGraph, state: TarjanState): void {
  const frames: Frame[] = [{ node: root, successors: successorsOf(graph, root), next: 0 }];
  visitNode(root, state);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame === undefined) break;
    if (frame.next < frame.successors.length) {
      const successor = frame.successors[frame.next] ?? '';
      frame.next += 1;
      if (!state.indices.has(successor)) {
        visitNode(successor, state);
        frames.push({ node: successor, successors: successorsOf(graph, successor), next: 0 });
        continue;
      }
      if (state.onStack.has(successor)) {
        state.lowLinks.set(
          frame.node,
          Math.min(state.lowLinks.get(frame.node) ?? 0, state.indices.get(successor) ?? 0),
        );
      }
      continue;
    }
    frames.pop();
    closeNode(frame.node, state);
    const parent = frames[frames.length - 1];
    if (parent !== undefined) {
      state.lowLinks.set(
        parent.node,
        Math.min(state.lowLinks.get(parent.node) ?? 0, state.lowLinks.get(frame.node) ?? 0),
      );
    }
  }
}

function successorsOf(graph: ImportGraph, node: string): string[] {
  return [...(graph.edges.get(node) ?? [])].filter((target) => graph.edges.has(target)).sort();
}

function visitNode(node: string, state: TarjanState): void {
  state.indices.set(node, state.index);
  state.lowLinks.set(node, state.index);
  state.index += 1;
  state.stack.push(node);
  state.onStack.add(node);
}

function closeNode(node: string, state: TarjanState): void {
  if (state.lowLinks.get(node) !== state.indices.get(node)) return;
  const component: string[] = [];
  for (;;) {
    const member = state.stack.pop();
    if (member === undefined) break;
    state.onStack.delete(member);
    component.push(member);
    if (member === node) break;
  }
  state.components.push(component.sort());
}

/** Composantes de plus d'un fichier, plus les fichiers qui s'importent eux-mêmes. */
export function findCycles(graph: ImportGraph): Cycle[] {
  const cycles: Cycle[] = [];
  for (const component of stronglyConnectedComponents(graph)) {
    const first = component[0];
    if (component.length > 1) {
      cycles.push({ files: component });
      continue;
    }
    if (first !== undefined && (graph.edges.get(first)?.has(first) ?? false)) {
      cycles.push({ files: [first] });
    }
  }
  return cycles.sort((a, b) => b.files.length - a.files.length
    || (a.files[0] ?? '').localeCompare(b.files[0] ?? ''));
}

/**
 * Fichiers exemptés de la règle orphan : ce sont des points d'entrée consommés
 * par un outil, pas par le code, donc personne ne les importe jamais.
 * Même liste d'exemptions que la règle no-orphans de dependency-cruiser :
 * fichiers de configuration et fichiers cachés.
 */
const ORPHAN_EXEMPT = /(?:^|\/)(?:\.[^/]+|[^/]+\.config)\.[cm]?tsx?$/;

/**
 * Fichier sans aucun import entrant ni sortant : plus relié à rien. `importedElsewhere` :
 * fichiers du graphe importés depuis des fichiers hors mesure, comme les tests.
 */
export function findOrphans(graph: ImportGraph, importedElsewhere: ReadonlySet<string> = new Set()): string[] {
  const incoming = new Set<string>(importedElsewhere);
  for (const targets of graph.edges.values()) {
    for (const target of targets) incoming.add(target);
  }
  return [...graph.edges.keys()]
    .filter((file) => !incoming.has(file)
      && (graph.edges.get(file)?.size ?? 0) === 0
      && !ORPHAN_EXEMPT.test(file))
    .sort();
}

export function graphFindings(cycles: Cycle[], orphans: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const cycle of cycles) {
    const key = cycle.files.join(',');
    const head = cycle.files[0] ?? '';
    findings.push(
      makeFinding({
        tool: 'depcruise',
        rule: 'cycle',
        file: head,
        symbol: key,
        symbolKey: key,
        value: cycle.files.length,
        threshold: 1,
        message: `cycle d'imports entre ${cycle.files.length} fichiers : ${key}`,
      }),
    );
  }
  for (const orphan of orphans) {
    findings.push(
      makeFinding({
        tool: 'depcruise',
        rule: 'orphan',
        file: orphan,
        severity: 'minor',
        message: 'fichier orphelin : aucun import entrant ni sortant',
      }),
    );
  }
  return findings.sort(compareFindings);
}

export function summarizeGraph(cycles: Cycle[], orphans: string[]): DependencySummary {
  return {
    cycles: cycles.length,
    orphans: orphans.length,
    largestCycle: cycles.reduce((max, cycle) => Math.max(max, cycle.files.length), 0),
  };
}

/** Cycles seulement : les orphelins dépendent de knip, ils sont ajoutés par scan/orphans.ts. */
export function analyzeGraph(rootPath: string, graph: ImportGraph): DependencyReport {
  const cycles = findCycles(graph);
  return {
    ...envelope(rootPath, 'ts-morph'),
    summary: summarizeGraph(cycles, []),
    cycles,
    orphans: [],
    findings: graphFindings(cycles, []),
  };
}
