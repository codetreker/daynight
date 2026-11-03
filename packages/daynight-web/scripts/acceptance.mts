import { recoverAcceptance, runAcceptance, runContainerCallback } from './acceptance/runner.mts';

const cancellation = new AbortController();
const cancel = (): void => cancellation.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--container') await runContainerCallback(cancellation);
  else if ((args.length === 1 || args.length === 2 && !args[1]!.startsWith('--')) && args[0] === '--cleanup') await recoverAcceptance(cancellation, args[1]);
  else if (args.every((value) => value === '--apfs' || value === '--stress') && new Set(args).size === args.length) {
    await runAcceptance(cancellation, { allowApfsImage: args.includes('--apfs'), stress: args.includes('--stress') });
  } else throw new Error('Usage: node scripts/acceptance.mts [--apfs] [--stress] | --cleanup [run-id]');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
