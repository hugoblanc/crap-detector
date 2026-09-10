/**
 * Complexité cognitive, implémentation de la spec Sonar v1.7
 * (G. Ann Campbell, « Cognitive Complexity: a new way of measuring understandability »,
 * 29 août 2023, https://www.sonarsource.com/docs/CognitiveComplexity.pdf).
 *
 * Règles implémentées (Appendix B) :
 * - Incréments : if / else if / else / ternaire, switch (+ tous ses case = 1 seul),
 *   for / foreach, while / do while, catch, break|continue étiquetés,
 *   séquences d'opérateurs logiques binaires (1 par séquence de même opérateur,
 *   les parenthèses cassent la séquence), chaque fonction d'un cycle de récursion.
 * - Niveau d'imbrication (B2) : if / else if / else, ternaire, switch, boucles,
 *   catch, fonctions et lambdas imbriquées. try et finally sont ignorés.
 * - Incrément d'imbrication (B3) : + niveau courant pour if, ternaire, switch,
 *   boucles, catch. else / else if sont hybrides : +1 sans incrément d'imbrication.
 * - Lambdas et méthodes imbriquées : +0 elles-mêmes, mais leur contenu est à niveau+1
 *   et compte dans le score de la fonction englobante (exemple myMethod2 du papier : 2).
 */
import { Node, SyntaxKind } from 'ts-morph';
import type {
  ArrowFunction,
  BinaryExpression,
  CallExpression,
  ConstructorDeclaration,
  FunctionDeclaration,
  FunctionExpression,
  GetAccessorDeclaration,
  IfStatement,
  MethodDeclaration,
  Node as TsNode,
  SetAccessorDeclaration,
  SourceFile,
} from 'ts-morph';

export type FunctionLikeNode =
  | ArrowFunction
  | ConstructorDeclaration
  | FunctionDeclaration
  | FunctionExpression
  | GetAccessorDeclaration
  | MethodDeclaration
  | SetAccessorDeclaration;

export function isFunctionLike(node: TsNode): node is FunctionLikeNode {
  return (
    Node.isArrowFunction(node)
    || Node.isConstructorDeclaration(node)
    || Node.isFunctionDeclaration(node)
    || Node.isFunctionExpression(node)
    || Node.isGetAccessorDeclaration(node)
    || Node.isMethodDeclaration(node)
    || Node.isSetAccessorDeclaration(node)
  );
}

export interface CognitiveResult {
  score: number;
  /** Profondeur d'imbrication Sonar maximale atteinte dans la fonction. */
  maxNesting: number;
}

export function analyzeCognitive(fn: FunctionLikeNode): CognitiveResult {
  const state: WalkState = {
    score: 0,
    maxNesting: 0,
    fnName: simpleName(fn),
    recursionCounted: false,
  };
  const body = fn.getBody();
  if (body !== undefined) visit(body, 0, state);
  return { score: state.score, maxNesting: state.maxNesting };
}

interface WalkState {
  score: number;
  maxNesting: number;
  /** Nom simple de la fonction analysée, pour détecter la récursion directe. */
  fnName: string | undefined;
  /** La spec compte +1 par fonction d'un cycle de récursion, pas par appel. */
  recursionCounted: boolean;
}

function visit(node: TsNode, level: number, state: WalkState): void {
  state.maxNesting = Math.max(state.maxNesting, level);

  if (Node.isIfStatement(node)) {
    visitIf(node, level, false, state);
    return;
  }
  if (Node.isConditionalExpression(node)) {
    state.score += 1 + level;
    visit(node.getCondition(), level, state);
    visit(node.getWhenTrue(), level + 1, state);
    visit(node.getWhenFalse(), level + 1, state);
    return;
  }
  if (
    Node.isForStatement(node)
    || Node.isForOfStatement(node)
    || Node.isForInStatement(node)
    || Node.isWhileStatement(node)
    || Node.isDoStatement(node)
  ) {
    state.score += 1 + level;
    // En-tête de boucle au niveau courant, corps un niveau plus profond.
    visitStructure(node, node.getStatement(), level, state);
    return;
  }
  if (Node.isSwitchStatement(node)) {
    // Le switch et tous ses case combinés = un seul incrément structurel.
    state.score += 1 + level;
    visit(node.getExpression(), level, state);
    for (const clause of node.getCaseBlock().getClauses()) {
      for (const statement of clause.getStatements()) visit(statement, level + 1, state);
    }
    return;
  }
  if (Node.isCatchClause(node)) {
    state.score += 1 + level;
    for (const statement of node.getBlock().getStatements()) visit(statement, level + 1, state);
    return;
  }
  if (Node.isBreakStatement(node) || Node.isContinueStatement(node)) {
    // Seuls les sauts multi-niveaux (vers label) incrémentent.
    if (node.getLabel() !== undefined) state.score += 1;
    return;
  }
  if (isFunctionLike(node)) {
    // Lambda / méthode imbriquée : +0, mais contenu un niveau plus profond.
    visitChildren(node, level + 1, state);
    return;
  }
  if (Node.isBinaryExpression(node) && isLogicalOperator(node)) {
    if (isLogicalSequenceRoot(node)) state.score += 1;
    // Les séquences logiques sont des incréments fondamentaux : pas d'effet du niveau.
    visitChildren(node, level, state);
    return;
  }
  if (Node.isCallExpression(node) && !state.recursionCounted && isRecursiveCall(node, state.fnName)) {
    state.score += 1;
    state.recursionCounted = true;
  }
  visitChildren(node, level, state);
}

function visitIf(node: IfStatement, level: number, isElseIf: boolean, state: WalkState): void {
  state.score += isElseIf ? 1 : 1 + level;
  // La condition est au niveau du if : ses opérateurs logiques ne prennent pas de bonus.
  visit(node.getExpression(), level, state);
  visit(node.getThenStatement(), level + 1, state);
  const elseStatement = node.getElseStatement();
  if (elseStatement === undefined) return;
  // else et else if sont hybrides : +1, pas d'incrément d'imbrication,
  // mais leurs contenus sont un niveau plus profond (B2).
  state.score += 1;
  if (Node.isIfStatement(elseStatement)) {
    visitIf(elseStatement, level, true, state);
  } else {
    visit(elseStatement, level + 1, state);
  }
}

function visitChildren(node: TsNode, level: number, state: WalkState): void {
  node.forEachChild((child) => visit(child, level, state));
}

/** Visite les enfants au niveau courant, sauf le corps de la structure qui descend d'un niveau. */
function visitStructure(node: TsNode, body: TsNode, level: number, state: WalkState): void {
  node.forEachChild((child) => {
    visit(child, child === body ? level + 1 : level, state);
  });
}

function isLogicalOperator(node: BinaryExpression): boolean {
  const operator = node.getOperatorToken().getText();
  return operator === '&&' || operator === '||';
}

/**
 * Racine d'une séquence = nœud logique dont le parent direct n'est pas
 * le même opérateur. Les parenthèses cassent la séquence :
 * `a && (b && c)` compte deux séquences (exemple du white paper).
 */
function isLogicalSequenceRoot(node: BinaryExpression): boolean {
  const parent = node.getParent();
  if (parent === undefined || !Node.isBinaryExpression(parent)) return true;
  return parent.getOperatorToken().getText() !== node.getOperatorToken().getText();
}

function isRecursiveCall(call: CallExpression, fnName: string | undefined): boolean {
  if (fnName === undefined) return false;
  const expression = call.getExpression();
  if (Node.isIdentifier(expression)) return expression.getText() === fnName;
  if (Node.isPropertyAccessExpression(expression)) {
    return expression.getName() === fnName && Node.isThisExpression(expression.getExpression());
  }
  return false;
}

/** Nom simple de la fonction, pour la détection de récursion directe. */
export function simpleName(fn: FunctionLikeNode): string | undefined {
  if (
    Node.isFunctionDeclaration(fn)
    || Node.isMethodDeclaration(fn)
    || Node.isGetAccessorDeclaration(fn)
    || Node.isSetAccessorDeclaration(fn)
  ) {
    return fn.getName() ?? undefined;
  }
  const parent = fn.getParent();
  if (parent === undefined) return undefined;
  if (Node.isVariableDeclaration(parent)) return parent.getName();
  if (Node.isPropertyAssignment(parent)) return parent.getName();
  return undefined;
}

const FUNCTION_LIKE_KINDS: readonly SyntaxKind[] = [
  SyntaxKind.ArrowFunction,
  SyntaxKind.Constructor,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.GetAccessor,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.SetAccessor,
];

/** Toutes les fonctions du fichier (racines d'analyse), en ordre de position. */
export function functionLikeNodes(sourceFile: SourceFile): FunctionLikeNode[] {
  const nodes: TsNode[] = [];
  for (const kind of FUNCTION_LIKE_KINDS) {
    nodes.push(...sourceFile.getDescendantsOfKind(kind));
  }
  return nodes
    .filter((node): node is FunctionLikeNode => isFunctionLike(node))
    .filter((fn) => fn.getBody() !== undefined)
    .sort((a, b) => a.getStart() - b.getStart() || a.getKind() - b.getKind());
}
