import { randomUUID } from 'node:crypto';
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import { aggregateFailures } from '../src/failures.ts';
import { markFixtureStopped, prepareFixtureOwnership, registerFixtureClaim, registerFixtureIdentity, startOwnedFixture } from '../src/fixture-owner.ts';
import { prepareWorkerFixtureConfiguration } from '../src/worker-config.ts';
import { stopAndRecordFixtureWorker } from '../src/worker-cleanup.ts';
import type { ManagedCommand } from '../src/command.ts';
import { cliEnvironment, expect, runOwnedCommand } from './fixtures.ts';
import { observeWorkerCandidates } from './subtask-compat-worker-observer.ts';

type Task = { id: string; assignedTo: string | null; version: number; status: string; properties: { worker?: { claimId: string; workerId: string; state: string; nativeSessionId?: string } } };
type Invoke = (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
const shellLiteral = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// Invoke once per isolated runner, with the candidate CLI used for fixture
// mutations and either real Worker entry. The existing owner tracks one claim.
export async function verifyGoalWorker(input: { entry: string; variant: 'candidate' | 'npm-0.72.0'; token: string; server: string; command: Invoke }): Promise<void> {
  const checkout = path.resolve(import.meta.dirname, '../../..');
  const runDirectory = process.env.DAYNIGHT_E2E_RUN_DIRECTORY;
  if (!runDirectory) throw new Error('Worker requires the original run identity.');
  const root = await prepareFixtureOwnership(checkout, runDirectory);
  const repository = path.join(root, 'repository'), bare = path.join(root, 'remote.git');
  const peer = path.join(root, 'codex.mjs'), log = path.join(root, 'peer.jsonl'), launcher = path.join(root, 'daynight');
  const git = async (cwd: string, args: string[]) => runOwnedCommand('git', args, { cwd, env: cliEnvironment, timeoutMs: 30_000 });
  const workerId = randomUUID();
  let worker: ManagedCommand | undefined, observer: Awaited<ReturnType<typeof observeWorkerCandidates>> | undefined, exited = false, failure: unknown;
  try {
    await git(root, ['init', '--bare', bare]);
    await git(root, ['init', '-b', 'main', repository]);
    await git(repository, ['config', 'user.name', 'Compatibility E2E']);
    await git(repository, ['config', 'user.email', 'compatibility@example.test']);
    await writeFile(path.join(repository, 'README.md'), 'isolated compatibility fixture\n');
    await git(repository, ['add', 'README.md']);
    await git(repository, ['commit', '-m', 'Initialize fixture']);
    const remote = `https://example.test/compat-worker/${randomUUID()}.git`;
    await git(repository, ['remote', 'add', 'origin', remote]);
    await git(repository, ['config', `url.file://${bare}.insteadOf`, remote]);
    await git(repository, ['push', 'origin', 'HEAD:main']);
    await git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    await copyFile(path.join(import.meta.dirname, 'native-worker-peer.mjs'), peer);
    await chmod(peer, 0o700);
    await writeFile(launcher, `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(input.entry)} "$@"\n`, { mode: 0o700 });
    const invoke = async (args: string[]) => {
      const result = await input.command(args);
      if (result.exitCode !== 0) throw new Error(`Candidate CLI ${args[0]} ${args[1]} failed: ${result.stderr}`);
      return result;
    };
    const idFrom = (stdout: string): string => {
      const id = stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
      if (!id) throw new Error('Fixture creation returned no ID.');
      return id;
    };
    const projectId = idFrom((await invoke(['project', 'create', `Goal Worker ${input.variant} ${randomUUID()}`, '--repo', remote, '--team', 'personal', '--confirm'])).stdout);
    const create = async (args: string[]) => idFrom((await invoke(['task', 'create', '--project', projectId, ...args])).stdout);
    const read = async (id: string): Promise<Task & { ready: boolean; allowAgents: boolean; parentId: string | null; parentTaskId: string | null }> => JSON.parse((await invoke(['task', 'show', id, '--project', projectId, '--json'])).stdout);
    const goal = await create(['--type', 'goal', '--title', 'Worker ancestor Goal']);
    const ancestors = [await create(['--title', 'Worker root', '--parent', goal, '--status', 'todo'])];
    for (let depth = 1; depth < 5; depth++) ancestors.push(await create(['--title', `Worker ancestor ${depth}`, '--parent-task', ancestors.at(-1)!, '--status', 'todo']));
    const leaf = await create(['--title', 'Worker open descendant', '--parent-task', ancestors.at(-1)!, '--status', 'todo']);
    const blocked = await create(['--title', 'Worker terminal descendant', '--parent-task', ancestors.at(-1)!, '--status', 'todo']);
    for (const id of [leaf, blocked]) {
      const task = await read(id);
      if (!task.assignedTo) throw new Error('Worker Task has no assignee.');
      await invoke(['task', 'update', id, '--project', projectId, '--allow-agents', 'true', '--if-version', String(task.version)]);
    }
    const open = await read(leaf), peerTask = await read(blocked);
    expect({ status: open.status, assignedTo: open.assignedTo, ready: open.ready, allowAgents: open.allowAgents, parentTaskId: open.parentTaskId }).toEqual({ status: peerTask.status, assignedTo: peerTask.assignedTo, ready: peerTask.ready, allowAgents: peerTask.allowAgents, parentTaskId: peerTask.parentTaskId });
    expect(open).toMatchObject({ status: 'todo', ready: true, allowAgents: true, parentTaskId: ancestors.at(-1) });
    const query = new URLSearchParams({ ready: 'true', allowAgents: 'true', automaticCandidate: 'true', compatiblePlatform: 'linux', assignedTo: 'me', limit: '100' });
    const response = await fetch(`${input.server}/api/v1/projects/${projectId}/tasks?${query}`, { headers: { Authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200) throw new Error(`Open candidate query failed: ${response.status}`);
    const candidates = await response.json() as { items: { id: string }[]; nextCursor: string | null };
    expect(candidates.nextCursor).toBeNull();
    expect(candidates.items.map(item => item.id)).toEqual(expect.arrayContaining([leaf, blocked]));
    await invoke(['task', 'update', blocked, '--project', projectId, '--allow-agents', 'false', '--if-version', String(peerTask.version)]);
    const before = await Promise.all([goal, ...ancestors].map(read));
    expect(before[0]).toMatchObject({ status: 'todo' });
    for (const [index, task] of before.slice(1).entries()) expect(task).toMatchObject({ status: 'todo', ...(index === 0 ? { parentId: goal } : { parentTaskId: ancestors[index - 1] }) });
    observer = await observeWorkerCandidates({ server: input.server, certificate: await readFile(path.join(runDirectory, 'artifacts', 'daynight-ca.pem')), key: await readFile(path.join(runDirectory, 'artifacts', 'daynight-key.pem')), projectId, blockedTaskId: blocked, workerId });
    const config = await prepareWorkerFixtureConfiguration(root, { serverUrl: observer.origin, serverToken: input.token, workerId, repositoryRoot: path.join(root, 'repositories'), peer, projectId, remote, repository, cli: launcher });
    const configFile = path.join(config, 'config.yml');
    const settings = JSON.parse(await readFile(configFile, 'utf8')) as { worker: { maxConcurrent: number } };
    settings.worker.maxConcurrent = 2;
    await writeFile(configFile, JSON.stringify(settings));
    await registerFixtureIdentity(checkout, runDirectory, { projectId, taskId: leaf, workerId, userId: open.assignedTo!, serverOrigin: observer.origin, repository });
    worker = await startOwnedFixture({ repository: checkout, runDirectory, command: process.execPath, args: [input.entry, 'worker', 'run'], options: {
      cwd: root, env: { ...cliEnvironment, DN_CONFIG_DIR: config, CODEX_HOME: path.join(root, 'native'), DAYNIGHT_WORKER_PEER_LOG: log }, timeoutMs: 600_000, onOutput: () => {},
    } });
    void worker.finished.then(() => { exited = true; }, () => { exited = true; });
    const alive = () => { if (exited) throw new Error(`${input.variant} Worker exited early: ${inspect(worker!.diagnostics(), { depth: 6 })}`); };
    await expect.poll(async () => { alive(); return (await read(leaf)).properties.worker?.claimId; }, { timeout: 90_000, intervals: [1_000] }).toEqual(expect.any(String));
    const claim = (await read(leaf)).properties.worker;
    if (!claim || claim.workerId !== workerId || claim.state !== 'active') throw new Error('Worker did not own the original claim.');
    await registerFixtureClaim(checkout, runDirectory, claim.claimId);
    await expect.poll(async () => {
      alive();
      try { return (await readFile(log, 'utf8')).includes('turn/start'); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
    }, { timeout: 90_000, intervals: [1_000] }).toBe(true);
    for (const [index, id] of [goal, ...ancestors].entries()) expect(await read(id)).toMatchObject({ status: before[index]!.status, version: before[index]!.version });
    for (const status of ['done', 'cancelled']) {
      await invoke(['task', 'set-status', goal, status, '--project', projectId, '--force']);
      if (status === 'done') {
        const current = await read(blocked);
        await invoke(['task', 'update', blocked, '--project', projectId, '--allow-agents', 'true', '--if-version', String(current.version)]);
      }
      const generation = observer.arm();
      await expect.poll(() => { alive(); return observer!.seen(generation); }, { timeout: 90_000, intervals: [250] }).toBe(true);
      expect(await read(goal)).toMatchObject({ status });
      expect(await read(blocked)).toMatchObject({ status: 'todo', ready: true, allowAgents: true, assignedTo: open.assignedTo });
      expect((await read(blocked)).properties.worker).toBeUndefined();
      expect(await read(leaf)).toMatchObject({ status: 'in_progress', properties: { worker: { workerId, claimId: claim.claimId, state: 'active' } } });
      console.log(`Goal Worker variant=${input.variant} terminal=${status} candidateRequest=${observer.requestId(generation)} blocked=${blocked} retainedClaim=${claim.claimId}`);
    }
    const current = await read(leaf);
    await invoke(['task', 'set-status', leaf, 'done', '--project', projectId, '--claim-id', claim.claimId, '--if-version', String(current.version)]);
    expect(await read(leaf)).toMatchObject({ status: 'done', properties: { worker: { workerId, claimId: claim.claimId, state: 'completed' } } });
    console.log(`Goal Worker variant=${input.variant} project=${projectId} goal=${goal} task=${leaf} blocked=${blocked} worker=${workerId} claim=${claim.claimId}`);
  } catch (error) { failure = error; }
  finally {
    const failures: unknown[] = [];
    if (failure !== undefined) failures.push(failure);
    if (worker) {
      try { await stopAndRecordFixtureWorker({ worker, exited, runDirectory, workerId, launchNumber: 1 }); await markFixtureStopped(checkout, runDirectory); }
      catch (error) { failures.push(error); }
    }
    if (observer) try { await observer.close(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw aggregateFailures('Goal Worker execution or shutdown failed.', failures);
  }
}

// The published Worker and Controller run normally; only the upstream Codex
// protocol peer is controlled, as in the existing product patrol fixture.
export async function verifyOldWorker(input: { entry: string; token: string; server: string; command: Invoke }): Promise<void> {
  const checkout = path.resolve(import.meta.dirname, '../../..');
  const runDirectory = process.env.DAYNIGHT_E2E_RUN_DIRECTORY;
  if (!runDirectory) throw new Error('Worker requires the original run identity.');
  const root = await prepareFixtureOwnership(checkout, runDirectory);
  const repository = path.join(root, 'repository'), bare = path.join(root, 'remote.git');
  const peer = path.join(root, 'codex.mjs'), log = path.join(root, 'peer.jsonl'), launcher = path.join(root, 'daynight');
  const git = async (cwd: string, args: string[]) => runOwnedCommand('git', args, { cwd, env: cliEnvironment, timeoutMs: 30_000 });
  const workerId = randomUUID();
  let worker: ManagedCommand | undefined, exited = false, failure: unknown;
  try {
    await git(root, ['init', '--bare', bare]);
    await git(root, ['init', '-b', 'main', repository]);
    await git(repository, ['config', 'user.name', 'Compatibility E2E']);
    await git(repository, ['config', 'user.email', 'compatibility@example.test']);
    await writeFile(path.join(repository, 'README.md'), 'isolated compatibility fixture\n');
    await git(repository, ['add', 'README.md']);
    await git(repository, ['commit', '-m', 'Initialize fixture']);
    const remote = `https://example.test/compat-worker/${randomUUID()}.git`;
    await git(repository, ['remote', 'add', 'origin', remote]);
    await git(repository, ['config', `url.file://${bare}.insteadOf`, remote]);
    await git(repository, ['push', 'origin', 'HEAD:main']);
    await git(root, ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    await copyFile(path.join(import.meta.dirname, 'native-worker-peer.mjs'), peer);
    await chmod(peer, 0o700);
    await writeFile(launcher, `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(input.entry)} "$@"\n`, { mode: 0o700 });
    const project = await input.command(['project', 'create', `Old Worker ${randomUUID()}`, '--repo', remote, '--team', 'personal', '--confirm']);
    const projectId = project.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
    if (!projectId) throw new Error('Worker Project creation returned no ID.');
    const creation = await input.command(['task', 'create', '--project', projectId, '--title', 'Published Worker compatibility', '--status', 'todo']);
    const taskId = creation.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
    if (!taskId) throw new Error('Worker Task creation returned no ID.');
    const read = async (): Promise<Task> => JSON.parse((await input.command(['task', 'show', taskId, '--project', projectId, '--json'])).stdout) as Task;
    const task = await read();
    if (!task.assignedTo) throw new Error('Worker Task has no assignee.');
    await input.command(['task', 'update', taskId, '--project', projectId, '--allow-agents', 'true', '--if-version', String(task.version)]);
    const config = await prepareWorkerFixtureConfiguration(root, { serverUrl: input.server, serverToken: input.token, workerId, repositoryRoot: path.join(root, 'repositories'), peer, projectId, remote, repository, cli: launcher });
    await registerFixtureIdentity(checkout, runDirectory, { projectId, taskId, workerId, userId: task.assignedTo, serverOrigin: input.server, repository });
    worker = await startOwnedFixture({ repository: checkout, runDirectory, command: process.execPath, args: [input.entry, 'worker', 'run'], options: {
      cwd: root, env: { ...cliEnvironment, DN_CONFIG_DIR: config, CODEX_HOME: path.join(root, 'native'), DAYNIGHT_WORKER_PEER_LOG: log }, timeoutMs: 300_000, onOutput: () => {},
    } });
    void worker.finished.then(() => { exited = true; }, () => { exited = true; });
    await expect.poll(async () => {
      if (exited) throw new Error(`Published Worker exited early: ${inspect(worker!.diagnostics(), { depth: 6 })}`);
      return (await read()).properties.worker?.claimId;
    }, { timeout: 90_000, intervals: [1_000] }).toEqual(expect.any(String));
    const claimed = await read(), claim = claimed.properties.worker;
    if (!claim || claim.workerId !== workerId || claim.state !== 'active') throw new Error('Published Worker did not own the original claim.');
    await registerFixtureClaim(checkout, runDirectory, claim.claimId);
    await expect.poll(async () => {
      try { return (await readFile(log, 'utf8')).includes('turn/start'); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
    }, { timeout: 90_000, intervals: [1_000] }).toBe(true);
    const before = await read();
    await input.command(['task', 'set-status', taskId, 'done', '--project', projectId, '--claim-id', claim.claimId, '--if-version', String(before.version)]);
    expect(await read()).toMatchObject({ id: taskId, status: 'done', properties: { worker: { workerId, claimId: claim.claimId, state: 'completed' } } });
    console.log(`published Worker project=${projectId} task=${taskId} worker=${workerId} claim=${claim.claimId}`);
  } catch (error) { failure = error; }
  finally {
    const failures: unknown[] = [];
    if (failure !== undefined) failures.push(failure);
    if (worker) {
      try { await stopAndRecordFixtureWorker({ worker, exited, runDirectory, workerId, launchNumber: 1 }); await markFixtureStopped(checkout, runDirectory); }
      catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw aggregateFailures('Published Worker execution or shutdown failed.', failures);
  }
}
