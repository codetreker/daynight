import { createInterface } from 'node:readline';

// Controlled app-server notifications exercise the real child-process adapter.
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const threadId = 'native-thread', turnId = 'native-turn';
const turn = { id: turnId, rootTurnId: null, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1793836800, completedAt: null, durationMs: null };
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') out({ id: m.id, result: {} });
  if (m.method === 'thread/start') out({ id: m.id, result: { thread: { id: threadId, cwd: process.cwd() } } });
  if (m.method === 'thread/read') out({ id: m.id, result: { thread: { id: threadId, turns: [] } } });
  if (m.method === 'model/list') out({ id: m.id, result: { data: [], nextCursor: null } });
  if (m.method === 'configRequirements/read') out({ id: m.id, result: { requirements: null } });
  if (m.method === 'skills/list') out({ id: m.id, result: { data: [] } });
  if (m.method === 'turn/start') {
    out({ method: 'turn/started', params: { threadId, turn } });
    const notifications = JSON.parse(m.params.input[0].text);
    for (const notification of notifications) {
      if (notification.params?.error?.additionalDetails === '__LONG_DETAILS__') notification.params.error.additionalDetails = '详情😀\\\"\n'.repeat(60_000);
      out(notification);
    }
    out({ id: m.id, result: { turn } });
  }
  if (m.method === 'turn/steer') {
    const completion = JSON.parse(m.params.input[0].text);
    out({ method: 'turn/completed', params: { threadId, turn: { ...turn, completedAt: 1793836801, durationMs: 1000, ...completion } } });
    out({ id: m.id, result: { turnId } });
  }
}
