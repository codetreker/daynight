import { readFileSync } from 'node:fs';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot, TimelineEntry } from '../src/api/types';
import { sessionFence } from '../../daynight/src/session/protocol';
import { TaskSessionClient, type SessionViewState } from '../src/features/task-agent-session/client';
import type { SessionApi } from '../src/api/sessions';
import { SessionView } from '../src/features/task-agent-session/SessionView';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';
import { selectSessionHistoryRows, type SessionHistoryPreview } from '../src/features/task-agent-session/history-preview';

const render = createLocaleRender('en');
const snapshot: SessionSnapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
const message = (seq: string, text = `Cached ${seq}`, revision = '1'): TimelineEntry => ({ kind: 'assistant_message', entryId: `entry-${seq}`, entrySeq: seq, revision, content: [{ type: 'text', text }] });
const preview: SessionHistoryPreview = { fence: sessionFence(snapshot), historyEpoch: snapshot.historyEpoch, lastEventSeq: '1', entries: [message('1'), message('2'), message('3')], resources: [] };
const coverage = (firstEntrySeq: string | null, throughEntrySeq: string, completeBefore = false) => ({ firstEntrySeq, throughEntrySeq, completeBefore, lastEventSeq: '1' });
const state = (entries: readonly TimelineEntry[] = []) => ({ ...emptySessionState(), snapshot, entries });
function clientFixture() {
  const base = new TaskSessionClient({ api: {} as SessionApi, userId: 'owner', testSessionId: snapshot.sessionId, isCurrent: () => true, onPrincipalMismatch: () => {}, storage: null });
  let value: SessionViewState = { ...base.snapshot(), state: state(), status: 'ready' };
  const client = { subscribe: () => () => {}, snapshot: () => value, canInteract: () => false, refresh: vi.fn(), loadOlder: vi.fn(), resource: vi.fn(), respond: vi.fn(), setDraft: vi.fn(), send: vi.fn(), cancel: vi.fn(), updateSetting: vi.fn(), executeCommand: vi.fn(), refreshControls: vi.fn() } as unknown as TaskSessionClient;
  return { client, update: (next: Partial<SessionViewState>) => { value = { ...value, ...next }; } };
}
const props = { active: true, canRespond: true, onRespond: vi.fn(), hasOlder: true, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: vi.fn(async () => new Blob()) };

describe('read-only history preview handoff', () => {
  it('keeps preview through current and replaces only verified page coverage with real revisions', () => {
    expect(selectSessionHistoryRows(state(), preview, false, null).map(row => row.entry)).toEqual(preview.entries);
    const live = message('2', 'Verified revision', '1');
    const rows = selectSessionHistoryRows(state([live]), preview, true, coverage('2', '2'));
    expect(rows.map(row => [row.entry.entryId, row.preview])).toEqual([['entry-1', true], ['entry-2', false], ['entry-3', true]]);
    expect(rows[1]!.entry).toBe(live);
    expect(selectSessionHistoryRows(state(), preview, true, coverage(null, '3', true))).toEqual([]);
    expect(selectSessionHistoryRows(state(), preview, true, coverage(null, '0')).map(row => row.entry)).toEqual(preview.entries);
  });
  it('retains the newer uncrossed watermark through an older complete empty page', () => {
    const newer = { ...preview, lastEventSeq: '9' };
    expect(selectSessionHistoryRows(state(), newer, true, coverage(null, '1', true)).map(row => row.entry.entrySeq)).toEqual(['2', '3']);
    expect(selectSessionHistoryRows(state(), newer, true, { ...coverage(null, '3', true), lastEventSeq: '9' })).toEqual([]);
  });
  it('discards other history identities and never lets late preview downgrade a live row', () => {
    const live = message('2', 'Real content', '1');
    const newerCache = { ...preview, entries: [message('2', 'Unverified newer cache', '99')] };
    expect(selectSessionHistoryRows(state([live]), newerCache, true, coverage('2', '2'))[0]!.entry).toBe(live);
    expect(selectSessionHistoryRows({ ...state(), snapshot: { ...snapshot, historyEpoch: 'other' } }, preview, false, null)).toEqual([]);
  });
  it('preserves the message article and scroll owner when current and verified history arrive', () => {
    const rendered = render(<SessionTimeline {...props} state={emptySessionState()} historyPreview={preview} historyLoaded={false} />);
    const article = rendered.container.querySelector('[data-entry-key="entry-2"]');
    const scroll = rendered.container.querySelector('.session-timeline');
    rendered.rerender(<SessionTimeline {...props} state={state()} historyPreview={preview} historyLoaded={false} />);
    expect(rendered.container.querySelector('[data-entry-key="entry-2"]')).toBe(article);
    rendered.rerender(<SessionTimeline {...props} state={state([message('2', 'Verified')])} historyPreview={preview} historyLoaded historyCoverage={coverage('2', '3')} />);
    expect(rendered.container.querySelector('[data-entry-key="entry-2"]')).toBe(article);
    expect(rendered.container.querySelector('.session-timeline')).toBe(scroll);
    expect(screen.getByText('Verified')).toBeVisible();
    expect(screen.queryByText('Cached 3')).toBeNull();
    expect(screen.getByText('Cached 1')).toBeVisible();
  });
  it('retains the same shared view rows from binding-free preview through accepted live history', () => {
    const f = clientFixture();
    const element = (client: TaskSessionClient | null) => <SessionView client={client} userId="owner" active current historyPreview={preview} presentation={{ variant: 'assistant' }} />;
    const rendered = render(element(null));
    const article = rendered.container.querySelector('[data-entry-key="entry-2"]');
    const scroll = rendered.container.querySelector('.session-timeline');
    rendered.rerender(element(f.client));
    expect(rendered.container.querySelector('[data-entry-key="entry-2"]')).toBe(article);
    expect(rendered.container.querySelector('.session-timeline')).toBe(scroll);
    f.update({ historyLoaded: true, historySettled: true, historyCoverage: coverage('2', '3'), state: state([message('2', 'Accepted history')]) });
    rendered.rerender(element(f.client));
    expect(rendered.container.querySelector('[data-entry-key="entry-2"]')).toBe(article);
    expect(rendered.container.querySelector('.session-timeline')).toBe(scroll);
    expect(screen.getByText('Accepted history')).toBeVisible();
  });
  it('does not present retained old entries under a new Bot history epoch before hydration', () => {
    const f = clientFixture();
    f.update({ historyLoaded: false, state: { ...state([message('2', 'Old retained history')]), snapshot: { ...snapshot, historyEpoch: 'new-epoch' } } });
    render(<SessionView client={f.client} userId="owner" active current historyPreview={preview} presentation={{ variant: 'assistant' }} />);
    expect(screen.queryByText('Old retained history')).toBeNull();
    expect(screen.queryByText('Cached 2')).toBeNull();
    expect(screen.queryByText('No conversation yet.')).toBeNull();
  });
  it('offers the current phase and retry callback to optional pending and unavailable slots', () => {
    const retry = vi.fn();
    const pending = vi.fn(({ phase }: { phase: string }) => <p>Pending {phase}</p>);
    const unavailable = vi.fn(({ error, retry }: { error: string; retry: () => void }) => <button onClick={retry}>{error}</button>);
    const rendered = render(<SessionView client={null} userId="owner" active current onRetry={retry} presentation={{ renderPending: pending, renderUnavailable: unavailable }} />);
    expect(screen.getByText('Pending binding')).toBeVisible();
    rendered.rerender(<SessionView client={null} userId="owner" active current error="Read failed" onRetry={retry} presentation={{ renderPending: pending, renderUnavailable: unavailable }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read failed' }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it.each(['resource', 'image'] as const)('renders historic approvals and %s parts without controls or resource requests', type => {
    const resourceId = 'resource';
    const entries: TimelineEntry[] = [
      { kind: 'interaction', entryId: 'approval', entrySeq: '1', revision: '1', interaction: { interactionId: 'request', revision: '1', state: 'pending', kind: 'approval', title: 'Historical approval', detail: 'Old operation', actions: ['allow_once'] } },
      { kind: 'assistant_message', entryId: 'image', entrySeq: '2', revision: '1', imageProjectionError: null, content: [type === 'image' ? { type, imageId: crypto.randomUUID(), resourceId, label: 'Old image' } : { type, resourceId, label: 'Old image' }] },
    ];
    const p: SessionHistoryPreview = { ...preview, entries, resources: [{ resourceId, name: 'result.png', status: 'available', mediaType: 'image/png', byteLength: '4', sha256: 'digest', error: null }] };
    const rendered = render(<SessionTimeline {...props} state={emptySessionState()} historyPreview={p} historyLoaded={false} />);
    expect(screen.getByText('Historical approval')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Allow|Download/ })).toBeNull();
    expect(rendered.container.querySelector('form')).toBeNull();
    expect(rendered.container.querySelector('img')).toBeNull();
    expect(props.onLoadResource).not.toHaveBeenCalled();
  });
  it('renders a stable client-free shell with no invented welcome or editable draft', () => {
    const rendered = render(<SessionView client={null} userId="confirmed-user" active current historyPreview={preview} />);
    expect(screen.getByText('Cached 2')).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('No conversation yet.')).toBeNull();
    expect(rendered.container.querySelector('.session-composer-placeholder')).not.toBeNull();
  });
});
