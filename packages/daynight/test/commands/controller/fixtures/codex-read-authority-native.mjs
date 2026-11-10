import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const cwd = process.cwd(), threadId = 'authority-thread';
let settings = { cwd, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: null, model: 'model', effort: 'medium' };
if (process.env.CODEX_AUTHORITY_CASE === 'restricted') settings.sandboxPolicy = { type: 'readOnly' };
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line), { id, method, params } = message;
  if (process.env.CODEX_AUTHORITY_LOG) appendFileSync(process.env.CODEX_AUTHORITY_LOG, line + '\n');
  if (method === 'initialize') out({ id, result: { userAgent: process.env.CODEX_AUTHORITY_CASE === 'version' ? 'daynight/0.168.0 (Linux)' : 'daynight/0.167.0 (Linux)' } });
  if (method === 'remoteControl/status/read') {
    if (process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED !== '1') throw new Error('Remote control must be disabled before spawn');
    out({ id, result: { status: process.env.CODEX_AUTHORITY_CASE === 'remote' ? 'connected' : 'disabled', environmentId: null } });
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    out({ id, result: { ...settings, sandbox: settings.sandboxPolicy, runtimeWorkspaceRoots: [cwd],
      thread: { id: threadId, sessionId: threadId, cwd, environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }] } } });
    if (process.env.CODEX_AUTHORITY_CASE === 'startup-restrict') out({ method: 'thread/settings/updated', params: { threadId, threadSettings: { ...settings, sandboxPolicy: { type: 'readOnly' } } } });
  }
  if (method === 'model/list') out({ id, result: { data: [{ model: 'model' }, { model: 'other-model' }], nextCursor: null } });
  if (method === 'configRequirements/read') out({ id, result: { requirements: null } });
  if (method === 'skills/list') out({ id, result: { data: [] } });
  if (method === 'thread/read') out({ id, result: { thread: { id: threadId, turns: [] } } });
  if (method === 'thread/turns/list') out({ id, result: { data: [{ id: 'history-turn', status: 'completed' }], nextCursor: null } });
  if (method === 'thread/items/list') out({ id, result: { data: [{ turnId: 'history-turn', item: { id: 'image-body', type: 'agentMessage', text: '![image](local.png)' } }], nextCursor: null } });
  if (method === 'hooks/list') out({ id, result: { data: [{ cwd, hooks: [], warnings: [], errors: [] }] } });
  if (method === 'thread/settings/update') {
    settings = { ...settings, ...params };
    out({ id, result: {} });
    out({ method: 'thread/settings/updated', params: { threadId, threadSettings: settings } });
  }
  if (method === 'turn/start') {
    const text = params.input[0].text;
    if (text === 'invalid-frame') { out({ id, result: { turn: { id: 'turn', status: 'completed' } } }); process.stdout.write('invalid JSON\n'); }
    else {
      if (text === 'restrict') out({ method: 'thread/settings/updated', params: { threadId, threadSettings: { ...settings, sandboxPolicy: { type: 'readOnly' } } } });
      if (text === 'remote') out({ method: 'remoteControl/status/changed', params: { status: 'connected' } });
      out({ id, result: { turn: { id: 'turn', status: 'completed' } } });
    }
  }
}
