/**
 * Signatures d'« AI slop » vérifiables sur l'AST.
 *
 * Deux familles :
 * - verbosité : lignes qui n'apportent rien (else redondant, variable assignée puis
 *   retournée, ternaire booléen, wrapper qui délègue à l'identique, catch vide).
 *   Elles alimentent la métrique Verbosity de SlopCodeBench.
 * - échappements de typage : `any` explicite, double assertion `as unknown as`,
 *   `@ts-ignore`. Le compilateur ne les voit pas, et un agent les utilise pour
 *   faire taire une erreur au lieu de la corriger.
 *
 * Volontairement absent : la détection de « commentaires redondants ». Aucune
 * formulation déterministe n'en donne un taux de faux positifs acceptable, et
 * une règle bruyante tue la confiance dans tout l'outil en une semaine.
 */
import { Node, SyntaxKind } from 'ts-morph';
import type { Node as TsNode, SourceFile } from 'ts-morph';
import type { Severity } from '../core/types.js';
import { isFunctionLike } from '../metrics/cognitive.js';
import type { FunctionLikeNode } from '../metrics/cognitive.js';
import { describeFunction } from '../metrics/sizes.js';

export interface SlopHit {
  rule: string;
  file: string;
  line: number;
  endLine: number;
  /** Fonction englobante, ou '#module' au niveau du fichier. */
  symbol: string;
  severity: Severity;
  message: string;
}

/** Règles comptées dans la fraction de verbosité (lignes inutiles). */
export const VERBOSITY_RULES: ReadonlySet<string> = new Set([
  'empty-catch',
  'console-only-catch',
  'redundant-else',
  'assign-then-return',
  'boolean-ternary',
  'passthrough-wrapper',
]);

/** Règles comptées dans les échappements de typage. */
export const TYPE_ESCAPE_RULES: ReadonlySet<string> = new Set([
  'type-escape-any',
  'type-escape-assertion',
  'type-escape-comment',
]);

const MODULE_SYMBOL = '#module';

/** Nom de la fonction contenant le nœud ; '#module' au niveau du fichier. */
export function enclosingSymbol(node: TsNode): string {
  let current: TsNode | undefined = node.getParent();
  while (current !== undefined) {
    if (isFunctionLike(current)) return describeFunction(current as FunctionLikeNode);
    current = current.getParent();
  }
  return MODULE_SYMBOL;
}

function hit(
  file: string,
  node: TsNode,
  rule: string,
  severity: Severity,
  message: string,
): SlopHit {
  return {
    rule,
    file,
    line: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    symbol: enclosingSymbol(node),
    severity,
    message,
  };
}

function isConsoleCall(statement: TsNode): boolean {
  if (!Node.isExpressionStatement(statement)) return false;
  const expression = statement.getExpression();
  if (!Node.isCallExpression(expression)) return false;
  const callee = expression.getExpression();
  return Node.isPropertyAccessExpression(callee)
    && Node.isIdentifier(callee.getExpression())
    && callee.getExpression().getText() === 'console';
}

/** Un catch vide ou qui se contente de logger masque l'erreur au lieu de la traiter. */
function catchRules(sourceFile: SourceFile, file: string, hits: SlopHit[]): void {
  for (const clause of sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause)) {
    const statements = clause.getBlock().getStatements();
    if (statements.length === 0) {
      hits.push(hit(file, clause, 'empty-catch', 'major', 'catch vide : l\'erreur est avalée'));
      continue;
    }
    if (statements.every(isConsoleCall)) {
      hits.push(
        hit(file, clause, 'console-only-catch', 'major', 'catch qui ne fait que logger'),
      );
    }
  }
}

/** Le dernier statement d'une branche coupe-t-il le flux ? */
function endsFlow(statement: TsNode | undefined): boolean {
  if (statement === undefined) return false;
  if (Node.isBlock(statement)) {
    const inner = statement.getStatements();
    return endsFlow(inner[inner.length - 1]);
  }
  return Node.isReturnStatement(statement)
    || Node.isThrowStatement(statement)
    || Node.isContinueStatement(statement)
    || Node.isBreakStatement(statement);
}

/** `if (…) { return x; } else { … }` : le else n'apporte qu'un niveau d'imbrication. */
function redundantElse(sourceFile: SourceFile, file: string, hits: SlopHit[]): void {
  for (const statement of sourceFile.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const elseStatement = statement.getElseStatement();
    if (elseStatement === undefined || Node.isIfStatement(elseStatement)) continue;
    if (!endsFlow(statement.getThenStatement())) continue;
    hits.push(
      hit(file, elseStatement, 'redundant-else', 'minor', 'else inutile après un then qui sort'),
    );
  }
}

/** `const x = …; return x;` en fin de bloc : la variable ne sert qu'une fois. */
function assignThenReturn(sourceFile: SourceFile, file: string, hits: SlopHit[]): void {
  for (const block of sourceFile.getDescendantsOfKind(SyntaxKind.Block)) {
    const statements = block.getStatements();
    const last = statements[statements.length - 1];
    const previous = statements[statements.length - 2];
    if (last === undefined || previous === undefined) continue;
    if (!Node.isReturnStatement(last) || !Node.isVariableStatement(previous)) continue;
    const expression = last.getExpression();
    if (expression === undefined || !Node.isIdentifier(expression)) continue;
    const declarations = previous.getDeclarationList().getDeclarations();
    if (declarations.length !== 1) continue;
    const declaration = declarations[0];
    if (declaration === undefined) continue;
    const nameNode = declaration.getNameNode();
    if (!Node.isIdentifier(nameNode) || nameNode.getText() !== expression.getText()) continue;
    hits.push(
      {
        rule: 'assign-then-return',
        file,
        line: previous.getStartLineNumber(),
        endLine: last.getEndLineNumber(),
        symbol: enclosingSymbol(previous),
        severity: 'minor',
        message: `'${nameNode.getText()}' est assignée puis retournée immédiatement`,
      },
    );
  }
}

/** `cond ? true : false` : la condition est déjà le booléen. */
function booleanTernary(sourceFile: SourceFile, file: string, hits: SlopHit[]): void {
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    const branches = [node.getWhenTrue().getText(), node.getWhenFalse().getText()].sort();
    if (branches[0] === 'false' && branches[1] === 'true') {
      hits.push(hit(file, node, 'boolean-ternary', 'minor', 'ternaire qui rend true / false'));
    }
  }
}

/** Corps d'une fonction réduit à un unique `return <expression>`. */
function soleReturnedExpression(fn: FunctionLikeNode): TsNode | undefined {
  const body = fn.getBody();
  if (body === undefined) return undefined;
  if (!Node.isBlock(body)) return body;
  const statements = body.getStatements();
  if (statements.length !== 1) return undefined;
  const only = statements[0];
  if (only === undefined || !Node.isReturnStatement(only)) return undefined;
  return only.getExpression();
}

/**
 * Wrapper qui transmet ses paramètres à l'identique, sans rien ajouter.
 * Restreint aux fonctions à au moins un paramètre, tous repassés dans le même
 * ordre : un `() => doThing()` est souvent un usage légitime de la paresse.
 */
function passthroughWrapper(sourceFile: SourceFile, file: string, hits: SlopHit[]): void {
  const functions: FunctionLikeNode[] = [];
  sourceFile.forEachDescendant((node) => {
    if (isFunctionLike(node)) functions.push(node as FunctionLikeNode);
  });
  for (const fn of functions) {
    const parameters = fn.getParameters();
    if (parameters.length === 0) continue;
    if (parameters.some((parameter) => !Node.isIdentifier(parameter.getNameNode()))) continue;
    const expression = soleReturnedExpression(fn);
    if (expression === undefined || !Node.isCallExpression(expression)) continue;
    const args = expression.getArguments();
    if (args.length !== parameters.length) continue;
    const identical = args.every(
      (argument, index) =>
        Node.isIdentifier(argument) && argument.getText() === parameters[index]?.getName(),
    );
    if (!identical) continue;
    hits.push(
      hit(
        file,
        fn,
        'passthrough-wrapper',
        'minor',
        `${describeFunction(fn)} ne fait que transmettre ses paramètres`,
      ),
    );
  }
}

/** `any` explicite, sous toutes ses formes d'annotation. */
function explicitAny(sourceFile: SourceFile, file: string, hits: SlopHit[]): void {
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.AnyKeyword)) {
    hits.push(hit(file, node, 'type-escape-any', 'major', 'type any explicite'));
  }
}

/** `x as unknown as T` : double assertion, le typage est contourné en deux temps. */
function doubleAssertion(sourceFile: SourceFile, file: string, hits: SlopHit[]): void {
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression)) {
    const inner = node.getExpression();
    if (!Node.isAsExpression(inner)) continue;
    if (inner.getTypeNode()?.getKind() !== SyntaxKind.UnknownKeyword) continue;
    hits.push(
      hit(file, node, 'type-escape-assertion', 'major', 'double assertion as unknown as'),
    );
  }
}

const TS_COMMENT_PATTERN = /^\s*(?:\/\/|\/\*+|\*)\s*@ts-(ignore|nocheck)\b/;

/**
 * `@ts-ignore` et `@ts-nocheck` désactivent le compilateur sans laisser de trace.
 * `@ts-expect-error` n'est pas visé : il échoue si l'erreur disparaît, donc il se nettoie.
 * Détection ligne à ligne, pas via l'AST : une occurrence dans une chaîne de
 * caractères serait comptée à tort, cas jugé négligeable.
 */
function tsComments(sourceFile: SourceFile, file: string, hits: SlopHit[]): void {
  const lines = sourceFile.getFullText().split('\n');
  lines.forEach((text, index) => {
    const match = TS_COMMENT_PATTERN.exec(text);
    if (match === null) return;
    hits.push({
      rule: 'type-escape-comment',
      file,
      line: index + 1,
      endLine: index + 1,
      symbol: MODULE_SYMBOL,
      severity: 'major',
      message: `@ts-${match[1]} : erreur de compilation masquée`,
    });
  });
}

/** Toutes les occurrences de slop du fichier, triées par ligne. */
export function slopHits(sourceFile: SourceFile, file: string): SlopHit[] {
  const hits: SlopHit[] = [];
  catchRules(sourceFile, file, hits);
  redundantElse(sourceFile, file, hits);
  assignThenReturn(sourceFile, file, hits);
  booleanTernary(sourceFile, file, hits);
  passthroughWrapper(sourceFile, file, hits);
  explicitAny(sourceFile, file, hits);
  doubleAssertion(sourceFile, file, hits);
  tsComments(sourceFile, file, hits);
  return hits.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}
