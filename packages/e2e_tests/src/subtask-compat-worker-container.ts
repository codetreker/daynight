import { randomUUID } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startCommand } from './command.ts';
import { startGatedCommand, stopGate } from './gated-command.ts';

// The full Node image includes Git; its digest fixes both tools for this fixture.
export const workerImage = 'node:24-bookworm@sha256:4140e303c3dcf97edde1e42837bcb8db8c5d349d20582990d9b3ee99ee71481e';
type Receipt = { schemaVersion: 1; runId: string; workerId: string; name: string; image: string; phase: 'creating' | 'never-created' | 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'removing' | 'removed'; id: string | null; stopGateId?: string; state?: { exitCode: number; startedAt: string; finishedAt: string; oomKilled: boolean } };
type Container = { Id: string; Config: { Labels: Record<string, string>; Image: string }; HostConfig: { PidMode: string }; State: { Running: boolean; Status: string; ExitCode: number; StartedAt: string; FinishedAt: string; OOMKilled: boolean } };
const receiptPath = (run: string) => path.join(run, 'results', 'compat-worker-container.json');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const save = async (run: string, value: Receipt): Promise<void> => {
  const file = receiptPath(run), temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
};
const load = async (run: string): Promise<Receipt | undefined> => {
  let value: Receipt;
  try { value = JSON.parse(await readFile(receiptPath(run), 'utf8')) as Receipt; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
  const id = path.basename(run);
  if (!uuid.test(id) || value.schemaVersion !== 1 || value.runId !== id || !uuid.test(value.workerId) || value.name !== `daynight-compat-worker-${id}` || value.image !== workerImage || !['creating', 'never-created', 'created', 'starting', 'running', 'stopping', 'stopped', 'removing', 'removed'].includes(value.phase) || !(value.id === null || /^[a-f0-9]{64}$/.test(value.id)) || (value.phase === 'never-created' && value.id !== null) || (value.phase === 'stopping' && (typeof value.stopGateId !== 'string' || !uuid.test(value.stopGateId))) || (['stopped', 'removing', 'removed'].includes(value.phase) && !value.state)) throw new Error('Compatibility Worker container ownership is invalid.');
  return value;
};
const dockerResult = async (run: string, args: string[], timeoutMs = 30_000) => await startCommand('docker', args, { cwd: run, timeoutMs, onOutput: () => {} }).finished;
const docker = async (run: string, args: string[], timeoutMs = 30_000) => {
  const result = await dockerResult(run, args, timeoutMs);
  if (result.exitCode !== 0) throw new Error(`Docker ${args[0]} failed (exit=${result.exitCode}): ${result.stderr}`);
  return result;
};
const prepareImage = async (run: string): Promise<void> => {
  const found = await dockerResult(run, ['image', 'inspect', workerImage]);
  if (found.exitCode === 0) return;
  if (found.exitCode !== 1 || !/No such image/i.test(found.stderr)) throw new Error('Compatibility Worker image observation failed.');
  await docker(run, ['pull', workerImage], 300_000);
  await docker(run, ['image', 'inspect', workerImage]);
};
const redact = async (run: string, value: string): Promise<string> => {
  const checkout = path.dirname(path.dirname(path.dirname(run)));
  const config = path.join(checkout, '.tmp', 'product-e2e-retained', path.basename(run), 'worker-config', 'config.yml');
  const parsed = JSON.parse(await readFile(config, 'utf8')) as { serverToken?: unknown };
  if (typeof parsed.serverToken !== 'string' || parsed.serverToken.length === 0) throw new Error('Compatibility Worker credential is unavailable for diagnostic redaction.');
  return value.replaceAll(parsed.serverToken, '[REDACTED]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
};
const containerLogs = async (run: string, id: string) => {
  const command = startCommand('docker', ['logs', '--tail', '2000', id], { cwd: run, timeoutMs: 30_000, onOutput: () => {} });
  const result = await command.finished, truncated = command.diagnostics().truncated;
  if (result.exitCode !== 0) throw new Error(`Docker logs failed (exit=${result.exitCode}).`);
  return {
    stdout: truncated.stdout ? '[truncated output omitted]' : await redact(run, result.stdout),
    stderr: truncated.stderr ? '[truncated output omitted]' : await redact(run, result.stderr),
    truncated,
  };
};
const inspect = async (run: string, receipt: Receipt): Promise<Container> => {
  if (!receipt.id) throw new Error('Original compatibility Worker container ID is unavailable.');
  const result = await docker(run, ['container', 'inspect', receipt.id]);
  const objects = JSON.parse(result.stdout) as Container[];
  const item = objects[0];
  if (objects.length !== 1 || !item || item.Id !== receipt.id || item.Config.Labels?.['daynight.e2e.run'] !== receipt.runId || item.Config.Labels?.['daynight.e2e.worker'] !== receipt.workerId || item.Config.Image !== workerImage || item.HostConfig.PidMode !== '') throw new Error('Compatibility Worker container identity or PID isolation conflicts.');
  return item;
};
const signalContainer = async (run: string, receipt: Receipt, signal: 'INT' | 'KILL'): Promise<void> => {
  const gateId = randomUUID();
  receipt.phase = 'stopping'; receipt.stopGateId = gateId; await save(run, receipt);
  const command = await startGatedCommand({ runDirectory: run, gateId, command: 'docker', args: ['kill', '--signal', signal, receipt.id!], options: { cwd: run, timeoutMs: 30_000, onOutput: () => {} } });
  const result = await command.finished;
  if (result.exitCode !== 0) throw new Error(`Docker Worker signal ${signal} failed (exit=${result.exitCode}): ${result.stderr}`);
};

export async function startCompatWorkerContainer(input: { runDirectory: string; checkout: string; root: string; entry: string; config: string; workerId: string; log: string; ca: string; resolver: string }): Promise<{ finished: Promise<{ exitCode: number; stdout: string; stderr: string }>; diagnostics(): { exit: { code: number | null; signal: null } | null; stdout: string; stderr: string } }> {
  const run = input.runDirectory, runId = path.basename(run);
  if (!uuid.test(runId) || !uuid.test(input.workerId) || await load(run) !== undefined || !input.root.startsWith(`${input.checkout}/.tmp/`) || !input.entry.startsWith(`${input.checkout}/.tmp/`)) throw new Error('Compatibility Worker container requires a fresh original fixture.');
  await prepareImage(run);
  const receipt: Receipt = { schemaVersion: 1, runId, workerId: input.workerId, name: `daynight-compat-worker-${runId}`, image: workerImage, phase: 'creating', id: null };
  await save(run, receipt);
  const environment = [`DN_CONFIG_DIR=${input.config}`, `CODEX_HOME=${path.join(input.root, 'native')}`, `HOME=${input.root}`, `DAYNIGHT_WORKER_PEER_LOG=${input.log}`, `NODE_EXTRA_CA_CERTS=${input.ca}`, `NODE_OPTIONS=--require=${input.resolver}`];
  const create = await dockerResult(run, ['create', '--pull', 'never', '--name', receipt.name, '--label', `daynight.e2e.run=${runId}`, '--label', `daynight.e2e.worker=${input.workerId}`, '--network', 'host', '--user', `${process.getuid!()}:${process.getgid!()}`, '--mount', `type=bind,src=${input.checkout},dst=${input.checkout},readonly`, '--mount', `type=bind,src=${input.root},dst=${input.root}`, '--mount', `type=bind,src=${run},dst=${run},readonly`, '--workdir', input.root, ...environment.flatMap(value => ['--env', value]), '--entrypoint', '/usr/local/bin/node', workerImage, input.entry, 'worker', 'run'], 120_000);
  if (create.exitCode !== 0) {
    // This daemon refusal is issued before container creation. Other errors,
    // including transport failures, retain the unresolved creation intent.
    if (/Error response from daemon: invalid mount config for type ["']bind["']:/i.test(create.stderr)) {
      const observed = await dockerResult(run, ['container', 'inspect', receipt.name]);
      if (observed.exitCode === 1 && /No such (?:container|object)/i.test(observed.stderr)) { receipt.phase = 'never-created'; await save(run, receipt); }
    }
    throw new Error(`Docker Worker creation failed (exit=${create.exitCode}): ${create.stderr}`);
  }
  const id = create.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Compatibility Worker container creation returned no exact ID.');
  receipt.id = id; receipt.phase = 'created'; await save(run, receipt);
  await inspect(run, receipt);
  receipt.phase = 'starting'; await save(run, receipt);
  await docker(run, ['start', id]);
  const started = await inspect(run, receipt);
  if (!started.State.Running && started.State.Status !== 'exited') throw new Error('Compatibility Worker container start is unconfirmed.');
  receipt.phase = 'running'; await save(run, receipt);
  let snapshot: { exit: { code: number | null; signal: null } | null; stdout: string; stderr: string } = { exit: null, stdout: '', stderr: '' };
  const finished = (async () => {
    for (;;) {
      const object = await inspect(run, receipt);
      if (!object.State.Running) {
        if (object.State.Status !== 'exited') throw new Error('Compatibility Worker container exit is unconfirmed.');
        const logs = await containerLogs(run, id);
        snapshot = { exit: { code: object.State.ExitCode, signal: null }, stdout: logs.stdout, stderr: logs.stderr };
        return { exitCode: object.State.ExitCode, stdout: snapshot.stdout, stderr: snapshot.stderr };
      }
      await delay(500);
    }
  })();
  void finished.catch(() => {});
  return { finished, diagnostics: () => snapshot };
}

// Never infer a stopped process boundary from a missing container or a pending
// Docker request. A receipt survives interruption and fences subsequent cleanup.
export async function stopCompatWorkerContainer(run: string, remove = false, workerId?: string): Promise<{ exitCode: number; stdout: string; stderr: string } | undefined> {
  const receipt = await load(run);
  if (!receipt) return undefined;
  if (workerId === undefined || workerId !== receipt.workerId) throw new Error('Compatibility Worker container does not match the original fixture Worker.');
  if (receipt.phase === 'never-created') return undefined;
  if (receipt.phase === 'creating') {
    const observed = await dockerResult(run, ['container', 'inspect', receipt.name]);
    if (observed.exitCode !== 0) throw new Error('Compatibility Worker container creation outcome is unconfirmed.');
    const objects = JSON.parse(observed.stdout) as Container[];
    if (objects.length !== 1 || !/^[a-f0-9]{64}$/.test(objects[0]?.Id ?? '')) throw new Error('Compatibility Worker creation identity is unconfirmed.');
    receipt.id = objects[0]!.Id; await inspect(run, receipt); receipt.phase = 'created'; await save(run, receipt);
  }
  if (receipt.phase === 'removed') return { exitCode: receipt.state!.exitCode, stdout: '', stderr: '' };
  if (receipt.phase === 'removing') {
    const observed = await dockerResult(run, ['container', 'inspect', receipt.id!]);
    if (observed.exitCode === 1 && /No such (?:container|object)/i.test(observed.stderr)) { receipt.phase = 'removed'; await save(run, receipt); return { exitCode: receipt.state!.exitCode, stdout: '', stderr: '' }; }
    throw new Error('Compatibility Worker container removal outcome is unconfirmed.');
  }
  let object = await inspect(run, receipt);
  if (receipt.phase === 'starting') {
    if (object.State.Status !== 'running' && object.State.Status !== 'exited') throw new Error('Compatibility Worker container start outcome is unconfirmed.');
    receipt.phase = 'running'; await save(run, receipt);
  }
  if (receipt.phase === 'stopping') {
    // Join the exact earlier Docker client before compensating a stuck boundary.
    // A missing gate proof retains the original resource and remains unknown.
    await stopGate(run, receipt.stopGateId!, Date.now() + 15_000);
    object = await inspect(run, receipt);
    if (object.State.Running) await signalContainer(run, receipt, 'KILL');
    object = await inspect(run, receipt);
  }
  if (object.State.Running) {
    await signalContainer(run, receipt, 'INT');
    const deadline = Date.now() + 15_000;
    while ((object = await inspect(run, receipt)).State.Running && Date.now() < deadline) await delay(200);
    if (object.State.Running) { await signalContainer(run, receipt, 'KILL'); }
  }
  const deadline = Date.now() + 15_000;
  while ((object = await inspect(run, receipt)).State.Running && Date.now() < deadline) await delay(200);
  if (object.State.Running || !['exited', 'created'].includes(object.State.Status)) throw new Error('Compatibility Worker container stop is unconfirmed.');
  const logs = await containerLogs(run, receipt.id!);
  const state = object.State;
  receipt.state = { exitCode: state.ExitCode, startedAt: state.StartedAt, finishedAt: state.FinishedAt, oomKilled: state.OOMKilled };
  receipt.phase = 'stopped'; await save(run, receipt);
  // Retain the immutable stop receipt and logs after removing the isolated boundary.
  const record = path.join(run, 'logs', 'compat-worker-container.json');
  const handle = await open(record, 'w', 0o600);
  try { await handle.writeFile(`${JSON.stringify({ id: receipt.id, workerId: receipt.workerId, image: receipt.image, state: receipt.state, ...logs }, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  if (remove) {
    receipt.phase = 'removing'; await save(run, receipt);
    const removal = await dockerResult(run, ['rm', receipt.id!]);
    if (removal.exitCode !== 0) {
      // Only a definite daemon permission refusal permits a later independent
      // removal attempt, after confirming the original container is still stopped.
      if (/Error response from daemon:.*permission denied/i.test(removal.stderr)) {
        const remaining = await inspect(run, receipt);
        if (!remaining.State.Running && ['exited', 'created'].includes(remaining.State.Status)) { receipt.phase = 'stopped'; await save(run, receipt); }
      }
      throw new Error(`Docker Worker removal failed (exit=${removal.exitCode}): ${removal.stderr}`);
    }
    const observed = await dockerResult(run, ['container', 'inspect', receipt.id!]);
    if (observed.exitCode !== 1 || !/No such (?:container|object)/i.test(observed.stderr)) throw new Error('Compatibility Worker container removal is not confirmed.');
    receipt.phase = 'removed'; await save(run, receipt);
  }
  return { exitCode: state.ExitCode, stdout: logs.stdout, stderr: logs.stderr };
}
