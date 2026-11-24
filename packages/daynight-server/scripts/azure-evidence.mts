import { createReadStream, existsSync, openSync, closeSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const prefix = 'github.com/codetreker/daynight/packages/daynight-server/';
const required = new Map<string, string[]>([
  [prefix + 'internal/core/filestorage/azure', ['TestAzurite', 'TestAzuriteArchiveStaging']],
  [prefix + 'internal/service', ['TestAzureStartupWithAzurite']],
  [prefix + 'internal/service/mcpdownload', ['TestAzureAttachmentDownloadSnapshotAndCleanup']],
  [prefix + 'internal/core/session', [
    'TestAzureImageCompletionIntegrityAndCleanup',
    'TestAzureImageCompletionIntegrityAndCleanup/length',
    'TestAzureImageCompletionIntegrityAndCleanup/digest',
    'TestAzureImageCompletionIntegrityAndCleanup/verified_and_cleanup_failure',
  ]],
]);

try {
  const [base, ...extra] = process.argv.slice(2);
  if (!base || extra.length) throw new Error('Usage: azure-evidence.mts MODULE_EVIDENCE_DIRECTORY');
  const runs = readdirSync(base, { withFileTypes: true }).filter(entry => entry.name.startsWith('run-'));
  if (runs.length !== 1 || !runs[0]!.isDirectory()) throw new Error('Expected exactly one module capture from this job.');
  const directory = join(base, runs[0]!.name);
  if (existsSync(join(directory, 'go-test.failed.json'))) throw new Error('Go test capture recorded a failure.');
  const marker = JSON.parse(readFileSync(join(directory, 'go-test.complete.json'), 'utf8'));
  const path = join(directory, 'go-test.jsonl');
  const size = statSync(path).size;
  if (marker.version !== 1 || !Number.isSafeInteger(marker.bytes) || marker.bytes <= 0 || marker.bytes !== size
      || marker.exitCode !== 0 || marker.signal !== null) throw new Error('Go test capture is incomplete or unsuccessful.');
  const fd = openSync(path, 'r');
  try {
    const last = Buffer.alloc(1);
    if (readSync(fd, last, 0, 1, size - 1) !== 1 || last[0] !== 10) throw new Error('Go test capture ends with an incomplete line.');
  } finally { closeSync(fd); }

  const counts = new Map<string, string[]>();
  const record = (key: string, action: string) => counts.set(key, [...(counts.get(key) ?? []), action]);
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    const event = JSON.parse(line);
    if (!event || typeof event !== 'object' || typeof event.Action !== 'string') throw new Error('Invalid Go test event.');
    const tests = required.get(event.Package);
    if (!tests) continue;
    if (event.Test === undefined) {
      if (['start', 'pass', 'fail', 'skip'].includes(event.Action)) record(event.Package, event.Action);
      continue;
    }
    if (typeof event.Test !== 'string') throw new Error('Invalid Go test identity.');
    const parent = tests.find(test => !test.includes('/') && (event.Test === test || event.Test.startsWith(test + '/')));
    if (!parent) continue;
    if (['fail', 'skip'].includes(event.Action)) throw new Error(`${event.Package} ${event.Test}: ${event.Action}`);
    if (tests.includes(event.Test) && ['run', 'pass'].includes(event.Action)) record(event.Package + ' ' + event.Test, event.Action);
  }
  for (const [pkg, tests] of required) {
    if (JSON.stringify(counts.get(pkg)) !== JSON.stringify(['start', 'pass'])) throw new Error(`${pkg}: expected one successful package execution.`);
    for (const test of tests) {
      if (JSON.stringify(counts.get(pkg + ' ' + test)) !== JSON.stringify(['run', 'pass'])) {
        throw new Error(`${pkg} ${test}: expected one passing test execution.`);
      }
    }
  }
  console.log('All required Azurite tests passed in the complete module capture.');
} catch (error) {
  console.error('Azure evidence validation failed:', error);
  process.exitCode = 1;
}
