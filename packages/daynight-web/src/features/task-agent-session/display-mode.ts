import type { TimelineEntry } from '../../api/types';
import { legacySubagentActivity } from './legacy-subagent-activity';

export type SessionDisplayMode = 'standard' | 'conversation';
export const DEFAULT_SESSION_DISPLAY_MODE: SessionDisplayMode = 'conversation';

const planTools = new Set([
  'update_plan', 'TodoWrite', 'todo_write', 'EnterPlanMode', 'ExitPlanMode',
  'enter_plan_mode', 'exit_plan_mode', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
]);

function isConversationEntry(entry: TimelineEntry): boolean {
  switch (entry.kind) {
    case 'user_message': case 'assistant_message': case 'todo': case 'interaction': return true;
    case 'error': return legacySubagentActivity(entry) === null;
    case 'tool_call': return planTools.has(entry.name.slice(entry.name.lastIndexOf('.') + 1));
    case 'reasoning': case 'compaction': return false;
  }
}

/** Selects existing entry references in order without changing entries or reading resources. */
export function selectSessionDisplayEntries(entries: readonly TimelineEntry[], mode: SessionDisplayMode): readonly TimelineEntry[] {
  return entries.filter(entry => mode === 'standard'
    ? entry.kind !== 'reasoning' || entry.text.trim().length > 0
    : isConversationEntry(entry));
}
