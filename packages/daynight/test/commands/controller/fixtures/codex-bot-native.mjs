import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => out({ id, result });
const notify = (method, params) => out({ method, params });
const threadId = 'c7975cdc-936b-411e-9f63-cd0a37ad7cbf';
let rollout, historyMode = 'paginated', settings = { model: 'fixture-model', reasoningEffort: 'medium', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
let activeTurn, activeUser;
const append = (type, payload) => appendFileSync(rollout, `${JSON.stringify({ type, payload })}\n`);
const records = () => readFileSync(rollout, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const thread = () => ({ id: threadId, cwd: process.cwd(), path: rollout, historyMode, turns: [] });
const answer = turnId => ({ type: 'agentMessage', id: `answer-${turnId}`, text: 'Preserved native assistant reply' });
const history = () => records().filter(entry => ['task_complete', 'turn_aborted'].includes(entry.payload.type)).map(entry => ({
  id: entry.payload.turn_id, status: entry.payload.type === 'turn_aborted' ? 'interrupted' : 'completed',
  items: entry.payload.type === 'turn_aborted' ? [] : [answer(entry.payload.turn_id)],
}));
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line), { id, method, params } = message;
  appendFileSync(process.env.CODEX_BOT_REQUEST_LOG, `${JSON.stringify({ ...message, observedHome: process.env.CODEX_HOME, observedConfig: process.env.CODEX_BOT_CONFIG_SENTINEL })}\n`);
  if (method === 'initialized') continue;
  if (method === 'initialize') { reply(id, { userAgent: `daynight/${process.env.CODEX_BOT_VERSION ?? '0.169.0'} (test)` }); continue; }
  if (method === 'thread/start' || method === 'thread/resume') {
    historyMode = process.env.CODEX_BOT_HISTORY_MODE ?? (method === 'thread/start' ? params.historyMode ?? 'paginated' : 'legacy');
    rollout = params.path ?? join(process.env.CODEX_HOME, 'sessions', `${threadId}.jsonl`);
    if (method === 'thread/start') {
      mkdirSync(join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
    } else {
      for (const entry of records()) if (entry.payload.type === 'thread_settings_applied') settings = entry.payload.thread_settings;
    }
    if (method === 'thread/resume' && process.env.CODEX_BOT_WRONG_PATH) {
      const outside = join(process.env.CODEX_HOME, 'wrong-rollout.jsonl');
      writeFileSync(outside, readFileSync(rollout)); rollout = outside;
    }
    reply(id, { ...settings, thread: { ...thread(), ...(process.env.CODEX_BOT_WRONG_ID ? { id: randomUUID() } : {}) } }); continue;
  }
  if (method === 'thread/name/set') {
    if (!existsSync(rollout)) writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: process.cwd(), cli_version: process.env.CODEX_BOT_VERSION ?? '0.169.0' } })}\n`);
    reply(id, {}); notify('thread/name/updated', { threadId, threadName: params.name }); continue;
  }
  if (method === 'thread/read') {
    let turns = params.includeTurns ? history() : [];
    if (process.env.CODEX_BOT_HISTORY_RESULT === 'empty') turns = [];
    if (process.env.CODEX_BOT_HISTORY_RESULT === 'wrong-watermark') turns = turns.map(turn => ({ ...turn, id: randomUUID() }));
    if (process.env.CODEX_BOT_HISTORY_RESULT === 'active') turns = turns.map(turn => ({ ...turn, status: 'inProgress' }));
    if (process.env.CODEX_BOT_HISTORY_RESULT === 'duplicate') turns = [...turns, ...turns];
    reply(id, { thread: { ...thread(), turns } }); continue;
  }
  if (historyMode === 'legacy' && ['thread/turns/list', 'thread/items/list'].includes(method)) {
    out({ id, error: { code: -32601, message: 'Paginated history is unavailable for legacy threads' } }); continue;
  }
  if (method === 'thread/turns/list') {
    reply(id, { data: records().filter(entry => ['task_complete', 'turn_aborted'].includes(entry.payload.type)).map(entry => ({ id: entry.payload.turn_id, status: entry.payload.type === 'turn_aborted' ? 'interrupted' : 'completed' })), nextCursor: null }); continue;
  }
  if (method === 'thread/items/list') { reply(id, { data: [], nextCursor: null }); continue; }
  if (method === 'config/read') { reply(id, { config: {} }); continue; }
  if (method === 'configRequirements/read') { reply(id, { requirements: null }); continue; }
  if (method === 'model/list') { reply(id, { data: ['fixture-model', 'other-model'].map(model => ({ id: model, model, displayName: model, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] })), nextCursor: null }); continue; }
  if (method === 'skills/list') { reply(id, { data: [] }); continue; }
  if (method === 'thread/settings/update') {
    settings = { ...settings, ...Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'threadId')) };
    append('event_msg', { type: 'thread_settings_applied', thread_id: threadId, thread_settings: settings });
    reply(id, {}); notify('thread/settings/updated', { threadId, threadSettings: settings }); continue;
  }
  if (method === 'turn/start' || method === 'thread/compact/start') {
    const turn = { id: randomUUID(), status: 'inProgress' };
    append('event_msg', { type: 'task_started', turn_id: turn.id });
    notify('turn/started', { threadId, turn });
    if (method === 'turn/start') {
      activeUser = { id: randomUUID(), type: 'userMessage', clientId: params.clientUserMessageId, content: params.input };
      notify('item/completed', { threadId, turnId: turn.id, item: activeUser });
    }
    reply(id, method === 'turn/start' ? { turn } : {});
    if (method === 'turn/start' && process.env.CODEX_BOT_TURN_MODE === 'hold-turn') { activeTurn = turn; continue; }
    if (method === 'thread/compact/start') append('compacted', { message: 'Fixture summary', replacement_history: [] });
    append('event_msg', { type: 'task_complete', turn_id: turn.id });
    notify('item/completed', { threadId, turnId: turn.id, item: answer(turn.id) });
    notify('turn/completed', { threadId, turn: { ...turn, status: 'completed', items: [] } }); continue;
  }
  if (method === 'turn/interrupt' && activeTurn?.id === params.turnId) {
    append('event_msg', { type: 'turn_aborted', turn_id: activeTurn.id, reason: 'interrupted' });
    reply(id, {});
    notify('turn/completed', { threadId, turn: { ...activeTurn, status: 'interrupted', itemsView: 'full', items: [activeUser] } });
    activeTurn = undefined; activeUser = undefined; continue;
  }
  out({ id, error: { code: -32601, message: `Unconfigured fixture method: ${method}` } });
}
