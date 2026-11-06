// Mermaid's percent widths lose their intended size in a Blob image. The
// viewBox is the renderer's own coordinate system and supplies its dimensions.
export const sizeMermaidSvg = (svg: string): string => {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = document.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg' || document.querySelector('parsererror')) {
    throw new Error('Invalid Mermaid SVG');
  }
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length !== 4 || viewBox.some((value) => !Number.isFinite(value)) || viewBox[2]! <= 0 || viewBox[3]! <= 0) {
    throw new Error('Invalid Mermaid SVG viewBox');
  }
  root.setAttribute('width', String(viewBox[2]));
  root.setAttribute('height', String(viewBox[3]));
  const style = root.getAttribute('style');
  if (style !== null) {
    const retained = style.split(';').filter((declaration) => !/^\s*max-width\s*:/i.test(declaration));
    if (retained.some((declaration) => declaration.trim() !== '')) root.setAttribute('style', retained.join(';'));
    else root.removeAttribute('style');
  }
  return new XMLSerializer().serializeToString(root);
};
