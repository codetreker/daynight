import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ProcessIdentity } from './identity.mts';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('./process-darwin.c', import.meta.url));
const temporaryRoot = resolve(dirname(source), '../../.tmp/native-process');
let helper: Promise<string> | undefined;

const nativeHelper = async (): Promise<string> => {
  helper ??= (async () => {
    const digest = createHash('sha256').update(await readFile(source)).update(`${process.platform}/${process.arch}`).digest('hex');
    const directory = join(temporaryRoot, digest);
    const binary = join(directory, 'process-helper');
    try { await access(binary, constants.X_OK); return binary; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const pending = join(directory, `process-helper-${randomUUID()}`);
    try {
      await execute('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', pending], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      await rename(pending, binary);
      return binary;
    } finally { await rm(pending, { force: true }); }
  })();
  return await helper;
};

const inspect = async (mode: 'identity' | 'arguments' | 'find', pid?: number, environment?: Record<string, string>): Promise<unknown> => {
  const executable = await nativeHelper();
  // Only requested process data leaves the native helper; unrelated argv/environment is never persisted.
  return await new Promise<unknown>((resolveResult, reject) => {
    const child = execFile(executable, pid === undefined ? [mode] : [mode, String(pid)], {
      timeout: 10_000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer',
    }, (error, stdout, stderr) => {
      if (error !== null) { reject(new Error(`macOS process inspection failed (${mode}): ${stderr.toString().trim() || error.message}`)); return; }
      try { resolveResult(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout))); }
      catch { reject(new Error('Invalid macOS process inspection output.')); }
    });
    child.stdin!.on('error', () => { /* A failed helper is reported by its exit status. */ });
    child.stdin!.end(environment === undefined ? undefined : Buffer.from(Object.entries(environment).map(([key, value]) => `${key}=${value}\0`).join('')));
  });
};

const checkedIdentity = (value: unknown): ProcessIdentity => {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid macOS process identity.');
  const identity = value as ProcessIdentity;
  if (identity.platform !== 'darwin' || !Number.isSafeInteger(identity.pid) || identity.pid <= 1
    || !Number.isSafeInteger(identity.group) || identity.group <= 0
    || typeof identity.executable !== 'string' || !identity.executable.startsWith('/') || identity.executable.includes('\0')
    || typeof identity.startTicks !== 'string' || !/^[1-9]\d*$/.test(identity.startTicks)) throw new Error('Invalid macOS process identity.');
  return identity;
};

export const darwinIdentity = async (pid: number): Promise<ProcessIdentity | null> => {
  const value = await inspect('identity', pid);
  if (value === null) return null;
  const identity = checkedIdentity(value);
  if (identity.pid !== pid) throw new Error('macOS process inspection returned another process.');
  return identity;
};
export const darwinArguments = async (pid: number): Promise<string[] | null> => {
  const value = await inspect('arguments', pid);
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) throw new Error('Invalid macOS process arguments.');
  return value as string[];
};
export const darwinFind = async (environment: Record<string, string>): Promise<ProcessIdentity[]> => {
  const value = await inspect('find', undefined, environment);
  if (!Array.isArray(value)) throw new Error('Invalid macOS process inventory.');
  const identities = value.map(checkedIdentity);
  if (new Set(identities.map((identity) => identity.pid)).size !== identities.length) throw new Error('Duplicate macOS process identities.');
  return identities;
};
