/**
 * Métriques de taille et nommage des symboles.
 * Le nommage alimente les ids de findings : il doit être stable quand le code
 * bouge dans le fichier (pas de numéro de ligne quand un nom existe).
 */
import { Node } from 'ts-morph';
import type { Node as TsNode, SourceFile } from 'ts-morph';
import { isFunctionLike, type FunctionLikeNode } from './cognitive.js';

/** Span physique de la fonction, bornes incluses (convention ESLint max-lines-per-function). */
export function functionSloc(fn: FunctionLikeNode): number {
  return fn.getEndLineNumber() - fn.getStartLineNumber() + 1;
}

/** Lignes non vides du fichier (définition SLOC retenue pour le projet). */
export function fileSloc(sourceFile: SourceFile): number {
  return slocLines(sourceFile).size;
}

/** Numéros, à partir de 1, des lignes que compte fileSloc. */
function slocLines(sourceFile: SourceFile): Set<number> {
  const lines = new Set<number>();
  sourceFile.getFullText().split('\n').forEach((line, index) => {
    if (line.trim() !== '') lines.add(index + 1);
  });
  return lines;
}

/**
 * Ne garde, par fichier, que les lignes comptées dans le SLOC. Une plage de clone couvre
 * aussi des lignes blanches : sans ce filtre, la verbosité diviserait des lignes brutes par du SLOC.
 */
export function keepSlocLines(
  byFile: Map<string, Set<number>>,
  sourceFiles: Map<string, SourceFile>,
): Map<string, Set<number>> {
  const kept = new Map<string, Set<number>>();
  for (const [file, lines] of byFile) {
    const source = sourceFiles.get(file);
    if (source === undefined) continue;
    const sloc = slocLines(source);
    const code = new Set<number>();
    for (const line of lines) {
      if (sloc.has(line)) code.add(line);
    }
    kept.set(file, code);
  }
  return kept;
}

/**
 * Nom du symbole pour les findings et les ids stables :
 * 'fnName', 'Class.method', 'obj.prop', 'varName', 'default',
 * fallback '#arrow@L<n>' / '#fn@L<n>' pour les fonctions anonymes.
 */
export function describeFunction(fn: FunctionLikeNode): string {
  if (Node.isFunctionDeclaration(fn)) {
    return fn.getName() ?? `#fn@L${fn.getStartLineNumber()}`;
  }
  if (Node.isConstructorDeclaration(fn)) {
    const parent = fn.getParent();
    const className
      = parent !== undefined
        && (Node.isClassDeclaration(parent) || Node.isClassExpression(parent))
        ? (parent.getName() ?? '#class')
        : '#class';
    return `${className}.constructor`;
  }
  if (
    Node.isMethodDeclaration(fn)
    || Node.isGetAccessorDeclaration(fn)
    || Node.isSetAccessorDeclaration(fn)
  ) {
    const name = fn.getName() ?? '#computed';
    const parent = fn.getParent();
    if (parent !== undefined && (Node.isClassDeclaration(parent) || Node.isClassExpression(parent))) {
      return `${parent.getName() ?? '#class'}.${name}`;
    }
    return `${objectPrefixFrom(parent)}.${name}`;
  }
  const named = namedBinding(fn);
  return named ?? `#arrow@L${fn.getStartLineNumber()}`;
}

/** Profondeur maximale de chaînes de fonctions imbriquées (callback hell), racine exclue. */
export function callbackDepth(fn: FunctionLikeNode): number {
  const body = fn.getBody();
  if (body === undefined) return 0;
  const walk = (node: TsNode, depth: number): number => {
    let max = depth;
    node.forEachChild((child) => {
      const childDepth = isFunctionLike(child) ? depth + 1 : depth;
      max = Math.max(max, walk(child, childDepth));
    });
    return max;
  };
  return walk(body, 0);
}

/** Nom de la variable / propriété qui porte la fonction, si elle en a une. */
function namedBinding(fn: FunctionLikeNode): string | undefined {
  const parent = fn.getParent();
  if (parent === undefined) return undefined;
  if (Node.isVariableDeclaration(parent)) return parent.getName();
  if (Node.isPropertyAssignment(parent)) {
    return `${objectPrefixFrom(parent)}.${parent.getName()}`;
  }
  if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getText() === '=') {
    const left = parent.getLeft();
    if (Node.isIdentifier(left) || Node.isPropertyAccessExpression(left)) return left.getText();
  }
  if (Node.isExportAssignment(parent)) return 'default';
  return undefined;
}

/**
 * Chemin pointé de l'objet qui contient le nœud, jusqu'à la déclaration nommée
 * la plus haute. `const obj = { a: { b: () => {} } }` → 'obj.a' pour la fonction b.
 * Sans déclaration nommée à la racine (argument d'appel, valeur de retour) → '#object'.
 * Les niveaux intermédiaires sont conservés : deux fonctions homonymes dans deux
 * sous-objets différents doivent produire deux symboles différents, donc deux ids.
 */
function objectPrefixFrom(node: TsNode | undefined): string {
  let current: TsNode | undefined = node;
  // Appelé tantôt sur la propriété qui porte la fonction, tantôt sur l'objet lui-même.
  if (
    current !== undefined
    && (Node.isPropertyAssignment(current) || Node.isShorthandPropertyAssignment(current))
  ) {
    current = current.getParent();
  }
  const segments: string[] = [];
  while (current !== undefined) {
    if (Node.isObjectLiteralExpression(current)) {
      current = current.getParent();
      continue;
    }
    if (Node.isPropertyAssignment(current)) {
      segments.unshift(current.getName());
      current = current.getParent();
      continue;
    }
    if (Node.isVariableDeclaration(current)) {
      segments.unshift(current.getName());
      return segments.join('.');
    }
    break;
  }
  return ['#object', ...segments].join('.');
}
