// A text offset survives Markdown node replacement and width-driven wrapping.
// This implementation is local; the reading-continuity behavior is also described by:
// https://github.com/xuangong/agent-remote-control/blob/7905c9e2d4a2beb28e84b954a29da3778094e384/packages/agent-remote-web/src/react/useTimelineScroll.ts
export type ReadingTextAnchor = { readonly offset: number; readonly quote: string; readonly top: number };
function textNodes(entry: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text, parent = node.parentElement;
    if (!node.length || !parent || parent.closest('[hidden], script, style, svg')) continue;
    const closed = parent.closest('details:not([open])');
    if (closed && !closed.querySelector('summary')?.contains(node)) continue;
    nodes.push(node);
  }
  return nodes;
}
function characterRect(range: Range, node: Text, offset: number): DOMRect | undefined {
  range.setStart(node, offset); range.setEnd(node, Math.min(node.length, offset + 1));
  if (typeof range.getBoundingClientRect !== 'function') return undefined;
  const rect = range.getBoundingClientRect();
  return rect.height > 0 ? rect : undefined;
}
export function captureReadingText(entry: HTMLElement, viewport: DOMRect): ReadingTextAnchor | undefined {
  const range = document.createRange(), nodes = textNodes(entry);
  let offset = 0;
  for (const node of nodes) {
    const last = characterRect(range, node, node.length - 1);
    if (!last || last.bottom <= viewport.top) { offset += node.length; continue; }
    let left = 0, right = node.length - 1;
    while (left < right) {
      const middle = Math.floor((left + right) / 2), rect = characterRect(range, node, middle);
      if (!rect || rect.bottom <= viewport.top) left = middle + 1; else right = middle;
    }
    const rect = characterRect(range, node, left);
    if (rect && rect.top < viewport.bottom) {
      const absolute = offset + left, text = nodes.map(node => node.data).join('');
      return { offset: absolute, quote: text.slice(absolute, absolute + 32), top: rect.top - viewport.top };
    }
    offset += node.length;
  }
  return undefined;
}
export function readingTextTop(entry: HTMLElement, anchor: ReadingTextAnchor): number | undefined {
  const nodes = textNodes(entry), text = nodes.map(node => node.data).join('');
  let offset = anchor.offset;
  if (text.slice(offset, offset + anchor.quote.length) !== anchor.quote) {
    // Prefer the closest surviving occurrence if preceding content changed.
    let candidate = text.indexOf(anchor.quote), nearest = -1;
    while (candidate !== -1) {
      if (nearest === -1 || Math.abs(candidate - offset) < Math.abs(nearest - offset)) nearest = candidate;
      candidate = text.indexOf(anchor.quote, candidate + 1);
    }
    if (nearest === -1) return undefined;
    offset = nearest;
  }
  for (const node of nodes) {
    if (offset < node.length) return characterRect(document.createRange(), node, offset)?.top;
    offset -= node.length;
  }
  return undefined;
}
