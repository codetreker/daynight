import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { CommandFailure, runCommand, startCommand } from '../src/command.ts';

const scratchRoot = path.resolve(import.meta.dirname, '../../..', '.tmp/e2e-command-tests');
let directory: string;
beforeEach(async () => { await mkdir(scratchRoot, { recursive: true }); directory = await mkdtemp(path.join(scratchRoot, 'run-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const options = () => ({ cwd: directory, timeoutMs: 5_000, onOutput: () => {} });
const active = async (pid: number): Promise<boolean> => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const descendantProgram = (exitParent: boolean): string => `
  const {spawn}=require('node:child_process');
  const child=spawn(process.execPath,['-e',${JSON.stringify("process.on('SIGTERM',()=>{});process.stdout.write('READY\\n');setInterval(()=>{},1000);")}],{stdio:['ignore','pipe','ignore']});
  child.stdout.once('data',()=>{process.stdout.write('DESCENDANT '+child.pid+'\\n');${exitParent ? 'process.exit(0);' : 'setInterval(()=>{},1000);'}});
`;

test('streams both channels and retains the nonzero command result', async () => {
  const streamed: string[] = [];
  await assert.rejects(runCommand(process.execPath, ['-e', "process.stdout.write('out');process.stderr.write('err');process.exitCode=7;"], {
    ...options(), onOutput: (channel, chunk) => { streamed.push(`${channel}:${chunk}`); },
  }), (error: unknown) => {
    assert.ok(error instanceof CommandFailure);
    assert.deepEqual(error.result, { stdout: 'out', stderr: 'err', exitCode: 7 });
    return true;
  });
  assert.deepEqual(streamed.sort(), ['stderr:err', 'stdout:out']);
});

test('preserves a failed spawn and exposes no invented PID', async () => {
  const command = startCommand(path.join(directory, 'missing-command'), [], options());
  assert.throws(() => command.pid, /did not spawn/);
  await assert.rejects(command.finished, (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
});

test('cleans an unreferenced descendant after its parent succeeds', async () => {
  let descendant: number | undefined;
  const result = await runCommand(process.execPath, ['-e', descendantProgram(true)], {
    ...options(), onOutput: (_channel, chunk) => { const match = /DESCENDANT (\d+)/.exec(chunk); if (match !== null) descendant = Number(match[1]); },
  });
  assert.equal(result.exitCode, 0);
  assert.ok(descendant !== undefined, 'The descendant must publish its real startup receipt.');
  assert.equal(await active(descendant), false);
});

test('cancellation rejects with the original reason after cleaning descendants', async () => {
  const controller = new AbortController();
  const reason = new Error('Receipt-driven cancellation');
  let descendant: number | undefined;
  const command = startCommand(process.execPath, ['-e', descendantProgram(false)], {
    ...options(), signal: controller.signal, onOutput: (_channel, chunk) => {
      const match = /DESCENDANT (\d+)/.exec(chunk);
      if (match !== null) { descendant = Number(match[1]); controller.abort(reason); }
    },
  });
  await assert.rejects(command.finished, (error: unknown) => error === reason);
  assert.ok(descendant !== undefined, 'Cancellation must follow the startup receipt.');
  assert.equal(await active(descendant), false);
});

test('the execution deadline cleans a descendant that ignores SIGTERM', async () => {
  let descendant: number | undefined;
  const command = startCommand(process.execPath, ['-e', descendantProgram(false)], {
    ...options(), timeoutMs: 1_000, onOutput: (_channel, chunk) => { const match = /DESCENDANT (\d+)/.exec(chunk); if (match !== null) descendant = Number(match[1]); },
  });
  await assert.rejects(command.finished, /timed out after 1000ms/);
  assert.ok(descendant !== undefined, 'The test must observe startup before the deadline.');
  assert.equal(await active(descendant), false);
});

test('explicit stop is idempotent and resolves the observed process exit', async () => {
  let ready: () => void = () => {};
  const receipt = new Promise<void>((resolve) => { ready = resolve; });
  const command = startCommand(process.execPath, ['-e', "process.stdout.write('READY');setInterval(()=>{},1000);"], {
    ...options(), onOutput: (_channel, chunk) => { if (chunk.includes('READY')) ready(); },
  });
  await receipt;
  await command.stop();
  await command.stop();
  assert.equal((await command.finished).exitCode, 143);
  assert.equal(await active(command.pid), false);
});

test('output retention is bounded while complete output is streamed', async () => {
  let streamedBytes = 0;
  const result = await runCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(2*1024*1024));"], {
    ...options(), onOutput: (_channel, chunk) => { streamedBytes += Buffer.byteLength(chunk); },
  });
  assert.equal(streamedBytes, 2 * 1024 * 1024);
  assert.equal(Buffer.byteLength(result.stdout), 1024 * 1024);
});

test('an already aborted signal fails before starting a process', () => {
  const reason = new Error('Already aborted');
  const controller = new AbortController(); controller.abort(reason);
  assert.throws(() => startCommand(process.execPath, [], { ...options(), signal: controller.signal }), (error: unknown) => error === reason);
});

test('an output observer failure terminates the command and remains observable', async () => {
  const reason = new Error('Output owner failed');
  const command = startCommand(process.execPath, ['-e', "process.stdout.write('READY');setInterval(()=>{},1000);"], {
    ...options(), onOutput: () => { throw reason; },
  });
  await assert.rejects(command.finished, (error: unknown) => error === reason);
  assert.equal(await active(command.pid), false);
});
