/**
 * La règle orphan ne tourne que quand knip n'a pas tourné : unused-file couvre le même besoin,
 * avec les conventions de framework. Mesurée d'un seul côté, par exemple `check --no-tools` face
 * à une baseline écrite avec knip, sa dette n'est ni une régression ni une amélioration.
 */
import type { Aggregates } from '../core/types.js';

const ORPHAN_KEY_PREFIX = 'depcruise|orphan|';

export interface ComparableDebt {
  before: Record<string, number>;
  after: Record<string, number>;
  /** Clés d'orphelins écartées parce qu'un des deux scans ne les a pas mesurées. */
  skipped: string[];
}

/** `aggregates` : ceux de la baseline puis ceux du scan ; `orphans.count` absent veut dire non mesuré. */
export function comparableDebt(
  before: Record<string, number>,
  after: Record<string, number>,
  aggregates: readonly [Aggregates, Aggregates],
): ComparableDebt {
  if (aggregates.every((side) => side['orphans.count'] !== undefined)) return { before, after, skipped: [] };
  const isOrphan = (key: string): boolean => key.startsWith(ORPHAN_KEY_PREFIX);
  const measured = (debt: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(debt).filter(([key]) => !isOrphan(key)));
  const skipped = new Set([...Object.keys(before), ...Object.keys(after)].filter(isOrphan));
  return { before: measured(before), after: measured(after), skipped: [...skipped].sort() };
}
