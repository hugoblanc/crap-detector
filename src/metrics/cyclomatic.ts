/**
 * Complexité cyclomatique (McCabe) : 1 + nombre de points de décision.
 * Comptés : if, for / for-of / for-in, while, do while, case (pas default),
 * catch, ternaire, et chaque opérateur &&, ||, ?? (contrairement à la
 * complexité cognitive qui compte les séquences une seule fois).
 * Les fonctions imbriquées sont mesurées séparément, pas dans leur parent.
 */
import { Node } from 'ts-morph';
import type { Node as TsNode } from 'ts-morph';
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
    } else if (Node.isBinaryExpression(node)) {
      const operator = node.getOperatorToken().getText();
      if (operator === '&&' || operator === '||' || operator === '??') score += 1;
    }
    node.forEachChild(visit);
  };
  visit(body);
  return score;
}
