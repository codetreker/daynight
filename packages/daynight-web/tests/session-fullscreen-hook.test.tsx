import { useRef, useState, type RefObject } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBodyScrollLock } from '../src/app/useBodyScrollLock';
import { NativeSelect } from '../src/ui/native-select/NativeSelect';
import { SessionFullscreenContext, useSessionFullscreen, type SessionFullscreenRegistration } from '../src/features/task-agent-session/useSessionFullscreen';
import { TaskConfirmation } from '../src/features/task-detail/TaskConfirmation';
import { renderWithLocale } from './helpers/renderWithLocale';

const client = {};
function View({ active = true, identity = 'session-1', userId = 'user-1', owner = client, fullscreenBoundary }: {
  active?: boolean; identity?: string | null; userId?: string; owner?: object; fullscreenBoundary?: RefObject<HTMLElement | null>;
}) {
  const view = useSessionFullscreen({ client: owner, userId, active, identity, ...(fullscreenBoundary ? { fullscreenBoundary } : {}) });
  return <section ref={view.sectionRef} tabIndex={-1} data-testid="session" data-fullscreen={view.fullscreen} hidden={!active} onKeyDown={view.onKeyDown}>
    <button ref={view.buttonRef} onClick={view.toggle}>Toggle</button>
    <input aria-label="Draft" defaultValue="retained draft" />
    <button onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } }}>Inner</button>
  </section>;
}
const toggle = () => fireEvent.click(screen.getByText('Toggle'));

function SelectView({ external, preventEscape = false }: { external: boolean; preventEscape?: boolean }) {
  const boundary = useRef<HTMLDivElement>(null);
  const view = useSessionFullscreen({ client, userId: 'user-1', active: true, identity: 'session-1',
    ...(external ? { fullscreenBoundary: boundary } : {}) });
  return <div ref={boundary}><section ref={view.sectionRef} tabIndex={-1} data-testid="select-session" data-fullscreen={view.fullscreen} onKeyDown={view.onKeyDown}>
    <button ref={view.buttonRef} onClick={view.toggle}>Toggle</button>
    <label>Session setting<NativeSelect defaultValue="confirmed" onKeyDown={event => {
      if (preventEscape && event.key === 'Escape') event.preventDefault();
    }}><option value="confirmed">Confirmed</option><option value="candidate">Candidate</option></NativeSelect></label>
  </section></div>;
}

describe('Session fullscreen ownership', () => {
  it.each([false, true])('preserves fullscreen for an open native selector through the external-boundary=%s handler', external => {
    render(<SelectView external={external} />); toggle();
    const select = screen.getByRole('combobox', { name: 'Session setting' });
    act(() => select.focus());
    // The browser suite owns native popup state; this test isolates both enclosing key handlers.
    const matches = select.matches.bind(select);
    const popup = vi.spyOn(select, 'matches').mockImplementation(selector => selector === ':open' || matches(selector));
    expect(fireEvent.keyDown(select, { key: 'Escape', cancelable: true })).toBe(true);
    expect(screen.getByTestId('select-session')).toHaveAttribute('data-fullscreen', 'true');
    expect(select).toHaveValue('confirmed');
    expect(select).toHaveFocus();
    popup.mockRestore();
    expect(fireEvent.keyDown(select, { key: 'Escape', cancelable: true })).toBe(false);
    expect(screen.getByTestId('select-session')).toHaveAttribute('data-fullscreen', 'false');
    expect(screen.getByText('Toggle')).toHaveFocus();
  });

  it.each([false, true])('respects prevented and IME Escape through the external-boundary=%s handler', external => {
    const view = render(<SelectView external={external} preventEscape />); toggle();
    const select = screen.getByRole('combobox', { name: 'Session setting' });
    expect(fireEvent.keyDown(select, { key: 'Escape', cancelable: true })).toBe(false);
    expect(screen.getByTestId('select-session')).toHaveAttribute('data-fullscreen', 'true');
    view.rerender(<SelectView external={external} />);
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      expect(fireEvent.keyDown(select, { key: 'Escape', cancelable: true, ...composition })).toBe(true);
      expect(screen.getByTestId('select-session')).toHaveAttribute('data-fullscreen', 'true');
    }
    fireEvent.keyDown(select, { key: 'Escape' });
    expect(screen.getByTestId('select-session')).toHaveAttribute('data-fullscreen', 'false');
    expect(screen.getByText('Toggle')).toHaveFocus();
  });

  it('includes only its own standalone result slot in the fullscreen focus cycle and isolates it for a modal', async () => {
    function Host() {
      const boundary = useRef<HTMLDivElement>(null), fallback = useRef<HTMLButtonElement>(null);
      const [modal, setModal] = useState(false);
      return <><div className="standalone-task-route"><div ref={boundary}><View fullscreenBoundary={boundary} /></div>
        <div className="standalone-deletion-slot" data-testid="own-slot"><button ref={fallback} onClick={() => setModal(true)}>Result action</button></div>
        {modal && <TaskConfirmation owner={boundary} fallbackFocus={fallback} title="Confirm" question="Continue?" explanation="Explanation" taskTitle="Task" confirmLabel="Confirm" cancelLabel="Cancel" closeLabel="Close" onCancel={() => setModal(false)} onConfirm={() => setModal(false)} />}
      </div><div className="standalone-task-route"><div className="standalone-deletion-slot" data-testid="other-slot"><button>Other result</button></div></div></>;
    }
    renderWithLocale(<Host />, { locale: 'en' }); toggle();
    const slot = screen.getByTestId('own-slot'), other = screen.getByTestId('other-slot');
    expect(slot).not.toHaveAttribute('inert'); expect(other.closest('[inert]')).not.toBeNull();
    const first = screen.getByText('Toggle'), last = screen.getByText('Result action');
    act(() => last.focus()); fireEvent.keyDown(last, { key: 'Tab' }); expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
    fireEvent.click(last);
    expect(slot).toHaveAttribute('inert'); expect(screen.getByRole('alertdialog')).toBeVisible();
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(slot).not.toHaveAttribute('inert'));
    expect(last).toHaveFocus(); fireEvent.keyDown(last, { key: 'Escape' });
    expect(screen.getByTestId('session')).toHaveAttribute('data-fullscreen', 'false');
    expect(first).toHaveFocus(); expect(other.closest('[inert]')).toBeNull();
  });

  it('includes external chrome in a stable fullscreen boundary and restores its owned presentation', () => {
    function Host() {
      const boundary = useRef<HTMLDivElement>(null);
      return <><button>Background</button><div ref={boundary} data-testid="boundary" data-session-fullscreen="previous">
        <button>Name</button><View fullscreenBoundary={boundary} /><button>Details</button>
      </div></>;
    }
    render(<Host />);
    const boundary = screen.getByTestId('boundary'), input = screen.getByLabelText('Draft');
    toggle();
    expect(boundary).toHaveAttribute('data-session-fullscreen', 'true');
    expect(boundary.style.getPropertyValue('--session-viewport-height')).toBe(`${window.innerHeight}px`);
    expect(screen.getByText('Background')).toHaveAttribute('inert');
    expect(screen.getByText('Name')).not.toHaveAttribute('inert');
    act(() => screen.getByText('Details').focus());
    expect(screen.getByText('Details')).toHaveFocus();
    fireEvent.keyDown(screen.getByText('Details'), { key: 'Tab' });
    expect(screen.getByText('Name')).toHaveFocus();
    fireEvent.keyDown(screen.getByText('Name'), { key: 'Tab', shiftKey: true });
    expect(screen.getByText('Details')).toHaveFocus();
    fireEvent.keyDown(screen.getByText('Details'), { key: 'Escape' });
    expect(boundary).toHaveAttribute('data-session-fullscreen', 'previous');
    expect(boundary.style.getPropertyValue('--session-viewport-height')).toBe('');
    expect(screen.getByLabelText('Draft')).toBe(input);
    expect(screen.getByText('Toggle')).toHaveFocus();
    expect(screen.getByText('Background')).not.toHaveAttribute('inert');
  });

  it('lets React modal keyboard handlers finish before the external fullscreen boundary', () => {
    function Host() {
      const boundary = useRef<HTMLDivElement>(null);
      return <div ref={boundary} data-testid="boundary"><View fullscreenBoundary={boundary} />
        <dialog open onKeyDown={event => { if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation(); }}>
          <button>Modal control</button>
        </dialog>
      </div>;
    }
    render(<Host />); toggle();
    const control = screen.getByText('Modal control');
    act(() => control.focus());
    expect(control).toHaveFocus();
    expect(fireEvent.keyDown(control, { key: 'Tab', cancelable: true })).toBe(true);
    expect(fireEvent.keyDown(control, { key: 'Escape', cancelable: true })).toBe(true);
    expect(screen.getByTestId('boundary')).toHaveAttribute('data-session-fullscreen', 'true');
    fireEvent.keyDown(screen.getByLabelText('Draft'), { key: 'Escape' });
    expect(screen.getByTestId('boundary')).not.toHaveAttribute('data-session-fullscreen');
  });

  it('retains the subtree and releases background scroll only after its own lock ends', () => {
    function Outer() { useBodyScrollLock(true); return <><button>Background</button><View /></>; }
    document.body.style.overflow = 'clip';
    const mounted = render(<Outer />);
    const input = screen.getByLabelText('Draft');
    toggle();
    expect(screen.getByTestId('session')).toHaveAttribute('data-fullscreen', 'true');
    expect(screen.getByText('Background')).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    toggle();
    expect(screen.getByLabelText('Draft')).toBe(input);
    expect(screen.getByText('Background')).not.toHaveAttribute('inert');
    expect(screen.getByText('Toggle')).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    mounted.unmount();
    expect(document.body.style.overflow).toBe('clip');
    document.body.style.overflow = '';
  });

  it('leaves temporary absent snapshots expanded but resets on a new identity', () => {
    const mounted = render(<View />); toggle();
    mounted.rerender(<View identity={null} />);
    expect(screen.getByTestId('session')).toHaveAttribute('data-fullscreen', 'true');
    mounted.rerender(<View identity="session-2" />);
    expect(screen.getByTestId('session')).toHaveAttribute('data-fullscreen', 'false');
    expect(document.body.style.overflow).toBe('');
  });

  it('binds the first available identity without exiting a loading Session', () => {
    const mounted = render(<View identity={null} />); toggle();
    mounted.rerender(<View identity="session-1" />);
    expect(screen.getByTestId('session')).toHaveAttribute('data-fullscreen', 'true');
    mounted.rerender(<View identity="session-2" />);
    expect(screen.getByTestId('session')).toHaveAttribute('data-fullscreen', 'false');
  });

  it.each(['active', 'client', 'user'] as const)('resets on %s changes without restoring stale focus', change => {
    const mounted = render(<><button>Background</button><View /></>); toggle();
    expect(screen.getByTestId('session')).toHaveAttribute('data-fullscreen', 'true');
    mounted.rerender(<><button>Background</button><View active={change !== 'active'} owner={change === 'client' ? {} : client} userId={change === 'user' ? 'user-2' : 'user-1'} /></>);
    expect(screen.getByTestId('session')).toHaveAttribute('data-fullscreen', 'false');
    expect(screen.getByText('Toggle')).not.toHaveFocus();
    mounted.rerender(<><button>Background</button><View /></>);
    expect(screen.getByTestId('session')).toHaveAttribute('data-fullscreen', 'false');
  });

  it('lets inner Escape finish first and consumes exactly one fullscreen layer', () => {
    let outer = 0;
    render(<div onKeyDown={event => { if (event.key === 'Escape') outer++; }}><View /></div>); toggle();
    fireEvent.keyDown(screen.getByText('Inner'), { key: 'Escape' });
    expect(screen.getByTestId('session')).toHaveAttribute('data-fullscreen', 'true');
    fireEvent.keyDown(screen.getByLabelText('Draft'), { key: 'Escape' });
    expect(screen.getByTestId('session')).toHaveAttribute('data-fullscreen', 'false');
    expect(outer).toBe(0);
    fireEvent.keyDown(screen.getByText('Toggle'), { key: 'Escape' });
    expect(outer).toBe(1);
  });

  it('contains Tab and redirects attempted background focus', () => {
    render(<><button>Background</button><View /></>); toggle();
    const first = screen.getByText('Toggle'), last = screen.getByText('Inner');
    act(() => last.focus()); fireEvent.keyDown(last, { key: 'Tab' }); expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
    act(() => screen.getByText('Background').focus()); expect(first).toHaveFocus();
  });

  it('isolates dynamically added background nodes while preserving existing inert ownership', async () => {
    const preexisting = document.createElement('div'); preexisting.setAttribute('inert', ''); document.body.append(preexisting);
    const mounted = render(<View />); toggle();
    const later = document.createElement('button'); later.textContent = 'Later';
    await act(async () => { document.body.append(later); });
    expect(later).toHaveAttribute('inert');
    mounted.unmount();
    expect(preexisting).toHaveAttribute('inert'); expect(later).not.toHaveAttribute('inert');
    preexisting.remove(); later.remove();
  });

  it('yields background isolation to an external modal making the Session inert', async () => {
    const mounted = render(<div data-testid="shell"><View /></div>); toggle();
    const admission = document.createElement('button'); admission.textContent = 'Authentication required';
    await act(async () => { screen.getByTestId('shell').setAttribute('inert', ''); document.body.append(admission); });
    expect(admission).not.toHaveAttribute('inert');
    act(() => admission.focus()); expect(admission).toHaveFocus();
    await act(async () => screen.getByTestId('shell').removeAttribute('inert'));
    expect(admission).toHaveAttribute('inert');
    mounted.unmount(); admission.remove();
  });

  it('keeps background controls inert after their normal presentation rerenders', async () => {
    render(<><button>Background</button><View /></>); toggle();
    const background = screen.getByText('Background');
    await act(async () => background.removeAttribute('inert'));
    expect(background).toHaveAttribute('inert');
    toggle(); expect(background).not.toHaveAttribute('inert');
  });

  it('registers a single host owner and lets the host release it', () => {
    function Host() {
      const [registration, setRegistration] = useState<SessionFullscreenRegistration | null>(null);
      const [register] = useState(() => (next: SessionFullscreenRegistration) => {
        setRegistration(next);
        return () => setRegistration(current => current?.owner === next.owner ? null : current);
      });
      return <SessionFullscreenContext.Provider value={register}><output data-testid="host">{registration ? 'expanded' : 'normal'}</output><View /><button onClick={() => registration?.exit()}>Host exit</button></SessionFullscreenContext.Provider>;
    }
    render(<Host />); toggle(); expect(screen.getByTestId('host')).toHaveTextContent('expanded');
    fireEvent.click(screen.getByText('Host exit')); expect(screen.getByTestId('host')).toHaveTextContent('normal');
  });

  it('tracks visual viewport dimensions and offsets and removes its CSS state on exit', () => {
    const viewport = Object.assign(new EventTarget(), { width: 390, height: 300, offsetTop: 40, offsetLeft: 5 });
    const descriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    try {
      render(<View />); toggle(); const section = screen.getByTestId('session');
      expect(section.style.getPropertyValue('--session-viewport-height')).toBe('300px');
      expect(section.style.getPropertyValue('--session-viewport-width')).toBe('390px');
      expect(section.style.getPropertyValue('--session-viewport-top')).toBe('40px');
      viewport.height = 200; viewport.offsetLeft = 12;
      act(() => viewport.dispatchEvent(new Event('resize')));
      expect(section.style.getPropertyValue('--session-viewport-height')).toBe('200px');
      act(() => viewport.dispatchEvent(new Event('scroll')));
      expect(section.style.getPropertyValue('--session-viewport-left')).toBe('12px');
      toggle(); expect(section.style.getPropertyValue('--session-viewport-height')).toBe('');
    } finally { if (descriptor) Object.defineProperty(window, 'visualViewport', descriptor); else Reflect.deleteProperty(window, 'visualViewport'); }
  });

  it.each([
    { sameRoot: false, retired: 'first' }, { sameRoot: false, retired: 'second' },
    { sameRoot: true, retired: 'first' }, { sameRoot: true, retired: 'second' },
  ] as const)('restores overlapping viewport owners (shared root=$sameRoot, retired=$retired)', ({ sameRoot, retired }) => {
    function Host() {
      const [first, setFirst] = useState(true);
      const [second, setSecond] = useState(true);
      const boundary = useRef<HTMLDivElement>(null);
      return <div className="standalone-task-route" data-testid="route">
        <div ref={boundary} data-testid="boundary">
          {first && <div data-testid="first"><View identity="first" {...(sameRoot ? { fullscreenBoundary: boundary } : {})} /></div>}
          {second && <div data-testid="second"><View identity="second" {...(sameRoot ? { fullscreenBoundary: boundary } : {})} /></div>}
        </div>
        <div className="standalone-deletion-slot"><button>Result</button></div>
        <button onClick={() => setFirst(false)}>Retire first</button>
        <button onClick={() => setSecond(false)}>Retire second</button>
      </div>;
    }
    const viewport = Object.assign(new EventTarget(), { width: 390, height: 300, offsetTop: 40, offsetLeft: 5 });
    const descriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    try {
      render(<Host />); const route = screen.getByTestId('route'), root = screen.getByTestId('boundary');
      route.style.setProperty('--standalone-session-viewport-top', '17px');
      if (sameRoot) { root.style.setProperty('--session-viewport-top', '29px'); root.setAttribute('data-session-fullscreen', 'previous'); }
      fireEvent.click(within(screen.getByTestId('first')).getByText('Toggle'));
      viewport.offsetTop = 90; viewport.width = 280;
      fireEvent.click(within(screen.getByTestId('second')).getByText('Toggle'));
      expect(route.style.getPropertyValue('--standalone-session-viewport-top')).toBe('90px');
      fireEvent.click(screen.getByText(`Retire ${retired}`));
      expect(route.style.getPropertyValue('--standalone-session-viewport-top')).toBe('90px');
      expect(route.style.getPropertyValue('--standalone-session-viewport-width')).toBe('280px');
      if (sameRoot) { expect(root).toHaveAttribute('data-session-fullscreen', 'true'); expect(root.style.getPropertyValue('--session-viewport-top')).toBe('90px'); }
      viewport.offsetTop = 130; act(() => viewport.dispatchEvent(new Event('scroll')));
      expect(route.style.getPropertyValue('--standalone-session-viewport-top')).toBe('130px');
      if (sameRoot) expect(root.style.getPropertyValue('--session-viewport-top')).toBe('130px');
      fireEvent.click(screen.getByText(`Retire ${retired === 'first' ? 'second' : 'first'}`));
      expect(route.style.getPropertyValue('--standalone-session-viewport-top')).toBe('17px');
      expect(route.style.getPropertyValue('--standalone-session-viewport-width')).toBe('');
      if (sameRoot) { expect(root).toHaveAttribute('data-session-fullscreen', 'previous'); expect(root.style.getPropertyValue('--session-viewport-top')).toBe('29px'); }
    } finally { if (descriptor) Object.defineProperty(window, 'visualViewport', descriptor); else Reflect.deleteProperty(window, 'visualViewport'); }
  });
});
