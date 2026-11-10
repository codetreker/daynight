import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { act, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { SessionApi } from '../src/api/sessions';
import type { MessagePart, SessionSnapshot, TimelineEntry } from '../src/api/types';
import { sessionFence } from '../../daynight/src/session/protocol';
import { TaskSessionClient, type SessionViewState } from '../src/features/task-agent-session/client';
import { SessionView } from '../src/features/task-agent-session/SessionView';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState } from '../src/features/task-agent-session/state';
import { SessionImageStore } from '../src/features/task-agent-session/images/image-store';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const snapshot: SessionSnapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
const id = '00000000-0000-4000-8000-000000000001';
const markdown = (revision = '1'): Extract<MessagePart, { type: 'markdown' }> => ({ type: 'markdown', text: 'Readable ![saved](https://example.com/image.png)', partId: id, revision, textSha256: '0'.repeat(64), complete: true, truncated: false, bindings: [], retainedImages: [] });
const entry = (revision = '1'): TimelineEntry => ({ kind: 'assistant_message', entryId: id, entrySeq: '1', revision, imageProjectionError: null, content: [markdown(revision)] });
const props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: false, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: vi.fn(async () => new Blob()) };

function fixture() {
  const base = new TaskSessionClient({ api: {} as SessionApi, userId: 'owner', testSessionId: snapshot.sessionId, isCurrent: () => true, onPrincipalMismatch: () => {}, storage: null });
  let value: SessionViewState = { ...base.snapshot(), historyLoaded: true, state: { ...emptySessionState(), snapshot, entries: [entry()] }, status: 'ready' };
  const client = { subscribe: () => () => {}, snapshot: () => value, canInteract: () => false, refresh: vi.fn(), loadOlder: vi.fn(), resource: vi.fn(), respond: vi.fn(), setDraft: vi.fn(), send: vi.fn(), cancel: vi.fn(), updateSetting: vi.fn(), executeCommand: vi.fn(), refreshControls: vi.fn() } as unknown as TaskSessionClient;
  return { client, update: (next: Partial<SessionViewState>) => { value = { ...value, ...next }; } };
}

it('reports the exact owning entry once and leaves failed bindings explicitly unavailable', async () => {
  const onInvalidImageBindings = vi.fn();
  const state = { ...emptySessionState(), entries: [entry()] };
  const view = render(<SessionTimeline {...props} state={state} onInvalidImageBindings={onInvalidImageBindings} />);
  await waitFor(() => expect(onInvalidImageBindings).toHaveBeenCalledWith(id, '1'));
  expect(screen.getByText('Image references could not be verified.')).toBeVisible();
  view.rerender(<SessionTimeline {...props} state={{ ...state, entries: [entry()] }} onInvalidImageBindings={onInvalidImageBindings} />);
  expect(onInvalidImageBindings).toHaveBeenCalledOnce();
  expect(props.onLoadResource).not.toHaveBeenCalled();
  expect(view.container.querySelector('img')).toBeNull();
});

it('does not validate or refresh cached Markdown image descriptors', async () => {
  const onInvalidImageBindings = vi.fn(), digest = vi.spyOn(crypto.subtle, 'digest');
  const historyPreview = { fence: sessionFence(snapshot), historyEpoch: snapshot.historyEpoch, lastEventSeq: '1', entries: [entry()], resources: [] };
  render(<SessionTimeline {...props} state={emptySessionState()} historyPreview={historyPreview} historyLoaded={false} onInvalidImageBindings={onInvalidImageBindings} />);
  expect(screen.getByText(/Readable/)).toBeVisible();
  expect(digest).not.toHaveBeenCalled();
  expect(onInvalidImageBindings).not.toHaveBeenCalled();
});

it.each(['tool_call', 'reasoning'] as const)('reports invalid bindings from expanded %s content under its real entry', async kind => {
  const { type: _type, text, ...metadata } = markdown();
  const value: TimelineEntry = kind === 'reasoning'
    ? { kind, entryId: id, entrySeq: '1', revision: '2', text, markdown: metadata, imageProjectionError: null }
    : { kind, entryId: id, entrySeq: '1', revision: '2', callId: 'call', name: 'tool', input: '{}', output: [markdown()], status: 'completed', truncated: false, imageProjectionError: null };
  const onInvalidImageBindings = vi.fn();
  const view = render(<SessionTimeline {...props} state={{ ...emptySessionState(), entries: [value] }} onInvalidImageBindings={onInvalidImageBindings} />);
  expect(onInvalidImageBindings).not.toHaveBeenCalled();
  await act(async () => { const details = view.container.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')); });
  await waitFor(() => expect(onInvalidImageBindings).toHaveBeenCalledWith(id, '2'));
  expect(onInvalidImageBindings).toHaveBeenCalledOnce();
});

it('refreshes the shared Session owner once per entry version despite timeline remounts', async () => {
  const f = fixture();
  const element = () => <SessionView client={f.client} userId="owner" active current />;
  const view = render(element());
  await waitFor(() => expect(f.client.refresh).toHaveBeenCalledOnce());
  f.update({ status: 'unavailable' }); view.rerender(element());
  f.update({ status: 'ready' }); view.rerender(element());
  const digests = vi.spyOn(crypto.subtle, 'digest');
  f.update({ state: { ...f.client.snapshot().state, entries: [entry('2')] } }); view.rerender(element());
  await waitFor(() => expect(f.client.refresh).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.all(digests.mock.results.map(result => result.value)); });
  expect(f.client.refresh).toHaveBeenCalledTimes(2);
  expect(f.client.resource).not.toHaveBeenCalled();
});

it('defers a failed binding refresh until the same owner regains read admission', async () => {
  const f = fixture(), digest = vi.spyOn(crypto.subtle, 'digest');
  const element = (current: boolean) => <SessionView client={f.client} userId="owner" active current={current} />;
  const view = render(element(false));
  await act(async () => { await Promise.all(digest.mock.results.map(result => result.value)); });
  expect(f.client.refresh).not.toHaveBeenCalled();
  f.update({ authPaused: true }); view.rerender(element(true));
  expect(f.client.refresh).not.toHaveBeenCalled();
  f.update({ authPaused: false }); view.rerender(element(true));
  await waitFor(() => expect(f.client.refresh).toHaveBeenCalledOnce());
  view.rerender(element(false)); view.rerender(element(true));
  expect(f.client.refresh).toHaveBeenCalledOnce();
});

it('drops queued failures when the authoritative entry was removed before admission returns', async () => {
  const f = fixture(), digest = vi.spyOn(crypto.subtle, 'digest');
  const element = (current: boolean) => <SessionView client={f.client} userId="owner" active current={current} />;
  const view = render(element(false));
  await act(async () => { await Promise.all(digest.mock.results.map(result => result.value)); });
  f.update({ state: { ...f.client.snapshot().state, entries: [] } });
  view.rerender(element(true));
  expect(f.client.refresh).not.toHaveBeenCalled();
});

it.each(['image', 'resource', 'markdown'] as const)('refreshes an immutable descriptor conflict in %s content through its entry owner only once', async type => {
  const f = fixture(), store = new SessionImageStore(), read = vi.fn();
  const resource = { resourceId: id, revision: '1', name: 'Image.png', mediaType: 'image/png', status: 'available' as const, byteLength: '68', sha256: 'a'.repeat(64), width: 1, height: 1, frameCount: 1, error: null };
  const scope = store.createScope({ identity: { serverOrigin: window.location.origin, actorUserId: 'owner', authorizationGeneration: '1', owner: { kind: 'session', fence: sessionFence(snapshot), nativeSessionId: snapshot.identity.nativeSessionId } }, read, canRead: () => true, canDownload: () => true });
  scope.asset(resource);
  const part = { type: 'image' as const, imageId: id, resourceId: id, label: 'Saved image' };
  const text = '![image](image:saved)';
  const content: MessagePart[] = type === 'markdown'
    ? [{ ...markdown(), text, textSha256: createHash('sha256').update(text).digest('hex'), bindings: [{ imageId: id, start: 0, end: text.length, part }] }]
    : type === 'image' ? [part] : [{ type: 'resource', resourceId: id, label: 'Saved image' }];
  f.update({ state: { ...f.client.snapshot().state, entries: [{ kind: 'assistant_message', entryId: id, entrySeq: '1', revision: '1', content, imageProjectionError: null }], resources: new Map([[id, { ...resource, sha256: 'b'.repeat(64) }]]) } });
  f.client.imageScope = () => scope;
  const element = () => <SessionView client={f.client} userId="owner" active current />;
  const view = render(element());
  await waitFor(() => expect(f.client.refresh).toHaveBeenCalledOnce());
  expect(screen.getByText('The saved image is damaged or no longer matches its description.')).toBeVisible();
  view.rerender(element());
  expect(f.client.refresh).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
  view.unmount(); await store.close();
});
