import { expect, it, vi } from 'vitest';
import { createSessionDisplayPreferenceStore } from '../src/features/task-agent-session/display-preference';
it('forgets a revoked preference despite storage failure without disabling future authorized choices', () => {
  const storage = { getItem: vi.fn(() => '"standard"'), setItem: vi.fn(), removeItem: vi.fn(() => { throw Error('denied'); }) };
  const store = createSessionDisplayPreferenceStore(() => storage), binding = { userId: 'owner', sessionId: 'session' };
  const old = store.get(binding); expect(old.getSnapshot().mode).toBe('standard');
  const changed = vi.fn(); old.subscribe(changed); store.remove(binding);
  expect(changed).toHaveBeenCalledOnce(); expect(old.getSnapshot().mode).toBe('conversation');
  old.setMode('standard'); old.retrySave(); expect(storage.setItem).not.toHaveBeenCalled();
  const fresh = store.get(binding); expect(fresh.getSnapshot().mode).toBe('conversation');
  fresh.setMode('standard'); expect(fresh.getSnapshot().mode).toBe('standard'); expect(storage.setItem).toHaveBeenCalledOnce();
});
