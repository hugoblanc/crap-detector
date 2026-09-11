/**
 * Règles qu'un scan ne mesure pas toujours. La règle orphan ne tourne que quand knip n'a pas
 * tourné : unused-file couvre le même besoin, avec les conventions de framework. Le couplage
 * caché exige git et un historique assez long. Mesurées d'un seul côté, par exemple
 * `check --no-tools` face à une baseline écrite avec knip, leur dette n'est ni une régression ni
 * une amélioration.
 */
import type { AggregateKey, Aggregates } from '../core/types.js';

/** Agrégat dont l'absence veut dire « non mesuré », et `outil|règle` des clés de dette concernées. */
const SOMETIMES_MEASURED: ReadonlyArray<readonly [AggregateKey, string]> = [
  ['orphans.count', 'depcruise|orphan'],
  ['coupling.hidden.count', 'churn|hidden-coupling'],
];

export interface ComparableDebt {
  before: Record<string, number>;
  after: Record<string, number>;
  /** Clés écartées parce qu'un des deux scans ne les a pas mesurées. */
  skipped: string[];
}

/** `aggregates` : ceux de la baseline puis ceux du scan. */
export function comparableDebt(
  before: Record<string, number>,
  after: Record<string, number>,
  aggregates: readonly [Aggregates, Aggregates],
): ComparableDebt {
  const rules = SOMETIMES_MEASURED
    .filter(([aggregate]) => aggregates.some((side) => side[aggregate] === undefined))
    .map(([, rule]) => rule);
  const isUnmeasured = (key: string): boolean => rules.some((rule) => key.startsWith(`${rule}|`));
  const measured = (debt: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(debt).filter(([key]) => !isUnmeasured(key)));
  const skipped = new Set([...Object.keys(before), ...Object.keys(after)].filter(isUnmeasured));
  return { before: measured(before), after: measured(after), skipped: [...skipped].sort() };
}
