import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { command, commandBytes } from './process.mts';
import { processIdentity, requireGroupStopped } from './identity.mts';

const temporary = fileURLToPath(new URL('../../.tmp/', import.meta.url));
const fixture = async (run: (directory: string) => Promise<void>): Promise<void> => {
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'command-bytes-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
};

test('raw command capture preserves invalid UTF-8, NUL, whitespace and empty bytes without logging', async () => {
  await fixture(async (cwd) => {
    const module = new URL('./process.mts', import.meta.url).href;
    const script = `
      const {commandBytes} = await import(${JSON.stringify(module)});
      const result = await commandBytes(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,128,32,10])); process.stderr.write("diagnostic\\\\n")'], {cwd: process.cwd()});
      process.stdout.write(JSON.stringify({stdout:result.stdout.toString('hex'),stderr:result.stderr.toString(),exitCode:result.exitCode}));
    `;
    const result = await commandBytes(process.execPath, ['--input-type=module', '-e', script], { cwd });
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.deepEqual(JSON.parse(result.stdout.toString()), { stdout: '00ff80200a', stderr: 'diagnostic\n', exitCode: 0 });
    assert.equal(result.stderr.length, 0);
    assert.deepEqual(await commandBytes(process.execPath, ['-e', ''], { cwd }), { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 });
    assert.equal(await command(process.execPath, ['-e', 'process.stdout.write("  text\\n")'], { cwd, quiet: true }), 'text');
  });
});

test('raw capture returns ordinary failure status and awaits process identity recording', async () => {
  await fixture(async (cwd) => {
    let registered = false;
    const result = await commandBytes(process.execPath, ['-e', 'process.stderr.write("not_found\\n"); process.exitCode=1'], {
      cwd, onSpawn: async () => { await new Promise((done) => setTimeout(done, 50)); registered = true; },
    });
    assert.equal(registered, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr.toString(), 'not_found\n');
    await assert.rejects(command(process.execPath, ['-e', 'process.exitCode=1'], { cwd, quiet: true }), /exit=1/);
  });
});

test('command input streams large fixture payloads without using an argument', async () => {
  await fixture(async (cwd) => {
    const input = `UPDATE users SET avatar_url = '${'x'.repeat(235_654)}';`;
    const result = await commandBytes(process.execPath, ['-e', 'let input=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(input));'], { cwd, input });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr.length, 0);
    assert.equal(result.stdout.toString('utf8'), input);
    const binary = Uint8Array.from([0, 255, 128, 32, 10]);
    const echoed = await commandBytes(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { cwd, input: binary });
    assert.equal(echoed.exitCode, 0);
    assert.deepEqual(echoed.stdout, Buffer.from(binary));
  });
});

test('a broken input pipe remains an error and reaps the command group', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await fixture(async (cwd) => {
    let group: number | undefined;
    await assert.rejects(commandBytes(process.execPath, ['-e', 'require("node:fs").closeSync(0); setInterval(() => {}, 1000)'], {
      cwd, input: Buffer.alloc(256 * 1024), timeoutMs: 5_000, onSpawn: (child) => { group = child.pid; },
    }), (error: unknown) => error instanceof Error && 'code' in error && ['EPIPE', 'ECONNRESET'].includes(String(error.code)));
    requireGroupStopped(group!);
  });
});

test('raw output retains the 8 MiB bound', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await fixture(async (cwd) => {
    let group: number | undefined;
    await assert.rejects(commandBytes(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(8*1024*1024+1))'], {
      cwd, onSpawn: (child) => { group = child.pid; },
    }), /bounded output/);
    assert.notEqual(group, undefined);
    requireGroupStopped(group!);
  });
});

test('timeout and cancellation reap the owned command group', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await fixture(async (cwd) => {
    for (const cancelled of [false, true]) {
      const controller = new AbortController();
      let group: number | undefined;
      let started: () => void = () => {};
      const ready = new Promise<void>((resolve) => { started = resolve; });
      const pending = commandBytes(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd, input: 'pending fixture input', timeoutMs: cancelled ? 5_000 : 100, signal: controller.signal,
        onSpawn: (child) => { group = child.pid; started(); },
      });
      await ready;
      if (cancelled) controller.abort(new Error('caller cancellation'));
      await assert.rejects(pending, cancelled ? /cancelled/ : /timed out/);
      assert.equal(await processIdentity(group!), null);
      requireGroupStopped(group!);
    }
  });
});

test('failed spawn registration terminates and reaps the process', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await fixture(async (cwd) => {
    let group: number | undefined;
    const failure = new Error('identity persistence failed');
    await assert.rejects(commandBytes(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd, onSpawn: (child) => { group = child.pid; throw failure; },
    }), (error) => error === failure);
    requireGroupStopped(group!);
  });
});

test('the command deadline also bounds identity registration after process exit', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await fixture(async (cwd) => {
    const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    await assert.rejects(commandBytes(process.execPath, ['-e', ''], {
      cwd, timeoutMs: 100, onSpawn: async () => await new Promise<void>(() => {}),
    }), /timed out/);
    assert.equal(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length, before);
  });
});

test('late identity recording failure leaves no delayed process-group kill', { skip: !['linux', 'darwin'].includes(process.platform) }, async (context) => {
  await fixture(async (cwd) => {
    const failure = new Error('late identity failure');
    let closed = false;
    let lateSignals = 0;
    const kill = process.kill;
    context.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => { if (closed) lateSignals++; return kill(pid, signal); });
    const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    await assert.rejects(commandBytes(process.execPath, ['-e', ''], {
      cwd, timeoutMs: 5_000,
      onSpawn: async (child) => { child.once('close', () => { closed = true; }); await new Promise((done) => setTimeout(done, 100)); throw failure; },
    }), (error) => error === failure);
    assert.equal(closed, true);
    assert.equal(lateSignals, 0);
    assert.equal(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length, before);
  });
});
