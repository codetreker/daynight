import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertCommandQuiescence, CommandFailure, markCommandOutcomeUnconfirmed, startCommand, type CommandResult } from './command.ts';
import { runCleanupSteps } from './lifecycle.ts';
import { recoverRunOwnership } from './fixture-owner.ts';

export type ResourceIdentity = {
  network: string;
  ingressNetwork: string;
  postgresContainer: string;
  redisContainer: string;
  applicationContainer: string;
  ownershipContainer: string;
  postgresVolume: string;
  runtimeImage: string;
};
export type RecoveryMetadata = { schemaVersion: 1; runId: string; directoryId: string; ownerUid: number; ownerGid: number };
export type CleanupVerification = {
  verified: boolean;
  resourcesAbsent: boolean;
  remaining: string[];
  verificationErrors: string[];
  cleanupErrors: string[];
};
export type CleanupReceipt = CleanupVerification & RecoveryMetadata & {
  resourceIdentity: ResourceIdentity;
  state: 'pending' | 'complete' | 'failed';
  recovery?: CleanupVerification & { completed: boolean; finishedAt: string };
};
export type DockerCommand = (args: readonly string[], timeoutMs: number) => Promise<CommandResult>;
type ResourceKind = 'container' | 'network' | 'volume' | 'image';
type DockerObject = { Config?: { Labels?: Record<string, string> }; Labels?: Record<string, string>; State?: { Running: boolean; ExitCode: number } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const markStageComplete = async (runDirectory: string, stage: 'build' | 'environment'): Promise<void> => {
  const file = path.join(runDirectory, 'results', `${stage}-complete.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, directoryId: path.basename(runDirectory), complete: true })}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
  const parent = await open(path.dirname(file), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
};
export const markBuildComplete = (runDirectory: string): Promise<void> => markStageComplete(runDirectory, 'build');
export const markEnvironmentComplete = (runDirectory: string): Promise<void> => markStageComplete(runDirectory, 'environment');
export const completeFailedEnvironmentSetup = async (runDirectory: string, browserStopped: boolean, cancelled: boolean): Promise<boolean> => {
  if (!browserStopped || cancelled) return false;
  try { assertCommandQuiescence(); } catch { return false; }
  await markEnvironmentComplete(runDirectory);
  return true;
};

const requireStageComplete = async (runDirectory: string, directoryId: string, stage: 'build' | 'environment'): Promise<void> => {
  let value: unknown;
  const label = stage === 'build' ? 'Build' : 'Environment setup';
  try { value = JSON.parse(await readFile(path.join(runDirectory, 'results', `${stage}-complete.json`), 'utf8')); }
  catch (cause) { throw new Error(`${label} process stop is unverified; original resources and evidence are retained.`, { cause }); }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).sort().join() !== 'complete,directoryId,schemaVersion'
    || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('directoryId' in value) || value.directoryId !== directoryId
    || !('complete' in value) || value.complete !== true) throw new Error(`${label} completion evidence conflicts with its original run.`);
};
const requireNoPendingDockerCleanup = async (runDirectory: string): Promise<void> => {
  try { await lstat(path.join(runDirectory, 'results', 'docker-cleanup-intent.json')); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
  throw new Error('A prior Docker cleanup mutation has an unknown outcome; original resources and evidence are retained.');
};

export const resourceIdentity = (runId: string): ResourceIdentity => {
  if (!uuid.test(runId)) throw new Error('The E2E resource UUID is invalid.');
  const name = `daynight-e2e-${runId}`;
  return {
    network: `${name}-network`, ingressNetwork: `${name}-ingress`,
    postgresContainer: `${name}-postgres`, redisContainer: `${name}-redis`, applicationContainer: `${name}-application`,
    ownershipContainer: `${name}-ownership`, postgresVolume: `${name}-postgres-data`,
    runtimeImage: `daynight-e2e-runtime:${runId}`,
  };
};

export const validateIdentity = (resources: ResourceIdentity, runId: string): void => {
  const expected = resourceIdentity(runId);
  if (Object.keys(resources).length !== Object.keys(expected).length || Object.entries(expected).some(([key, name]) => resources[key as keyof ResourceIdentity] !== name)) {
    throw new Error('The E2E receipt does not identify exactly its run-owned resources.');
  }
};

export const cleanupApplication = async (operations: {
  captureDiagnostics: () => Promise<void>;
  checkRunning: () => Promise<void>;
  stop: () => Promise<void>;
  checkStopped: () => Promise<void>;
  remove: () => Promise<void>;
}): Promise<void> => runCleanupSteps([
  operations.captureDiagnostics, operations.checkRunning, operations.stop,
  operations.checkStopped, operations.captureDiagnostics, operations.remove,
]);

export const writeCleanupReceipt = async (runDirectory: string, receipt: CleanupReceipt): Promise<void> => {
  const filename = path.join(runDirectory, 'results', 'environment-cleanup.json');
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(`${filename}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
  await rename(`${filename}.tmp`, filename);
};

export const createDockerAccess = (repository: string, runId: string, options: { execute?: DockerCommand; deadline?: number; runDirectory?: string } = {}) => {
  if (!uuid.test(runId)) throw new Error('The E2E resource UUID is invalid.');
  const execute: DockerCommand = options.execute === undefined
    ? async (args, timeoutMs) => startCommand('docker', args, { cwd: repository, env: process.env, timeoutMs, onOutput: () => {} }).finished
    : options.execute;
  const result = async (args: readonly string[], requestedTimeoutMs = 30_000): Promise<CommandResult> => {
    const remaining = options.deadline === undefined ? requestedTimeoutMs : options.deadline - performance.now();
    if (remaining <= 0) throw new Error('E2E recovery exceeded its cleanup deadline.');
    return execute(args, Math.min(requestedTimeoutMs, remaining));
  };
  const run = async (args: readonly string[], timeoutMs = 30_000): Promise<CommandResult> => {
    const mutation = options.runDirectory !== undefined && (['stop', 'create', 'start'].includes(args[0] ?? '') || args[1] === 'rm');
    const intent = mutation ? path.join(options.runDirectory!, 'results', 'docker-cleanup-intent.json') : undefined;
    try {
      if (intent !== undefined) {
        const handle = await open(intent, 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, runId, kind: 'docker_cleanup_mutation' })}\n`); await handle.sync(); }
        finally { await handle.close(); }
        const parent = await open(path.dirname(intent), 'r'); try { await parent.sync(); } finally { await parent.close(); }
      }
      const output = await result(args, timeoutMs);
      if (output.exitCode !== 0) throw new CommandFailure('docker', output);
      if (intent !== undefined) {
        await unlink(intent);
        const parent = await open(path.dirname(intent), 'r'); try { await parent.sync(); } finally { await parent.close(); }
      }
      return output;
    } catch (error) { if (intent !== undefined) markCommandOutcomeUnconfirmed(); throw error; }
  };
  const inspect = async (kind: ResourceKind, resource: string): Promise<DockerObject | undefined> => {
    const output = await result([kind, 'inspect', resource]);
    if (output.exitCode !== 0) {
      const missing = [`No such ${kind}: ${resource}`, `No such object: ${resource}`,
        ...(kind === 'network' ? [`network ${resource} not found`] : []),
        ...(kind === 'volume' ? [`get ${resource}: no such volume`] : [])];
      if (output.exitCode === 1 && missing.some((message) => output.stderr.toLowerCase().includes(message.toLowerCase()))) return undefined;
      throw new Error(`Could not inspect ${kind} ${resource}: ${output.stderr}`);
    }
    const objects = JSON.parse(output.stdout) as DockerObject[];
    if (!Array.isArray(objects) || objects.length !== 1 || objects[0] === null || typeof objects[0] !== 'object') throw new Error(`Invalid Docker ${kind} inspection for ${resource}.`);
    const object = objects[0]!;
    const labels = kind === 'container' || kind === 'image' ? object.Config?.Labels : object.Labels;
    if (labels?.['daynight.e2e.run'] !== runId) throw new Error(`Refusing to mutate ${kind} ${resource}: the E2E owner label does not match.`);
    return object;
  };
  const remove = async (kind: ResourceKind, resource: string): Promise<void> => {
    if (await inspect(kind, resource) !== undefined) {
      await run(kind === 'container' ? ['container', 'rm', '--force', resource]
        : kind === 'image' ? ['image', 'rm', '--force', resource] : [kind, 'rm', resource]);
    }
    if (await inspect(kind, resource) !== undefined) throw new Error(`Cleanup left ${kind} ${resource} present.`);
  };
  const state = (object: DockerObject): { running: boolean; exitCode: number } => {
    if (typeof object.State?.Running !== 'boolean' || !Number.isInteger(object.State.ExitCode)) throw new Error('Invalid application container state.');
    return { running: object.State.Running, exitCode: object.State.ExitCode };
  };
  return { result, run, inspect, remove, state };
};

export const cleanupOwnedResources = async (options: {
  repository: string;
  runDirectory: string;
  resources: ResourceIdentity;
  metadata: RecoveryMetadata;
  mode: 'normal' | 'recovery';
  applicationStarted: boolean;
  redisStarted?: boolean;
  execute?: DockerCommand;
  deadline?: number;
}): Promise<CleanupVerification & { failures: unknown[] }> => {
  validateIdentity(options.resources, options.metadata.runId);
  await requireNoPendingDockerCleanup(options.runDirectory);
  const resources = options.resources;
  const docker = createDockerAccess(options.repository, options.metadata.runId, { execute: options.execute, deadline: options.deadline, runDirectory: options.runDirectory });
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<void>): Promise<void> => {
    try { await operation(); } catch (error) { failures.push(error); }
  };
  const captureDiagnostics = async (): Promise<void> => {
    if (await docker.inspect('container', resources.applicationContainer) === undefined) return;
    const logs = await docker.run(['logs', resources.applicationContainer]);
    await mkdir(path.join(options.runDirectory, 'logs'), { recursive: true });
    await writeFile(path.join(options.runDirectory, 'logs', 'runtime.stdout.log'), logs.stdout);
    await writeFile(path.join(options.runDirectory, 'logs', 'runtime.stderr.log'), logs.stderr);
  };
  await attempt(async () => cleanupApplication({
    captureDiagnostics,
    checkRunning: async () => {
      if (options.mode !== 'normal' || !options.applicationStarted) return;
      const object = await docker.inspect('container', resources.applicationContainer);
      if (object === undefined) throw new Error('Application disappeared before requested shutdown.');
      const state = docker.state(object);
      if (!state.running) throw new Error(`Application exited before requested shutdown (exit=${state.exitCode}).`);
    },
    stop: async () => {
      const object = await docker.inspect('container', resources.applicationContainer);
      if (object !== undefined && docker.state(object).running) await docker.run(['stop', '--time', '10', resources.applicationContainer], 20_000);
    },
    checkStopped: async () => {
      const object = await docker.inspect('container', resources.applicationContainer);
      if (object === undefined) return;
      const state = docker.state(object);
      if (state.running || options.mode === 'normal' && state.exitCode !== 0) throw new Error(`Application shutdown failed (running=${state.running}, exit=${state.exitCode}).`);
    },
    remove: async () => docker.remove('container', resources.applicationContainer),
  }));
  await attempt(async () => runCleanupSteps([
    async () => {
      await docker.remove('container', resources.ownershipContainer);
      const directories: string[] = [];
      for (const name of ['private', 'logs']) {
        try { await stat(path.join(options.runDirectory, name)); directories.push(`/run/${name}`); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      }
      if (directories.length === 0 || await docker.inspect('image', resources.runtimeImage) === undefined) return;
      await docker.run(['create', '--pull', 'never', '--name', resources.ownershipContainer, '--label', `daynight.e2e.run=${options.metadata.runId}`, '--network', 'none',
        '--mount', `type=bind,src=${path.resolve(options.runDirectory)},dst=/run`, '--entrypoint', 'chown', resources.runtimeImage,
        '--recursive', '--no-dereference', '--', `${options.metadata.ownerUid}:${options.metadata.ownerGid}`, ...directories]);
      await docker.run(['start', '--attach', resources.ownershipContainer]);
      const object = await docker.inspect('container', resources.ownershipContainer);
      if (object === undefined) throw new Error('Ownership repair helper disappeared.');
      const state = docker.state(object);
      if (state.running || state.exitCode !== 0) throw new Error(`Private data ownership repair failed (running=${state.running}, exit=${state.exitCode}).`);
    },
    async () => docker.remove('container', resources.ownershipContainer),
  ]));
  await attempt(async () => {
    if (options.mode !== 'normal' || !options.redisStarted) return;
    const object = await docker.inspect('container', resources.redisContainer);
    if (object === undefined) throw new Error('Redis disappeared before requested shutdown.');
    const state = docker.state(object);
    if (!state.running) throw new Error(`Redis exited before requested shutdown (exit=${state.exitCode}).`);
  });
  for (const [kind, resource] of [
    ['container', resources.redisContainer], ['container', resources.postgresContainer], ['volume', resources.postgresVolume],
    ['network', resources.ingressNetwork], ['network', resources.network], ['image', resources.runtimeImage],
  ] as const) await attempt(async () => docker.remove(kind, resource));
  const cleanupErrors = failures.map((error) => error instanceof Error ? error.message : String(error));
  const verificationErrors: string[] = [];
  const remaining: string[] = [];
  for (const [kind, resource] of [
    ['container', resources.applicationContainer], ['container', resources.ownershipContainer], ['container', resources.postgresContainer], ['container', resources.redisContainer],
    ['volume', resources.postgresVolume], ['network', resources.network], ['network', resources.ingressNetwork], ['image', resources.runtimeImage],
  ] as const) {
    try { if (await docker.inspect(kind, resource) !== undefined) remaining.push(resource); }
    catch (error) { failures.push(error); verificationErrors.push(`${kind} ${resource}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (remaining.length > 0) failures.push(new Error(`Environment cleanup left resources present: ${remaining.join(', ')}`));
  const resourcesAbsent = remaining.length === 0 && verificationErrors.length === 0;
  return { failures, verified: resourcesAbsent && cleanupErrors.length === 0, resourcesAbsent, remaining, verificationErrors, cleanupErrors };
};

const validateRunDirectory = async (repository: string, runDirectory: string): Promise<{ directoryId: string; ownerUid: number; ownerGid: number }> => {
  const expectedParent = path.join(await realpath(repository), '.tmp', 'product-e2e');
  const actual = await realpath(runDirectory);
  const directoryId = path.basename(actual);
  if (path.dirname(actual) !== expectedParent || !uuid.test(directoryId)) throw new Error('Recovery requires an exact repository-owned product E2E run directory.');
  const owner = await stat(actual);
  if (!owner.isDirectory()) throw new Error('The E2E run path is not a directory.');
  return { directoryId, ownerUid: owner.uid, ownerGid: owner.gid };
};

export const recoverEnvironment = async (options: { repository: string; runDirectory: string; phase?: 'build' | 'environment'; execute?: DockerCommand }): Promise<void> => {
  const directory = await validateRunDirectory(options.repository, options.runDirectory);
  const filename = path.join(options.runDirectory, 'results', 'environment-cleanup.json');
  await requireStageComplete(options.runDirectory, directory.directoryId, 'build');
  if (options.phase !== 'build') await requireStageComplete(options.runDirectory, directory.directoryId, 'environment');
  await requireNoPendingDockerCleanup(options.runDirectory);
  try { await recoverRunOwnership({ repository: options.repository, runDirectory: options.runDirectory, mode: 'independent' }); }
  catch (cause) {
    throw new Error('Fixture ownership or process stop remains unverified; original resources and evidence are retained.', { cause });
  }
  const lock = new DatabaseSync(path.join(options.runDirectory, 'results', 'environment-recovery-lock.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS recovery_lock (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE');
    await requireNoPendingDockerCleanup(options.runDirectory);
  let receipt: CleanupReceipt | undefined;
  try { receipt = JSON.parse(await readFile(filename, 'utf8')) as CleanupReceipt; }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (receipt === undefined && options.phase !== 'build') {
    const unknown = new Error('E2E runtime cleanup receipt is missing; resource ownership and cleanup remain unverified.');
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(path.join(path.dirname(filename), 'environment-recovery.json'), `${JSON.stringify({ ...directory, runtimeRegistered: 'unknown', recovery: { completed: false, verified: false, resourcesAbsent: false, remaining: [], verificationErrors: [unknown.message], cleanupErrors: [], finishedAt: new Date().toISOString() } }, null, 2)}\n`);
    throw unknown;
  }
  const failures: unknown[] = [];
  let verification: CleanupVerification = { verified: true, resourcesAbsent: true, remaining: [], verificationErrors: [], cleanupErrors: [] };
  if (receipt !== undefined) {
    if (!['pending', 'complete', 'failed'].includes(receipt.state) || typeof receipt.verified !== 'boolean' || typeof receipt.resourcesAbsent !== 'boolean' ||
      ![receipt.remaining, receipt.verificationErrors, receipt.cleanupErrors].every((values) => Array.isArray(values) && values.every((value) => typeof value === 'string'))) throw new Error('The E2E cleanup receipt has an invalid outcome structure.');
    if (receipt.schemaVersion !== 1 || receipt.directoryId !== directory.directoryId || receipt.ownerUid !== directory.ownerUid || receipt.ownerGid !== directory.ownerGid) throw new Error('The E2E recovery metadata does not match its run directory owner.');
    validateIdentity(receipt.resourceIdentity, receipt.runId);
    const cleaned = await cleanupOwnedResources({ ...options, resources: receipt.resourceIdentity, metadata: receipt, mode: 'recovery', applicationStarted: false, deadline: performance.now() + 150_000 });
    failures.push(...cleaned.failures);
    verification = { verified: cleaned.verified, resourcesAbsent: cleaned.resourcesAbsent, remaining: cleaned.remaining, verificationErrors: cleaned.verificationErrors, cleanupErrors: cleaned.cleanupErrors };
  }
  if (failures.length === 0 && verification.verified) {
    for (const name of ['private', 'artifacts']) {
      try { await rm(path.join(options.runDirectory, name), { recursive: true, force: true }); }
      catch (error) { failures.push(error); verification.cleanupErrors.push(error instanceof Error ? error.message : String(error)); verification.verified = false; }
    }
  }
  const recovery = { ...verification, completed: failures.length === 0 && verification.verified, finishedAt: new Date().toISOString() };
  if (receipt !== undefined) await writeCleanupReceipt(options.runDirectory, { ...receipt, recovery });
  else {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(path.join(path.dirname(filename), 'environment-recovery.json'), `${JSON.stringify({ ...directory, runtimeRegistered: false, recovery }, null, 2)}\n`);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Independent E2E recovery failed.', { cause: failures[0] });
    lock.exec('COMMIT');
  } finally { lock.close(); }
};
