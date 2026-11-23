import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { TimelineEntry } from '../src/api/types';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';

const props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: false, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: async () => new Blob() };
const message = (id: string, origin?: 'user' | 'daynight') => ({ kind: 'user_message' as const, entryId: id, entrySeq: id, revision: '1', content: [{ type: 'text' as const, text: `Message ${id}` }], ...(origin ? { origin } : {}) });

it.each(['en', 'zh-CN'] as const)('shows a collapsed Daynight notification in both display modes in %s', async locale => {
  const notification = { ...message('3', 'daynight'), content: [{ type: 'text' as const, text: 'Read the **manual**.\nThen report the result.' }] };
  const state = { ...emptySessionState(), entries: [message('1'), message('2', 'user'), notification] };
  const view = createLocaleRender(locale)(<SessionTimeline state={state} {...props} displayMode="conversation" />);
  const label = locale === 'en' ? 'Daynight notification' : 'Daynight 通知';
  const summary = screen.getByText(label).closest('summary')!;
  const details = summary.closest('details')!;
  expect(details).not.toHaveAttribute('open');
  expect(summary.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(screen.queryByText('manual')).toBeNull();
  expect(view.container.querySelector('[data-entry-key="3"] .user_message')).toBeNull();
  expect(view.container.querySelectorAll('.session-message.user_message')).toHaveLength(2);
  expect(screen.getByText('Message 1')).toBeVisible();
  expect(screen.getByText('Message 2')).toBeVisible();
  details.open = true; fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(screen.getByText('manual')).toBeVisible());
  expect(details.querySelector('strong')?.textContent).toBe('manual');
  expect(details.querySelector('br')).not.toBeNull();
  view.rerender(<SessionTimeline state={{ ...state, operations: new Map() }} {...props} displayMode="standard" />);
  expect(screen.getByText(label).closest('details')).toBe(details);
  expect(details).toHaveAttribute('open');
  expect(screen.getByText('manual')).toBeVisible();
  details.open = false; fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(screen.queryByText('manual')).toBeNull());
});

it('keeps notification attachments available on expansion without loading them while collapsed', async () => {
  const notification: TimelineEntry = { ...message('1', 'daynight'), kind: 'user_message', content: [
    { type: 'text', text: 'An attached report.' },
    { type: 'resource', resourceId: 'report', label: 'Report' },
    { type: 'image_unavailable', imageId: 'image', label: 'Diagram', error: { code: 'source_unavailable', message: 'Diagram unavailable.' } },
  ] };
  const resource = { resourceId: 'report', status: 'available' as const, mediaType: 'text/plain', name: 'report.txt', byteLength: '4', sha256: 'a'.repeat(64), error: null };
  const load = vi.fn(async () => new Blob());
  const view = createLocaleRender('en')(<SessionTimeline state={{ ...emptySessionState(), entries: [notification], resources: new Map([['report', resource]]) }} {...props} onLoadResource={load} />);
  expect(screen.queryByText('An attached report.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Download: Report' })).toBeNull();
  expect(load).not.toHaveBeenCalled();
  const details = view.container.querySelector('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  expect(await screen.findByText('An attached report.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Download: Report' })).toBeVisible();
  expect(screen.getByText('Diagram unavailable.')).toBeVisible();
  expect(load).not.toHaveBeenCalled();
});
