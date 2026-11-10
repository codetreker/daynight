import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  BOT_DISPLAY_SNAPSHOT_NAMESPACE, BotDisplaySnapshotStore,
  decodeBotDisplayPreview, parseBotDisplayPreview, prepareBotDisplayPreview,
  type BotDisplayPreview, type BotDisplaySnapshotLock, type BotDisplaySnapshotSave,
} from '../src/features/bots/display-snapshot';
import { parseTimelineEntry, type SessionResource, type TimelineEntry } from '../../daynight/src/session/protocol';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const key = (owner: string) => BOT_DISPLAY_SNAPSHOT_NAMESPACE + owner;
const stores: BotDisplaySnapshotStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); });

function entry(n = 1, text = `message ${n}`): TimelineEntry {
  return { kind: 'assistant_message', entryId: id(1_000 + n), entrySeq: String(n), revision: '1', content: [{ type: 'text', text }] };
}
function resource(n = 1): SessionResource {
  return { resourceId: id(2_000 + n), status: 'available', name: 'image.png', mediaType: 'image/png', byteLength: '4', sha256: 'a'.repeat(64), error: null };
}
function preview(owner: string, bot = 1, overrides: Partial<BotDisplayPreview> = {}): BotDisplayPreview {
  const binding = { ownerUserId: owner, botId: id(bot), sessionId: id(100 + bot), testExecutionId: id(200 + bot) };
  return { schemaVersion: 1, ownerUserId: owner, botId: binding.botId, lastKnownBinding: binding, botName: `Bot ${bot}`, fence: { sessionId: binding.sessionId, testExecutionId: binding.testExecutionId, executionGeneration: '1' }, historyEpoch: 'history-1', lastEventSeq: '1', entries: [entry()], resources: [], savedAt: 1_000, ...overrides };
}
function sizedPreview(owner: string, bot: number, units: number): BotDisplayPreview {
  const shell = preview(owner, bot, { entries: [entry(1, '')] });
  const padding = units - JSON.stringify(shell).length;
  // The emoji occupies two UTF-16 units and four UTF-8 bytes.
  return { ...shell, entries: [entry(1, '😀' + 'x'.repeat(padding - 2))] };
}
function lock(): BotDisplaySnapshotLock {
  let tail = Promise.resolve();
  return async <T>(_name: string, run: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(run);
    tail = result.then(() => {}, () => {});
    return result;
  };
}
function store(owner: string, options: Partial<ConstructorParameters<typeof BotDisplaySnapshotStore>[0]> = {}) {
  const result = new BotDisplaySnapshotStore({ isCurrent: candidate => candidate === owner, withLock: lock(), ...options });
  stores.push(result); return result;
}
async function save(target: BotDisplaySnapshotStore, value: BotDisplayPreview) {
  const observed = await target.observe(value.ownerUserId, value.botId);
  expect(observed).not.toBeNull();
  return target.save(observed!, { source: 'verified-history', historyLoaded: true, preview: value });
}
function envelope(owner: string, value = preview(owner)) {
  return { schemaVersion: 1, ownerUserId: owner, generation: id(900), records: [{ historyVersion: id(901), preview: value }] };
}
function storageFacade(): Storage {
  return { get length() { return localStorage.length; }, key: index => localStorage.key(index), getItem: name => localStorage.getItem(name), setItem: (name, value) => localStorage.setItem(name, value), removeItem: name => localStorage.removeItem(name), clear: () => localStorage.clear() };
}

describe('Bot display snapshot codec', () => {
  it.each(['markdown', 'reasoning', 'unknown_reasoning'] as const)('retains the complete resource closure for %s image bindings', kind => {
    const owner = crypto.randomUUID(), image = { ...resource(), revision: '1', width: 1, height: 1, frameCount: 1 };
    const text = '![saved](resource:saved)', textSha256 = createHash('sha256').update(text).digest('hex');
    const binding = { imageId: id(3_001), start: 0, end: text.length, part: { type: 'image' as const, imageId: id(3_001), resourceId: image.resourceId, label: 'saved' } };
    const unknown = kind === 'unknown_reasoning';
    const markdown = { partId: id(4_001), revision: '2', textSha256, complete: true, truncated: false, bindings: unknown ? null : [binding], retainedImages: unknown ? [{ ...binding, sourceRevision: '1', sourceTextSha256: textSha256, linkHref: null }] : [] };
    const common = { entryId: id(1_001), entrySeq: '1', revision: '2', imageProjectionError: unknown ? { code: 'source_unavailable', message: 'Projection unavailable.' } : null };
    const message = parseTimelineEntry(kind === 'markdown'
      ? { ...common, kind: 'assistant_message', content: [{ type: 'markdown', text, ...markdown }] }
      : { ...common, kind: 'reasoning', text, markdown });
    const value = preview(owner, 1, { entries: [message], resources: [image] });
    expect(prepareBotDisplayPreview(value, owner, value.botId)?.resources).toEqual([image]);
    expect(decodeBotDisplayPreview(JSON.stringify({ ...value, resources: [] }), owner, value.botId)).toBeNull();
  });

  it.each(['user_message', 'assistant_message', 'tool_call'] as const)('persists unified image descriptors from %s and rejects missing resource metadata', async kind => {
    const owner = crypto.randomUUID(), image = { ...resource(), revision: '1', width: 1, height: 1, frameCount: 1 };
    const content = [{ type: 'image' as const, imageId: id(3_001), resourceId: image.resourceId, label: 'saved image' }];
    const message: TimelineEntry = kind === 'tool_call'
      ? { kind, entryId: id(1_001), entrySeq: '1', revision: '1', imageProjectionError: null, callId: 'image-call', name: 'image', input: '', output: content, status: 'completed', truncated: false }
      : { ...entry(), kind, imageProjectionError: null, content };
    const value = preview(owner, 1, { entries: [message], resources: [image] });
    expect(prepareBotDisplayPreview(value, owner, value.botId)?.resources).toEqual([image]);
    expect(decodeBotDisplayPreview(JSON.stringify({ ...value, resources: [] }), owner, value.botId)).toBeNull();
    const target = store(owner);
    expect(await save(target, value)).toBe('saved');
    target.close();
    expect(await store(owner, { storage: storageFacade() }).read(owner, value.botId)).toEqual(value);
  });

  it('round-trips detached historical entries, descriptors and a reading anchor', () => {
    const owner = crypto.randomUUID(), image = resource();
    const message: TimelineEntry = { ...entry(), kind: 'assistant_message', content: [{ type: 'text', text: 'saved response' }, { type: 'resource', resourceId: image.resourceId, label: 'image' }] };
    const value = preview(owner, 1, { entries: [message], resources: [image], readingAnchor: { entryId: message.entryId, offset: 24.5, following: false } });
    const decoded = decodeBotDisplayPreview(JSON.stringify(value), owner, value.botId);
    expect(decoded).toEqual(value);
    expect(decoded).not.toBe(value);
    expect(decoded!.entries[0]).not.toBe(message);
    expect(decoded!.resources[0]).not.toBe(image);
  });

  it('trims unified image and retained Markdown references without dropping shared originals', () => {
    const owner = crypto.randomUUID(), old = { ...resource(1), revision: '1', width: 1, height: 1, frameCount: 1 }, shared = { ...resource(2), revision: '1', width: 1, height: 1, frameCount: 1 };
    const image = (n: number, resourceId: string) => ({ type: 'image' as const, imageId: id(3_000 + n), resourceId, label: `image ${n}` });
    const entries = Array.from({ length: 151 }, (_, index) => entry(index + 1));
    entries[0] = { ...entry(1), kind: 'assistant_message', imageProjectionError: null, content: [image(1, old.resourceId), image(2, shared.resourceId)] };
    const text = 'Revised body', markdown = { type: 'markdown' as const, text, partId: id(4_001), revision: '2', textSha256: createHash('sha256').update(text).digest('hex'), complete: true, truncated: false, bindings: [], retainedImages: [{ imageId: id(3_003), start: 0, end: 4, part: image(3, shared.resourceId), sourceRevision: '1', sourceTextSha256: 'a'.repeat(64), linkHref: null }] };
    entries[150] = { ...entry(151), kind: 'assistant_message', imageProjectionError: null, content: [markdown] };
    const value = preview(owner, 1, { entries, resources: [old, shared] });
    const trimmed = prepareBotDisplayPreview(value, owner, value.botId)!;
    expect(trimmed.entries).toEqual(entries.slice(1));
    expect(trimmed.resources).toEqual([shared]);
    expect(decodeBotDisplayPreview(JSON.stringify(trimmed), owner, value.botId)).toEqual(trimmed);
    expect(prepareBotDisplayPreview({ ...value, resources: [old] }, owner, value.botId)).toBeNull();
  });

  it.each(['bytes', 'data', 'blobUrl', 'url', 'credential'])('refuses private payload field %s inside unified image occurrences', field => {
    const owner = crypto.randomUUID(), descriptor = { ...resource(), revision: '1', width: 1, height: 1, frameCount: 1 };
    const part = { type: 'image', imageId: id(3_001), resourceId: descriptor.resourceId, label: 'saved', [field]: 'blob:private-content' };
    const value = preview(owner, 1, { resources: [descriptor] });
    const entries = [{ ...entry(), imageProjectionError: null, content: [part] }];
    expect(prepareBotDisplayPreview({ ...value, entries }, owner, value.botId)).toBeNull();
  });

  it.each([
    ['schema version', (p: BotDisplayPreview) => ({ ...p, schemaVersion: 2 })],
    ['owner identity', (p: BotDisplayPreview) => ({ ...p, ownerUserId: id(99) })],
    ['Bot identity', (p: BotDisplayPreview) => ({ ...p, botId: id(99) })],
    ['binding owner', (p: BotDisplayPreview) => ({ ...p, lastKnownBinding: { ...p.lastKnownBinding, ownerUserId: id(99) } })],
    ['binding Bot', (p: BotDisplayPreview) => ({ ...p, lastKnownBinding: { ...p.lastKnownBinding, botId: id(99) } })],
    ['session fence', (p: BotDisplayPreview) => ({ ...p, fence: { ...p.fence, sessionId: id(99) } })],
    ['execution fence', (p: BotDisplayPreview) => ({ ...p, fence: { ...p.fence, testExecutionId: id(99) } })],
    ['managed claim fence', (p: BotDisplayPreview) => ({ ...p, fence: { sessionId: p.lastKnownBinding.sessionId, claimId: id(99), executionGeneration: '1' } })],
    ['duplicate entries', (p: BotDisplayPreview) => ({ ...p, entries: [entry(), { ...entry(), entrySeq: '2' }] })],
    ['unordered entries', (p: BotDisplayPreview) => ({ ...p, entries: [entry(2), entry(1)] })],
    ['missing resource', (p: BotDisplayPreview) => ({ ...p, entries: [{ ...entry(), kind: 'user_message', content: [{ type: 'resource', resourceId: resource().resourceId, label: 'image' }] }] })],
    ['duplicate resources', (p: BotDisplayPreview) => ({ ...p, resources: [resource(), resource()] })],
    ['missing anchor entry', (p: BotDisplayPreview) => ({ ...p, readingAnchor: { entryId: id(99), offset: 0, following: false } })],
    ['negative anchor offset', (p: BotDisplayPreview) => ({ ...p, readingAnchor: { entryId: entry().entryId, offset: -1, following: false } })],
    ['unsafe save timestamp', (p: BotDisplayPreview) => ({ ...p, savedAt: Number.MAX_SAFE_INTEGER + 1 })],
    ['malformed Unicode', (p: BotDisplayPreview) => ({ ...p, historyEpoch: '\ud800' })],
  ])('rejects %s instead of accepting a partially decoded record', (_name, corrupt) => {
    const owner = crypto.randomUUID(), value = preview(owner);
    expect(decodeBotDisplayPreview(JSON.stringify(corrupt(value)), owner, value.botId)).toBeNull();
  });

  it.each(['{', 'null', '[]', '"snapshot"'])('treats malformed JSON or non-record %s as a miss', raw => {
    expect(decodeBotDisplayPreview(raw, crypto.randomUUID(), id(1))).toBeNull();
  });

  it.each(['01', '-1', '1.5', '1e3', '9223372036854775808', 9007199254740992])('rejects noncanonical or overflowing sequence %s', lastEventSeq => {
    const owner = crypto.randomUUID(), value = preview(owner);
    expect(decodeBotDisplayPreview(JSON.stringify({ ...value, lastEventSeq }), owner, value.botId)).toBeNull();
  });

  it('retains the newest 150 whole entries and only their descriptors and anchors', () => {
    const owner = crypto.randomUUID(), firstImage = resource(1), lastImage = resource(2);
    const entries = Array.from({ length: 151 }, (_, i) => entry(i + 1));
    entries[0] = { ...entry(1), kind: 'user_message', content: [{ type: 'resource', resourceId: firstImage.resourceId, label: 'old' }] };
    entries[150] = { ...entry(151), kind: 'assistant_message', content: [{ type: 'resource', resourceId: lastImage.resourceId, label: 'new' }] };
    const value = preview(owner, 1, { entries, resources: [firstImage, lastImage], readingAnchor: { entryId: entries[0]!.entryId, offset: 8, following: false } });
    expect(decodeBotDisplayPreview(JSON.stringify(value), owner, value.botId)).toBeNull();
    const trimmed = prepareBotDisplayPreview(value, owner, value.botId)!;
    expect(trimmed.entries).toEqual(entries.slice(1));
    expect(trimmed.resources).toEqual([lastImage]);
    expect(trimmed.readingAnchor).toBeUndefined();
    expect(prepareBotDisplayPreview({ ...value, readingAnchor: { entryId: entries[1]!.entryId, offset: 8, following: false } }, owner, value.botId)?.readingAnchor?.entryId).toBe(entries[1]!.entryId);
    expect(parseBotDisplayPreview(trimmed, owner, value.botId)).toEqual(trimmed);
  });

  it('validates discarded entries before applying the entry limit', () => {
    const owner = crypto.randomUUID(), value = preview(owner, 1, { entries: Array.from({ length: 151 }, (_, i) => entry(i + 1)) });
    const invalidOldEntry = { ...entry(), revision: '0' };
    expect(prepareBotDisplayPreview({ ...value, entries: [invalidOldEntry, ...value.entries.slice(1)] }, owner, value.botId)).toBeNull();
  });

  it('accepts exactly 750000 UTF-16 units and rejects one oversized whole entry', () => {
    const owner = crypto.randomUUID(), exact = sizedPreview(owner, 1, 750_000), over = sizedPreview(owner, 1, 750_001);
    expect(JSON.stringify(exact).length).toBe(750_000);
    expect(new TextEncoder().encode(JSON.stringify(exact)).length).toBeGreaterThan(750_000);
    expect(prepareBotDisplayPreview(exact, owner, exact.botId)).toEqual(exact);
    expect(decodeBotDisplayPreview(JSON.stringify(exact), owner, exact.botId)).toEqual(exact);
    expect(prepareBotDisplayPreview(over, owner, over.botId)).toBeNull();
    expect(decodeBotDisplayPreview(JSON.stringify(over), owner, over.botId)).toBeNull();
  });

  it('removes the oldest complete entry to satisfy the character budget', () => {
    const owner = crypto.randomUUID(), entries = [entry(1, 'a'.repeat(400_000)), entry(2, 'b'.repeat(400_000))];
    const value = preview(owner, 1, { entries });
    expect(prepareBotDisplayPreview(value, owner, value.botId)?.entries).toEqual([entries[1]]);
  });

  it.each(['operations', 'capabilities', 'currentTurnId', 'activeTurn', 'pendingInteractions', 'outbox', 'cursor', 'draft'])('rejects top-level runtime field %s', field => {
    const owner = crypto.randomUUID(), value = preview(owner);
    expect(prepareBotDisplayPreview({ ...value, [field]: {} }, owner, value.botId)).toBeNull();
  });

  it.each(['bytes', 'data', 'blobUrl', 'url', 'signedUrl', 'uploadDraft'])('rejects resource payload field %s', field => {
    const owner = crypto.randomUUID(), value = preview(owner, 1, { resources: [resource()] });
    expect(prepareBotDisplayPreview({ ...value, resources: [{ ...resource(), [field]: 'blob:private-content' }] }, owner, value.botId)).toBeNull();
  });

  it('keeps historical approval and running tool records without adding live state', () => {
    const owner = crypto.randomUUID();
    const tool: TimelineEntry = { entryId: id(1_001), entrySeq: '1', revision: '1', kind: 'tool_call', callId: 'call-1', name: 'shell', input: 'pwd', output: [], status: 'running', truncated: false };
    const approval: TimelineEntry = { entryId: id(1_002), entrySeq: '2', revision: '1', kind: 'interaction', interaction: { interactionId: id(500), revision: '1', state: 'pending', title: 'Run shell', kind: 'approval', detail: 'pwd', actions: ['allow_once', 'reject'] } };
    // Historical status remains readable; action eligibility belongs to the live client.
    const value = preview(owner, 1, { entries: [tool, approval] });
    expect(prepareBotDisplayPreview(value, owner, value.botId)?.entries).toEqual([tool, approval]);
  });
});

describe('Bot display snapshot storage', () => {
  it('uses the browser Storage adapter, isolates owners, and recovers from persisted bytes', async () => {
    const owner = crypto.randomUUID(), other = crypto.randomUUID(), target = store(owner), value = preview(owner);
    expect(await save(target, value)).toBe('saved');
    const raw = localStorage.getItem(key(owner))!;
    expect(JSON.parse(raw).records[0].preview).toEqual(value);
    expect(await target.read(other, value.botId)).toBeNull();
    target.close();
    // A distinct Storage facade creates a fresh module realm over the persisted bytes.
    const reopened = store(owner, { storage: storageFacade() });
    expect(await reopened.read(owner, value.botId)).toEqual(value);
    expect(await save(store(other), preview(other))).toBe('saved');
    expect(await reopened.clearAccount(owner)).toBe(true);
    expect(JSON.parse(localStorage.getItem(key(other))!).records).toHaveLength(1);
  });

  it('keeps six snapshots, updates LRU on read, and fences leases when evicting', async () => {
    const owner = crypto.randomUUID(), target = store(owner);
    for (let n = 1; n <= 6; n++) expect(await save(target, preview(owner, n))).toBe('saved');
    const oldLease = await target.observe(owner, id(2));
    expect(await target.read(owner, id(1))).not.toBeNull();
    expect(await save(target, preview(owner, 7, { savedAt: 1 }))).toBe('saved');
    expect(JSON.parse(localStorage.getItem(key(owner))!).records.map((row: { preview: BotDisplayPreview }) => row.preview.botId)).toEqual([3, 4, 5, 6, 1, 7].map(id));
    expect(await target.read(owner, id(2))).toBeNull();
    expect(await target.save(oldLease!, { source: 'verified-history', historyLoaded: true, preview: preview(owner, 2) })).toBe('stale');
  });

  it('includes envelope overhead in the exact 1500000-unit account budget', async () => {
    const owner = crypto.randomUUID(), target = store(owner);
    await save(target, preview(owner, 1)); await save(target, preview(owner, 2));
    const raw = localStorage.getItem(key(owner))!, data = JSON.parse(raw) as { records: { preview: BotDisplayPreview }[] };
    const overhead = raw.length - data.records.reduce((sum, row) => sum + JSON.stringify(row.preview).length, 0);
    const first = sizedPreview(owner, 1, 749_999), second = sizedPreview(owner, 2, 1_500_000 - overhead - 749_999);
    expect(await save(target, first)).toBe('saved'); expect(await save(target, second)).toBe('saved');
    expect(localStorage.getItem(key(owner))!.length).toBe(1_500_000);
    expect(await save(target, sizedPreview(owner, 2, JSON.stringify(second).length + 1))).toBe('saved');
    expect(await target.read(owner, id(1))).toBeNull();
    expect(await target.read(owner, id(2))).not.toBeNull();
    expect(localStorage.getItem(key(owner))!.length).toBeLessThan(1_500_000);
  });

  it('preserves readable history for oversized or incomplete input and permits authoritative emptiness', async () => {
    const owner = crypto.randomUUID(), target = store(owner), value = preview(owner);
    await save(target, value); const observed = (await target.observe(owner, value.botId))!;
    const before = localStorage.getItem(key(owner));
    for (const input of [
      { source: 'preview', historyLoaded: true, preview: value },
      { source: 'verified-history', historyLoaded: false, preview: value },
      { source: 'verified-history', historyLoaded: true, preview: value, cursor: 'cached' },
      { source: 'verified-history', historyLoaded: true, preview: sizedPreview(owner, 1, 750_001) },
    ]) expect(await target.save(observed, input as BotDisplaySnapshotSave)).toBe('invalid');
    expect(localStorage.getItem(key(owner))).toBe(before);
    expect(await target.read(owner, value.botId)).toEqual(value);
    const empty = { ...value, lastEventSeq: '2', entries: [], resources: [] };
    expect(await target.save(observed, { source: 'verified-history', historyLoaded: true, preview: empty })).toBe('saved');
    expect(await target.read(owner, value.botId)).toEqual(empty);
  });

  it('compares adjacent int64 sequences and revisions without Number rounding', async () => {
    const owner = crypto.randomUUID(), target = store(owner), value = preview(owner, 1, { lastEventSeq: '9007199254740993', entries: [{ ...entry(), revision: '9007199254740993', entrySeq: '9007199254740993' }] });
    await save(target, value); const observed = (await target.observe(owner, value.botId))!;
    const submit = (candidate: BotDisplayPreview) => target.save(observed, { source: 'verified-history', historyLoaded: true, preview: candidate });
    expect(await submit({ ...value, lastEventSeq: '9007199254740992', savedAt: 9_999 })).toBe('stale');
    expect(await submit({ ...value, lastEventSeq: '9007199254740994', entries: [{ ...value.entries[0]!, revision: '9007199254740992' }] })).toBe('stale');
    const newest = { ...value, lastEventSeq: '9223372036854775807', entries: [{ ...value.entries[0]!, revision: '9223372036854775807' }], savedAt: 1 };
    expect(await submit(newest)).toBe('saved');
    expect(await target.read(owner, value.botId)).toEqual(newest);
  });

  it.each([
    ['JSON', (owner: string) => '{'],
    ['version', (owner: string) => JSON.stringify({ ...envelope(owner), schemaVersion: 2 })],
    ['outer owner', (owner: string) => JSON.stringify(envelope(id(99)))],
    ['inner owner', (owner: string) => JSON.stringify(envelope(owner, preview(id(99))))],
    ['generation', (owner: string) => JSON.stringify({ ...envelope(owner), generation: 'invalid' })],
    ['history version', (owner: string) => JSON.stringify({ ...envelope(owner), records: [{ historyVersion: 'invalid', preview: preview(owner) }] })],
    ['duplicate Bot', (owner: string) => { const data = envelope(owner); return JSON.stringify({ ...data, records: [...data.records, ...data.records] }); }],
    ['seventh record', (owner: string) => JSON.stringify({ ...envelope(owner), records: Array.from({ length: 7 }, (_, n) => ({ historyVersion: id(901), preview: preview(owner, n + 1) })) })],
    ['oversized envelope', (_owner: string) => ' '.repeat(1_500_001)],
  ])('treats corrupt persisted %s as a miss and leaves its bytes untouched', async (_name, corrupt) => {
    const owner = crypto.randomUUID(), raw = corrupt(owner); localStorage.setItem(key(owner), raw);
    const target = store(owner);
    expect(await target.read(owner, id(1))).toBeNull();
    expect(await save(target, preview(owner))).toBe('memory');
    expect(await target.read(owner, id(1))).toEqual(preview(owner));
    expect(localStorage.getItem(key(owner))).toBe(raw);
  });

  it.each(['QuotaExceededError', 'SecurityError'])('degrades a %s write to memory and still permits a later tombstone', async errorName => {
    const owner = crypto.randomUUID(), target = store(owner), value = preview(owner);
    await save(target, value);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', errorName); });
    const changed = { ...value, lastEventSeq: '2' };
    expect(await save(target, changed)).toBe('memory');
    expect(await target.read(owner, value.botId)).toEqual(changed);
    const failedCalls = setItem.mock.calls.length;
    expect(await save(target, { ...changed, lastEventSeq: '3' })).toBe('memory');
    expect(setItem).toHaveBeenCalledTimes(failedCalls);
    setItem.mockRestore();
    expect(await target.clearAccount(owner)).toBe(true);
    expect(JSON.parse(localStorage.getItem(key(owner))!).records).toEqual([]);
  });

  it('treats denied reads as a miss and never republishes unverified sibling history on clear', async () => {
    const owner = crypto.randomUUID(), target = store(owner);
    await save(target, preview(owner, 1)); await save(target, preview(owner, 2));
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(await target.read(owner, id(1))).toBeNull();
    expect(await target.clearTarget(owner, id(1))).toBe(true);
    getItem.mockRestore();
    expect(JSON.parse(localStorage.getItem(key(owner))!).records).toEqual([]);
    expect(await target.read(owner, id(2))).toBeNull();
  });

  it('retains cumulative revocations after failed clears and a later successful clear', async () => {
    const owner = crypto.randomUUID(), target = store(owner);
    for (let bot = 1; bot <= 3; bot++) await save(target, preview(owner, bot));
    const before = localStorage.getItem(key(owner));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(await target.clearTarget(owner, id(1))).toBe(false);
    expect(await target.clearTarget(owner, id(2))).toBe(false);
    expect(localStorage.getItem(key(owner))).toBe(before);
    expect(await target.read(owner, id(1))).toBeNull(); expect(await target.read(owner, id(2))).toBeNull();
    setItem.mockRestore();
    expect(await target.clearTarget(owner, id(3))).toBe(true);
    expect(JSON.parse(localStorage.getItem(key(owner))!).records).toEqual([]);
  });

  it('retains an account-wide failed revocation when a later target clear succeeds', async () => {
    const owner = crypto.randomUUID(), target = store(owner);
    await save(target, preview(owner, 1)); await save(target, preview(owner, 2));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(await target.clearAccount(owner)).toBe(false);
    setItem.mockRestore();
    expect(await target.clearTarget(owner, id(1))).toBe(true);
    expect(await target.read(owner, id(2))).toBeNull();
    expect(JSON.parse(localStorage.getItem(key(owner))!).records).toEqual([]);
  });

  it('retries old disk cleanup without discarding newer memory history or its lease in the same storage realm', async () => {
    const owner = crypto.randomUUID(), old = store(owner, { storage: localStorage }), first = preview(owner);
    expect(await save(old, first)).toBe('saved');
    const oldRaw = localStorage.getItem(key(owner));
    const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(await old.clearAccount(owner)).toBe(false);
    denied.mockRestore();
    const fresh = store(owner, { storage: localStorage }), next = { ...first, lastEventSeq: '2', entries: [entry(2, 'new authorized history')] };
    const lease = (await fresh.observe(owner, next.botId))!;
    expect(await fresh.save(lease, { source: 'verified-history', historyLoaded: true, preview: next })).toBe('memory');
    expect(localStorage.getItem(key(owner))).toBe(oldRaw);
    expect(await old.retryClearAccount(owner, oldRaw)).toBe(true);
    expect(JSON.parse(localStorage.getItem(key(owner))!).records).toEqual([]);
    expect(await fresh.read(owner, next.botId)).toEqual(next);
    const latest = { ...next, lastEventSeq: '3' };
    expect(await fresh.save(lease, { source: 'verified-history', historyLoaded: true, preview: latest })).toBe('memory');
    expect(await fresh.read(owner, next.botId)).toEqual(latest);
    expect(JSON.parse(localStorage.getItem(key(owner))!).records).toEqual([]);
  });

  it('recovers read-only data without Web Locks and avoids unlocked persistent writes', async () => {
    const owner = crypto.randomUUID(), value = preview(owner), raw = JSON.stringify(envelope(owner, value));
    localStorage.setItem(key(owner), raw); vi.stubGlobal('navigator', { locks: undefined });
    const target = new BotDisplaySnapshotStore({ isCurrent: candidate => candidate === owner }); stores.push(target);
    expect(await target.read(owner, value.botId)).toEqual(value);
    expect(await save(target, { ...value, lastEventSeq: '2' })).toBe('memory');
    expect(localStorage.getItem(key(owner))).toBe(raw);
    expect(await target.clearAccount(owner)).toBe(false);
    expect(await target.read(owner, value.botId)).toBeNull();
  });

  it('survives a denied localStorage accessor using only memory', async () => {
    const owner = crypto.randomUUID();
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const target = store(owner);
    expect(await save(target, preview(owner))).toBe('memory');
    expect(await target.read(owner, id(1))).toEqual(preview(owner));
    expect(await target.clearAccount(owner)).toBe(false);
  });

  it('does not repeat an already-entered lock callback when its completion is unknown', async () => {
    const owner = crypto.randomUUID(); let rejectAfter = false;
    const withLock: BotDisplaySnapshotLock = async (_name, run) => { const result = await run(); if (rejectAfter) throw Error('lost lock completion'); return result; };
    const target = store(owner, { withLock }), observed = (await target.observe(owner, id(1)))!;
    const setItem = vi.spyOn(Storage.prototype, 'setItem'); rejectAfter = true;
    expect(await target.save(observed, { source: 'verified-history', historyLoaded: true, preview: preview(owner) })).toBe('unavailable');
    expect(setItem).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(key(owner))!).records[0].preview).toEqual(preview(owner));
  });

  it('degrades a lock rejected before entry without attempting persistent writes', async () => {
    const owner = crypto.randomUUID(), target = store(owner, { withLock: async () => { throw Error('locks denied'); } });
    expect(await save(target, preview(owner))).toBe('memory');
    expect(await target.read(owner, id(1))).toEqual(preview(owner));
    expect(localStorage.getItem(key(owner))).toBeNull();
  });
});

describe('Bot display snapshot invalidation and observations', () => {
  it('rejects foreign or forged observations and an account that loses confirmation', async () => {
    const owner = crypto.randomUUID(); let current = true;
    const target = store(owner, { isCurrent: candidate => current && candidate === owner }), second = store(owner);
    const observed = (await target.observe(owner, id(1)))!, input = { source: 'verified-history' as const, historyLoaded: true as const, preview: preview(owner) };
    expect(await second.save(observed, input)).toBe('unavailable');
    expect(await target.save({ ...observed }, input)).toBe('unavailable');
    current = false;
    expect(await target.save(observed, input)).toBe('unavailable');
    expect(await target.read(owner, id(1))).toBeNull(); expect(await target.observe(owner, id(1))).toBeNull();
  });

  it('revokes one queued observation without changing peer data or other observation authority', async () => {
    const owner = crypto.randomUUID(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    let blocked = false;
    const target = store(owner, { storage: storageFacade(), withLock: async (_name, run) => {
      if (blocked) { entered.resolve(); await gate.promise; }
      return run();
    } });
    const value = preview(owner), sibling = preview(owner, 2);
    expect(await save(target, value)).toBe('saved'); expect(await save(target, sibling)).toBe('saved');
    const revoked = (await target.observe(owner, value.botId))!, retained = (await target.observe(owner, value.botId))!, siblingLease = (await target.observe(owner, sibling.botId))!;
    const before = localStorage.getItem(key(owner)), token = target.revocationToken(owner);
    blocked = true;
    const queued = target.save(revoked, { source: 'verified-history', historyLoaded: true, preview: { ...value, lastEventSeq: '2' } });
    await entered.promise;
    target.revokeObservation(revoked); target.revokeObservation(revoked);
    expect(target.revocationToken(owner)).toBe(token);
    gate.resolve();
    expect(await queued).toBe('stale');
    expect(localStorage.getItem(key(owner))).toBe(before);
    expect(await target.save(retained, { source: 'verified-history', historyLoaded: true, preview: { ...value, lastEventSeq: '2' } })).toBe('saved');
    expect(await target.save(siblingLease, { source: 'verified-history', historyLoaded: true, preview: { ...sibling, lastEventSeq: '2' } })).toBe('saved');
    expect((await target.read(owner, value.botId))?.lastEventSeq).toBe('2');
    expect((await target.read(owner, sibling.botId))?.lastEventSeq).toBe('2');
  });
  it('prevents a queued write from restoring synchronously revoked history', async () => {
    const owner = crypto.randomUUID(), target = store(owner), value = preview(owner);
    await save(target, value); const observed = (await target.observe(owner, value.botId))!;
    const queued = target.save(observed, { source: 'verified-history', historyLoaded: true, preview: { ...value, lastEventSeq: '2' } });
    const clearing = target.clearTarget(owner, value.botId);
    expect(await queued).toBe('stale'); expect(await clearing).toBe(true);
    expect(await target.read(owner, value.botId)).toBeNull();
  });

  it('keeps overlapping clears cumulative while preserving an unaffected target', async () => {
    const owner = crypto.randomUUID(), target = store(owner);
    for (let bot = 1; bot <= 3; bot++) await save(target, preview(owner, bot));
    expect(await Promise.all([target.clearTarget(owner, id(1)), target.clearTarget(owner, id(2))])).toEqual([true, true]);
    expect(await target.read(owner, id(1))).toBeNull(); expect(await target.read(owner, id(2))).toBeNull();
    expect(await target.read(owner, id(3))).toEqual(preview(owner, 3));
  });

  it('fences stale writers across independent storage realms and target deletion', async () => {
    const owner = crypto.randomUUID(), withLock = lock(), first = store(owner, { storage: storageFacade(), withLock }), second = store(owner, { storage: storageFacade(), withLock });
    await save(first, preview(owner)); const stale = (await first.observe(owner, id(1)))!;
    expect(await second.clearTarget(owner, id(1))).toBe(true);
    expect(await first.save(stale, { source: 'verified-history', historyLoaded: true, preview: preview(owner, 1, { lastEventSeq: '99' }) })).toBe('stale');
    expect(await first.read(owner, id(1))).toBeNull();
  });

  it('does not renew an observation queued before a peer replaces the target history', async () => {
    const owner = crypto.randomUUID(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    let blocked = false;
    const first = store(owner, { storage: storageFacade(), withLock: async (_name, run) => {
      if (blocked) { entered.resolve(); await gate.promise; }
      return run();
    } });
    const second = store(owner, { storage: storageFacade() }), original = preview(owner);
    expect(await save(first, original)).toBe('saved');
    blocked = true;
    const queued = first.observe(owner, original.botId);
    await entered.promise;
    const replacement = { ...original, historyEpoch: 'history-2', lastEventSeq: '0', entries: [] };
    expect(await save(second, replacement)).toBe('saved');
    gate.resolve();
    expect(await queued).toBeNull();
    expect(await first.read(owner, original.botId)).toEqual(replacement);
    expect(await save(first, replacement)).toBe('saved');
  });

  it('rejects stale history and absence leases after identity and eviction ABA cycles', async () => {
    const owner = crypto.randomUUID(), target = store(owner), original = preview(owner);
    await save(target, original); const old = (await target.observe(owner, id(1)))!;
    await save(target, { ...original, historyEpoch: 'history-2', lastEventSeq: '0', entries: [] });
    await save(target, original);
    expect(await target.save(old, { source: 'verified-history', historyLoaded: true, preview: { ...original, lastEventSeq: '99' } })).toBe('stale');
    const absent = (await target.observe(owner, id(9)))!;
    await save(target, preview(owner, 9));
    for (let bot = 2; bot <= 7; bot++) await save(target, preview(owner, bot));
    expect(await target.read(owner, id(9))).toBeNull();
    expect(await target.save(absent, { source: 'verified-history', historyLoaded: true, preview: preview(owner, 9) })).toBe('stale');
  });

  it.each<[string, (value: BotDisplayPreview) => BotDisplayPreview]>([
    ['history epoch', value => ({ ...value, historyEpoch: 'history-2' })],
    ['execution generation', value => ({ ...value, fence: { ...value.fence, executionGeneration: '2' } })],
    ['session binding', value => ({ ...value, lastKnownBinding: { ...value.lastKnownBinding, sessionId: id(500) }, fence: { ...value.fence, sessionId: id(500) } })],
    ['execution binding', value => ({ ...value, lastKnownBinding: { ...value.lastKnownBinding, testExecutionId: id(501) }, fence: { sessionId: value.fence.sessionId, testExecutionId: id(501), executionGeneration: value.fence.executionGeneration } })],
  ])('requires a new observation when the %s changes', async (_name, changeIdentity) => {
    const owner = crypto.randomUUID(), target = store(owner), value = preview(owner), observed = (await target.observe(owner, id(1)))!;
    const submit = (candidate: BotDisplayPreview) => target.save(observed, { source: 'verified-history', historyLoaded: true, preview: candidate });
    expect(await submit(value)).toBe('saved');
    const candidate = changeIdentity(value);
    expect(await submit(candidate)).toBe('stale');
    expect(await target.read(owner, value.botId)).toEqual(value);
    expect(await save(target, candidate)).toBe('saved');
    expect(await target.read(owner, value.botId)).toEqual(candidate);
  });

  it('rereads current disk after an obsolete storage event and never restores its old payload', async () => {
    const owner = crypto.randomUUID(), target = store(owner), value = preview(owner);
    await save(target, value); const oldRaw = localStorage.getItem(key(owner));
    await save(target, { ...value, lastEventSeq: '2' });
    const changes = vi.fn(); target.subscribe(changes); const version = target.getVersion();
    window.dispatchEvent(new StorageEvent('storage', { key: key(owner), newValue: oldRaw, storageArea: localStorage }));
    expect(changes).toHaveBeenCalled(); expect(target.getVersion()).toBeGreaterThan(version);
    expect((await target.read(owner, value.botId))?.lastEventSeq).toBe('2');
  });

  it('does not restore revoked disk history when the first reconciliation cannot acquire its lock', async () => {
    const owner = crypto.randomUUID();
    let denied = false;
    const target = store(owner, { storage: localStorage, withLock: async (_name, run) => {
      if (denied) throw new DOMException('locks denied', 'SecurityError');
      return run();
    } });
    const peer = store(owner, { storage: storageFacade() }), value = preview(owner);
    expect(await save(target, value)).toBe('saved');
    const oldLease = (await target.observe(owner, value.botId))!;
    expect(await peer.clearTarget(owner, value.botId)).toBe(true);
    window.dispatchEvent(new StorageEvent('storage', { key: key(owner), storageArea: localStorage, newValue: localStorage.getItem(key(owner)) }));
    denied = true;
    expect(await target.read(owner, value.botId)).toBeNull();
    expect(await target.save(oldLease, { source: 'verified-history', historyLoaded: true, preview: value })).toBe('stale');
    expect(JSON.parse(localStorage.getItem(key(owner))!).records).toEqual([]);
  });

  it('does not issue a newer lease when an unreconciled storage notification is superseded by another clear', async () => {
    const owner = crypto.randomUUID(), target = store(owner, { storage: localStorage }), peer = store(owner, { storage: storageFacade() });
    await save(target, preview(owner, 1)); await save(target, preview(owner, 2));
    expect(await peer.clearTarget(owner, id(1))).toBe(true);
    window.dispatchEvent(new StorageEvent('storage', { key: key(owner), storageArea: localStorage, newValue: localStorage.getItem(key(owner)) }));
    expect(await peer.clearTarget(owner, id(2))).toBe(true);
    expect(await target.observe(owner, id(2))).toBeNull();
    expect(await target.read(owner, id(2))).toBeNull();
  });

  it('can observe new accepted sibling history before the first passive reconciliation', async () => {
    const owner = crypto.randomUUID(), target = store(owner, { storage: localStorage }), peer = store(owner, { storage: storageFacade() });
    const sibling = preview(owner, 2);
    await save(target, preview(owner, 1)); await save(target, sibling);
    expect(await peer.clearTarget(owner, id(1))).toBe(true);
    window.dispatchEvent(new StorageEvent('storage', { key: key(owner), storageArea: localStorage, newValue: localStorage.getItem(key(owner)) }));
    const lease = await target.observe(owner, id(2));
    expect(lease).not.toBeNull();
    expect(await target.save(lease!, { source: 'verified-history', historyLoaded: true, preview: { ...sibling, lastEventSeq: '2' } })).toBe('saved');
  });

  it.each([false, true])('fences leases on %s whole-storage removal events even after same-generation rewrite', async wholeStorage => {
    const owner = crypto.randomUUID(), target = store(owner), value = preview(owner);
    await save(target, value); const observed = (await target.observe(owner, id(1)))!;
    const raw = localStorage.getItem(key(owner))!;
    localStorage.removeItem(key(owner)); localStorage.setItem(key(owner), raw);
    window.dispatchEvent(new StorageEvent('storage', { key: wholeStorage ? null : key(owner), newValue: null, storageArea: localStorage }));
    expect(await target.save(observed, { source: 'verified-history', historyLoaded: true, preview: { ...value, lastEventSeq: '2' } })).toBe('stale');
  });

  it('ignores unrelated storage events and releases notifications and queued work on close', async () => {
    const owner = crypto.randomUUID(), target = store(owner), value = preview(owner);
    await save(target, value); const changes = vi.fn(), unsubscribe = target.subscribe(changes);
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: 'x', storageArea: localStorage }));
    window.dispatchEvent(new StorageEvent('storage', { key: key(owner), newValue: null, storageArea: sessionStorage }));
    expect(changes).not.toHaveBeenCalled();
    unsubscribe(); await save(target, { ...value, lastEventSeq: '2' }); expect(changes).not.toHaveBeenCalled();
    const observed = (await target.observe(owner, id(1)))!;
    const queued = target.save(observed, { source: 'verified-history', historyLoaded: true, preview: { ...value, lastEventSeq: '3' } });
    target.close(); target.close();
    expect(await queued).toBe('unavailable'); expect(await target.read(owner, id(1))).toBeNull();
    expect(await store(owner, { storage: storageFacade() }).read(owner, id(1))).toEqual({ ...value, lastEventSeq: '2' });
  });

  it('detaches queued input and returned previews from caller mutations', async () => {
    const owner = crypto.randomUUID(), target = store(owner), value = preview(owner), observed = (await target.observe(owner, id(1)))!;
    const queued = target.save(observed, { source: 'verified-history', historyLoaded: true, preview: value });
    (value.entries as TimelineEntry[]).splice(0);
    expect(await queued).toBe('saved');
    const read = (await target.read(owner, id(1)))!; (read.entries as TimelineEntry[]).splice(0);
    expect((await target.read(owner, id(1)))?.entries).toEqual([entry()]);
  });
});
