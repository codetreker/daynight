import { act, fireEvent } from '@testing-library/react';
import { expect, it } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import { useTimelineScroll } from '../src/ui/useTimelineScroll';
const render = createLocaleRender('en');

it('retains the same relative image point through decoding, reflow and a detached bookmark', () => {
  let height = 400, scrollTop = 0, scroll: ReturnType<typeof useTimelineScroll>;
  const bounds = (top: number, size: number) => ({ top, bottom: top + size, left: 0, right: 400, width: 400, height: size, x: 0, y: top, toJSON() {} });
  function MediaTimeline() {
    scroll = useTimelineScroll('media-owner', true, height, undefined, undefined, { historyEpoch: '1', historyComplete: true });
    return <div ref={node => {
      scroll.viewport.current = node;
      if (node) {
        node.getBoundingClientRect = () => bounds(0, 200);
        Object.defineProperties(node, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, get: () => height + 800 }, scrollTop: { configurable: true, get: () => scrollTop, set: value => { scrollTop = value; } } });
      }
    }} onScroll={scroll.onScroll} onWheel={scroll.onWheel}>
      <div ref={scroll.content}><article data-entry-key="image-entry" ref={node => { if (node) node.getBoundingClientRect = () => bounds(-scrollTop, height + 800); }}>
        <span data-media-key="image-entry/occurrence" ref={node => { if (node) node.getBoundingClientRect = () => bounds(100 - scrollTop, height); }} />
      </article></div>
    </div>;
  }
  const view = render(<MediaTimeline />), box = view.container.firstElementChild!;
  fireEvent.wheel(box, { deltaY: -10 }); scrollTop = 200; fireEvent.scroll(box);
  const bookmark = scroll!.captureBookmark();
  expect(bookmark?.anchor).toMatchObject({ media: { key: 'image-entry/occurrence', normalizedY: 0.25, top: 0 } });
  height = 800; view.rerender(<MediaTimeline />);
  expect(scrollTop).toBe(300);
  height = 400; view.rerender(<MediaTimeline />);
  expect(scrollTop).toBe(200);
  act(() => { scroll!.latest(); scroll!.restoreBookmark(bookmark!); });
  expect(scrollTop).toBe(200);
});
