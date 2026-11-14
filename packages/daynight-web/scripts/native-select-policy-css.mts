import { find, ident, parse, walk, type CssNode, type Selector } from 'css-tree';

const layoutProperties = /^(?:(?:min-|max-)?(?:width|inline-size)|margin(?:-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?))?|flex(?:-basis|-grow|-shrink)?|(?:align|justify|place)-self|grid(?:-area|-row(?:-start|-end)?|-column(?:-start|-end)?)?|order)$/;
const internalClass = (name: string): boolean => name === 'native-select__control' || name === 'native-select__arrow';
const wrapperClass = (name: string, wrappers: ReadonlySet<string>): boolean => name === 'native-select' || wrappers.has(name);
type Target = { internal: boolean; wrapper: boolean; pseudo: boolean; descendants: boolean };

const unowned = (): Target => ({ internal: false, wrapper: false, pseudo: false, descendants: false });
const targets = (selector: Selector, wrappers: ReadonlySet<string>, parent = unowned(), implicitNesting = false): Target => {
  let subject: CssNode[] = [];
  let wrapperAncestor = false;
  const classify = (nodes: CssNode[]): Target => {
    const result = unowned();
    for (const node of nodes) {
      if (node.type === 'TypeSelector' && ident.decode(node.name).toLowerCase().split('|').at(-1) === 'select') {
        result.internal = true;
        result.descendants = true;
      }
      if (node.type === 'ClassSelector') {
        result.internal ||= internalClass(ident.decode(node.name));
        result.wrapper ||= wrapperClass(ident.decode(node.name), wrappers);
        result.descendants ||= result.internal || result.wrapper;
      }
      if (node.type === 'AttributeSelector' && ident.decode(node.name.name).toLowerCase() === 'class' && node.value !== null) {
        const value = node.value.type === 'String' ? node.value.value : ident.decode(node.value.name);
        result.internal ||= value.includes('native-select__');
        result.wrapper ||= value.split(/\s+/).some(name => wrapperClass(name, wrappers));
        result.descendants ||= result.internal || result.wrapper;
      }
      if (node.type === 'PseudoElementSelector') result.pseudo = true;
      if (node.type === 'NestingSelector') {
        result.internal ||= parent.internal;
        result.wrapper ||= parent.wrapper;
        result.pseudo ||= parent.pseudo;
        result.descendants ||= parent.descendants;
      }
      if (node.type === 'PseudoClassSelector' && ['is', 'where', 'nth-child', 'nth-last-child'].includes(node.name.toLowerCase()) && node.children !== null) {
        node.children.forEach(child => {
          const selectors = child.type === 'Nth' ? child.selector : child.type === 'SelectorList' ? child : null;
          if (selectors === null) return;
          selectors.children.forEach(branch => {
            if (branch.type !== 'Selector') return;
            const nested = targets(branch, wrappers, parent);
            result.internal ||= nested.internal;
            result.wrapper ||= nested.wrapper;
            result.pseudo ||= nested.pseudo;
            result.descendants ||= nested.descendants;
          });
        });
      }
    }
    return result;
  };
  selector.children.forEach(node => {
    if (node.type === 'Combinator') {
      if (node.name !== '+' && node.name !== '~') wrapperAncestor ||= classify(subject).descendants;
      subject = [];
    } else subject.push(node);
  });
  const result = classify(subject);
  const implicitAncestor = implicitNesting && parent.descendants
    && find(selector, node => node.type === 'NestingSelector') === null;
  return { ...result, internal: result.internal || wrapperAncestor || implicitAncestor,
    descendants: result.descendants || wrapperAncestor || implicitAncestor };
};

export const inspectSelectCss = (text: string, path: string, wrappers: ReadonlySet<string>): string[] => {
  const diagnostics: string[] = [];
  const ast = parse(text, {
    positions: true, filename: path,
    onParseError: error => { throw new Error(`${path}:${error.line}:${error.column}: CSS parse failed: ${error.message}`, { cause: error }); },
  });
  const contexts: Target[][] = [[unowned()]];
  walk(ast, {
    enter(node: CssNode) {
      if (node.type === 'Atrule' && node.name.toLowerCase() === 'scope' && node.prelude !== null) {
        const scope = find(node.prelude, child => child.type === 'Scope');
        if (scope?.type !== 'Scope' || scope.root?.type === 'Raw') throw new Error(`${path}:${node.loc?.start.line ?? 1}: CSS scope selector AST is unavailable.`);
        scope.root?.children.forEach(selector => {
          if (selector.type !== 'Selector') throw new Error(`${path}:${node.loc?.start.line ?? 1}: CSS scope selector AST is unavailable.`);
          const target = targets(selector, wrappers);
          if (target.internal || target.wrapper || target.descendants) {
            diagnostics.push(`${path}:${node.loc?.start.line ?? 1}: native-select CSS ownership: @scope rooted in a native-select target belongs in ui/native-select/native-select.css; use direct wrapper layout rules.`);
          }
        });
      }
      if (node.type === 'Rule') {
        if (node.prelude?.type !== 'SelectorList') throw new Error(`${path}:${node.loc?.start.line ?? 1}: CSS rule has no readable selector AST.`);
        const selected: Target[] = [];
        node.prelude.children.forEach(selector => {
          if (selector.type !== 'Selector') throw new Error(`${path}:${node.loc?.start.line ?? 1}: CSS selector AST is unavailable.`);
          for (const parent of contexts.at(-1)!) selected.push(targets(selector, wrappers, parent, contexts.length > 1));
        });
        contexts.push(selected);
      }
      if (node.type !== 'Declaration') return;
      const property = node.property.toLowerCase();
      if (contexts.at(-1)!.some(target => target.internal || target.wrapper && (target.pseudo || !layoutProperties.test(property)))) {
        diagnostics.push(`${path}:${node.loc?.start.line ?? 1}: native-select CSS ownership: ${property} belongs in ui/native-select/native-select.css; wrapper classes allow width, flex/grid placement and margin only.`);
      }
    },
    leave(node: CssNode) { if (node.type === 'Rule') contexts.pop(); },
  });
  return diagnostics;
};
