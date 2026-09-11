/**
 * Contrat du rapport de code mort de knip, hors enveloppe. Aucun import : core/types.ts
 * importe ces types, un import en retour ferait un cycle.
 */

export interface DeadCodeSummary {
  unusedFiles: number;
  unusedExports: number;
  /** Absent quand la règle unused-type est désactivée : non mesuré. */
  unusedTypes?: number;
  unusedDependencies: number;
}

/**
 * Sans point d'entrée connu, knip juge morts des fichiers atteignables : ses findings de fichiers,
 * exports et dépendances inutilisés mesurent alors sa configuration, pas le code mort.
 */
export interface KnipReliability {
  /** false : trop de fichiers du périmètre signalés inutilisés, ces findings ne sont ni affichés ni comptés. */
  trusted: boolean;
  /** Part des fichiers du périmètre que knip signale inutilisés. */
  unusedFileFraction: number;
  /** Au-delà, knip est jugé non fiable : `knip.maxUnusedFileFraction` de crap-detector.json. */
  maxUnusedFileFraction: number;
  /** Sous ce nombre de fichiers signalés, knip reste jugé fiable quelle que soit leur part : `knip.minUnusedFiles`. */
  minUnusedFiles: number;
  /** Findings unused-file, unused-export, unused-type et unused-dependency écartés ; 0 si knip est fiable. */
  discarded: number;
  /** Configuration knip trouvée à la racine ; absente, knip ne connaît que ses conventions. */
  configFile?: string;
  /** Ce que le résumé dit de la fiabilité de knip et ce qu'il faut faire ; absent si rien à signaler. */
  note?: string;
}
