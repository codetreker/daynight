import { resolve, dirname } from 'node:path';
import {
  isBinaryExpression, isCallExpression, isConditionalExpression, isIdentifier,
  isImportDeclaration, isJsxAttribute, isJsxExpression, isJsxOpeningElement,
  isJsxSelfClosingElement, isNamedImports, isNamespaceImport, isNoSubstitutionTemplateLiteral,
  isParenthesizedExpression, isPropertyAccessExpression, isStringLiteral, isTemplateExpression,
  isJsxSpreadAttribute, isObjectLiteralExpression, isPropertyAssignment, isSpreadAssignment, isComputedPropertyName,
  SyntaxKind, type Node, type SourceFile,
} from 'typescript/unstable/ast';
import type { Checker } from 'typescript/unstable/sync';

const literalStrings = (node: Node): string[] | undefined => {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (isParenthesizedExpression(node)) return literalStrings(node.expression);
  if (isJsxExpression(node)) return node.expression === undefined ? undefined : literalStrings(node.expression);
  if (isConditionalExpression(node)) {
    const left = literalStrings(node.whenTrue), right = literalStrings(node.whenFalse);
    return left === undefined || right === undefined ? undefined : [...left, ...right];
  }
  const combine = (left: string[], right: string[]): string[] => left.flatMap(a => right.map(b => a + b));
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken) {
    const left = literalStrings(node.left), right = literalStrings(node.right);
    return left === undefined || right === undefined ? undefined : combine(left, right);
  }
  if (isTemplateExpression(node)) {
    let values = [node.head.text];
    for (const span of node.templateSpans) {
      const expression = literalStrings(span.expression);
      if (expression === undefined) return undefined;
      values = combine(values, expression).map(value => value + span.literal.text);
    }
    return values;
  }
  return undefined;
};

export const inspectSelectTypeScript = (
  source: SourceFile, path: string, ownerPath: string, checker: Checker,
): { diagnostics: string[]; wrappers: Set<string> } => {
  const diagnostics: string[] = [], wrappers = new Set<string>();
  const reactObjects = new Set<number>(), createElements = new Set<number>();
  const selects = new Set<number>(), selectObjects = new Set<number>();
  const bindingNames = new Set<string>();
  const id = (node: Node): number | undefined => checker.getSymbolAtLocation(node)?.id;
  const add = (set: Set<number>, node: Node): void => {
    const symbol = id(node);
    if (symbol === undefined) throw new Error(`${path}:1: import binding AST has no symbol: ${node.getText(source)}.`);
    set.add(symbol);
    bindingNames.add(node.getText(source));
  };
  for (const statement of source.statements) {
    if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier) || statement.importClause === undefined) continue;
    const module = statement.moduleSpecifier.text;
    const react = module === 'react';
    const native = module.startsWith('.') && resolve(dirname(source.fileName), module).replace(/\.(?:tsx?|jsx?)$/, '') === ownerPath.replace(/\.tsx$/, '');
    if (!react && !native) continue;
    const clause = statement.importClause;
    if (react && clause.name !== undefined) add(reactObjects, clause.name);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && isNamespaceImport(bindings)) add(react ? reactObjects : selectObjects, bindings.name);
    if (bindings !== undefined && isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (binding.isTypeOnly) continue;
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (react && imported === 'default') add(reactObjects, binding.name);
        if (react && imported === 'createElement') add(createElements, binding.name);
        if (native && imported === 'NativeSelect') add(selects, binding.name);
      }
    }
  }
  const matches = (set: ReadonlySet<number>, node: Node): boolean => {
    if (set.size === 0 || !isIdentifier(node) || !bindingNames.has(node.text)) return false;
    const symbol = id(node);
    return symbol !== undefined && set.has(symbol);
  };
  const member = (node: Node, name: string, objects: ReadonlySet<number>): boolean =>
    isPropertyAccessExpression(node) && node.name.text === name && matches(objects, node.expression);
  const report = (node: Node, message: string): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    diagnostics.push(`${path}:${line + 1}:${character + 1}: ${message}`);
  };
  const inspectWrapper = (node: Node, value: Node | undefined): void => {
    const values = value === undefined ? undefined : literalStrings(value);
    if (values === undefined) report(node, 'native-select wrapperClassName must be a static string token list or literal combination.');
    else for (const text of values) for (const token of text.split(/\s+/).filter(Boolean)) wrappers.add(token);
  };
  const inspectProps = (node: Node): void => {
    if (isParenthesizedExpression(node)) { inspectProps(node.expression); return; }
    if (node.kind === SyntaxKind.NullKeyword) return;
    if (!isObjectLiteralExpression(node)) {
      report(node, 'native-select props spreads must be literal objects so wrapperClassName tokens can be checked.');
      return;
    }
    for (const property of node.properties) {
      if (isSpreadAssignment(property)) { inspectProps(property.expression); continue; }
      const name = isComputedPropertyName(property.name) ? literalStrings(property.name.expression) :
        [isStringLiteral(property.name) ? property.name.text : property.name.getText(source)];
      if (name === undefined) report(property, 'native-select computed props must have a literal property name.');
      else if (name.includes('wrapperClassName')) inspectWrapper(property, isPropertyAssignment(property) ? property.initializer : undefined);
    }
  };
  const nativeComponent = (node: Node): boolean => matches(selects, node) || member(node, 'NativeSelect', selectObjects);
  const visit = (node: Node): void => {
    if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) {
      if (isIdentifier(node.tagName) && node.tagName.text === 'select' && resolve(source.fileName) !== ownerPath) {
        report(node, 'native-select creation: use NativeSelect from ui/native-select/NativeSelect.');
      }
      if (nativeComponent(node.tagName)) {
        for (const attribute of node.attributes.properties) {
          if (isJsxSpreadAttribute(attribute)) { inspectProps(attribute.expression); continue; }
          if (!isJsxAttribute(attribute) || attribute.name.getText(source) !== 'wrapperClassName') continue;
          inspectWrapper(attribute, attribute.initializer);
        }
      }
    }
    if (isCallExpression(node) && (matches(createElements, node.expression) || member(node.expression, 'createElement', reactObjects))) {
      const element = node.arguments[0];
      if (element !== undefined && literalStrings(element)?.includes('select') && resolve(source.fileName) !== ownerPath) {
        report(node, 'native-select creation: use NativeSelect from ui/native-select/NativeSelect.');
      }
      if (element !== undefined && nativeComponent(element) && node.arguments[1] !== undefined) inspectProps(node.arguments[1]);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return { diagnostics, wrappers };
};
