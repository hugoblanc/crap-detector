/**
 * Métrique d'érosion (SlopCodeBench, arXiv 2603.24755) :
 * part de la masse de code située dans des fonctions au-delà du seuil cyclomatique.
 * mass(f) = CC(f) x sqrt(SLOC(f)) ; erosion = sum(mass si CC > seuil) / sum(mass).
 * Repères de l'étude : ~0,31 pour du code humain, ~0,68 pour du code agentique.
 */
import type { FunctionMetrics } from '../core/types.js';

type SizeableFunction = Pick<FunctionMetrics, 'cyclomatic' | 'sloc'>;

export interface ErosionStats {
  /** Masse concentrée dans les fonctions au-delà du seuil. */
  erodedMass: number;
  totalMass: number;
  fraction: number;
}

/**
 * La masse érodée est rendue à part parce que la fraction seule ne suffit pas à
 * décider d'une régression : supprimer du code sain fait monter le ratio sans
 * que rien n'ait empiré. Le cliquet a besoin des deux.
 */
export function erosionStats(
  functions: SizeableFunction[],
  cyclomaticThreshold: number,
): ErosionStats {
  let totalMass = 0;
  let erodedMass = 0;
  for (const fn of functions) {
    const mass = fn.cyclomatic * Math.sqrt(fn.sloc);
    totalMass += mass;
    if (fn.cyclomatic > cyclomaticThreshold) erodedMass += mass;
  }
  return {
    erodedMass,
    totalMass,
    fraction: totalMass > 0 ? erodedMass / totalMass : 0,
  };
}

export function erosionFraction(functions: SizeableFunction[], cyclomaticThreshold: number): number {
  return erosionStats(functions, cyclomaticThreshold).fraction;
}
