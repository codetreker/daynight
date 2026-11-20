import { generate, ident, lexer, parse, walk, type CssNode } from 'css-tree';

export const typographyOwner = 'src/styles/typography.css';
const aliases = new Map([
  ['--selection-control-font-size', 'src/ui/selection-control/selection-control.css'],
  ['--selection-control-count-font-size', 'src/ui/selection-control/selection-control.css'],
  ['--native-select-font-size', 'src/ui/native-select/native-select.css'],
]);
const inherited = new Set(['inherit', 'unset']);
const compact = (value: string): string => value.replace(/\s+/g, '');
const terminalSize = 'calc(var(--text-terminal)*var(--terminal-text-scale,1))';

const stylesheet = (text: string, path: string, context: 'stylesheet' | 'declarationList' = 'stylesheet'): CssNode => parse(text, {
  context, positions: true, filename: path, parseCustomProperty: true,
  onParseError: error => { throw new Error(`${path}:${error.line}:${error.column}: CSS parse failed: ${error.message}`, { cause: error }); },
});

export const readTypographyRoles = (text: string): Set<string> => {
  const roles = new Set<string>();
  const ast = stylesheet(text, typographyOwner);
  walk(ast, function (node) {
    if (node.type !== 'Declaration') return;
    const name = ident.decode(node.property);
    if (!name.startsWith('--text-')) return;
    if (this.rule?.prelude?.type !== 'SelectorList' || generate(this.rule.prelude) !== ':root' || this.atrule !== null) {
      throw new Error(`${typographyOwner}:${node.loc?.start.line}: typography roles must be unconditional :root definitions.`);
    }
    if (roles.has(name)) throw new Error(`${typographyOwner}:${node.loc?.start.line}: duplicate typography role ${name}.`);
    const value = compact(generate(node.value));
    if (!/^(?:\d*\.)?\d+rem$/.test(value) && !(name === '--text-touch-field' && value === 'max(1rem,16px)')) {
      throw new Error(`${typographyOwner}:${node.loc?.start.line}: ${name} requires a shared rem size or the documented touch minimum.`);
    }
    roles.add(name);
  });
  if (!roles.has('--text-interface') || !roles.has('--text-reading')) throw new Error(`${typographyOwner}:1: required typography roles are missing.`);
  return roles;
};

export const typographyValueProblem = (property: string, text: string, roles: ReadonlySet<string>, path: string): string | undefined => {
  const value = compact(text);
  if (inherited.has(value.toLowerCase())) return;
  const role = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  if (property === 'font-size' && role !== undefined && (roles.has(role) || aliases.get(role) === path)) return;
  if (property === 'font-size' && value === terminalSize && roles.has('--text-terminal')) return;
  if (property === 'font') {
    const sizes = [...text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)];
    if (sizes.length === 1 && roles.has(sizes[0]![1]!) && !text.includes('var(', text.indexOf('var(') + 1)) {
      const marker = '123456789';
      const replaced = parse(text.replace(sizes[0]![0], `${marker}rem`), { context: 'value' });
      const match = lexer.matchProperty('font', replaced);
      let semanticSize = false;
      if (match.error === null) walk(replaced, node => {
        if (node.type === 'Dimension' && node.value === marker && node.unit === 'rem'
          && match.isProperty(node, 'font-size')) semanticSize = true;
      });
      if (semanticSize) return;
    }
    if (value.startsWith(`${terminalSize}/`) && roles.has('--text-terminal')
      && lexer.matchProperty('font', text.replace(/calc\(var\(--text-terminal\)\s*\*\s*var\(--terminal-text-scale,\s*1\)\)/, '1rem')).error === null) return;
  }
  return `${property} must inherit or use a registered shared typography role without a fallback or local size.`;
};

export const inspectTypographyCss = (text: string, path: string, roles: ReadonlySet<string>, inline = false): string[] => {
  const diagnostics: string[] = [];
  const ast = stylesheet(text, path, inline ? 'declarationList' : 'stylesheet');
  walk(ast, node => {
    if (node.type === 'Atrule' && node.name.toLowerCase() === 'property' && node.prelude !== null) {
      const property = ident.decode(generate(node.prelude));
      if (property.startsWith('--text-') || aliases.has(property)) {
        diagnostics.push(`${path}:${node.loc?.start.line ?? 1}:${node.loc?.start.column ?? 1}: typography ownership: ${property} cannot be registered with @property; preserve shared typography inheritance.`);
      }
    }
    if (node.type !== 'Declaration') return;
    const decoded = ident.decode(node.property);
    const property = decoded.startsWith('--') ? decoded : decoded.toLowerCase();
    let problem: string | undefined;
    if (property.startsWith('--text-')) {
      if (path !== typographyOwner || inline) problem = `${property} is owned by ${typographyOwner}; local overrides are forbidden.`;
    } else if (aliases.has(property)) {
      if (aliases.get(property) !== path || inline) problem = `${property} is owned by ${aliases.get(property)}.`;
      else problem = typographyValueProblem('font-size', generate(node.value), roles, path === 'src/ui/native-select/native-select.css' ? 'src/ui/selection-control/selection-control.css' : path);
    } else if (property === 'font-size' || property === 'font') {
      problem = typographyValueProblem(property, generate(node.value), roles, inline ? '' : path);
    }
    if (problem !== undefined) diagnostics.push(`${path}:${node.loc?.start.line ?? 1}:${node.loc?.start.column ?? 1}: typography ownership: ${problem}`);
  });
  return diagnostics;
};
