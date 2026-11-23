import { resolve, dirname } from 'node:path';
import {
  isBinaryExpression, isCallExpression, isConditionalExpression, isIdentifier,
  isImportDeclaration, isJsxAttribute, isJsxExpression, isJsxOpeningElement,
  isJsxSelfClosingElement, isNamedImports, isNamespaceImport, isNoSubstitutionTemplateLiteral,
  isParenthesizedExpression, isPropertyAccessExpression, isStringLiteral, isTemplateExpression,
  isJsxSpreadAttribute, isObjectLiteralExpression, isPropertyAssignment, isSpreadAssignment, isComputedPropertyName,
  isVariableDeclarationList, NodeFlags, SyntaxKind, type Node, type SourceFile,
} from 'typescript/unstable/ast';
import type { Checker } from 'typescript/unstable/sync';

const literalStrings = (node: Node, aliases: ReadonlyMap<number, Node>, checker: Checker, seen = new Set<number>()): string[] | undefined => {
  const strings = (value: Node) => literalStrings(value, aliases, checker, seen);
  if (isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node)?.id;
    if (symbol === undefined || seen.has(symbol)) return undefined;
    const value = aliases.get(symbol);
    return value === undefined ? undefined : literalStrings(value, aliases, checker, new Set([...seen, symbol]));
  }
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (isParenthesizedExpression(node)) return strings(node.expression);
  if (isJsxExpression(node)) return node.expression === undefined ? undefined : strings(node.expression);
  if (isConditionalExpression(node)) {
    const left = strings(node.whenTrue), right = strings(node.whenFalse);
    return left === undefined || right === undefined ? undefined : [...left, ...right];
  }
  const combine = (left: string[], right: string[]): string[] => left.flatMap(a => right.map(b => a + b));
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken) {
    const left = strings(node.left), right = strings(node.right);
    return left === undefined || right === undefined ? undefined : combine(left, right);
  }
  if (isTemplateExpression(node)) {
    let values = [node.head.text];
    for (const span of node.templateSpans) {
      const expression = strings(span.expression);
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
  const triggers = new Set<number>(), triggerObjects = new Set<number>();
  const aliases = new Map<number, Node>();
  const collectAliases = (node: Node): void => {
    if (isVariableDeclarationList(node) && (node.flags & NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) {
        if (!isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        const symbol = checker.getSymbolAtLocation(declaration.name)?.id;
        if (symbol !== undefined) aliases.set(symbol, declaration.initializer);
      }
    }
    node.forEachChild(collectAliases);
  };
  collectAliases(source);
  const strings = (node: Node) => literalStrings(node, aliases, checker);
  const triggerPath = resolve(dirname(ownerPath), '../selection-control/SelectTrigger');
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
    const trigger = module.startsWith('.') && resolve(dirname(source.fileName), module).replace(/\.(?:tsx?|jsx?)$/, '') === triggerPath;
    if (!react && !native && !trigger) continue;
    const clause = statement.importClause;
    if (react && clause.name !== undefined) add(reactObjects, clause.name);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && isNamespaceImport(bindings)) add(react ? reactObjects : native ? selectObjects : triggerObjects, bindings.name);
    if (bindings !== undefined && isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (binding.isTypeOnly) continue;
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (react && imported === 'default') add(reactObjects, binding.name);
        if (react && imported === 'createElement') add(createElements, binding.name);
        if (native && imported === 'NativeSelect') add(selects, binding.name);
        if (trigger && imported === 'SelectTrigger') add(triggers, binding.name);
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
  const inspectWrapper = (node: Node, value: Node | undefined, property = 'wrapperClassName'): void => {
    const values = value === undefined ? undefined : strings(value);
    if (values === undefined) report(node, `native-select ${property} must be a static string token list or literal combination.`);
    else for (const text of values) for (const token of text.split(/\s+/).filter(Boolean)) wrappers.add(token);
  };
  const inspectProperty = (node: Node, names: string[] | undefined, value: Node | undefined, trigger: boolean): void => {
    if (names === undefined) { report(node, 'native-select computed props must have a literal property name.'); return; }
    if (names.some(name => name === 'className' || name === 'style')) report(node, 'selection-control className/style are forbidden; use public presentation props and static layout classes.');
    const property = trigger ? 'layoutClassName' : 'wrapperClassName';
    if (names.includes(property)) inspectWrapper(node, value, property);
  };
  const inspectProps = (node: Node, trigger: boolean): void => {
    if (isParenthesizedExpression(node)) { inspectProps(node.expression, trigger); return; }
    if (isConditionalExpression(node)) { inspectProps(node.whenTrue, trigger); inspectProps(node.whenFalse, trigger); return; }
    if (node.kind === SyntaxKind.NullKeyword) return;
    if (!isObjectLiteralExpression(node)) {
      report(node, 'native-select props spreads must be literal objects so wrapperClassName tokens can be checked.');
      return;
    }
    for (const property of node.properties) {
      if (isSpreadAssignment(property)) { inspectProps(property.expression, trigger); continue; }
      const name = isComputedPropertyName(property.name) ? strings(property.name.expression) :
        [isStringLiteral(property.name) ? property.name.text : property.name.getText(source)];
      inspectProperty(property, name, isPropertyAssignment(property) ? property.initializer : undefined, trigger);
    }
  };
  const nativeComponent = (node: Node): boolean => matches(selects, node) || member(node, 'NativeSelect', selectObjects);
  const triggerComponent = (node: Node): boolean => matches(triggers, node) || member(node, 'SelectTrigger', triggerObjects);
  const visit = (node: Node): void => {
    if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) {
      if (isIdentifier(node.tagName) && node.tagName.text.startsWith('s') && node.tagName.text.toLowerCase() === 'select' && resolve(source.fileName) !== ownerPath) {
        report(node, 'native-select creation: use NativeSelect from ui/native-select/NativeSelect.');
      }
      if (nativeComponent(node.tagName) || triggerComponent(node.tagName)) {
        const trigger = triggerComponent(node.tagName);
        for (const attribute of node.attributes.properties) {
          if (isJsxSpreadAttribute(attribute)) { inspectProps(attribute.expression, trigger); continue; }
          if (!isJsxAttribute(attribute)) continue;
          inspectProperty(attribute, [attribute.name.getText(source)], attribute.initializer, trigger);
        }
      }
    }
    if (isCallExpression(node) && (matches(createElements, node.expression) || member(node.expression, 'createElement', reactObjects))) {
      const element = node.arguments[0];
      if (element !== undefined && strings(element)?.some(tag => tag.toLowerCase() === 'select') && resolve(source.fileName) !== ownerPath) {
        report(node, 'native-select creation: use NativeSelect from ui/native-select/NativeSelect.');
      }
      if (element !== undefined && (nativeComponent(element) || triggerComponent(element)) && node.arguments[1] !== undefined) inspectProps(node.arguments[1], triggerComponent(element));
    }
    node.forEachChild(visit);
  };
  visit(source);
  return { diagnostics, wrappers };
};
