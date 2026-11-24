import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureProcessEvidence, inspectProcessEvidence, stopEvidenceGroup, type ProcessEvidence } from '../src/process-evidence.ts';
import { cleanupRecoveryResources, type RecoveryProcess, type RecoveryResource } from '../src/subtask-compat-recovery-cleanup.ts';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const image = 'node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const docker = async (args: string[]): Promise<string> => (await exec('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout;

test('real stopped user precedes cleanup of owned Docker container, volume and network', async () => {
  const id = randomUUID(), prefix = `daynight-compat-cleanup-test-${id}`, label = `daynight.compat.cleanup.test=${id}`;
  const resources: RecoveryResource[] = [{ kind: 'container', name: `${prefix}-service` }, { kind: 'volume', name: `${prefix}-volume` }, { kind: 'network', name: `${prefix}-network` }];
  const inspect = async (resource: RecoveryResource): Promise<boolean> => {
    try {
      const output = await docker([resource.kind, 'inspect', resource.name]);
      const object = (JSON.parse(output) as { Config?: { Labels?: Record<string, string> }; Labels?: Record<string, string> }[])[0];
      assert.equal((object?.Config?.Labels ?? object?.Labels)?.['daynight.compat.cleanup.test'], id);
      return true;
    } catch (error) {
      const result = error as { code?: unknown; stderr?: unknown };
      if (result.code === 1 && typeof result.stderr === 'string' && /no such (container|volume)|network .* not found/i.test(result.stderr)) return false;
      throw error;
    }
  };
  const child: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  let proof: ProcessEvidence | undefined;
  try {
    assert.ok(child.pid); proof = await captureProcessEvidence(child.pid);
    await docker(['network', 'create', '--internal', '--label', label, resources[2]!.name]);
    await docker(['volume', 'create', '--label', label, resources[1]!.name]);
    await docker(['run', '--detach', '--pull', 'never', '--name', resources[0]!.name, '--label', label, '--network', resources[2]!.name,
      '--mount', `type=volume,src=${resources[1]!.name},dst=/data`, image, 'node', '-e', 'setInterval(() => {}, 1000)']);
    const processes: RecoveryProcess[] = [{ id: randomUUID(), operation: 'real user', proof }];
    const result = await cleanupRecoveryResources({ repository, runId: id, mode: 'owner', processes, resources, deadline: Date.now() + 30_000,
      save: async () => {}, inspect,
      stop: async resource => { assert.equal(await inspectProcessEvidence(proof!), 'stopped'); await docker(['stop', '--time', '1', resource.name]); },
      remove: async resource => { await docker([resource.kind, 'rm', resource.name]); } });
    assert.equal(result.usersStopped, true); assert.deepEqual(result.failures, []); assert.deepEqual(processes, []);
    assert.deepEqual(Object.values(result.observations), ['absent', 'absent', 'absent']);
    for (const resource of resources) assert.equal(await inspect(resource), false);
  } finally {
    if (proof) await stopEvidenceGroup(proof, [], Date.now() + 10_000);
    else if (child.pid) { child.kill('SIGKILL'); throw new Error('Original process identity was unavailable; Docker resources were retained.'); }
    for (const resource of resources) {
      if (await inspect(resource)) {
        if (resource.kind === 'container') await docker(['stop', '--time', '1', resource.name]);
        await docker([resource.kind, 'rm', resource.name]);
      }
    }
  }
});
