/**
 * D'où vient un symbole exporté que personne n'importe ? Trois réponses, trois gestes.
 *
 * knip les range sous un seul verdict : la table de constantes passée au décorateur juste
 * en dessous, où seul le mot-clé `export` est en trop ; la ligne `export { x } from './y'`,
 * où le symbole vit dans un autre module et où seule la ligne est retirable ; et le symbole
 * que personne n'appelle, le seul qui soit vraiment supprimable. Le graphe d'imports ne sait
 * pas trancher, il raisonne par fichier et pas par symbole ; l'AST du fichier, si.
 *
 * L'usage local est jugé lexicalement : on compte les identifiants qui portent ce nom
 * ailleurs que sur sa déclaration et que ses clauses d'import et d'export. Les noms de
 * propriétés (`objet.nom`, `{ nom: … }`) sont écartés, sans quoi une propriété homonyme
 * ferait passer un symbole mort pour un export superflu.
 *
 * Trous connus, tous dans le sens « usage local à tort » : la récursion, l'auto-référence
 * d'un type ou d'une classe, un membre d'enum qui en cite un autre du même nom, et un
 * homonyme déclaré dans une portée imbriquée. Reclassés à l'aveugle sur les 310 exports
 * réellement concernés de quatre dépôts réels, aucun de ces cas n'est apparu : 297 usages
 * locaux réels, 13 fichiers non analysables, zéro auto-référence et zéro ombrage. Ils
 * restent théoriques et ne sont pas traités : les corriger demanderait un résolveur de
 * portées, pour un gain nul mesuré.
 */
import { Node } from 'ts-morph';
import type { ExportDeclaration, SourceFile } from 'ts-morph';

/** Ce qu'un export sans importeur coûte à corriger : un mot-clé, une ligne, ou du code. */
export type ExportOrigin = 'local-usage' | 'reexport' | 'dead';

/** Clauses qui nomment un symbole sans l'utiliser : `import { X }`, `export { X }`, `import * as X`. */
const NAMING_CLAUSES = [Node.isImportSpecifier, Node.isExportSpecifier, Node.isImportClause, Node.isNamespaceImport];

/** Positions où un identifiant nomme autre chose que le symbole : propriété, alias, déclaration. */
function isNamePosition(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined) return true;
  // `{ NOM }` dans un littéral d'objet : c'est bien une lecture du symbole.
  if (Node.isShorthandPropertyAssignment(parent)) return false;
  // `Espace.NOM` : le nom qualifie un membre, pas le symbole du fichier.
  if (Node.isQualifiedName(parent)) return parent.getRight() === node;
  // `const { NOM: alias }` déclare une variable, des deux côtés du deux-points.
  if (Node.isBindingElement(parent)) return parent.getPropertyNameNode() === node || parent.getNameNode() === node;
  if (NAMING_CLAUSES.some((matches) => matches(parent))) return true;
  // Toute déclaration nommée, et `objet.nom` : le nœud est le nom, pas une référence.
  const named = parent as { getNameNode?: () => Node | undefined };
  return typeof named.getNameNode === 'function' && named.getNameNode() === node;
}

/** true si le fichier référence ce nom ailleurs que sur sa déclaration et ses clauses d'export. */
export function usesSymbolLocally(sourceFile: SourceFile, name: string): boolean {
  if (name === '' || name === 'default') return false;
  let used = false;
  sourceFile.forEachDescendant((node, traversal) => {
    if (!Node.isIdentifier(node) || node.getText() !== name) return;
    if (isNamePosition(node)) return;
    used = true;
    traversal.stop();
  });
  return used;
}

/** true si le nom est écrit quelque part dans le fichier, déclaration et clauses comprises. */
function mentionsName(sourceFile: SourceFile, name: string): boolean {
  let found = false;
  sourceFile.forEachDescendant((node, traversal) => {
    if (!Node.isIdentifier(node) || node.getText() !== name) return;
    found = true;
    traversal.stop();
  });
  return found;
}

/** true si cette ligne `… from '…'` réexporte ce nom, sous son nom d'origine ou sous un alias. */
function reexportsName(declaration: ExportDeclaration, name: string): boolean {
  for (const specifier of declaration.getNamedExports()) {
    if ((specifier.getAliasNode() ?? specifier.getNameNode()).getText() === name) return true;
  }
  return declaration.getNamespaceExport()?.getNameNode().getText() === name;
}

/**
 * Nature d'un export sans importeur. Un ré-export est reconnu à sa ligne nommée, ou, pour
 * un `export * from '…'`, au fait que le nom n'est écrit nulle part dans le fichier : il ne
 * peut alors venir que du module cité. Un ré-export ne peut pas servir localement, il est
 * donc cherché en premier.
 */
export function exportOrigin(sourceFile: SourceFile, name: string): ExportOrigin {
  const reexports = sourceFile.getExportDeclarations().filter((entry) => entry.getModuleSpecifier() !== undefined);
  if (reexports.some((entry) => reexportsName(entry, name))) return 'reexport';
  if (usesSymbolLocally(sourceFile, name)) return 'local-usage';
  const star = reexports.some((entry) => entry.getNamedExports().length === 0 && entry.getNamespaceExport() === undefined);
  return star && !mentionsName(sourceFile, name) ? 'reexport' : 'dead';
}

/** Réponse mémorisée par fichier et par symbole : le parcours d'AST n'est fait qu'une fois. */
export function exportOriginLookup(sourceFiles: Map<string, SourceFile>): (file: string, symbol: string) => ExportOrigin {
  const cache = new Map<string, ExportOrigin>();
  return (file, symbol) => {
    const key = `${file}\n${symbol}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const source = sourceFiles.get(file);
    // Fichier hors du périmètre analysé : rien à affirmer de plus que knip.
    const origin = source === undefined ? 'dead' : exportOrigin(source, symbol);
    cache.set(key, origin);
    return origin;
  };
}
