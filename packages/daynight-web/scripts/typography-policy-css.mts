import { generate, ident, lexer, parse, walk, type CssNode } from 'css-tree';
import { bridges, occurrenceDiagnostic, retired, retiredIn, scale, typographyOwner, type TypographyOccurrence } from './typography-policy-contract.mts';
export { typographyOwner } from './typography-policy-contract.mts';

const compact = (value: string): string => value.replace(/\s+/g, '');
const stylesheet = (text: string, path: string, context: 'stylesheet' | 'declarationList' = 'stylesheet'): CssNode => parse(text, {
  context, positions: true, filename: path, parseCustomProperty: true,
  onParseError: error => { throw new Error(`${path}:${error.line}:${error.column}: CSS parse failed: ${error.message}`, { cause: error }); },
});

export const readTypographyRoles = (text: string): Set<string> => {
  const found = new Set<string>();
  const ast = stylesheet(text, typographyOwner);
  let roots = 0;
  walk(ast, function (node) {
    if (node.type === 'Rule' && node.prelude.type === 'SelectorList' && generate(node.prelude) === ':root') roots++;
    if (node.type !== 'Declaration') return;
    const name = ident.decode(node.property);
    if (!name.startsWith('--text-')) return;
    if (this.rule?.prelude?.type !== 'SelectorList' || generate(this.rule.prelude) !== ':root' || this.atrule !== null) throw new Error(`${typographyOwner}: typography roles must be unconditional :root definitions.`);
    if (found.has(name)) throw new Error(`${typographyOwner}: duplicate typography role ${name}.`);
    const expected = scale.get(name) ?? bridges.get(name);
    if (expected === undefined || compact(generate(node.value)) !== expected || node.important) throw new Error(`${typographyOwner}: ${name} must use its exact public scale or bridge definition.`);
    found.add(name);
  });
  if (roots !== 1 || [...scale.keys()].some(name => !found.has(name))) throw new Error(`${typographyOwner}: exactly one :root and all six public sizes are required.`);
  return new Set(scale.keys());
};

export const typographyValueProblem = (property: string, text: string, roles: ReadonlySet<string>, path: string): string | undefined => {
  const value = compact(text);
  if (['inherit', 'unset'].includes(value.toLowerCase())) return;
  const role = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  if (property === 'font-size' && role !== undefined && roles.has(role)) return;
  if (property === 'font-size' && path === 'src/styles/typography.css' && value === 'max(var(--text-base),16px)') return;
  const terminal = 'calc(var(--text-sm)*var(--terminal-text-scale,1))';
  if (path === 'src/features/task-agent-session/terminal-session.css' && property === 'font' && value.startsWith(`${terminal}/`)
    && lexer.matchProperty('font', text.replace(/calc\(var\(--text-sm\)\s*\*\s*var\(--terminal-text-scale,\s*1\)\)/, '1rem')).error === null) return;
  if (property === 'font') {
    const sizes = [...text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)];
    if (sizes.length === 1 && roles.has(sizes[0]![1]!)) {
      const marker = '123456789';
      const replaced = parse(text.replace(sizes[0]![0], `${marker}rem`), { context: 'value' });
      const match = lexer.matchProperty('font', replaced);
      let semanticSize = false;
      if (match.error === null) walk(replaced, node => {
        if (node.type === 'Dimension' && node.value === marker && node.unit === 'rem' && match.isProperty(node, 'font-size')) semanticSize = true;
      });
      if (semanticSize) return;
    }
  }
  return `${property} must inherit or use one public size without a fallback or local size.`;
};

export const collectTypographyCss = (text: string, path: string, roles: ReadonlySet<string>, inline = false): TypographyOccurrence[] => {
  const result: TypographyOccurrence[] = [];
  const ast = stylesheet(text, path, inline ? 'declarationList' : 'stylesheet');
  const contexts: string[] = [];
  walk(ast, {
    enter(node: CssNode) {
      if (node.type === 'Rule') contexts.push(generate(node.prelude));
      if (node.type === 'Atrule') contexts.push(`@${node.name}${node.prelude === null ? '' : ` ${generate(node.prelude)}`}`);
      const add = (category: TypographyOccurrence['category'], context: string, value: string, message: string): void => {
        result.push({ path, category, context: [...contexts, context].join(' > '), value, line: node.loc?.start.line ?? 1, column: node.loc?.start.column ?? 1, message });
      };
      if (node.type === 'Atrule' && node.name.toLowerCase() === 'property' && node.prelude !== null) {
        const name = ident.decode(generate(node.prelude));
        if (name.startsWith('--text-') || retired.has(name)) add('invalid', '@property', name, `${name} cannot be registered with @property.`);
      }
      if (node.type !== 'Declaration') return;
      const decoded = ident.decode(node.property);
      const property = decoded.startsWith('--') ? decoded : decoded.toLowerCase();
      const value = generate(node.value);
      const references: string[] = [];
      walk(node.value, child => { if (child.type === 'Identifier') references.push(ident.decode(child.name)); });
      const legacy = [...new Set(references.filter(name => retired.has(name)))].sort();
      if (property.startsWith('--text-') && (path !== typographyOwner || inline)) add('invalid', property, value, `${property} is owned by ${typographyOwner}; local overrides are forbidden.`);
      else if (retired.has(property)) add('legacy-definition', property, value, `retired definition ${property}.`);
      else if (property.endsWith('-font-size') && property.startsWith('--')) add('invalid', property, value, `private typography alias ${property} is forbidden.`);
      if (legacy.length > 0) add('legacy-reference', property, value, `retired typography reference ${legacy.join(', ')}.`);
      if ((property === 'font-size' || property === 'font') && legacy.length === 0) {
        const problem = typographyValueProblem(property, value, roles, inline ? '' : path);
        if (problem !== undefined) add('invalid', property, value, problem);
      }
      walk(node.value, child => {
        if (child.type === 'String' && retiredIn(child.value).length > 0) add('legacy-reference', `${property} string`, child.value, 'retired typography identifier in a CSS string.');
      });
    },
    leave(node: CssNode) { if (node.type === 'Rule' || node.type === 'Atrule') contexts.pop(); },
  });
  return result;
};
export const inspectTypographyCss = (text: string, path: string, roles: ReadonlySet<string>, inline = false): string[] => collectTypographyCss(text, path, roles, inline).map(occurrenceDiagnostic);
