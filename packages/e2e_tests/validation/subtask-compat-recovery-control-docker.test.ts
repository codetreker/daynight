import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { recoveryControl } from '../src/subtask-compat-recovery-control.ts';

test('host connects to the private container socket through a long bind mount path', { timeout: 30_000 }, async () => {
  const repository = path.resolve(import.meta.dirname, '../../..'), scratch = path.join(repository, '.tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'recovery-control-container-'));
  const privateDirectory = path.join(root, 'x'.repeat(80), 'private'); await mkdir(privateDirectory, { recursive: true });
  assert.ok(Buffer.byteLength(path.join(privateDirectory, 'control.sock')) > 108);
  const id = randomUUID(), name = `daynight-recovery-control-${id}`;
  const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const source = `const net=require('net');const server=net.createServer(s=>s.on('data',()=>s.end('{"count":1}\\n')));server.listen('/run/private/control.sock');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
    docker(['run', '--detach', '--name', name, '--label', `daynight.e2e.control-test=${id}`, '--network', 'none', '--user', `${process.getuid!()}:${process.getgid!()}`, '--mount', `type=bind,src=${privateDirectory},dst=/run/private`, '--entrypoint', 'node', 'node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54', '-e', source]);
    const deadline = Date.now() + 10_000;
    while (true) { try { if ((await stat(path.join(privateDirectory, 'control.sock'))).isSocket()) break; } catch (error) { if (Date.now() >= deadline) throw error; } await delay(50); }
    assert.deepEqual(await recoveryControl(privateDirectory, 'count'), { count: 1 });
  } finally {
    let container: { Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean } } | undefined;
    try { container = JSON.parse(docker(['container', 'inspect', name]))[0]; }
    catch (error) { if (!(error instanceof Error && 'stderr' in error && String(error.stderr).includes('No such'))) throw error; }
    if (container) {
      assert.equal(container.Config.Labels['daynight.e2e.control-test'], id);
      if (container.State.Running) docker(['stop', '--time', '3', container.Id]);
      const stopped = JSON.parse(docker(['container', 'inspect', container.Id]))[0] as { State: { Running: boolean } };
      assert.equal(stopped.State.Running, false); docker(['rm', container.Id]);
      assert.equal(docker(['ps', '--all', '--filter', `id=${container.Id}`, '--format', '{{.ID}}']), '');
    }
    await rm(root, { recursive: true, force: true });
  }
});
