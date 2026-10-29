import { resolve } from 'node:path';
import { readAcceptanceScope, type AcceptanceScope } from './inventory.mts';

export const acceptanceUsage = 'Usage: node scripts/acceptance.mts [--target all|native|container] [--apfs] [--cli-package <directory> --producer-run <run-id> --producer-attempt <attempt>] | --cleanup [run-id]';
type PackageArguments = { directory: string; runId: string; originAttempt: number };
export type AcceptanceArguments = { command: 'callback' } | { command: 'cleanup'; runId: string | undefined }
  | { command: 'acceptance'; scope: AcceptanceScope; allowApfsImage: boolean; package: PackageArguments | undefined };
const invalid: () => never = () => { throw new Error(acceptanceUsage); };

export const parseAcceptanceArguments = (args: readonly string[]): AcceptanceArguments => {
  if (args.length === 1 && args[0] === '--container') return { command: 'callback' };
  if (args[0] === '--cleanup') {
    if (args.length > 2 || args[1]?.startsWith('--')) invalid();
    return { command: 'cleanup', runId: args[1] };
  }
  let scope: AcceptanceScope = 'all';
  let allowApfsImage = false;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    if (option === '--apfs') {
      if (allowApfsImage) invalid();
      allowApfsImage = true;
      continue;
    }
    if (!['--target', '--cli-package', '--producer-run', '--producer-attempt'].includes(option) || values.has(option)) invalid();
    const value = args[++index];
    if (value === undefined || value === '' || value.startsWith('--')) invalid();
    values.set(option, value);
  }
  if (values.has('--target')) {
    try { scope = readAcceptanceScope(values.get('--target')); }
    catch { invalid(); }
  }
  if (scope === 'container' && allowApfsImage) invalid();
  const packageKeys = ['--cli-package', '--producer-run', '--producer-attempt'];
  const packageValues = packageKeys.filter((key) => values.has(key));
  let packed: PackageArguments | undefined;
  if (packageValues.length !== 0) {
    if (packageValues.length !== packageKeys.length) invalid();
    const directory = values.get('--cli-package')!;
    const runId = values.get('--producer-run')!;
    const attempt = values.get('--producer-attempt')!;
    if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(attempt) || !Number.isSafeInteger(Number(attempt))) invalid();
    packed = { directory: resolve(directory), runId, originAttempt: Number(attempt) };
  }
  return { command: 'acceptance', scope, allowApfsImage, package: packed };
};
