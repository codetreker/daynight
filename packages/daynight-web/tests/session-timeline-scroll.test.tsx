import { act, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';
const render = createLocaleRender('en');
const props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: false, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: async () => new Blob() };
function setup(text = '[Link](https://example.com)\n\n' + 'reading '.repeat(200)) {
  let revision = 0, height = 1000;
  const state = () => ({ ...emptySessionState(), entries: [{ kind: 'assistant_message' as const, entryId: '1', entrySeq: '1', revision: String(++revision), content: [{ type: 'text' as const, text }] }] });
  const view = render(<SessionTimeline state={state()} {...props} />);
  const box = view.container.querySelector<HTMLElement>('.session-timeline')!, entry = view.container.querySelector<HTMLElement>('[data-entry-key]')!;
  Object.defineProperties(box, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, get: () => height } });
  vi.spyOn(box, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, bottom: 200, left: 0, right: 400, width: 400, height: 200, x: 0, y: 0, toJSON() {} }));
  vi.spyOn(entry, 'getBoundingClientRect').mockImplementation(() => ({ top: -box.scrollTop, bottom: height - box.scrollTop, left: 0, right: 400, width: 400, height, x: 0, y: -box.scrollTop, toJSON() {} }));
  const update = (next = height) => { height = next; view.rerender(<SessionTimeline state={state()} {...props} />); };
  update(); return { view, box, entry, update };
}
it('continues following after a touch tap, but pauses on an upward reading gesture', () => {
  const { box, update } = setup(); expect(box.scrollTop).toBe(800);
  fireEvent.touchStart(box, { touches: [{ clientY: 100 }] }); update(1200); expect(box.scrollTop).toBe(1000);
  fireEvent.touchStart(box, { touches: [{ clientY: 100 }] }); fireEvent.touchMove(box, { touches: [{ clientY: 140 }] });
  box.scrollTop = 850; fireEvent.scroll(box); update(1400); expect(box.scrollTop).toBe(850);
});
it('pauses reading keys on a descendant link during streaming', () => {
  const { box, entry, update } = setup(); fireEvent.keyDown(entry.querySelector('a')!, { key: 'PageUp' });
  box.scrollTop = 500; fireEvent.scroll(box); update(1200); expect(box.scrollTop).toBe(500);
});
it('preserves a focused control brought into view while streaming', () => {
  const { box, entry, update } = setup(); const link = entry.querySelector('a')!;
  vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({ top: -300, bottom: -280 } as DOMRect); fireEvent.focus(link);
  box.scrollTop = 400; fireEvent.scroll(box); update(1200); expect(box.scrollTop).toBe(400);
});
it('keeps the same text line visible when a long entry reflows', () => {
  const { box, update } = setup(); let charsPerLine = 80;
  const rect = (start: number) => ({ top: Math.floor(start / charsPerLine) * 20 - box.scrollTop, bottom: Math.floor(start / charsPerLine) * 20 + 20 - box.scrollTop, left: 0, right: 400, width: 400, height: 20, x: 0, y: 0, toJSON() {} });
  // JSDOM has no Range geometry. Only text wrapping is modeled here;
  // native layout, observers and scrolling remain browser acceptance.
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    let start = 0, end = 0;
    return { setStart: (_node: Node, offset: number) => { start = offset; }, setEnd: (_node: Node, offset: number) => { end = offset; }, selectNodeContents: (node: Node) => { start = 0; end = node.textContent!.length; }, getBoundingClientRect: () => ({ ...rect(start), bottom: rect(Math.max(start, end - 1)).bottom }), getClientRects: () => [rect(start)], detach() {} } as unknown as Range;
  });
  fireEvent.wheel(box, { deltaY: -10 }); box.scrollTop = 100; fireEvent.scroll(box);
  charsPerLine = 40; act(() => { window.dispatchEvent(new Event('resize')); }); expect(box.scrollTop).toBe(200);
  update(1400); expect(box.scrollTop).toBe(200);
});
it('keeps following while an editable descendant uses its own navigation keys', () => {
  const { box, entry, update } = setup(); const input = document.createElement('textarea'); entry.append(input);
  fireEvent.keyDown(input, { key: 'Home' }); update(1200); expect(box.scrollTop).toBe(1000);
});
it('resumes following only after the user scrolls down to the latest content', () => {
  const { box, update } = setup(); fireEvent.wheel(box, { deltaY: -10 }); box.scrollTop = 500; fireEvent.scroll(box);
  update(1200); expect(box.scrollTop).toBe(500);
  box.scrollTop = 1000; fireEvent.scroll(box); update(1400); expect(box.scrollTop).toBe(1200);
});
it('pauses following when a footnote is used to navigate within a long message', () => {
  const { box, entry, update } = setup('Footnote[^1]\n\n[^1]: note'); const link = entry.querySelector('a[data-footnote-ref]')!;
  fireEvent.click(link); box.scrollTop = 400; fireEvent.scroll(box); update(1200); expect(box.scrollTop).toBe(400);
});
