import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [scope, realGo, command, ...args] = process.argv.slice(2);
const scripts = dirname(fileURLToPath(import.meta.url));
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
let shim: string | undefined;
try {
  if (!['module', 'startup-shutdown'].includes(scope ?? '') || !realGo || !isAbsolute(realGo) || !command || !isAbsolute(command)) {
    throw new Error('Usage: go-cov-capture.mts module|startup-shutdown ABSOLUTE_GO ABSOLUTE_GO_COV [ARGUMENT...]');
  }
  accessSync(realGo, fsConstants.X_OK);
  const base = resolve(scripts, '../.tmp/go-test-evidence', scope!);
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'run-'));
  shim = join(directory, '.shim');
  mkdirSync(shim);
  writeFileSync(join(shim, 'go'), [
    '#!/bin/sh',
    // Only go-cov resolves the private shim. Tests and nested Go commands keep
    // the caller's PATH, including its absence, without private environment keys.
    process.env.PATH === undefined ? 'unset PATH' : 'PATH=' + quote(process.env.PATH) + '; export PATH',
    'if [ "$1" != test ]; then exec ' + quote(realGo) + ' "$@"; fi',
    'exec ' + quote(process.execPath) + ' ' + quote(join(scripts, 'go-test-output.mts')) + ' ' + quote(realGo) + ' ' + quote(directory) + ' "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  console.error('Go test evidence: ' + directory);
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, PATH: shim + delimiter + (process.env.PATH ?? '') },
  });
  let launchError: Error | undefined;
  child.once('error', error => { launchError = error; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (launchError) throw launchError;
  process.exitCode = result.code ?? 128 + constants.signals[result.signal!];
  if (process.exitCode === 0) {
    // A future go-cov release must not silently bypass the scoped go shim.
    const capture = JSON.parse(readFileSync(join(directory, 'go-test.complete.json'), 'utf8'));
    if (capture.version !== 1 || !Number.isSafeInteger(capture.bytes) || capture.bytes < 0
      || statSync(join(directory, 'go-test.jsonl')).size !== capture.bytes
      || capture.exitCode !== 0 || capture.signal !== null) {
      throw new Error('go-cov succeeded without a complete successful go test capture.');
    }
  }
} catch (error) {
  console.error('Go test capture failed:', error);
  process.exitCode = 125;
} finally {
  if (shim !== undefined) {
    try { rmSync(shim, { recursive: true, force: true }); }
    catch (error) {
      console.error('Unable to remove the private go shim:', error);
      if (!process.exitCode) process.exitCode = 125;
    }
  }
}
