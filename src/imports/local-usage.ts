/**
 * Un symbole exporté sans importeur sert-il quand même dans son propre fichier ?
 *
 * C'est la question qui sépare deux situations que knip confond : la table de constantes
 * passée au décorateur juste en dessous, où seul le mot-clé `export` est en trop, et le
 * symbole que personne n'appelle, qui est supprimable. Le graphe d'imports ne sait pas
 * répondre — il raisonne par fichier, pas par symbole — mais l'AST du fichier, si.
 *
 * Volontairement lexical : on compte les identifiants qui portent ce nom ailleurs que sur
 * sa déclaration et que ses clauses d'export. Les noms de propriétés (`objet.nom`, `{ nom: … }`)
 * sont écartés, sans quoi une propriété homonyme suffirait à faire passer un symbole mort
 * pour un export superflu. L'inverse — rater un usage — ne fait que laisser l'alerte
 * majeure d'origine, qui reste exacte.
 */
import { Node } from 'ts-morph';
import type { SourceFile } from 'ts-morph';

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

/** Réponse mémorisée par fichier et par symbole : le parcours d'AST n'est fait qu'une fois. */
export function localUsageLookup(sourceFiles: Map<string, SourceFile>): (file: string, symbol: string) => boolean {
  const cache = new Map<string, boolean>();
  return (file, symbol) => {
    const key = `${file}\n${symbol}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const source = sourceFiles.get(file);
    const used = source !== undefined && usesSymbolLocally(source, symbol);
    cache.set(key, used);
    return used;
  };
}
