import { recoverAcceptance, runAcceptance, runContainerCallback } from './acceptance/runner.mts';

const cancellation = new AbortController();
const cancel = (): void => cancellation.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

try {
  if (process.argv.length === 3 && process.argv[2] === '--container') await runContainerCallback(cancellation);
  else if ((process.argv.length === 3 || process.argv.length === 4) && process.argv[2] === '--cleanup') await recoverAcceptance(cancellation, process.argv[3]);
  else if (process.argv.length === 3 && process.argv[2] === '--apfs') await runAcceptance(cancellation, { allowApfsImage: true });
  else if (process.argv.length === 2) await runAcceptance(cancellation);
  else throw new Error('Usage: node scripts/acceptance.mts [--apfs | --cleanup [run-id]]');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
