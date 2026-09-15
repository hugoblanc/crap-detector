/**
 * Complexité cyclomatique (McCabe) : 1 + nombre de points de décision.
 * Comptés : if, for / for-of / for-in, while, do while, case (pas default),
 * catch, ternaire, et les opérateurs logiques qui pilotent le flux.
 * Les fonctions imbriquées sont mesurées séparément, pas dans leur parent.
 *
 * `a ?? défaut`, `x || 0`, `opts.mode || 'auto'` ne sont pas comptés : une valeur
 * par défaut n'est pas une branche que le lecteur doit suivre. Mesuré sur cinq
 * dépôts (docs/PRECISION-2026-09.md), ces opérateurs de valeur portaient 42 % des
 * alertes de la règle, dont aucune n'était jugée utile à corriger.
 *
 * `x ||= f()`, `x &&= f()`, `x ??= f()` pris comme instruction comptent, eux : l'appel
 * n'a lieu que parfois. L'ancien calcul les ratait, comparant le texte de l'opérateur
 * aux seuls `&&`, `||` et `??`.
 */
import { Node } from 'ts-morph';
import type { BinaryExpression, Node as TsNode } from 'ts-morph';
import { isFunctionLike, type FunctionLikeNode } from './cognitive.js';

export function cyclomaticComplexity(fn: FunctionLikeNode): number {
  const body = fn.getBody();
  if (body === undefined) return 1;
  let score = 1;
  const visit = (node: TsNode): void => {
    if (isFunctionLike(node)) return;
    if (
      Node.isIfStatement(node)
      || Node.isForStatement(node)
      || Node.isForOfStatement(node)
      || Node.isForInStatement(node)
      || Node.isWhileStatement(node)
      || Node.isDoStatement(node)
      || Node.isCatchClause(node)
      || Node.isConditionalExpression(node)
    ) {
      score += 1;
    } else if (Node.isCaseClause(node)) {
      score += 1;
    } else if (isLogicalOperator(node) && drivesControlFlow(node)) {
      score += 1;
    }
    node.forEachChild(visit);
  };
  visit(body);
  return score;
}

/** Court-circuits, et leurs formes d'affectation : `x ||= f()` n'appelle f que parfois. */
const SHORT_CIRCUIT = new Set(['&&', '||', '??']);
const SHORT_CIRCUIT_ASSIGNMENT = new Set(['&&=', '||=', '??=']);

function operatorOf(node: TsNode): string | undefined {
  return Node.isBinaryExpression(node) ? node.getOperatorToken().getText() : undefined;
}

function isLogicalOperator(node: TsNode): node is BinaryExpression {
  const operator = operatorOf(node);
  return operator !== undefined
    && (SHORT_CIRCUIT.has(operator) || SHORT_CIRCUIT_ASSIGNMENT.has(operator));
}

/**
 * Seuls les court-circuits se chaînent : dans `x ||= a && b`, le `&&` produit la valeur
 * affectée, il ne prend pas la position de l'affectation.
 */
function isChainedOperand(node: TsNode): boolean {
  const operator = operatorOf(node);
  return operator !== undefined && SHORT_CIRCUIT.has(operator);
}

/**
 * Un opérateur logique est un point de décision quand son résultat décide de ce qui
 * s'exécute : condition de if / while / do while / for / ternaire, ou expression
 * prise comme instruction (`pret && envoyer()`). Ailleurs il produit une valeur.
 * Les parenthèses, la négation et les opérateurs logiques imbriqués sont traversés :
 * dans `if (!(a || b) && c)`, les trois opérateurs pilotent bien le flux.
 */
function drivesControlFlow(node: BinaryExpression): boolean {
  let current: TsNode = node;
  let parent = current.getParent();
  while (parent !== undefined) {
    if (
      Node.isParenthesizedExpression(parent)
      || Node.isPrefixUnaryExpression(parent)
      || isChainedOperand(parent)
    ) {
      current = parent;
      parent = parent.getParent();
      continue;
    }
    if (Node.isExpressionStatement(parent)) return true;
    if (Node.isIfStatement(parent) || Node.isWhileStatement(parent) || Node.isDoStatement(parent)) {
      return parent.getExpression() === current;
    }
    if (Node.isForStatement(parent)) return parent.getCondition() === current;
    if (Node.isConditionalExpression(parent)) return parent.getCondition() === current;
    return false;
  }
  return false;
}
