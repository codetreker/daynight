import { codexSubagentActivity } from '../../../../daynight/src/session/codex-subagent-activity';
import type { TimelineEntry } from '../../api/types';

export function legacySubagentActivity(entry: Extract<TimelineEntry, { kind: 'error' }>) {
  const prefix = 'Unsupported native timeline item: subAgentActivity. ';
  if (entry.code !== 'unsupported_native_item' || !entry.message.startsWith(prefix)) return null;
  // Persisted errors do not retain the item lifecycle. Show the operation
  // without inferring either its completion or the child session's state.
  try { return codexSubagentActivity(JSON.parse(entry.message.slice(prefix.length))); }
  catch { return null; }
}
