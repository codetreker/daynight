import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSessionFullscreen } from '../src/features/task-agent-session/useSessionFullscreen';

const client = {};
function View({ observed = (_prevented: boolean) => {} }: { observed?: (prevented: boolean) => void }) {
  const view = useSessionFullscreen({ client, userId: 'reader', active: true, identity: 'session' });
  return <div style={{ overflow: 'auto' }} data-testid="background"><section ref={view.sectionRef} data-testid="root">
    <button ref={view.buttonRef} onClick={view.toggle}>Toggle</button>
    <div data-testid="timeline" style={{ overflowY: 'auto' }} onTouchMove={event => observed(event.defaultPrevented)}><span>Message</span></div>
    <textarea aria-label="Draft" style={{ overflowY: 'auto' }} defaultValue="draft" />
    <div data-testid="code" style={{ overflowX: 'auto' }}>code</div>
  </section></div>;
}
function metrics(element: HTMLElement, top = 0) {
  Object.defineProperties(element, { clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 300 }, clientWidth: { configurable: true, value: 100 }, scrollWidth: { configurable: true, value: 300 } });
  element.scrollTop = top;
}
function start(element: HTMLElement, x = 50, y = 50) { fireEvent.touchStart(element, { touches: [{ identifier: 1, clientX: x, clientY: y }] }); }
function move(element: HTMLElement, x = 50, y = 80) { return fireEvent.touchMove(element, { cancelable: true, touches: [{ identifier: 1, clientX: x, clientY: y }] }); }
function setup(observed?: (prevented: boolean) => void) {
  const mounted = render(<View {...(observed ? { observed } : {})} />);
  fireEvent.click(screen.getByText('Toggle'));
  return mounted;
}

describe('Session scroll containment', () => {
  it('blocks background chaining after React observes the timeline boundary gesture', () => {
    const observed: boolean[] = []; setup(prevented => observed.push(prevented));
    const timeline = screen.getByTestId('timeline'); metrics(timeline);
    start(timeline); expect(move(timeline)).toBe(false);
    expect(observed).toEqual([false]);
    expect(fireEvent.wheel(timeline, { deltaY: -30, cancelable: true })).toBe(false);
    expect(fireEvent.wheel(screen.getByTestId('root'), { deltaY: 30, cancelable: true })).toBe(false);
  });
  it('allows movement within long messages, drafts, and horizontal code but blocks their outer edges', () => {
    setup();
    for (const element of [screen.getByTestId('timeline'), screen.getByLabelText('Draft')]) {
      metrics(element, 50); start(element); expect(move(element)).toBe(true);
      element.scrollTop = 200; start(element); expect(move(element, 50, 20)).toBe(false);
    }
    const code = screen.getByTestId('code'); metrics(code); code.scrollLeft = 30;
    expect(fireEvent.wheel(code, { deltaX: -10, cancelable: true })).toBe(true);
    code.scrollLeft = 0;
    expect(fireEvent.wheel(code, { deltaX: -10, cancelable: true })).toBe(false);
  });
  it('allows a scrollable parent inside the boundary, but never uses a background ancestor', () => {
    setup(); const root = screen.getByTestId('root'), background = screen.getByTestId('background');
    metrics(root, 20); root.style.overflowY = 'auto'; metrics(background, 20);
    const message = screen.getByText('Message'); start(message); expect(move(message)).toBe(true);
    root.scrollTop = 0; start(message); expect(move(message)).toBe(false);
  });
  it('preserves pinch zoom and text selection, and resets single-touch tracking after a pinch', () => {
    setup(); const root = screen.getByTestId('root'); start(root);
    expect(fireEvent.touchMove(root, { cancelable: true, touches: [{ identifier: 1, clientX: 20, clientY: 20 }, { identifier: 2, clientX: 60, clientY: 20 }] })).toBe(true);
    expect(move(root)).toBe(true); expect(move(root, 50, 100)).toBe(false);
    expect(fireEvent.wheel(root, { deltaY: 30, ctrlKey: true, cancelable: true })).toBe(true);
    const draft = screen.getByLabelText('Draft') as HTMLTextAreaElement; draft.setSelectionRange(1, 3);
    start(draft); expect(move(draft)).toBe(true); expect(draft.selectionStart).toBe(1); expect(draft.selectionEnd).toBe(3);
  });
  it('yields to hidden or inert modal owners and removes listeners on exit and unmount', () => {
    const mounted = setup(); const root = screen.getByTestId('root');
    root.setAttribute('inert', ''); start(root); expect(move(root)).toBe(true); root.removeAttribute('inert');
    root.hidden = true; expect(fireEvent.wheel(root, { deltaY: 30, cancelable: true })).toBe(true); root.hidden = false;
    fireEvent.click(screen.getByText('Toggle')); start(root); expect(move(root)).toBe(true);
    fireEvent.click(screen.getByText('Toggle')); mounted.unmount();
    expect(fireEvent.wheel(document.body, { deltaY: 30, cancelable: true })).toBe(true);
  });
  it('keeps the owning route result panel scrollable without admitting background gestures', () => {
    render(<div className="standalone-task-route"><View /><div className="standalone-deletion-slot">
      <div data-testid="results" style={{ overflowY: 'auto' }}>Result</div>
    </div></div>);
    fireEvent.click(screen.getByText('Toggle'));
    const results = screen.getByTestId('results'); metrics(results, 50);
    expect(fireEvent.wheel(results, { deltaY: -10, cancelable: true })).toBe(true);
    results.scrollTop = 0;
    expect(fireEvent.wheel(results, { deltaY: -10, cancelable: true })).toBe(false);
    expect(fireEvent.wheel(document.body, { deltaY: 10, cancelable: true })).toBe(true);
    start(results); expect(move(results)).toBe(false);
  });
  it('does not take native range drags or cancelled gestures from their owners', () => {
    setup(); const root = screen.getByTestId('root'), range = document.createElement('input');
    range.type = 'range'; root.append(range);
    start(range); expect(move(range)).toBe(true);
    start(root); expect(move(root, 50, 50)).toBe(true);
    fireEvent.touchCancel(root); expect(move(root)).toBe(true);
    root.addEventListener('wheel', event => event.preventDefault());
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 20 });
    fireEvent(root, event); expect(event.defaultPrevented).toBe(true);
  });
});
