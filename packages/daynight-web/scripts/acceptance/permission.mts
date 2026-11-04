import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type ContainerPermissionIdentity = {
  acceptanceRunId: string;
  devCiRunId: string;
  sourceGitSha: string;
};
export type ContainerPermission = ContainerPermissionIdentity & {
  schemaVersion: 1;
  phase: 'native-prepared';
};
export type ContainerPermissionWaitOptions = { signal: AbortSignal; timeoutMs: number };

const filename = 'container-permission.json';
const identityKeys = ['acceptanceRunId', 'devCiRunId', 'sourceGitSha'];
const receiptKeys = ['schemaVersion', 'phase', ...identityKeys];
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const requireIdentity = (identity: ContainerPermissionIdentity): void => {
  if (!exactKeys(identity, identityKeys)
    || typeof identity.acceptanceRunId !== 'string'
    || !/^\d{14}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.acceptanceRunId)
    || typeof identity.devCiRunId !== 'string' || !/^\d{14}-[1-9]\d*-\d{5}$/.test(identity.devCiRunId)
    || typeof identity.sourceGitSha !== 'string' || !/^[a-f0-9]{40}$/.test(identity.sourceGitSha)) {
    throw new Error('Invalid container permission identity.');
  }
};
const requireDirectory = (directory: string): void => {
  if (!isAbsolute(directory)) throw new Error('Container permission directory must be absolute.');
};

export const writeContainerPermission = async (directory: string, identity: ContainerPermissionIdentity): Promise<void> => {
  requireDirectory(directory);
  requireIdentity(identity);
  const receipt: ContainerPermission = { schemaVersion: 1, phase: 'native-prepared', ...identity };
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.container-permission-${randomUUID()}.next`);
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, join(directory, filename));
  } catch (publicationError) {
    try { await rm(temporary, { force: true }); }
    catch (cleanupError) {
      throw new AggregateError([publicationError, cleanupError], 'Container permission publication and temporary cleanup failed.', { cause: publicationError });
    }
    throw publicationError;
  }
};

export const waitForContainerPermission = async (directory: string, identity: ContainerPermissionIdentity,
  { signal, timeoutMs }: ContainerPermissionWaitOptions): Promise<void> => {
  requireDirectory(directory);
  requireIdentity(identity);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid container permission timeout.');
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('Container browser permission timed out.');
    let contents: string;
    try { contents = await readFile(join(directory, filename), { encoding: 'utf8', signal }); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      signal.throwIfAborted();
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('Container browser permission timed out.');
      await delay(Math.min(25, remaining), undefined, { signal });
      continue;
    }
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('Container browser permission timed out.');
    const receipt: unknown = JSON.parse(contents);
    if (!exactKeys(receipt, receiptKeys) || receipt.schemaVersion !== 1 || receipt.phase !== 'native-prepared') {
      throw new Error('Invalid container browser permission receipt.');
    }
    if (identityKeys.some((key) => receipt[key] !== identity[key as keyof ContainerPermissionIdentity])) {
      throw new Error('Container browser permission belongs to a different run or source.');
    }
    return;
  }
};
