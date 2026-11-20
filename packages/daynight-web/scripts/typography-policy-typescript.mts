import {
  isAsExpression, isBinaryExpression, isCallExpression, isComputedPropertyName, isConditionalExpression,
  isElementAccessExpression, isIdentifier, isJsxAttribute, isJsxExpression, isNoSubstitutionTemplateLiteral, isNumericLiteral,
  isParenthesizedExpression, isPrefixUnaryExpression, isPropertyAccessExpression, isPropertyAssignment, isSatisfiesExpression,
  isShorthandPropertyAssignment, isStringLiteral, isTemplateExpression, isVariableDeclaration, isVariableDeclarationList, NodeFlags, SyntaxKind, type Node, type SourceFile,
} from 'typescript/unstable/ast';
import type { Checker } from 'typescript/unstable/sync';
import { collectTypographyCss, typographyValueProblem } from './typography-policy-css.mts';
import { occurrenceDiagnostic, retiredIn, type TypographyOccurrence } from './typography-policy-contract.mts';

export const collectTypographyTypeScript = (source: SourceFile, path: string, roles: ReadonlySet<string>, checker: Checker): TypographyOccurrence[] => {
  const diagnostics: TypographyOccurrence[] = [];
  let context = '';
  const aliases = new Map<number, Node>();
  const collect = (node: Node): void => {
    if (isVariableDeclarationList(node) && (node.flags & NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) {
        const symbol = isIdentifier(declaration.name) ? checker.getSymbolAtLocation(declaration.name)?.id : undefined;
        if (symbol !== undefined && declaration.initializer !== undefined) aliases.set(symbol, declaration.initializer);
      }
    }
    node.forEachChild(collect);
  };
  collect(source);
  const strings = (node: Node, seen = new Set<number>()): string[] | undefined => {
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isNumericLiteral(node)) return [node.text];
    if (isPrefixUnaryExpression(node) && (node.operator === SyntaxKind.MinusToken || node.operator === SyntaxKind.PlusToken)) {
      return strings(node.operand, seen)?.map(value => String(node.operator === SyntaxKind.MinusToken ? -Number(value) : Number(value)));
    }
    if (isParenthesizedExpression(node) || isAsExpression(node) || isSatisfiesExpression(node)) return strings(node.expression, seen);
    if (isJsxExpression(node)) return node.expression === undefined ? undefined : strings(node.expression, seen);
    if (isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)?.id;
      if (symbol === undefined || seen.has(symbol)) return;
      const value = aliases.get(symbol);
      return value === undefined ? undefined : strings(value, new Set([...seen, symbol]));
    }
    if (isConditionalExpression(node)) {
      const left = strings(node.whenTrue, seen), right = strings(node.whenFalse, seen);
      return left === undefined || right === undefined ? undefined : [...left, ...right];
    }
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken) {
      const left = strings(node.left, seen), right = strings(node.right, seen);
      return left === undefined || right === undefined ? undefined : left.flatMap(a => right.map(b => a + b));
    }
    if (isTemplateExpression(node)) {
      let values = [node.head.text];
      for (const span of node.templateSpans) {
        const parts = strings(span.expression, seen);
        if (parts === undefined) return;
        values = values.flatMap(value => parts.map(part => value + part + span.literal.text));
      }
      return values;
    }
    return;
  };
  const report = (node: Node, message: string, category: TypographyOccurrence['category'] = 'invalid', value = node.getText(source).replace(/\s+/g, ' ')): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    diagnostics.push({ path, category, context, value, line: line + 1, column: character + 1, message });
  };
  const name = (node: Node): string[] | undefined => isComputedPropertyName(node) ? strings(node.expression)
    : isIdentifier(node) ? [node.text] : strings(node);
  const inspect = (node: Node, property: string, value: Node | undefined): void => {
    const normalized = property === 'fontSize' ? 'font-size' : property.startsWith('--') ? property : property.toLowerCase();
    if (normalized !== 'font-size' && normalized !== 'font' && !normalized.startsWith('--text-') && !normalized.endsWith('-font-size')) return;
    if (normalized.startsWith('--') ) { report(node, `${normalized} cannot be defined inline; use its stylesheet owner.`); return; }
    const values = value === undefined ? undefined : strings(value);
    if (values === undefined) { report(node, `${normalized} must be a statically readable shared role or inheritance value.`); return; }
    for (const text of values) {
      if (retiredIn(text).length > 0) continue;
      const problem = typographyValueProblem(normalized, text, roles, '');
      if (problem !== undefined) report(node, problem);
    }
  };
  const declarations = (node: Node, value: Node | undefined): void => {
    const values = value === undefined ? undefined : strings(value);
    if (values === undefined) return;
    for (const text of values) {
      for (const item of collectTypographyCss(text, path, roles, true)) {
        if (item.category === 'invalid') report(node, item.message, item.category, item.value);
      }
    }
  };
  const member = (node: Node): string[] | undefined => isPropertyAccessExpression(node) ? [node.name.text]
    : isElementAccessExpression(node) ? strings(node.argumentExpression) : undefined;
  const isStyleMember = (node: Node): boolean => (isPropertyAccessExpression(node) || isElementAccessExpression(node)) && member(node.expression)?.includes('style') === true;
  const visit = (node: Node, ancestors: readonly Node[]): void => {
    context = ancestors.flatMap(parent => {
      if (isVariableDeclaration(parent) && isIdentifier(parent.name)) return [`const ${parent.name.text}`];
      if (isPropertyAssignment(parent)) return [`property ${(name(parent.name) ?? ['computed']).join('|')}`];
      return [];
    }).concat(SyntaxKind[node.kind]).join(' > ');
    const stringExpression = isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isTemplateExpression(node)
      || (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken);
    const values = stringExpression ? strings(node) : undefined;
    if (values !== undefined && values.some(value => retiredIn(value).length > 0)) {
      // Record resolved values once at their outer expression; whitespace and
      // quotation changes do not create a new legacy allowance.
      const parent = ancestors.at(-1);
      const parentValues = parent === undefined ? undefined : strings(parent);
      if (parentValues === undefined) {
        for (const value of [...new Set(values)].sort()) if (retiredIn(value).length > 0) report(node, 'retired typography identifier in TypeScript.', 'legacy-reference', value);
      }
    }
    if (isPropertyAssignment(node)) {
      const names = name(node.name);
      const diagramTheme = ancestors.some(parent => isVariableDeclaration(parent) && parent.type?.getText(source) === 'MermaidConfig')
        && names?.some(property => property !== 'maxTextSize' && (/(?:FontSize|TextSize)$/.test(property) || property === 'fontSize'));
      if (diagramTheme) report(node, 'Mermaid font configuration requires migration to measured public sizes.', 'legacy-mermaid-size', JSON.stringify([names, strings(node.initializer) ?? node.initializer.getText(source).replace(/\s+/g, ' ')]));
      else names?.forEach(property => inspect(node, property, node.initializer));
    }
    if (isShorthandPropertyAssignment(node)) {
      const symbol = checker.getShorthandAssignmentValueSymbol(node)?.id;
      name(node.name)?.forEach(property => inspect(node, property, symbol === undefined ? undefined : aliases.get(symbol)));
    }
    if (isJsxAttribute(node)) {
      const property = node.name.getText(source);
      if (property === 'style' && node.initializer !== undefined && isStringLiteral(node.initializer)) declarations(node, node.initializer);
      else inspect(node, property, node.initializer);
    }
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken && isStyleMember(node.left)) {
      for (const property of member(node.left) ?? []) {
        if (property === 'cssText') declarations(node, node.right);
        else inspect(node, property, node.right);
      }
    }
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (['getPropertyValue', 'setProperty', 'setAttribute'].includes(method)) {
        for (const argument of node.arguments) {
          for (const value of strings(argument) ?? []) if (retiredIn(value).length > 0) report(node, 'retired typography identifier in a runtime style access.', 'legacy-reference', value);
        }
      }
      if (method === 'setProperty' && member(node.expression.expression)?.includes('style') && node.arguments[0] !== undefined) {
        strings(node.arguments[0])?.forEach(property => inspect(node, property, node.arguments[1]));
      }
      if (method === 'setAttribute' && node.arguments[0] !== undefined) {
        strings(node.arguments[0])?.forEach(property => property.toLowerCase() === 'style' ? declarations(node, node.arguments[1]) : inspect(node, property, node.arguments[1]));
      }
    }
    node.forEachChild(child => visit(child, [...ancestors, node]));
  };
  visit(source, []);
  return diagnostics;
};
export const inspectTypographyTypeScript = (source: SourceFile, path: string, roles: ReadonlySet<string>, checker: Checker): string[] => collectTypographyTypeScript(source, path, roles, checker).map(occurrenceDiagnostic);
