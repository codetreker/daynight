import {
  isArrowFunction, isAsExpression, isBinaryExpression, isCallExpression, isComputedPropertyName, isConditionalExpression,
  isArrayBindingPattern, isElementAccessExpression, isIdentifier, isImportSpecifier, isJsxAttribute, isJsxExpression, isNoSubstitutionTemplateLiteral, isNumericLiteral, isObjectBindingPattern, isObjectLiteralExpression, isParameterDeclaration,
  isParenthesizedExpression, isPrefixUnaryExpression, isPropertyAccessExpression, isPropertyAssignment, isSatisfiesExpression,
  isShorthandPropertyAssignment, isSpreadAssignment, isStringLiteral, isTemplateExpression, isTypeAliasDeclaration, isVariableDeclaration, isVariableDeclarationList, NodeFlags, SyntaxKind, type Node, type SourceFile,
} from 'typescript/unstable/ast';
import type { Checker } from 'typescript/unstable/sync';
import { generate, ident, parse, walk } from 'css-tree';
import { collectTypographyCss, typographyValueProblem } from './typography-policy-css.mts';
import { occurrenceDiagnostic, retiredIn, type TypographyOccurrence } from './typography-policy-contract.mts';

export const collectTypographyTypeScript = (source: SourceFile, path: string, roles: ReadonlySet<string>, checker: Checker): TypographyOccurrence[] => {
  const diagnostics: TypographyOccurrence[] = [];
  let context = '';
  const aliases = new Map<number, Node>();
  const configSymbols = new Set<number>();
  const configCandidates: { symbol: number; initializer: Node }[] = [];
  const bindings: { name: Node; initializer: Node }[] = [];
  const configTypes = new Set<string>();
  const typeCandidates: { name: string; type: Node }[] = [];
  const configType = (type: Node | undefined): boolean => type !== undefined && (/(?:Mermaid|Sequence|Gantt|Journey|Quadrant|XY|Packet|Requirement|Er|ER|Theme)\w*Config\b/.test(type.getText(source))
    || [...configTypes].some(name => type.getText(source).split(/\W+/).includes(name)));
  const collectTypes = (node: Node): void => {
    if (isTypeAliasDeclaration(node)) typeCandidates.push({ name: node.name.text, type: node.type });
    if (isImportSpecifier(node) && configType(node.propertyName ?? node.name)) configTypes.add(node.name.text);
    node.forEachChild(collectTypes);
  };
  collectTypes(source);
  let newType = true;
  while (newType) {
    newType = false;
    for (const { name, type } of typeCandidates) if (!configTypes.has(name) && configType(type)) { configTypes.add(name); newType = true; }
  }
  const collect = (node: Node): void => {
    if (isVariableDeclarationList(node)) {
      for (const declaration of node.declarations) {
        const symbol = isIdentifier(declaration.name) ? checker.getSymbolAtLocation(declaration.name)?.id : undefined;
        if (symbol !== undefined && declaration.initializer !== undefined && (node.flags & NodeFlags.Const) !== 0) aliases.set(symbol, declaration.initializer);
        if (symbol !== undefined && declaration.initializer !== undefined) configCandidates.push({ symbol, initializer: declaration.initializer });
        if (!isIdentifier(declaration.name) && declaration.initializer !== undefined) bindings.push({ name: declaration.name, initializer: declaration.initializer });
        if (symbol !== undefined && (configType(declaration.type) || declaration.initializer !== undefined && (isAsExpression(declaration.initializer) || isSatisfiesExpression(declaration.initializer)) && configType(declaration.initializer.type))) configSymbols.add(symbol);
      }
    }
    if (isParameterDeclaration(node) && isIdentifier(node.name) && configType(node.type)) {
      const symbol = checker.getSymbolAtLocation(node.name)?.id;
      if (symbol !== undefined) configSymbols.add(symbol);
    }
    node.forEachChild(collect);
  };
  collect(source);
  const configRoot = (node: Node): boolean => {
    while (isPropertyAccessExpression(node) || isElementAccessExpression(node)) node = node.expression;
    const symbol = isIdentifier(node) ? checker.getSymbolAtLocation(node)?.id : undefined;
    return symbol !== undefined && configSymbols.has(symbol);
  };
  const markBinding = (node: Node): void => {
    if (isIdentifier(node)) { const symbol = checker.getSymbolAtLocation(node)?.id; if (symbol !== undefined) configSymbols.add(symbol); }
    else if (isObjectBindingPattern(node) || isArrayBindingPattern(node)) for (const element of node.elements) if ('name' in element) markBinding(element.name);
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const { symbol, initializer } of configCandidates) if (!configSymbols.has(symbol) && configRoot(initializer)) { configSymbols.add(symbol); changed = true; }
    for (const { name, initializer } of bindings) if (configRoot(initializer)) { const before = configSymbols.size; markBinding(name); if (configSymbols.size !== before) changed = true; }
  }
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
  const report = (node: Node, message: string, category: TypographyOccurrence['category'] = 'invalid', value = node.getText(source).replace(/\s+/g, ' '), identifiers = retiredIn(value), inlineContext?: string): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    diagnostics.push({ path, category, context: inlineContext === undefined ? context : `${context} > inline ${inlineContext}`, value, line: line + 1, column: character + 1, message, identifiers });
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
      if (retiredIn(text).length > 0) {
        report(node, 'retired typography identifier in an inline style write.', 'legacy-reference', text);
        continue;
      }
      const problem = typographyValueProblem(normalized, text, roles, '');
      if (problem !== undefined) report(node, problem);
    }
  };
  const declarations = (node: Node, value: Node | undefined): void => {
    const values = value === undefined ? undefined : strings(value);
    if (values === undefined) return;
    for (const text of values) {
      for (const item of collectTypographyCss(text, path, roles, true)) {
        report(node, item.message, item.category, item.value, item.identifiers, item.context);
      }
    }
  };
  const member = (node: Node): string[] | undefined => isPropertyAccessExpression(node) ? [node.name.text]
    : isElementAccessExpression(node) ? strings(node.argumentExpression) : undefined;
  const isStyleMember = (node: Node): boolean => (isPropertyAccessExpression(node) || isElementAccessExpression(node)) && member(node.expression)?.includes('style') === true;
  const isTrackedExpression = (node: Node): boolean => isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isTemplateExpression(node)
    || isParenthesizedExpression(node) || isAsExpression(node) || isSatisfiesExpression(node) || isConditionalExpression(node) || isJsxExpression(node)
    || (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken);
  const sizes: Record<string, string> = {
    'fontSize': 'sm', 'themeVariables.fontSize': 'sm', 'themeVariables.pieTitleTextSize': 'lg',
    'themeVariables.pieSectionTextSize': 'sm', 'themeVariables.pieLegendTextSize': 'sm',
    'themeVariables.packet.byteFontSize': 'xs', 'themeVariables.packet.labelFontSize': 'sm', 'themeVariables.packet.titleFontSize': 'lg',
    'er.fontSize': 'sm', 'requirement.fontSize': 'sm', 'sequence.actorFontSize': 'sm', 'sequence.noteFontSize': 'sm', 'sequence.messageFontSize': 'sm',
    'gantt.fontSize': 'sm', 'gantt.sectionFontSize': 'sm', 'journey.taskFontSize': 'sm', 'journey.titleFontSize': 'lg',
    'quadrantChart.titleFontSize': 'lg', 'quadrantChart.xAxisLabelFontSize': 'xs', 'quadrantChart.yAxisLabelFontSize': 'xs',
    'quadrantChart.quadrantLabelFontSize': 'sm', 'quadrantChart.pointLabelFontSize': 'sm',
    'xyChart.titleFontSize': 'lg', 'xyChart.legendFontSize': 'sm', 'xyChart.xAxis.labelFontSize': 'xs', 'xyChart.yAxis.labelFontSize': 'xs',
    'xyChart.xAxis.titleFontSize': 'sm', 'xyChart.yAxis.titleFontSize': 'sm',
  };
  const measured = (node: Node, size: string): boolean => isPropertyAccessExpression(node) && isIdentifier(node.expression)
    && node.expression.text === 'sizes' && node.name.text === size;
  const measuredValue = (node: Node, size: string): boolean => measured(node, size)
    || (isTemplateExpression(node) && node.head.text === '' && node.templateSpans.length === 1
      && measured(node.templateSpans[0]!.expression, size) && node.templateSpans[0]!.literal.text === 'px');
  const measuredCss = (node: Node): boolean => {
    const expand = (value: Node): string[] | undefined => {
      if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) return [value.text];
      if (isConditionalExpression(value)) {
        const left = expand(value.whenTrue), right = expand(value.whenFalse);
        return left && right ? [...left, ...right] : undefined;
      }
      if (!isTemplateExpression(value)) return;
      let texts = [value.head.text];
      for (const span of value.templateSpans) {
        const size = ['xs', 'sm', 'lg'].find(candidate => measured(span.expression, candidate));
        const geometry = ['sequenceLayout.radius', 'sequenceLayout.marginX * 2'].includes(span.expression.getText(source)) && span.literal.text.startsWith('px');
        const parts = geometry ? ['1px'] : size === undefined ? expand(span.expression) : span.literal.text.startsWith('px') ? [`var(--measured-${size})`] : undefined;
        if (parts === undefined) return;
        const tail = size === undefined && !geometry ? span.literal.text : span.literal.text.slice(2);
        texts = texts.flatMap(text => parts.map(part => text + part + tail));
      }
      return texts;
    };
    const variants = expand(node);
    return variants !== undefined && variants.every(css => {
      const allowed = new Set(['--measured-xs', '--measured-sm', '--measured-lg']);
      if (collectTypographyCss(css, path, allowed).length !== 0) return false;
      let valid = true;
      walk(parse(css), item => {
        if (item.type === 'Declaration' && ['font', 'font-size'].includes(ident.decode(item.property).toLowerCase())
          && !/^var\(--measured-(?:xs|sm|lg)\)$/.test(generate(item.value))) valid = false;
      });
      return valid;
    });
  };
  const isAdapter = (ancestors: readonly Node[]): boolean => path === 'src/ui/markdown/mermaid/MermaidRenderer.ts'
    && ancestors.some((parent, index) => isArrowFunction(parent) && configType(parent.type)
      && parent.parameters.length > 0 && parent.parameters[0]!.getText(source) === 'sizes: MermaidSizes'
      && isVariableDeclaration(ancestors[index - 1]!) && (ancestors[index - 1] as import('typescript/unstable/ast').VariableDeclaration).name.getText(source) === 'buildMermaidConfiguration');
  const inConfig = (ancestors: readonly Node[]): boolean => ancestors.some(parent =>
    (isVariableDeclaration(parent) || isArrowFunction(parent)) && configType(parent.type)
    || (isAsExpression(parent) || isSatisfiesExpression(parent)) && configType(parent.type)
    || isCallExpression(parent) && isPropertyAccessExpression(parent.expression) && isIdentifier(parent.expression.expression)
      && parent.expression.expression.text === 'mermaid' && parent.expression.name.text === 'initialize');
  const fontField = (property: string): boolean => property !== 'maxTextSize'
    && (property === 'fontSize' || /(?:FontSize|TextSize|fontSizeFactor)$/.test(property));
  const configContainers = new Set(['themeVariables', 'sequence', 'gantt', 'journey', 'quadrantChart', 'xyChart', 'xAxis', 'yAxis', 'er', 'requirement', 'packet']);
  const visit = (node: Node, ancestors: readonly Node[]): void => {
    context = ancestors.flatMap(parent => {
      if (isVariableDeclaration(parent) && isIdentifier(parent.name)) return [`const ${parent.name.text}`];
      if (isPropertyAssignment(parent)) return [`property ${(name(parent.name) ?? ['computed']).join('|')}`];
      return [];
    }).concat(SyntaxKind[node.kind]).join(' > ');
    const values = isTrackedExpression(node) ? strings(node) : undefined;
    if (values !== undefined && values.some(value => retiredIn(value).length > 0)) {
      // Record resolved values once at their outer expression; whitespace and
      // quotation changes do not create a new legacy allowance.
      const parent = ancestors.at(-1);
      const parentValues = parent === undefined || !isTrackedExpression(parent) ? undefined : strings(parent);
      if (parentValues === undefined) {
        for (const value of [...new Set(values)].sort()) if (retiredIn(value).length > 0) report(node, 'retired typography identifier in TypeScript.', 'legacy-reference', value);
      }
    }
    if (isPropertyAssignment(node)) {
      const names = name(node.name);
      if (inConfig(ancestors) && names === undefined) report(node, 'Mermaid configuration requires statically known paths.');
      if (inConfig(ancestors) && names?.some(property => configContainers.has(property)) && !isObjectLiteralExpression(node.initializer)) report(node, 'Mermaid configuration containers must expose their fields for inspection.');
      const diagramTheme = inConfig(ancestors) && names?.some(property => fontField(property) || property === 'themeCSS');
      if (diagramTheme) {
        const key = [...ancestors.filter(isPropertyAssignment).map(parent => name(parent.name)?.[0] ?? '?'), names![0]!].join('.');
        const valid = isAdapter(ancestors) && (key === 'themeCSS' ? measuredCss(node.initializer) : sizes[key] !== undefined && measuredValue(node.initializer, sizes[key]!));
        if (!valid) report(node, 'Mermaid font configuration must use the measured size for its supported path.');
      }
      else names?.forEach(property => inspect(node, property, node.initializer));
    }
    if (isSpreadAssignment(node) && inConfig(ancestors)) report(node, 'Mermaid configuration spreads cannot establish font-size ownership.');
    if (isShorthandPropertyAssignment(node)) {
      const symbol = checker.getShorthandAssignmentValueSymbol(node)?.id;
      if (inConfig(ancestors) && name(node.name)?.some(property => fontField(property) || property === 'themeCSS' || configContainers.has(property))) report(node, 'Mermaid font configuration must use the measured size for its supported path.');
      else name(node.name)?.forEach(property => inspect(node, property, symbol === undefined ? undefined : aliases.get(symbol)));
    }
    if (isVariableDeclaration(node) && configType(node.type) && node.initializer !== undefined && !isObjectLiteralExpression(node.initializer)) report(node, 'Mermaid configuration must expose its fields for inspection.');
    if (isJsxAttribute(node)) {
      const property = node.name.getText(source);
      if (property === 'style' && node.initializer !== undefined) declarations(node, node.initializer);
      else inspect(node, property, node.initializer);
    }
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken && isStyleMember(node.left)) {
      for (const property of member(node.left) ?? []) {
        if (property === 'cssText') declarations(node, node.right);
        else inspect(node, property, node.right);
      }
    }
    if (isBinaryExpression(node) && node.operatorToken.kind >= SyntaxKind.FirstAssignment && node.operatorToken.kind <= SyntaxKind.LastAssignment && (isPropertyAccessExpression(node.left) || isElementAccessExpression(node.left))) {
      let root: Node = node.left;
      const parts: string[] = [];
      while (isPropertyAccessExpression(root) || isElementAccessExpression(root)) { parts.unshift(...(member(root) ?? ['?'])); root = root.expression; }
      const symbol = isIdentifier(root) ? checker.getSymbolAtLocation(root)?.id : undefined;
      const packetGeometryWrite = isAdapter(ancestors) && node.operatorToken.kind === SyntaxKind.EqualsToken
        && parts.length === 1 && parts[0] === 'packet' && isIdentifier(node.right) && node.right.text === 'packet';
      if (symbol !== undefined && configSymbols.has(symbol) && !packetGeometryWrite && (parts.some(part => fontField(part) || part === 'themeCSS' || part === '?')
        || configContainers.has(parts[0] ?? ''))) report(node, 'Mermaid font configuration cannot be written dynamically.');
    }
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === 'assign' && isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object'
        && node.arguments[0] !== undefined && configRoot(node.arguments[0])) report(node, 'Mermaid configuration cannot be written dynamically.');
      if (method === 'set' && isIdentifier(node.expression.expression) && node.expression.expression.text === 'Reflect'
        && node.arguments[0] !== undefined && configRoot(node.arguments[0])) report(node, 'Mermaid configuration cannot be written dynamically.');
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
