import assert from 'node:assert/strict';
import { open, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { recoveryControl } from '../src/subtask-compat-recovery-control.ts';

const repository = path.resolve(import.meta.dirname, '../../..');

test('recovery control reaches its private socket when the checkout path is too long', async () => {
  const scratch = path.join(repository, '.tmp'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'recovery-control-'));
  const privateDirectory = path.join(root, 'x'.repeat(80), 'private');
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  assert.ok(Buffer.byteLength(path.join(privateDirectory, 'control.sock')) > 108);
  const directory = await open(privateDirectory, 'r');
  const server = createServer(socket => {
    socket.on('data', data => {
      if (data.toString() === 'count\n') socket.end('{"count":1}\n');
      else socket.end('{"error":"control failed"}\n');
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(`/proc/self/fd/${directory.fd}/control.sock`, () => { server.off('error', reject); resolve(); }); });
    assert.deepEqual(await recoveryControl(privateDirectory, 'count'), { count: 1 });
    await assert.rejects(recoveryControl(privateDirectory, 'bad'), /Recovery control refused/);
    const link = path.join(root, 'link'); await symlink(privateDirectory, link);
    await assert.rejects(recoveryControl(link, 'count'));
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await directory.close(); await rm(root, { recursive: true, force: true });
  }
});
