import { find, ident, parse, walk, type CssNode, type Selector } from 'css-tree';

const layoutProperties = /^(?:(?:min-|max-)?(?:width|inline-size)|margin(?:-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?))?|flex(?:-basis|-grow|-shrink)?|(?:align|justify|place)-self|grid(?:-area|-row(?:-start|-end)?|-column(?:-start|-end)?)?|order)$/;
type CssOwner = 'consumer' | 'native' | 'selection';
const nativeInternal = (name: string): boolean => name === 'native-select__control' || name === 'native-select__arrow';
const selectionInternal = (name: string): boolean => name.startsWith('selection-control__') || name.startsWith('select-trigger__');
const internalClass = (name: string, owner: CssOwner): boolean => owner !== 'native' && nativeInternal(name) || owner !== 'selection' && selectionInternal(name);
const wrapperClass = (name: string, wrappers: ReadonlySet<string>, owner: CssOwner): boolean =>
  owner !== 'native' && name === 'native-select' || owner !== 'selection' && (name === 'selection-control' || name === 'select-trigger') || wrappers.has(name);
type Target = { internal: boolean; wrapper: boolean; pseudo: boolean; descendants: boolean; siblings: boolean; directChild: boolean };

const unowned = (): Target => ({ internal: false, wrapper: false, pseudo: false, descendants: false, siblings: false, directChild: false });
const targets = (selector: Selector, wrappers: ReadonlySet<string>, parent = unowned(), implicitNesting = false, owner: CssOwner = 'consumer'): Target => {
  let subject: CssNode[] = [];
  let ownedAncestor = false;
  const classify = (nodes: CssNode[]): Target => {
    const result = unowned();
    for (const node of nodes) {
      if (node.type === 'TypeSelector' && owner !== 'native' && ident.decode(node.name).toLowerCase().split('|').at(-1) === 'select') {
        result.internal = true;
        result.descendants = true;
        result.siblings = true;
        result.directChild = true;
      }
      if (node.type === 'ClassSelector') {
        const internal = internalClass(ident.decode(node.name), owner);
        result.internal ||= internal;
        result.siblings ||= internal;
        result.directChild ||= internal;
        result.wrapper ||= wrapperClass(ident.decode(node.name), wrappers, owner);
        result.descendants ||= result.internal || result.wrapper;
      }
      if (node.type === 'AttributeSelector' && ident.decode(node.name.name).toLowerCase() === 'class' && node.value !== null) {
        const value = node.value.type === 'String' ? node.value.value : ident.decode(node.value.name);
        const internal = owner !== 'native' && value.includes('native-select__') || owner !== 'selection' && (value.includes('selection-control__') || value.includes('select-trigger__'));
        result.internal ||= internal;
        result.siblings ||= internal;
        result.directChild ||= (node.matcher === '=' || node.matcher === '~=') && value.split(/\s+/).some(name => internalClass(name, owner));
        result.wrapper ||= value.split(/\s+/).some(name => wrapperClass(name, wrappers, owner));
        result.descendants ||= result.internal || result.wrapper;
      }
      if (node.type === 'PseudoElementSelector') result.pseudo = true;
      if (node.type === 'NestingSelector') {
        result.internal ||= parent.internal;
        result.wrapper ||= parent.wrapper;
        result.pseudo ||= parent.pseudo;
        result.descendants ||= parent.descendants;
        result.siblings ||= parent.siblings;
        result.directChild ||= parent.directChild;
      }
      if (node.type === 'PseudoClassSelector' && node.name.toLowerCase() === 'has' && node.children !== null) {
        const roles: ('wrapper' | 'child' | 'internal' | 'unknown')[] = [];
        node.children.forEach(child => {
          if (child.type !== 'SelectorList') { roles.push('unknown'); return; }
          child.children.forEach(branch => {
            if (branch.type !== 'Selector') { roles.push('unknown'); return; }
            const [relation, ...rest] = branch.children.toArray();
            if (relation?.type !== 'Combinator' || !['>', '+', '~'].includes(relation.name)) { roles.push('unknown'); return; }
            const end = rest.findIndex(part => part.type === 'Combinator');
            const first = classify(end === -1 ? rest : rest.slice(0, end));
            roles.push(!first.internal ? 'unknown' : !first.directChild ? 'internal' : relation.name === '>' ? 'wrapper' : 'child');
          });
        });
        if (roles.some(role => role !== 'unknown')) {
          // Layout requires every alternative to identify the wrapper; uncertain depth or alternatives retain internal ownership.
          const wrapper = roles.every(role => role === 'wrapper');
          result.wrapper ||= wrapper;
          result.internal ||= !wrapper;
          result.descendants = true;
          result.siblings ||= !wrapper;
          result.directChild ||= roles.every(role => role === 'child');
        }
      }
      if (node.type === 'PseudoClassSelector' && ['is', 'where', 'nth-child', 'nth-last-child'].includes(node.name.toLowerCase()) && node.children !== null) {
        let allDirectChildren = true, branches = 0;
        node.children.forEach(child => {
          const selectors = child.type === 'Nth' ? child.selector : child.type === 'SelectorList' ? child : null;
          if (selectors === null) return;
          selectors.children.forEach(branch => {
            if (branch.type !== 'Selector') return;
            const nested = targets(branch, wrappers, parent, false, owner);
            allDirectChildren &&= nested.directChild;
            branches += 1;
            result.internal ||= nested.internal;
            result.wrapper ||= nested.wrapper;
            result.pseudo ||= nested.pseudo;
            result.descendants ||= nested.descendants;
            result.siblings ||= nested.siblings;
          });
        });
        result.directChild ||= branches > 0 && allDirectChildren;
      }
    }
    return result;
  };
  selector.children.forEach(node => {
    if (node.type === 'Combinator') {
      const previous = classify(subject);
      // Every production select and internal marker is a child of the shared wrapper, so its siblings stay inside that owner.
      ownedAncestor ||= node.name === '+' || node.name === '~' ? previous.siblings : previous.descendants;
      subject = [];
    } else subject.push(node);
  });
  const result = classify(subject);
  const implicitAncestor = implicitNesting && parent.descendants
    && find(selector, node => node.type === 'NestingSelector') === null;
  return { ...result, internal: result.internal || ownedAncestor || implicitAncestor,
    descendants: result.descendants || ownedAncestor || implicitAncestor,
    siblings: result.siblings || ownedAncestor || implicitAncestor };
};

export const inspectSelectCss = (text: string, path: string, wrappers: ReadonlySet<string>, owner: CssOwner = 'consumer'): string[] => {
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
          const target = targets(selector, wrappers, unowned(), false, owner);
          if (target.internal || target.wrapper || target.descendants) {
            diagnostics.push(`${path}:${node.loc?.start.line ?? 1}: native-select CSS ownership: @scope rooted in a selection-control target belongs in its public presentation stylesheet; use direct wrapper layout rules.`);
          }
        });
      }
      if (node.type === 'Rule') {
        if (node.prelude?.type !== 'SelectorList') throw new Error(`${path}:${node.loc?.start.line ?? 1}: CSS rule has no readable selector AST.`);
        const selected: Target[] = [];
        node.prelude.children.forEach(selector => {
          if (selector.type !== 'Selector') throw new Error(`${path}:${node.loc?.start.line ?? 1}: CSS selector AST is unavailable.`);
          for (const parent of contexts.at(-1)!) selected.push(targets(selector, wrappers, parent, contexts.length > 1, owner));
        });
        contexts.push(selected);
      }
      if (node.type !== 'Declaration') return;
      const property = node.property.toLowerCase();
      if (property.startsWith('--selection-control-') && owner !== 'selection') {
        diagnostics.push(`${path}:${node.loc?.start.line ?? 1}: selection-control CSS ownership: ${property} belongs in ui/selection-control/selection-control.css.`);
      }
      if (contexts.at(-1)!.some(target => target.internal || target.wrapper && (target.pseudo || !layoutProperties.test(property)))) {
        diagnostics.push(`${path}:${node.loc?.start.line ?? 1}: native-select CSS ownership: ${property} belongs in ui/selection-control/selection-control.css or, for native internals, ui/native-select/native-select.css; layout classes allow width, flex/grid placement and margin only.`);
      }
    },
    leave(node: CssNode) { if (node.type === 'Rule') contexts.pop(); },
  });
  return diagnostics;
};
