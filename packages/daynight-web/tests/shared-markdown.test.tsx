import { fireEvent, screen, within } from '@testing-library/react';
import type { MouseEvent } from 'react';
import { expect, it, vi } from 'vitest';
import { MarkdownView } from '../src/ui/markdown/MarkdownView';
import type { MarkdownDocumentImage, MarkdownResources } from '../src/ui/markdown/types';
import { createLocaleRender } from './helpers/renderWithLocale';

// Diagram scheduling and cleanup are tested at the Mermaid boundary; this test
// exercises the real Markdown parser and its choice of node renderer.
vi.mock('../src/ui/markdown/mermaid/MermaidDiagram', () => ({
  MermaidDiagram: ({ source }: { source: string }) => <div data-testid="diagram">{source}</div>,
}));

const render = createLocaleRender('en');
const resources = (overrides: Partial<Extract<MarkdownResources, { kind: 'document' }>> = {}): MarkdownResources => ({
  kind: 'document', paused: false, resolveUrl: value => value,
  renderImage: ({ url, alt, title }) => <img src={url} alt={alt} title={title} />,
  ...overrides,
});

it('uses chat line breaks, safe links, local footnotes and the common diagram renderer', () => {
  const text = 'First\nsecond [external](https://example.com) [refused](file:///secret) [local](#manual) and note[^x].\n\n[^x]: Footnote\n\n`one\ntwo`\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n![photo](https://example.com/image.png)';
  const view = render(<MarkdownView text={text} resources={{ kind: 'chat', images: { kind: 'unavailable' } }} />);
  expect(view.container.querySelector('p br')).not.toBeNull();
  expect(screen.getByRole('link', { name: 'external' })).toHaveAttribute('target', '_blank');
  expect(screen.getByRole('link', { name: 'external' })).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.queryByRole('link', { name: 'refused' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'local' })).toBeNull();
  const footnote = view.container.querySelector<HTMLAnchorElement>('a[data-footnote-ref]')!;
  expect(view.container.querySelector(`[id="${footnote.hash.slice(1)}"]`)).not.toBeNull();
  expect(view.container.querySelector('code')).toHaveTextContent('one two');
  expect(screen.getByTestId('diagram')).toHaveTextContent('flowchart LR');
  expect(view.container.querySelector('img')).toBeNull();
  expect(screen.getByText('photo — Resource unavailable')).toBeVisible();
});

it('matches controlled ranges before callbacks and keeps linked actions outside rejected links', () => {
  const image = '![a](file:///secret)', text = `😀 [${image}](file:///private)\n\n![ref][x]\n\n[x]: https://example.com/image.png`;
  const start = text.indexOf(image), reference = text.indexOf('![ref][x]');
  const positions = [{ start, end: start + image.length }, { start: reference, end: reference + '![ref][x]'.length }];
  const draw = vi.fn((node: { start: number; end: number; alt: string }, presentation: string) => <span data-presentation={presentation}>{node.alt}:{presentation}</span>);
  const invalid = vi.fn();
  const view = render(<MarkdownView text={text} resources={{ kind: 'chat', images: { kind: 'controlled', positions, render: draw, onInvalid: invalid } }} />);
  expect(invalid).not.toHaveBeenCalled();
  expect(draw).toHaveBeenCalledWith({ ...positions[0], alt: 'a' }, 'linked');
  expect(draw).toHaveBeenCalledWith({ ...positions[0], alt: 'a' }, 'actions');
  expect(draw).toHaveBeenCalledWith({ ...positions[1], alt: 'ref' }, 'standalone');
  expect(screen.queryByRole('link')).toBeNull();
  expect(view.container.querySelector('img')).toBeNull();
  expect(view.container.querySelector('[data-presentation="linked"]')?.compareDocumentPosition(view.container.querySelector('[data-presentation="actions"]')!)! & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(draw.mock.calls.every(([node]) => Object.keys(node).sort().join(',') === 'alt,end,start')).toBe(true);
});

it('rejects the entire controlled binding set before rendering and reports once for equivalent input', () => {
  const source = '![a](image:a)', text = `${source} \`![fake](image:b)\``;
  const positions = [{ start: 0, end: source.length }, { start: text.indexOf('![fake]'), end: text.indexOf('![fake]') + '![fake](image:b)'.length }];
  const draw = vi.fn(), invalid = vi.fn();
  const content = (ranges: typeof positions) => <MarkdownView text={text} resources={{ kind: 'chat', images: { kind: 'controlled', positions: ranges, render: draw, onInvalid: invalid } }} />;
  const view = render(content(positions));
  expect(draw).not.toHaveBeenCalled();
  expect(invalid).toHaveBeenCalledTimes(1);
  view.rerender(content(positions.map(range => ({ ...range }))));
  expect(draw).not.toHaveBeenCalled();
  expect(invalid).toHaveBeenCalledTimes(1);
});

it('renders document semantics, named table and only Mermaid fenced blocks as diagrams', () => {
  const text = '# Title\n\nFirst line\nsecond line\n\n- One\n- Two\n\n> Quoted\n\n| A | B |\n| - | - |\n| C | D |\n\n`inline`\n\n```ts\nconst answer = 42;\n```\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n<div>literal html</div>';
  const view = render(<MarkdownView text={text} resources={resources()} />);
  expect(screen.getByRole('heading', { name: 'Title' })).toBeVisible();
  expect(screen.getByText('First line second line').tagName).toBe('P');
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(view.container.querySelector('blockquote')).toHaveTextContent('Quoted');
  const region = screen.getByRole('region', { name: 'Table' });
  expect(region).toHaveAttribute('tabindex', '0');
  expect(within(region).getByRole('table')).toHaveTextContent('ABCD');
  expect(view.container.querySelector('pre > code.language-ts')).toHaveTextContent('const answer = 42;');
  expect(screen.getByText('inline').tagName).toBe('CODE');
  expect(screen.getByTestId('diagram')).toHaveTextContent('flowchart LR');
  expect(view.container.querySelectorAll('[data-testid="diagram"]')).toHaveLength(1);
  expect(view.container).toHaveTextContent('<div>literal html</div>');
  const codeRegion = screen.getByRole('region', { name: 'Code' });
  expect(codeRegion).toHaveAttribute('tabindex', '0');
  expect(within(codeRegion).getByText('const answer = 42;')).toBeVisible();
});

it('isolates generated footnotes and their accessible labels in each instance across language changes', () => {
  const resolveUrl = vi.fn((value: string) => value);
  const onLinkClick = vi.fn((_: string, event: MouseEvent<HTMLAnchorElement>) => event.preventDefault());
  const text = 'Read[^same] and [document](guide.md).\n\n[^same]: Footnote text';
  const view = render(<><MarkdownView text={text} resources={resources({ resolveUrl, onLinkClick })} /><MarkdownView text={text} resources={resources({ resolveUrl, onLinkClick })} /></>);
  const containers = view.container.querySelectorAll('.markdown-content');
  expect(containers).toHaveLength(2);
  const ids = new Set<string>();
  for (const container of containers) {
    const ref = container.querySelector<HTMLAnchorElement>('a[data-footnote-ref]')!;
    const back = container.querySelector<HTMLAnchorElement>('a[data-footnote-backref]')!;
    const label = container.querySelector<HTMLHeadingElement>('.footnotes h2')!;
    expect(label).toHaveTextContent('Footnotes');
    expect(ref.getAttribute('aria-describedby')).toBe(label.id);
    expect(container.querySelector(`[id="${ref.hash.slice(1)}"]`)).not.toBeNull();
    expect(container.querySelector(`[id="${back.hash.slice(1)}"]`)).not.toBeNull();
    expect(back).toHaveAttribute('aria-label', 'Back to reference');
    for (const element of container.querySelectorAll<HTMLElement>('[id]')) {
      expect(ids.has(element.id)).toBe(false);
      ids.add(element.id);
    }
    fireEvent.click(ref);
    fireEvent.click(back);
  }
  expect(onLinkClick).not.toHaveBeenCalled();
  expect(resolveUrl).toHaveBeenCalledTimes(2);
  fireEvent.click(within(containers[0] as HTMLElement).getByRole('link', { name: 'document' }));
  expect(onLinkClick).toHaveBeenCalledWith('guide.md', expect.anything());
  view.setLocale('zh-CN');
  for (const container of containers) {
    expect(container.querySelector('.footnotes h2')).toHaveTextContent('脚注');
    expect(container.querySelector('a[data-footnote-backref]')).toHaveAttribute('aria-label', '返回引用');
  }
});

it('supplies normalized source and safely transformed URL without restoring refused image sources', () => {
  const images: MarkdownDocumentImage[] = [];
  const resolveUrl = vi.fn((value: string) => value === 'reject.png' ? null : value === 'unsafe.png' ? 'javascript:alert(1)' : value.startsWith('images/') ? `/preview/${value}` : value);
  const view = render(<MarkdownView text={'![Space](<images/a b.png> "Title") ![Refused](reject.png) ![Danger](unsafe.png)\n\n[Unsafe](javascript:alert(1))'} resources={resources({ resolveUrl, renderImage: image => { images.push(image); return <img alt={image.alt} src={image.url} />; } })} />);
  expect(images).toEqual([
    { sourceUrl: 'images/a%20b.png', url: '/preview/images/a%20b.png', alt: 'Space', title: 'Title' },
    { sourceUrl: 'reject.png', url: '', alt: 'Refused', title: undefined },
    { sourceUrl: 'unsafe.png', url: '', alt: 'Danger', title: undefined },
  ]);
  expect(screen.getByRole('img', { name: 'Refused' })).not.toHaveAttribute('src');
  expect(screen.getByRole('img', { name: 'Danger' })).not.toHaveAttribute('src');
  expect(view.container.querySelector('a')).toHaveAttribute('href', '');
});

it('disables paused non-fragment links while leaving generated footnotes local', () => {
  const onLinkClick = vi.fn();
  const view = render(<MarkdownView text={'[Document](guide.md) and note[^x].\n\n[^x]: Here'} resources={resources({ paused: true, onLinkClick })} />);
  const link = screen.getByRole('link', { name: 'Document' });
  expect(link).toHaveAttribute('aria-disabled', 'true');
  expect(link).toHaveAttribute('tabindex', '0');
  expect(link).not.toHaveAttribute('href');
  fireEvent.click(link);
  expect(onLinkClick).not.toHaveBeenCalled();
  const footnote = view.container.querySelector<HTMLAnchorElement>('a[data-footnote-ref]')!;
  expect(footnote).toHaveAttribute('href', expect.stringMatching(/^#markdown-/));
  expect(footnote).not.toHaveAttribute('aria-disabled');
});

it('retains the diagram node and image when parent resources or language change', () => {
  const text = '![Image](picture.png)\n\n```mermaid\nflowchart LR\nA --> B\n```';
  const view = render(<MarkdownView text={text} resources={resources()} />);
  const diagram = screen.getByTestId('diagram'), image = screen.getByRole('img', { name: 'Image' });
  view.rerender(<MarkdownView text={text} resources={resources()} />);
  view.setLocale('zh-CN');
  expect(screen.getByTestId('diagram')).toBe(diagram);
  expect(screen.getByRole('img', { name: 'Image' })).toBe(image);
  view.rerender(<MarkdownView text={'```mermaid\nflowchart LR\nB --> C\n```'} resources={resources()} />);
  expect(screen.getByTestId('diagram')).not.toBe(diagram);
});
