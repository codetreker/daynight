import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { ThreadPostError, type getThreadPage, type postThreadMessage } from '../src/features/task-thread/api';
import { encodedMessageBytes, type ThreadMessage, type ThreadPage } from '../src/features/task-thread/contract';
import { createThreadController, THREAD_LIMITS, type ThreadController, type ThreadControllerOptions } from '../src/features/task-thread/controller';

const id = (number: number): string => `00000000-0000-0000-0000-${number.toString(16).padStart(12, '0')}`;
const scope = { userId: id(1), projectId: id(2), taskId: id(3) };
const message = (number: number, body = `message ${number}`): ThreadMessage => ({ id: id(number), author: { userId: scope.userId, displayName: null, Agent: false }, body, createdAt: `2026-11-04T10:00:${Math.floor(number / 1000).toString().padStart(2, '0')}.${(number % 1000).toString().padStart(3, '0')}Z` });
const page = (items: readonly ThreadMessage[], hasMoreBefore = false, hasMoreAfter = false): ThreadPage => ({ items, hasMoreBefore, hasMoreAfter });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const controllers: ThreadController[] = [];
const make = (overrides: Partial<ThreadControllerOptions> = {}) => {
  const lifetime = new AbortController();
  const list = vi.fn<typeof getThreadPage>().mockResolvedValue(page([]));
  const post = vi.fn<typeof postThreadMessage>();
  const ready = vi.fn(async (_signal: AbortSignal) => {});
  const principalMismatch = vi.fn();
  const controller = createThreadController({ scope, lifetime: lifetime.signal, ready, principalMismatch, api: { list, post }, ...overrides });
  controllers.push(controller);
  return { controller, list, post, lifetime, ready, principalMismatch };
};
const start = async (controller: ThreadController): Promise<void> => { controller.setActive(true); await controller.refresh(); };
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const controller of controllers.splice(0)) controller.retire(); vi.useRealTimers(); });

describe('Thread controller continuous reading', () => {
  it('does not work while mounted inactive and cancels hidden reads before late publication', async () => {
    const { controller, list } = make();
    const pending = deferred<ThreadPage>(); list.mockReturnValueOnce(pending.promise);
    expect(list).not.toHaveBeenCalled();
    controller.setActive(true); await flush();
    expect(list).toHaveBeenCalledTimes(1);
    const admission = list.mock.calls[0]![3];
    controller.setActive(false);
    expect(() => admission.assertCurrent()).toThrow();
    pending.resolve(page([message(10)])); await flush();
    expect(controller.snapshot().visible).toEqual([]);
    controller.setActive(true); await controller.refresh();
    expect(list).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().consumedAfterId).toBeNull();
  });

  it('keeps A as cursor while own C is visible, then merges B and C without a duplicate', async () => {
    const { controller, list, post } = make();
    const a = message(10), b = message(11), c = message(12, '  own C\n\n    code\n');
    list.mockResolvedValueOnce(page([a])); await start(controller);
    post.mockImplementationOnce(async (_scope, input, _signal, admission) => { expect(input.body).toBe(c.body); expect(input).not.toHaveProperty('claimId'); admission.onDispatch?.(); admission.onConfirmed?.(c); return c; });
    controller.setDraft(c.body); await controller.send();
    expect(controller.snapshot().visible.map(item => item.id)).toEqual([a.id, c.id]);
    expect(controller.snapshot().consumedAfterId).toBe(a.id);
    list.mockResolvedValueOnce(page([b, c])); await controller.refresh();
    expect(list.mock.calls.at(-1)![1]).toEqual({ afterId: a.id, count: 50 });
    expect(controller.snapshot().visible.map(item => item.id)).toEqual([a.id, b.id, c.id]);
    expect(controller.snapshot().consumedAfterId).toBe(c.id);
  });

  it('uses fromBeginning after the initial empty page and consumes every returned page', async () => {
    const { controller, list } = make(); await start(controller);
    list.mockResolvedValueOnce(page([message(10)], false, true)).mockResolvedValueOnce(page([message(11)]));
    await controller.refresh();
    expect(list.mock.calls[1]![1]).toEqual({ count: 50, fromBeginning: true });
    expect(list.mock.calls[2]![1]).toEqual({ count: 50, afterId: id(10) });
    expect(controller.snapshot().consumedAfterId).toBe(id(11));
  });

  it('serializes forward readers and preserves the cursor on malformed immutable echoes', async () => {
    const { controller, list } = make();
    const a = message(10); list.mockResolvedValueOnce(page([a])); await start(controller);
    const pending = deferred<ThreadPage>(); list.mockReturnValueOnce(pending.promise);
    const first = controller.refresh(), second = controller.refresh();
    expect(first).toBe(second); await flush();
    pending.resolve(page([{ ...a, body: 'changed immutable body' }])); await first;
    expect(list).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().visible).toEqual([a]);
    expect(controller.snapshot().consumedAfterId).toBe(a.id);
    expect(controller.snapshot().readError).toBeInstanceOf(ApiError);
  });

  it('reads history in both directions without changing the continuous position', async () => {
    const { controller, list } = make();
    list.mockResolvedValueOnce(page([message(20)], true)); await start(controller);
    list.mockResolvedValueOnce(page([message(19)], true, true)); await controller.loadOlder();
    expect(list.mock.calls.at(-1)![1]).toEqual({ beforeId: id(20), count: 50 });
    expect(controller.snapshot().consumedAfterId).toBe(id(20));
    list.mockResolvedValueOnce(page([message(21)])); await controller.loadWindowNewer();
    expect(list.mock.calls.at(-1)![1]).toEqual({ afterId: id(20), count: 50 });
    expect(controller.snapshot().consumedAfterId).toBe(id(20));
    expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(19), id(20), id(21)]);
  });

  it('resumes immediately when visible, polls only after success, and stops after failure', async () => {
    const { controller, list } = make(); await start(controller);
    await vi.advanceTimersByTimeAsync(5_000); expect(list).toHaveBeenCalledTimes(2);
    controller.setDocumentVisible(false); await vi.advanceTimersByTimeAsync(10_000); expect(list).toHaveBeenCalledTimes(2);
    controller.setDocumentVisible(true); await controller.refresh(); expect(list).toHaveBeenCalledTimes(3);
    list.mockRejectedValueOnce(new ApiError('network')); await vi.advanceTimersByTimeAsync(5_000);
    const count = list.mock.calls.length; await vi.advanceTimersByTimeAsync(20_000); expect(list).toHaveBeenCalledTimes(count);
    list.mockResolvedValueOnce(page([])); await controller.refresh(); await vi.advanceTimersByTimeAsync(5_000);
    expect(list).toHaveBeenCalledTimes(count + 2);
  });

  it('keeps details and reading state through hidden and blocked admission while rejecting stale reads', async () => {
    const { controller, list, post } = make();
    const original = message(20), late = deferred<ThreadPage>(), resumed = deferred<ThreadPage>();
    list.mockResolvedValueOnce(page([original], true)); await start(controller);
    controller.setDraft('draft'); controller.setReply(original.id); controller.setFollowing(false); controller.setReadingAnchor(original.id);
    await controller.openDetails(original.id);
    list.mockReturnValueOnce(late.promise); const oldRead = controller.loadOlder(); await flush();
    const oldCall = list.mock.calls.at(-1)!;
    controller.setDocumentVisible(false);
    expect(oldCall[2].aborted).toBe(true); expect(() => oldCall[3].assertCurrent()).toThrow();
    controller.setAdmissionBlocked(true); controller.setDocumentVisible(true);
    await controller.refresh(); await controller.loadOlder(); await controller.send();
    expect(list).toHaveBeenCalledTimes(2); expect(post).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ detailsMessage: original, draft: 'draft', replyTo: original.id, hasMoreBefore: true, consumedAfterId: original.id, canSend: false });
    list.mockReturnValueOnce(resumed.promise); controller.setAdmissionBlocked(false); await flush();
    expect(list).toHaveBeenCalledTimes(3);
    late.resolve(page([message(19)], true, true)); await oldRead;
    expect(controller.snapshot().visible).toEqual([original]);
    expect(controller.snapshot().detailsMessage).toEqual(original);
    resumed.resolve(page([])); await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ detailsMessage: original, draft: 'draft', replyTo: original.id, hasMoreBefore: true, consumedAfterId: original.id, canSend: true });
    controller.retire();
    expect(controller.snapshot()).toMatchObject({ retired: true, visible: [], detailsMessage: null, draft: '', replyTo: null, hasMoreBefore: false, consumedAfterId: null });
  });

  it('retains the open details while resumed requests wait for scope readiness', async () => {
    const resume = deferred<void>(); let hold = false;
    const ready = vi.fn(async (_signal: AbortSignal) => { if (hold) await resume.promise; });
    const { controller, list, post } = make({ ready }); const original = message(10);
    list.mockResolvedValueOnce(page([original], true)); await start(controller);
    controller.setDraft('draft'); controller.setReply(original.id); await controller.openDetails(original.id);
    controller.setAdmissionBlocked(true); hold = true; controller.setAdmissionBlocked(false); await flush();
    const sending = controller.send(); await flush();
    expect(list).toHaveBeenCalledTimes(1); expect(post).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ detailsMessage: original, draft: 'draft', replyTo: original.id, hasMoreBefore: true, postOutcome: 'waiting_auth' });
    const sent = { ...message(11, 'draft'), replyTo: original.id };
    post.mockImplementationOnce(async (_scope, _input, _signal, admission) => { admission.onDispatch?.(); admission.onConfirmed?.(sent); return sent; });
    hold = false; resume.resolve(); await sending; await flush();
    expect(list).toHaveBeenCalledTimes(2); expect(post).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().detailsMessage).toEqual(original);
  });

  it.each(['forward', 'reference'] as const)('ignores a late %s scope-loss error after admission is cancelled', async (kind) => {
    const { controller, list } = make(); const original = message(20), late = deferred<ThreadPage>();
    list.mockResolvedValueOnce(page([original], true)); await start(controller);
    controller.setDraft('draft'); controller.setReply(original.id); await controller.openDetails(original.id);
    list.mockReturnValueOnce(late.promise);
    const old = kind === 'forward' ? controller.refresh() : controller.showReference(id(10)); await flush();
    controller.setAdmissionBlocked(true); controller.setAdmissionBlocked(false); await flush();
    late.reject(new ApiError('server', 403, 'forbidden')); await old;
    expect(controller.snapshot()).toMatchObject({ retired: false, readError: null, referenceError: null, detailsMessage: original, draft: 'draft', replyTo: original.id });
    expect(controller.snapshot().visible).toEqual([original]);
  });
});

describe('Thread scope and replies', () => {
  it('keeps local message_not_found failures but clears parent not_found and lifetime loss', async () => {
    const { controller, list, lifetime } = make();
    list.mockResolvedValueOnce(page([message(10)])); await start(controller); controller.setDraft('draft'); controller.setReply(id(10));
    list.mockRejectedValueOnce(new ApiError('server', 404, 'message_not_found')); await controller.loadOlder();
    expect(controller.snapshot().visible).toHaveLength(1); expect(controller.snapshot().draft).toBe('draft'); expect(controller.snapshot().consumedAfterId).toBe(id(10));
    list.mockRejectedValueOnce(new ApiError('protocol', 404)); await controller.refresh();
    expect(controller.snapshot().retired).toBe(false); expect(controller.snapshot().draft).toBe('draft');
    list.mockRejectedValueOnce(new ApiError('server', 404, 'not_found')); await controller.refresh();
    expect(controller.snapshot().retired).toBe(true); expect(controller.snapshot().visible).toEqual([]); expect(controller.snapshot().draft).toBe('');
    lifetime.abort(); expect(controller.snapshot().replyTo).toBeNull();
  });

  it('retires old admissions before they can trigger principal mismatch', async () => {
    const { controller, list, principalMismatch } = make();
    const pending = deferred<ThreadPage>(); list.mockReturnValueOnce(pending.promise);
    controller.setActive(true); await flush(); const admission = list.mock.calls[0]![3];
    controller.retire();
    expect(() => admission.onPrincipalMismatch()).toThrow();
    expect(principalMismatch).not.toHaveBeenCalled();
    pending.resolve(page([message(10)])); await flush(); expect(controller.snapshot().visible).toEqual([]);
  });

  it('resolves an off-window parent with at most two bounded GETs and never changes the cursor', async () => {
    const { controller, list } = make();
    list.mockResolvedValueOnce(page([message(20)])); await start(controller);
    list.mockResolvedValueOnce(page([message(9)], true, true)).mockResolvedValueOnce(page([message(10)], true, true));
    await controller.showReference(id(10));
    expect(list.mock.calls.slice(1).map(call => call[1])).toEqual([{ beforeId: id(10), count: 1 }, { afterId: id(9), count: 1 }]);
    expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(10)]);
    expect(controller.snapshot().consumedAfterId).toBe(id(20));
    await controller.openDetails(id(10)); expect(list).toHaveBeenCalledTimes(3); expect(controller.snapshot().detailsMessage?.id).toBe(id(10));
  });

  it('uses fromBeginning for the first parent and preserves a failed reference ID', async () => {
    const { controller, list } = make(); list.mockResolvedValueOnce(page([message(20)])); await start(controller);
    list.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([message(10)], false, true)); await controller.openDetails(id(10));
    expect(list.mock.calls.at(-1)![1]).toEqual({ fromBeginning: true, count: 1 });
    controller.closeDetails(); controller.setDraft('kept');
    list.mockRejectedValueOnce(new ApiError('server', 404, 'message_not_found')); await controller.showReference(id(11));
    expect(controller.snapshot().retired).toBe(false); expect(controller.snapshot().referenceError).toBeInstanceOf(ApiError);
    expect(controller.snapshot().draft).toBe('kept'); expect(controller.snapshot().consumedAfterId).toBe(id(20));
  });
});

describe('Thread sending', () => {
  it('keeps revisions edited during an in-flight POST and does not abort for a hidden tab', async () => {
    const { controller, list, post } = make(); list.mockResolvedValueOnce(page([message(10)])); await start(controller);
    const pending = deferred<ThreadMessage>();
    post.mockImplementationOnce(async (_scope, _input, signal, admission) => { admission.onDispatch?.(); const item = await pending.promise; expect(signal.aborted).toBe(false); admission.onConfirmed?.(item); return item; });
    controller.setDraft('submitted'); controller.setReply(id(10)); const sending = controller.send(); await flush();
    controller.setDraft('next draft'); controller.setReply(null); controller.setActive(false);
    pending.resolve({ ...message(11, 'submitted'), replyTo: id(10) }); await sending;
    expect(controller.snapshot().draft).toBe('next draft'); expect(controller.snapshot().replyTo).toBeNull();
    expect(controller.snapshot().remoteOutcome).toBe('confirmed'); expect(controller.snapshot().consumedAfterId).toBe(id(10));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('holds a fully confirmed response across auth admission and never reclassifies it unknown', async () => {
    const resume = deferred<void>(); let hold = false;
    const ready = vi.fn(async (_signal: AbortSignal) => { if (hold) await resume.promise; });
    const { controller, list, post } = make({ ready }); list.mockResolvedValueOnce(page([message(10)])); await start(controller);
    post.mockImplementationOnce(async (_scope, _input, _signal, admission) => { admission.onDispatch?.(); admission.onConfirmed?.(message(11, 'submitted')); hold = true; controller.setAdmissionBlocked(true); return message(11, 'submitted'); });
    controller.setDraft('submitted'); const sending = controller.send(); await flush();
    expect(controller.snapshot().remoteOutcome).toBe('confirmed'); expect(controller.snapshot().draft).toBe('submitted');
    await vi.advanceTimersByTimeAsync(20_000); expect(controller.snapshot().remoteOutcome).toBe('confirmed');
    controller.setAdmissionBlocked(false); hold = false; resume.resolve(); await sending;
    expect(controller.snapshot().draft).toBe(''); expect(controller.snapshot().visible.map(item => item.id)).toContain(id(11)); expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not replay a dispatched post hidden during admission and publishes its confirmed result only after ready', async () => {
    const result = deferred<ThreadMessage>(), resume = deferred<void>(); let hold = false;
    const ready = vi.fn(async (_signal: AbortSignal) => { if (hold) await resume.promise; });
    const { controller, list, post } = make({ ready }); list.mockResolvedValueOnce(page([message(10)])); await start(controller);
    post.mockImplementationOnce(async (_scope, _input, signal, admission) => {
      admission.onDispatch?.(); const item = await result.promise; expect(signal.aborted).toBe(false); admission.onConfirmed?.(item); return item;
    });
    controller.setDraft('submitted'); const sending = controller.send(); await flush();
    controller.setDocumentVisible(false); controller.setAdmissionBlocked(true); hold = true;
    result.resolve(message(11, 'submitted')); await flush();
    expect(controller.snapshot()).toMatchObject({ remoteOutcome: 'confirmed', postOutcome: 'confirmed', draft: 'submitted' });
    expect(controller.snapshot().visible.map(item => item.id)).not.toContain(id(11));
    await vi.advanceTimersByTimeAsync(20_000); expect(post).toHaveBeenCalledTimes(1);
    controller.setDocumentVisible(true); controller.setAdmissionBlocked(false); hold = false; resume.resolve(); await sending; await flush();
    expect(controller.snapshot()).toMatchObject({ remoteOutcome: 'confirmed', draft: '' });
    expect(controller.snapshot().visible.map(item => item.id)).toContain(id(11)); expect(post).toHaveBeenCalledTimes(1);
  });

  it('preserves unknown drafts without replay and distinguishes confirmed refusal', async () => {
    const { controller, list, post } = make(); await start(controller); controller.setDraft('not lost');
    post.mockImplementationOnce(async (_scope, _input, _signal, admission) => { admission.onDispatch?.(); throw new ThreadPostError('unknown', new ApiError('network')); });
    await controller.send(); expect(controller.snapshot().postOutcome).toBe('unknown'); expect(controller.snapshot().draft).toBe('not lost');
    await controller.refresh(); expect(post).toHaveBeenCalledTimes(1);
    post.mockRejectedValueOnce(new ThreadPostError('refused', new ApiError('server', 503, 'clock_not_advanced'))); await controller.send();
    expect(controller.snapshot().postOutcome).toBe('refused'); expect(controller.snapshot().draft).toBe('not lost');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('expresses the shared body rules in control availability', async () => {
    const { controller } = make(); await start(controller);
    for (const body of ['\u0085', '\u0000', '\ud800', 'x'.repeat(65_537)]) { controller.setDraft(body); expect(controller.snapshot().canSend).toBe(false); }
    controller.setDraft(' \n body\n\n    code\n'); expect(controller.snapshot().canSend).toBe(true);
  });
});

it('bounds own-receipt pins and releases a full incoming buffer for the next forward page', async () => {
  const { controller, list, post } = make({ limits: { ...THREAD_LIMITS, visibleCount: 8, visibleBytes: 600_000, incomingCount: 3, incomingBytes: 150_000 } });
  const a = message(10), body = 'x'.repeat(59_000), b = [message(11, body), message(12, body)], later = [message(13, body), message(14, body)];
  list.mockImplementation(async (_scope, query) => query.afterId === a.id ? page(b, false, true) : query.afterId === id(12) ? page(later) : page([a]));
  await start(controller); controller.setFollowing(false); controller.setReadingAnchor(a.id); await controller.refresh();
  expect(controller.snapshot().incomingCount).toBe(2); expect(controller.snapshot().catchupPaused).toBe(true); expect(controller.snapshot().consumedAfterId).toBe(id(12));
  let own = 100;
  post.mockImplementation(async (_scope, input, _signal, admission) => { admission.onDispatch?.(); const item = message(own++, input.body); admission.onConfirmed?.(item); return item; });
  for (let count = 0; count < 7; count++) { controller.setDraft(body); expect(controller.snapshot().canSend).toBe(true); await controller.send(); }
  expect(controller.snapshot().visible).toHaveLength(8);
  controller.revealIncoming(); await controller.refresh();
  expect(controller.snapshot().incomingCount).toBe(0); expect(controller.snapshot().consumedAfterId).toBe(id(14));
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([a.id, ...b.map(item => item.id), ...later.map(item => item.id), id(106)]);
  expect(controller.snapshot().visible.reduce((sum, item) => sum + encodedMessageBytes(item), 0)).toBeLessThan(600_000);
  expect(controller.snapshot().visible.length).toBeLessThanOrEqual(8);
  expect(post).toHaveBeenCalledTimes(7);
});

it('removes own newly displayed echo from the incoming count if polling wins the POST response race', async () => {
  const { controller, list, post } = make();
  const a = message(10), b = message(11), c = message(12, 'own'); list.mockResolvedValueOnce(page([a])); await start(controller);
  controller.setFollowing(false);
  const response = deferred<ThreadMessage>(); post.mockImplementationOnce(async (_scope, _input, _signal, admission) => { admission.onDispatch?.(); const item = await response.promise; admission.onConfirmed?.(item); return item; });
  controller.setDraft('own'); const sending = controller.send(); await flush();
  list.mockResolvedValueOnce(page([b, c])); await controller.refresh(); expect(controller.snapshot().incomingCount).toBe(2);
  response.resolve(c); await sending;
  expect(controller.snapshot().incomingCount).toBe(1); expect(controller.snapshot().consumedAfterId).toBe(c.id);
});

it('keeps confirmed commit facts when local immutable admission fails and reports no private fields', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { controller, list, post } = make(); const a = message(10);
  list.mockResolvedValueOnce(page([a])); await start(controller);
  post.mockImplementationOnce(async (_scope, _input, _signal, admission) => { admission.onDispatch?.(); const conflict = { ...a, body: 'private draft' }; admission.onConfirmed?.(conflict); return conflict; });
  controller.setDraft('private draft'); await controller.send();
  expect(controller.snapshot().remoteOutcome).toBe('confirmed'); expect(controller.snapshot().postOutcome).toBe('confirmed');
  expect(controller.snapshot().postError).toBeNull(); expect(controller.snapshot().readError).toBeInstanceOf(ApiError); expect(controller.snapshot().draft).toBe('private draft');
  expect(warn).toHaveBeenCalled(); const fields = warn.mock.calls.at(-1)![1];
  expect(fields).toMatchObject({ component: 'task_thread_web', phase: 'admit', taskId: scope.taskId, outcome: 'confirmed' });
  expect(JSON.stringify(fields)).not.toContain('private draft'); expect(fields).not.toHaveProperty('error');
  warn.mockRestore();
});

it('cancels a superseded reference without letting its late result replace the chosen target', async () => {
  const { controller, list } = make(); list.mockResolvedValueOnce(page([message(20)])); await start(controller);
  const old = deferred<ThreadPage>(); list.mockReturnValueOnce(old.promise);
  const first = controller.showReference(id(10)); await flush();
  list.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([message(11)]));
  await controller.openDetails(id(11)); expect(controller.snapshot().detailsMessage?.id).toBe(id(11));
  old.resolve(page([message(9)])); await first;
  expect(controller.snapshot().detailsMessage?.id).toBe(id(11)); expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(20)]);
});

it('retires pending history when a reference replaces the window, preserving the intervening navigation range', async () => {
  const { controller, list } = make(); list.mockResolvedValueOnce(page([message(151)], true)); await start(controller);
  const old = deferred<ThreadPage>(); list.mockReturnValueOnce(old.promise);
  const history = controller.loadOlder(); await flush(); const admission = list.mock.calls.at(-1)![3];
  list.mockResolvedValueOnce(page([message(9)], true, true)).mockResolvedValueOnce(page([message(10)], true, true));
  await controller.showReference(id(10));
  expect(() => admission.assertCurrent()).toThrow(); expect(controller.snapshot().loadingOlder).toBe(false);
  list.mockResolvedValueOnce(page([message(11)], true, true)); await controller.loadWindowNewer();
  expect(list.mock.calls.at(-1)![1]).toEqual({ afterId: id(10), count: 50 });
  old.resolve(page([message(150)], true, true)); await history;
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(10), id(11)]);
  expect(controller.snapshot().historyError).toBeNull(); expect(controller.snapshot().consumedAfterId).toBe(id(151));
});

it('releases pending history for a new reveal window and ignores its late terminal failure', async () => {
  const { controller, list } = make(); list.mockResolvedValueOnce(page([message(151)], true)); await start(controller);
  controller.setFollowing(false); list.mockResolvedValueOnce(page([message(152)])); await controller.refresh();
  const old = deferred<ThreadPage>(); list.mockReturnValueOnce(old.promise);
  const history = controller.loadOlder(); await flush();
  controller.revealIncoming(); await controller.refresh();
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(152)]); expect(controller.snapshot().loadingOlder).toBe(false);
  const fresh = deferred<ThreadPage>(); list.mockReturnValueOnce(fresh.promise); const newHistory = controller.loadOlder(); await flush();
  expect(list.mock.calls.at(-1)![1]).toEqual({ beforeId: id(152), count: 50 });
  old.reject(new ApiError('server', 404, 'not_found')); await history;
  expect(controller.snapshot().retired).toBe(false); expect(controller.snapshot().historyError).toBeNull(); expect(controller.snapshot().loadingOlder).toBe(true);
  fresh.resolve(page([message(151)], true, true)); await newHistory;
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(151), id(152)]); expect(controller.snapshot().consumedAfterId).toBe(id(152));
});

it('rejects a history result when its captured boundary was evicted by concurrent forward admission', async () => {
  const { controller, list } = make({ limits: { ...THREAD_LIMITS, visibleCount: 2 } });
  list.mockResolvedValueOnce(page([message(151)], true)); await start(controller);
  const old = deferred<ThreadPage>(); list.mockReturnValueOnce(old.promise);
  const history = controller.loadOlder(); await flush(); const admission = list.mock.calls.at(-1)![3];
  list.mockResolvedValueOnce(page([message(152), message(153)])); await controller.refresh();
  expect(() => admission.assertCurrent()).toThrow();
  old.resolve(page([message(150)], true, true)); await history;
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(152), id(153)]); expect(controller.snapshot().historyError).toBeNull();
  list.mockResolvedValueOnce(page([message(151)], true, true)); await controller.loadOlder();
  expect(list.mock.calls.at(-1)![1]).toEqual({ beforeId: id(152), count: 50 }); expect(controller.snapshot().consumedAfterId).toBe(id(153));
});

it('keeps an empty-buffer scroll jump on its established range despite a disconnected own receipt', async () => {
  const { controller, list, post } = make(); const own = message(200, 'own');
  list.mockResolvedValueOnce(page([message(151)], true)); await start(controller);
  list.mockResolvedValueOnce(page([message(9)], true, true)).mockResolvedValueOnce(page([message(10)], true, true)); await controller.showReference(id(10));
  post.mockImplementationOnce(async (_scope, _input, _signal, admission) => { admission.onDispatch?.(); admission.onConfirmed?.(own); return own; });
  controller.setDraft(own.body); await controller.send();
  list.mockResolvedValueOnce(page([message(152), own], true)); controller.revealIncoming(); await controller.refresh();
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(10), own.id]); expect(controller.snapshot().incomingCount).toBe(1);
  expect(controller.snapshot().consumedAfterId).toBe(own.id);
  list.mockResolvedValueOnce(page([message(11), message(12), message(151)], true, true)); await controller.loadWindowNewer();
  expect(list.mock.calls.at(-1)![1]).toEqual({ afterId: id(10), count: 50 });
  list.mockResolvedValueOnce(page([message(152), own], true)); await controller.loadWindowNewer();
  expect(list.mock.calls.at(-1)![1]).toEqual({ afterId: id(151), count: 50 });
  list.mockResolvedValueOnce(page([message(9)], true, true)); await controller.loadOlder();
  expect(list.mock.calls.at(-1)![1]).toEqual({ beforeId: id(10), count: 50 });
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(9), id(10), id(11), id(12), id(151), id(152), own.id]);
  expect(controller.snapshot().incomingCount).toBe(0); expect(controller.snapshot().consumedAfterId).toBe(own.id);
});

it('retains a visible own echo inside the complete buffered segment rather than using notification IDs as range membership', async () => {
  const { controller, list, post } = make({ limits: { ...THREAD_LIMITS, visibleCount: 3 } });
  const a = message(10), b = message(11), c = message(12, 'own'), d = message(13), e = message(14);
  list.mockResolvedValueOnce(page([a])); await start(controller); controller.setFollowing(false);
  post.mockImplementationOnce(async (_scope, _input, _signal, admission) => { admission.onDispatch?.(); admission.onConfirmed?.(c); return c; });
  controller.setDraft(c.body); await controller.send(); list.mockResolvedValueOnce(page([b, c, d])); await controller.refresh();
  expect(controller.snapshot().incomingCount).toBe(2);
  controller.revealIncoming(); await controller.refresh(); controller.setReadingAnchor(c.id);
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([b.id, c.id, d.id]);
  list.mockResolvedValueOnce(page([e])); await controller.refresh();
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([c.id, d.id, e.id]);
  list.mockResolvedValueOnce(page([b], true, true)); await controller.loadOlder();
  expect(list.mock.calls.at(-1)![1]).toEqual({ beforeId: c.id, count: 50 });
  expect(controller.snapshot().consumedAfterId).toBe(e.id);
});

it('keeps disconnected fixed pins outside a pruned segment and exposes both retrievable directions', async () => {
  const { controller, list } = make({ limits: { ...THREAD_LIMITS, visibleCount: 4 } });
  list.mockResolvedValueOnce(page([message(1), message(2), message(3), message(4)])); await start(controller); controller.setReadingAnchor(id(1));
  list.mockResolvedValueOnce(page([message(5), message(6)])); await controller.loadWindowNewer();
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(1), id(4), id(5), id(6)]); expect(controller.snapshot().hasMoreBefore).toBe(true);
  list.mockResolvedValueOnce(page([message(2), message(3)], true, true)); await controller.loadOlder();
  expect(list.mock.calls.at(-1)![1]).toEqual({ beforeId: id(4), count: 50 });
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(1), id(2), id(3), id(4)]); expect(controller.snapshot().hasMoreAfter).toBe(true);
  list.mockResolvedValueOnce(page([message(5), message(6)], true)); await controller.loadWindowNewer();
  expect(list.mock.calls.at(-1)![1]).toEqual({ afterId: id(4), count: 50 }); expect(controller.snapshot().consumedAfterId).toBe(id(4));
});

it('admits connected overlapping forward pages after historical navigation without leaving obsolete buffered entries', async () => {
  const { controller, list } = make();
  list.mockResolvedValueOnce(page([message(10)])); await start(controller);
  list.mockResolvedValueOnce(page([message(11), message(12), message(13)], true, true)); await controller.loadWindowNewer();
  expect(controller.snapshot().consumedAfterId).toBe(id(10));
  list.mockResolvedValueOnce(page([message(11), message(12), message(13), message(14)])); controller.revealIncoming(); await controller.refresh();
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(10), id(11), id(12), id(13), id(14)]); expect(controller.snapshot().incomingCount).toBe(0);
  list.mockResolvedValueOnce(page([message(15)])); await controller.refresh();
  expect(controller.snapshot().visible.at(-1)?.id).toBe(id(15)); expect(controller.snapshot().incomingCount).toBe(0); expect(controller.snapshot().consumedAfterId).toBe(id(15));
});

it('keeps an own receipt outside range membership until the first fromBeginning page is admitted', async () => {
  const { controller, list, post } = make(); await start(controller); const c = message(12, 'own');
  post.mockImplementationOnce(async (_scope, _input, _signal, admission) => { admission.onDispatch?.(); admission.onConfirmed?.(c); return c; });
  controller.setDraft(c.body); await controller.send(); expect(controller.snapshot().consumedAfterId).toBeNull();
  list.mockResolvedValueOnce(page([message(10), message(11), c])); await controller.refresh();
  expect(list.mock.calls.at(-1)![1]).toEqual({ fromBeginning: true, count: 50 });
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(10), id(11), c.id]); expect(controller.snapshot().incomingCount).toBe(0);
  expect(controller.snapshot().consumedAfterId).toBe(c.id);
  list.mockResolvedValueOnce(page([])); await controller.loadOlder(); expect(list.mock.calls.at(-1)![1]).toEqual({ beforeId: id(10), count: 50 });
});

it('releases a complete buffered segment when history displays it so later forward pages cannot overtake stale incoming data', async () => {
  const { controller, list } = make(); list.mockResolvedValueOnce(page([message(10)])); await start(controller); controller.setFollowing(false);
  list.mockResolvedValueOnce(page([message(11), message(12)])); await controller.refresh(); expect(controller.snapshot().incomingCount).toBe(2);
  list.mockResolvedValueOnce(page([message(11), message(12)], true)); await controller.loadWindowNewer(); expect(controller.snapshot().incomingCount).toBe(0);
  list.mockResolvedValueOnce(page([])); controller.revealIncoming(); await controller.refresh();
  list.mockResolvedValueOnce(page([message(13)])); await controller.refresh();
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(10), id(11), id(12), id(13)]); expect(controller.snapshot().incomingCount).toBe(0); expect(controller.snapshot().consumedAfterId).toBe(id(13));
});

it('keeps a disconnected latest receipt out of the newer boundary after pruning toward older history', async () => {
  const { controller, list, post } = make({ limits: { ...THREAD_LIMITS, visibleCount: 4 } });
  list.mockResolvedValueOnce(page([message(3), message(4), message(5), message(6)], true)); await start(controller);
  const own = message(7, 'own'); post.mockImplementationOnce(async (_scope, _input, _signal, admission) => { admission.onDispatch?.(); admission.onConfirmed?.(own); return own; });
  controller.setDraft(own.body); await controller.send();
  list.mockResolvedValueOnce(page([message(2), message(3)], true, true)); await controller.loadOlder();
  expect(list.mock.calls.at(-1)![1]).toEqual({ beforeId: id(4), count: 50 });
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(2), id(3), id(4), own.id]); expect(controller.snapshot().hasMoreAfter).toBe(true);
  list.mockResolvedValueOnce(page([message(5), message(6), own], true)); await controller.loadWindowNewer();
  expect(list.mock.calls.at(-1)![1]).toEqual({ afterId: id(4), count: 50 });
  expect(controller.snapshot().visible.map(item => item.id)).toEqual([id(4), id(5), id(6), own.id]); expect(controller.snapshot().hasMoreBefore).toBe(true); expect(controller.snapshot().consumedAfterId).toBe(id(6));
});
