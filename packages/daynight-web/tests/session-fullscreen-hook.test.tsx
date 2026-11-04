import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBodyScrollLock } from '../src/app/useBodyScrollLock';
import { SessionFullscreenContext, useSessionFullscreen, type SessionFullscreenRegistration } from '../src/features/task-agent-session/useSessionFullscreen';

const client = {};
function View({ active = true, identity = 'session-1', userId = 'user-1', owner = client }: {
  active?: boolean; identity?: string | null; userId?: string; owner?: object;
}) {
  const view = useSessionFullscreen({ client: owner, userId, active, identity });
  return <section ref={view.sectionRef} tabIndex={-1} data-testid="session" data-fullscreen={view.fullscreen} hidden={!active} onKeyDown={view.onKeyDown}>
    <button ref={view.buttonRef} onClick={view.toggle}>Toggle</button>
    <input aria-label="Draft" defaultValue="retained draft" />
    <button onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } }}>Inner</button>
  </section>;
}
const toggle = () => fireEvent.click(screen.getByText('Toggle'));

describe('Session fullscreen ownership', () => {
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
});
