import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPackedCliPackage, packCliPackage, readCliSourceIdentity, type CliSourceIdentity, type PackedCliPackage,
} from '../../../daynight/test/fixtures/installed-cli.ts';
import { requireGroupStopped } from './identity.mts';
import { command } from './process.mts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export type CliPackageProducer = { readonly runId: string; readonly originAttempt: number };
export type CliPackageManifest = {
  readonly schemaVersion: 1;
  readonly source: CliSourceIdentity;
  readonly packageVersion: string;
  readonly tarballSha256: string;
  readonly producer: CliPackageProducer;
};
export type CliPackageExpectation = CliPackageProducer & { readonly source: CliSourceIdentity };
export type PreparedCliPackage = { readonly manifest: CliPackageManifest; readonly packedPackage: PackedCliPackage };

const sameSource = (left: CliSourceIdentity, right: CliSourceIdentity): boolean =>
  left.gitSha === right.gitSha && left.gitTreeSha === right.gitTreeSha && left.dirty === right.dirty;
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('CLI package manifest is invalid.');
  return value as Record<string, unknown>;
};
const sourceIdentity = (value: unknown): CliSourceIdentity => {
  const source = object(value);
  if (typeof source.gitSha !== 'string' || !/^[a-f0-9]{40}$/.test(source.gitSha)
    || typeof source.gitTreeSha !== 'string' || !/^[a-f0-9]{40}$/.test(source.gitTreeSha) || typeof source.dirty !== 'boolean') {
    throw new Error('CLI package source identity is invalid.');
  }
  return { gitSha: source.gitSha, gitTreeSha: source.gitTreeSha, dirty: source.dirty };
};
const producerIdentity = (value: unknown): CliPackageProducer => {
  const producer = object(value);
  if (typeof producer.runId !== 'string' || !/^[1-9][0-9]*$/.test(producer.runId) || !Number.isSafeInteger(producer.originAttempt) || (producer.originAttempt as number) < 1) {
    throw new Error('CLI package producer identity is invalid.');
  }
  return { runId: producer.runId, originAttempt: producer.originAttempt as number };
};
const requireCiSource = (source: CliSourceIdentity, producer: CliPackageProducer, preparing: boolean): void => {
  if (process.env.CI === undefined) return;
  if (source.dirty || process.env.GITHUB_SHA !== source.gitSha || process.env.GITHUB_RUN_ID !== producer.runId
    || (preparing && Number(process.env.GITHUB_RUN_ATTEMPT) !== producer.originAttempt)) {
    throw new Error('CI CLI package must match its clean GitHub source and producer identity.');
  }
};
const parseManifest = (value: unknown, expected: CliPackageExpectation): CliPackageManifest => {
  const manifest = object(value);
  const source = sourceIdentity(manifest.source);
  const producer = producerIdentity(manifest.producer);
  if (manifest.schemaVersion !== 1 || typeof manifest.packageVersion !== 'string' || manifest.packageVersion === ''
    || typeof manifest.tarballSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.tarballSha256)) throw new Error('CLI package manifest is invalid.');
  if (!sameSource(source, expected.source) || producer.runId !== expected.runId || producer.originAttempt !== expected.originAttempt) {
    throw new Error('CLI package manifest differs from its expected source or producer.');
  }
  return { schemaVersion: 1, source, packageVersion: manifest.packageVersion, tarballSha256: manifest.tarballSha256, producer };
};
const owned = async <T,>(operation: (onSpawn: (child: ChildProcess) => void) => Promise<T>): Promise<T> => {
  const children: ChildProcess[] = [];
  let result!: T;
  let failure: unknown;
  try { result = await operation((child) => { children.push(child); }); }
  catch (error) { failure = error; }
  for (const child of children) {
    if (child.pid === undefined) continue;
    try { requireGroupStopped(child.pid); }
    catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'CLI package command and process-group cleanup failed.', { cause: failure }); }
  }
  if (failure !== undefined) throw failure;
  return result;
};

export const readCliPackage = async (directory: string, expected: CliPackageExpectation): Promise<PreparedCliPackage> => {
  if (!isAbsolute(directory)) throw new Error('CLI package directory must be absolute.');
  sourceIdentity(expected.source);
  producerIdentity(expected);
  if (!sameSource(expected.source, readCliSourceIdentity())) throw new Error('Expected CLI package source differs from the current checkout.');
  requireCiSource(expected.source, expected, false);
  const manifest = parseManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), expected);
  const packedPackage: PackedCliPackage = { tarballPath: join(directory, 'daynight.tgz'), tarballSha256: manifest.tarballSha256,
    packageVersion: manifest.packageVersion, source: manifest.source };
  await loadPackedCliPackage(packedPackage);
  return { manifest, packedPackage };
};

export const prepareCliPackage = async (directory: string, producer: CliPackageProducer, cancellation: AbortController): Promise<PreparedCliPackage> => {
  cancellation.signal.throwIfAborted();
  if (!isAbsolute(directory)) throw new Error('CLI package directory must be absolute.');
  const producerContext = producerIdentity(producer);
  const source = readCliSourceIdentity();
  requireCiSource(source, producerContext, true);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  try {
    cancellation.signal.throwIfAborted();
    await owned(async (onSpawn) => { await command('pnpm', ['build'], { cwd: repositoryRoot, signal: cancellation.signal, timeoutMs: 180_000, onSpawn }); });
    const packedPackage = await owned(async (onSpawn) => await packCliPackage({ tarballPath: join(directory, 'daynight.tgz'), signal: cancellation.signal, onSpawn }));
    cancellation.signal.throwIfAborted();
    if (!sameSource(source, packedPackage.source) || !sameSource(source, readCliSourceIdentity())) throw new Error('CLI source changed while its package was being prepared.');
    requireCiSource(source, producerContext, true);
    const manifest: CliPackageManifest = { schemaVersion: 1, source, packageVersion: packedPackage.packageVersion,
      tarballSha256: packedPackage.tarballSha256, producer: producerContext };
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    cancellation.signal.throwIfAborted();
    return { manifest, packedPackage };
  } catch (error) {
    try { await rm(directory, { recursive: true, force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'CLI package preparation and cleanup failed.', { cause: error }); }
    throw error;
  }
};
