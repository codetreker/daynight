import { ApiError } from '../../api/client';
import { listAssistantTasks, type AssistantTask, type AssistantTaskPage } from '../../api/assistant-tasks';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
export const assistantTaskAdmission = (scope: TaskCacheScope) => ({ userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
export async function collectAssistantPages<T>(read: (cursor?: string) => Promise<AssistantTaskPage<T>>, key: (entry: T) => string): Promise<T[]> {
  const values = new Map<string,T>(), cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    for (const entry of page.items) { if (values.has(key(entry))) throw new ApiError('protocol'); values.set(key(entry),entry); }
    cursor = page.nextCursor ?? undefined;
    if (cursor) { if (cursors.has(cursor)) throw new ApiError('protocol'); cursors.add(cursor); }
  } while (cursor);
  return [...values.values()];
}
export const loadAssistantTasks = (scope: TaskCacheScope, signal: AbortSignal) => collectAssistantPages(cursor => listAssistantTasks({limit:200,...(cursor ? {cursor} : {})},signal,assistantTaskAdmission(scope)), entry => entry.id);
export const assistantTaskState = (task: AssistantTask) => task.state === 'paused' ? 'paused' : task.claimState === 'pending' ? 'binding' : task.claimState;
export const assistantTaskUrl = (id: string, tab?: 'manual'|'records'|'proposals', recordId?: string) => `/bots/tasks/${id}${tab ? `?tab=${tab}${recordId ? `&recordId=${encodeURIComponent(recordId)}` : ''}` : ''}`;

export const assistantTaskEventItem = (payload: unknown): string | null => payload !== null && typeof payload === 'object' && !Array.isArray(payload) && 'itemId' in payload && typeof payload.itemId === 'string' ? payload.itemId : null;
