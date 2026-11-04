import { describe, expect, it } from 'vitest';
import { BotSessionStorage, clearBotSessionStorage } from '../src/features/bots/session-storage';

const denied = (): Storage => ({
  get length(): number { throw new Error('denied'); },
  key: () => { throw new Error('denied'); }, getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); }, clear: () => { throw new Error('denied'); },
});
describe('Bot lightweight state storage', () => {
  it('retains drafts and original unknown operations when every storage operation throws', () => {
    const storage = new BotSessionStorage('A', denied());
    storage.setItem('draft', '{"text":"unsent"}'); storage.setItem('operation', '{"operationId":"original"}');
    expect(storage.getItem('draft')).toBe('{"text":"unsent"}');
    expect(storage.getItem('operation')).toBe('{"operationId":"original"}');
    expect(storage.length).toBe(2); expect(storage.key(0)).toBe('draft');
    storage.removeItem('draft'); expect(storage.getItem('draft')).toBeNull();
    storage.clear(); expect(storage.length).toBe(0);
  });
  it('isolates identities, survives cold reads, and removes only its own namespace', () => {
    sessionStorage.clear();
    const a = new BotSessionStorage('A', sessionStorage), b = new BotSessionStorage('B', sessionStorage);
    a.setItem('draft', 'a'); b.setItem('draft', 'b');
    expect(new BotSessionStorage('A', sessionStorage).getItem('draft')).toBe('a');
    expect(a.key(0)).toBe('draft'); expect(a.length).toBe(1); expect(a.key(1)).toBeNull();
    a.clear(); expect(a.getItem('draft')).toBeNull(); expect(b.getItem('draft')).toBe('b');
    expect(sessionStorage.length).toBe(1);
  });
  it('does not resurrect stale disk state after removal fails or after invalidation', () => {
    sessionStorage.clear();
    const storage = new BotSessionStorage('A', sessionStorage);
    storage.setItem('draft', 'old');
    const failing: Storage = { get length() { return sessionStorage.length; }, key: i => sessionStorage.key(i), getItem: key => sessionStorage.getItem(key), setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('denied'); }, clear: () => { throw new Error('denied'); } };
    const fallback = new BotSessionStorage('A', failing);
    fallback.removeItem('draft'); expect(fallback.getItem('draft')).toBeNull(); expect(fallback.length).toBe(0);
    fallback.setItem('draft', 'new'); expect(fallback.getItem('draft')).toBe('new');
    fallback.invalidate(); expect(fallback.getItem('draft')).toBeNull();
    fallback.setItem('draft', 'late'); expect(fallback.length).toBe(0);
  });
});


it('clears cold account state and permits newly saved authorized drafts after login', () => {
  sessionStorage.clear();
  const identity = JSON.stringify(['cold-owner', 'bot', 'session', 'execution']);
  new BotSessionStorage(identity, sessionStorage).setItem('draft', 'before logout');
  clearBotSessionStorage('cold-owner');
  expect(sessionStorage.length).toBe(0);
  expect(new BotSessionStorage(identity, sessionStorage).getItem('draft')).toBeNull();
  new BotSessionStorage(identity, sessionStorage).setItem('draft', 'after login');
  expect(new BotSessionStorage(identity, sessionStorage).getItem('draft')).toBe('after login');
});

it.each(['enumeration', 'removal'] as const)('keeps namespace invalidation across new storage instances when %s fails', failure => {
  sessionStorage.clear();
  const identity = JSON.stringify([`revoked-${failure}`, 'bot', 'session', 'execution']);
  const original = new BotSessionStorage(identity, sessionStorage);
  original.setItem('draft', 'revoked draft'); original.setItem('operation', 'original operation');
  const failing: Storage = {
    get length() { if (failure === 'enumeration') throw Error('denied'); return sessionStorage.length; },
    key: i => sessionStorage.key(i), getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: () => { throw Error('denied'); }, clear: () => { throw Error('denied'); },
  };
  new BotSessionStorage(identity, failing).invalidate();
  const authorized = new BotSessionStorage(identity, sessionStorage);
  expect(authorized.getItem('draft')).toBeNull(); expect(authorized.getItem('operation')).toBeNull();
  expect(authorized.length).toBe(0);
  original.setItem('draft', 'late old writer');
  expect(new BotSessionStorage(identity, sessionStorage).getItem('draft')).toBeNull();
  authorized.setItem('draft', 'fresh authorized draft');
  const reopened = new BotSessionStorage(identity, sessionStorage);
  expect(reopened.getItem('draft')).toBe('fresh authorized draft'); expect(reopened.getItem('operation')).toBeNull();
});
