import { canonicalId } from '../../api/parse';
import type { CreateBotInput } from '../../api/bots';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';

const cleared = new Set<string>();
export function clearPendingBotCreation(userId: string): void {
  cleared.add(userId);
  try { window.sessionStorage.removeItem(`daynight.bot.creation:${userId}`); } catch { /* Do not read an inaccessible old identity again in this document. */ }
}
const retained = new WeakMap<TaskCacheScope, CreateBotInput | null>();
const key = (scope: TaskCacheScope) => `daynight.bot.creation:${scope.userId}`;
function write(scope: TaskCacheScope, request: CreateBotInput | null) {
  // Retain only the observation identity on disk, never a replayable POST body.
  try { if (request === null) window.sessionStorage.removeItem(key(scope)); else window.sessionStorage.setItem(key(scope), request.id); } catch { /* The same document retains the identity even without storage. */ }
}
export function pendingBotCreation(scope: TaskCacheScope): CreateBotInput | null {
  if (scope.isInvalidated) return null;
  if (!retained.has(scope)) {
    let request: CreateBotInput | null = null;
    try { const id = cleared.has(scope.userId) ? null : canonicalId(window.sessionStorage.getItem(key(scope)) ?? ''); if (id !== null) request = { id, name: '' }; } catch { /* No persisted identity is available. */ }
    retained.set(scope, request);
    scope.signal.addEventListener('abort', () => { retained.delete(scope); clearPendingBotCreation(scope.userId); }, { once: true });
  }
  return retained.get(scope) ?? null;
}
export function rememberBotCreation(scope: TaskCacheScope, request: CreateBotInput | null): void {
  if (scope.isInvalidated) return;
  pendingBotCreation(scope);
  retained.set(scope, request);
  if (request === null) clearPendingBotCreation(scope.userId); else { cleared.delete(scope.userId); write(scope, request); }
}
