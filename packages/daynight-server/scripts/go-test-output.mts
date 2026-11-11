import { spawn } from 'node:child_process';
import { closeSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';

const [realGo, directory, ...args] = process.argv.slice(2);
let descriptor: number | undefined;
const fail = (error: unknown): never => {
  // Keep the first capture failure even if an overlapping invocation later
  // finishes the raw stream and publishes its own completion marker.
  if (directory !== undefined) {
    try {
      writeFileSync(join(directory, 'go-test.failed.json'),
        JSON.stringify({ version: 1, error: String(error) }) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (recordError) {
      if ((recordError as NodeJS.ErrnoException).code !== 'EEXIST') {
        try { writeSync(2, 'Unable to record go test capture failure: ' + String(recordError) + '\n'); } catch {}
      }
    }
  }
  try { writeSync(2, 'Unable to capture go test output: ' + String(error) + '\n'); } catch {}
  if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
  // The outer command-timeout owns the group, including children of a killed shim.
  // Exit immediately: waiting for their handles here could hide capture failure.
  process.exit(125);
};
process.stdout.on('error', fail);

try {
  if (!realGo || !directory || args[0] !== 'test') throw new Error('Expected the private go test capture invocation.');
  // The pinned runner issues one go test. A repeated invocation must not reuse
  // its predecessor's completion when the exclusive raw-file open rejects it.
  rmSync(join(directory, 'go-test.complete.json'), { force: true });
  descriptor = openSync(join(directory, 'go-test.jsonl'), 'wx', 0o600);
  const child = spawn(realGo, args, { stdio: ['inherit', 'pipe', 'inherit'] });
  child.once('error', fail);
  const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  let bytes = 0;
  for await (const chunk of child.stdout!) {
    const buffer = chunk as Buffer;
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(descriptor, buffer, offset, buffer.length - offset);
      if (written === 0) throw new Error('The capture file stopped accepting bytes.');
      offset += written;
      bytes += written;
    }
    // Await every write callback before reading another chunk. Both the pipe and
    // file stay bounded, and every byte sent to go-cov already exists in the file.
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(buffer, error => { if (error) reject(error); else resolve(); });
    });
  }
  const result = await closed;
  closeSync(descriptor);
  descriptor = undefined;
  const temporary = join(directory, '.go-test.complete.tmp');
  writeFileSync(temporary, JSON.stringify({ version: 1, bytes, ...result }) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, join(directory, 'go-test.complete.json'));
  process.exitCode = result.exitCode ?? 128 + constants.signals[result.signal!];
} catch (error) {
  fail(error);
}
