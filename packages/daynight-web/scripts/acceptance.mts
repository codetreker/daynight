import { recoverAcceptance, runAcceptance, runContainerCallback } from './acceptance/runner.mts';
import { parseAcceptanceArguments } from './acceptance/arguments.mts';
import { readCliPackage } from './acceptance/cli-package.mts';
import { readCliSourceIdentity } from '../../daynight/test/fixtures/installed-cli.ts';

const cancellation = new AbortController();
const cancel = (): void => cancellation.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);

try {
  const invocation = parseAcceptanceArguments(process.argv.slice(2));
  if (invocation.command === 'callback') await runContainerCallback(cancellation);
  else if (invocation.command === 'cleanup') await recoverAcceptance(cancellation, invocation.runId);
  else {
    const packed = invocation.package;
    const prepared = packed === undefined ? undefined : await readCliPackage(packed.directory, {
      source: readCliSourceIdentity(), runId: packed.runId, originAttempt: packed.originAttempt,
    });
    await runAcceptance(cancellation, { scope: invocation.scope, allowApfsImage: invocation.allowApfsImage,
      ...(prepared === undefined ? {} : { packedPackage: prepared.packedPackage }) });
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
