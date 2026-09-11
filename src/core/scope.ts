/**
 * Périmètre d'analyse tel qu'un rapport et une baseline l'enregistrent, et la règle qui
 * décide si deux périmètres se comparent : deux scans qui n'ont pas lu les mêmes fichiers
 * feraient passer leur différence pour une régression ou une amélioration.
 *
 * Aucun import de core/types.ts, qui importe ces types : pas de cycle.
 */

export interface BaselineScope {
  include: string[];
  exclude: string[];
  /** true = fichiers ignorés par git retirés du périmètre ; absent des baselines antérieures. */
  gitignore: boolean;
  /** knip et jscpd restreints au périmètre ; absent des baselines qui les comptaient hors périmètre. */
  toolsScoped: true;
  /**
   * Règles d'imports en vigueur. 2 : paquet jugé contre le package.json le plus proche, critique
   * seulement s'il n'est installé nulle part ; orphelins comptés seulement sans knip, tests compris
   * comme importeurs. Absent des baselines antérieures.
   */
  importRules: 2;
  /** Règles optionnelles activées, triées ; absent des baselines antérieures, qui les comptaient toutes. */
  rules: string[];
}

export interface ReportScope extends BaselineScope {
  gitignoreUnavailableReason?: string;
  /** Sous-dossiers qui ont leur propre package.json ; informatif, jamais écrit dans la baseline. */
  subprojects: string[];
}

export function baselineScope(scope: ReportScope): BaselineScope {
  const { include, exclude, gitignore, toolsScoped, importRules, rules } = scope;
  return { include: [...include], exclude: [...exclude], gitignore, toolsScoped, importRules, rules: [...rules] };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Sans champ `gitignore`, la baseline date d'avant ce filtrage et comptait `.next/`.
 * Sans `toolsScoped`, sa dette knip et jscpd comptait hors périmètre et passerait pour corrigée ;
 * une baseline écrite sans ces outils (`--no-tools`) n'a rien compté de tel.
 * Sans `importRules`, ses faux positifs de dépendances laisseraient de la marge à de vrais paquets inventés.
 */
export function scopeIncompatibility(
  baseline: { scope: BaselineScope; toolVersions: Record<string, string> },
  current: ReportScope,
): string | undefined {
  const scope = baseline.scope;
  if (!sameList(scope.include, current.include) || !sameList(scope.exclude, current.exclude)) {
    return 'périmètre d\'analyse modifié : refaire la baseline';
  }
  const withTools = baseline.toolVersions['knip'] !== undefined || baseline.toolVersions['jscpd'] !== undefined;
  if (withTools && scope.toolsScoped !== true) {
    return 'la baseline compte la duplication et le code mort hors du périmètre : refaire la baseline';
  }
  if (scope.importRules !== 2) {
    return 'la baseline compte orphelins et paquets non déclarés avec les règles antérieures : refaire la baseline';
  }
  return gitignoreIncompatibility(scope, current) ?? rulesIncompatibility(scope, current);
}

function gitignoreIncompatibility(scope: BaselineScope, current: ReportScope): string | undefined {
  if (scope.gitignore === current.gitignore) return undefined;
  if (scope.gitignore === true) {
    return 'la baseline excluait les fichiers ignorés par git, ce scan n\'a pas pu les exclure : '
      + (current.gitignoreUnavailableReason ?? 'git indisponible');
  }
  return 'la baseline a été écrite sans exclure les fichiers ignorés par git : refaire la baseline';
}

/** Une règle activée d'un seul côté ferait passer toute sa dette pour corrigée, ou pour nouvelle. */
function rulesIncompatibility(scope: BaselineScope, current: ReportScope): string | undefined {
  if (!Array.isArray(scope.rules)) {
    return 'la baseline date d\'avant la sélection des règles et les comptait toutes : refaire la baseline';
  }
  if (sameList(scope.rules, current.rules)) return undefined;
  const listed = (rules: string[]): string => (rules.length === 0 ? 'aucune' : rules.join(', '));
  return `règles optionnelles activées modifiées (${listed(scope.rules)} → ${listed(current.rules)}) : refaire la baseline`;
}
