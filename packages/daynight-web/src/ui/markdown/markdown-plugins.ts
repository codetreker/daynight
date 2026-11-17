import type { MarkdownSourceRange } from './types';

type MarkdownNode = { type: string; value?: string; identifier?: string; position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } }; children?: MarkdownNode[] };
export type ImageValidation = { valid: boolean };
export const position = (node: { position?: MarkdownNode['position'] } | undefined): MarkdownSourceRange | null => {
  const start = node?.position?.start.offset, end = node?.position?.end.offset;
  return typeof start === 'number' && typeof end === 'number' && start < end ? { start, end } : null;
};
export const positionKey = ({ start, end }: MarkdownSourceRange) => `${start}/${end}`;

// Validate original offsets before the chat text plugin modifies the tree.
export function imageNodes(options: { readonly positions: readonly MarkdownSourceRange[]; readonly validation: ImageValidation }) {
  return (tree: MarkdownNode) => {
    const definitions = new Set<string>(), images = new Set<string>();
    const walk = (node: MarkdownNode, visit: (node: MarkdownNode) => void) => { visit(node); node.children?.forEach(child => walk(child, visit)); };
    walk(tree, node => { if (node.type === 'definition' && node.identifier) definitions.add(node.identifier); });
    walk(tree, node => {
      if (node.type !== 'image' && !(node.type === 'imageReference' && node.identifier && definitions.has(node.identifier))) return;
      const span = position(node);
      if (span) images.add(positionKey(span));
    });
    options.validation.valid = options.positions.every(span => images.has(positionKey(span)));
  };
}

export function chatBreaks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value?.includes('\n')) { visit(child); return [child]; }
        return child.value.split(/\r?\n/).flatMap((value, index) => index ? [{ type: 'break' }, { type: 'text', value }] : [{ type: 'text', value }]);
      });
    };
    visit(tree);
  };
}
