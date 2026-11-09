import { fireEvent, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { TimelineEntry } from '../src/api/types';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: false, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: async () => new Blob() };
const error = (code: string, message: string): TimelineEntry => ({ kind: 'error', code, message, entryId: 'error', entrySeq: '1', revision: '1' });
const show = (entry: TimelineEntry) => render(<SessionTimeline state={{ ...emptySessionState(), entries: [entry] }} {...props} />);
const raw = { message: 'Reconnecting... 1/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: 'stream disconnected before completion: error decoding response body' };
const expand = (container: HTMLElement) => {
  const details = container.querySelector('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  return details;
};

it('shows a native retry as a compact notice with technical details closed', () => {
  const message = JSON.stringify({ message: raw.message, details: JSON.stringify(raw) });
  const view = show(error('native_retry', message));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Retry notice');
  expect(screen.getByText(raw.message)).toBeVisible();
  const details = view.container.querySelector('details')!;
  expect(details).not.toHaveAttribute('open');
  expect(screen.getByText('Technical details')).toBeVisible();
  expect(within(details).getByText('native_retry')).not.toBeVisible();
  expect(details.querySelector('pre')).toBeNull();
  expand(view.container);
  expect(details.querySelector('pre')?.textContent).toBe(message);
  expect(details.querySelector('pre')).toBeVisible();
});

it('keeps stored reconnect JSON at unknown severity and leaves its bytes unchanged', () => {
  const message = JSON.stringify(raw, null, 2), entry = error('native_error', message);
  const before = JSON.stringify(entry);
  const view = show(entry);
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText(raw.message)).toBeVisible();
  expect(view.container.querySelector('.session-diagnostic-summary')).not.toHaveTextContent('codexErrorInfo');
  expect(expand(view.container).querySelector('pre')?.textContent).toBe(message);
  expect(JSON.stringify(entry)).toBe(before);
});

it.each(['native_turn_error', 'native_error', 'permission_denied', 'other_provider_error'])(
  'retains an alert and readable plain-text diagnostic for %s', code => {
    show(error(code, 'Access denied by the provider.'));
    expect(screen.getByRole('alert')).toHaveTextContent('Access denied by the provider.');
    expect(screen.getByText(code)).not.toBeVisible();
    if (code === 'native_turn_error') expect(screen.getByText('Turn failed')).toBeVisible();
  },
);

it.each(['{"message":', '{"message":42,"code":"broken"}', '["opaque"]', 'null', ''])('keeps malformed or opaque diagnostics available without a JSON wall: %s', message => {
  const view = show(error('native_error', message));
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(view.container.querySelector('.session-diagnostic-summary')).toHaveTextContent('An error was reported.');
  expect(expand(view.container).querySelector('pre')?.textContent).toBe(message);
});

it('bounds the visible summary while preserving long text and treating markup as text', () => {
  const message = '<img src=x onerror=alert(1)> ' + '连接已断开'.repeat(500);
  const view = show(error('native_error', message));
  expect(view.container.querySelector('.session-diagnostic-summary')!.textContent!.length).toBeLessThanOrEqual(240);
  expect(view.container.querySelector('.session-diagnostic-summary')).toHaveTextContent('…');
  expect(expand(view.container).querySelector('pre')?.textContent).toBe(message);
  expect(view.container.querySelector('img')).toBeNull();
});

it('preserves the expanded detail, entry identity and focus through unrelated renders and locale changes', () => {
  const entry = error('native_retry', JSON.stringify({ message: raw.message, details: JSON.stringify(raw) }));
  const view = show(entry), details = view.container.querySelector('details')!;
  const summary = within(details).getByText('Technical details');
  summary.focus();
  fireEvent.click(summary);
  fireEvent(details, new Event('toggle'));
  expect(details).toHaveAttribute('open');
  expect(details.querySelector('pre')).toBeVisible();
  view.rerender(<SessionTimeline state={{ ...emptySessionState(), entries: [entry, { kind: 'assistant_message', entryId: 'answer', entrySeq: '2', revision: '1', content: [{ type: 'text', text: 'Subsequent output' }] }] }} {...props} />);
  view.setLocale('zh-CN');
  expect(view.container.querySelector('details')).toBe(details);
  expect(details).toHaveAttribute('open');
  expect(document.activeElement).toBe(summary);
  expect(screen.getByText('重试通知')).toBeVisible();
  expect(screen.getByText('技术详情')).toBeVisible();
  expect(screen.queryByText(/recovered|已恢复/i)).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['Reconnecting...', '{broken', JSON.stringify(raw), '{"message":"Reconnecting...","details":42}'])('does not downgrade a malformed retry envelope: %s', message => {
  show(error('native_retry', message));
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.queryByRole('status')).toBeNull();
});

it.each(['input_cancelled', 'turn_interrupted'])('retains cancellation presentation for %s', code => {
  const view = show(error(code, 'cancelled'));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(view.container.querySelector('details')).toBeNull();
});
