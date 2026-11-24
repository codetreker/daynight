import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { sourceFingerprint } from './build.ts';
import { assertCommandQuiescence, runCommand } from './command.ts';

// Compute the expected fingerprint independently from the recovery checkout.
export const revisionFingerprint = async (repository: string, revision: string, directory: string): Promise<string> => {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Repair revision must be a complete commit ID.');
  const proofDirectory = await mkdtemp(path.join(directory, 'repair-source-proof-'));
  const checkout = path.join(proofDirectory, 'checkout');
  const git = async (cwd: string, args: string[]): Promise<string> =>
    (await runCommand('git', args, { cwd, timeoutMs: 120_000, onOutput: () => {} })).stdout.trim();
  try {
    await git(repository, ['clone', '--no-hardlinks', '--no-checkout', repository, checkout]);
    await git(checkout, ['checkout', '--quiet', '--detach', revision]);
    if (await git(checkout, ['rev-parse', 'HEAD']) !== revision || await git(checkout, ['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error('Repair source identity mismatch.');
    if (await git(checkout, ['status', '--porcelain=v1', '--untracked-files=normal'])) throw new Error('Repair source is not clean.');
    const fingerprint = await sourceFingerprint(checkout);
    if (await git(checkout, ['status', '--porcelain=v1', '--untracked-files=normal'])) throw new Error('Repair source changed during fingerprinting.');
    return fingerprint;
  } finally {
    // Unknown command outcomes retain the checkout for independent reconciliation.
    assertCommandQuiescence();
    await rm(proofDirectory, { recursive: true, force: true });
  }
};
