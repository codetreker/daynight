import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertCommandQuiescence, startCommand, type CommandOptions, type ManagedCommand } from './command.ts';
import { captureProcessEvidence } from './process-evidence.ts';
import { cleanupRecoveryResources, type RecoveryProcess, type RecoveryResource } from './subtask-compat-recovery-cleanup.ts';
import { runAuthenticatedRecovery } from './subtask-compat-recovery-real.ts';

const args = parseArgs({ options: { repository: { type: 'string' }, candidate: { type: 'string' }, baseline: { type: 'string' }, directory: { type: 'string' }, cleanup: { type: 'boolean', default: false }, 'legacy-diagnostic': { type: 'boolean', default: false }, 'candidate-artifact': { type: 'string' }, 'candidate-artifact-sha256': { type: 'string' }, 'candidate-manifest': { type: 'string' }, 'old-cli': { type: 'string' }, 'repair-revision': { type: 'string' }, 'repair-artifact': { type: 'string' }, 'repair-artifact-sha256': { type: 'string' } } }).values;
if (!args.repository || !args.directory || (!args.cleanup && (!args.candidate || !args.baseline)) || ([args['candidate-artifact'], args['candidate-artifact-sha256'], args['candidate-manifest']].filter(Boolean).length % 3 !== 0)) throw new Error('Recovery runner requires its repository, source revisions and report directory.');
const repository = path.resolve(args.repository), directory = path.resolve(args.directory), runtime = path.join(directory, 'private');
const legacyRepairRevision = 'e52039d43a62e5f8731a6917a7cb2eb437d6d155';
await mkdir(directory, { recursive: true, mode: 0o700 });
// The descriptor holds the advisory lock even after flock exits; the kernel
// releases it if the runner crashes, so compensation remains possible.
const lock = await open(path.join(directory, 'recovery.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
const lockProcess = spawn('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock.fd] });
const lockResult = await new Promise<number | null>((resolve, reject) => { lockProcess.once('error', reject); lockProcess.once('exit', resolve); });
if (lockResult !== 0) { await lock.close(); throw new Error('Recovery receipt is already in use.'); }
let existing: Record<string, unknown> | undefined;
if (args.cleanup) {
  existing = JSON.parse(await readFile(path.join(directory, 'recovery.json'), 'utf8')) as Record<string, unknown>;
  if (existing.schemaVersion === 1) {
    const priorResources = existing.resources as { network?: unknown } | undefined;
    const priorRunId = typeof priorResources?.network === 'string' ? /^daynight-compat-recovery-(.+)-network$/.exec(priorResources.network)?.[1] : undefined;
    existing = { ...existing, schemaVersion: 2, runId: priorRunId, originalStatus: existing.status, status: 'failed', originQuiescent: false, pendingDocker: [{ id: randomUUID(), operation: 'legacy outcome unconfirmed' }], legacyReceipt: true, fixtureVerification: { verified: false, reason: 'Legacy fixture did not establish authenticated container acceptance.' } };
  }
} else {
  try { await readFile(path.join(directory, 'recovery.json')); throw new Error('Recovery receipt already exists; use a new directory or --cleanup.'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
}
const runId = args.cleanup ? existing?.runId : randomUUID();
if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)) throw new Error('Invalid recovery run identity.');
const prefix = `daynight-compat-recovery-${runId}`;
const basicResources = { network: `${prefix}-network`, volume: `${prefix}-postgres-data`, postgres: `${prefix}-postgres`, redis: `${prefix}-redis` };
const extendedResources = { ...basicResources, ingress: `${prefix}-ingress`, auth: `${prefix}-auth`, old: `${prefix}-old`, candidate: `${prefix}-candidate`, repair: `${prefix}-repair`, controlled: `${prefix}-controlled`, image: `${prefix}-image:latest` };
const resources = existing?.schemaVersion === 2 ? basicResources : extendedResources;
if (existing && (![2, 3, 4].includes(existing.schemaVersion as number) || JSON.stringify(existing.resources) !== JSON.stringify(resources) || !Array.isArray(existing.pendingDocker) || typeof existing.originQuiescent !== 'boolean')) throw new Error('Recovery receipt identity or state is invalid.');
if (existing && existing.pendingProcesses === undefined) {
  existing.pendingProcesses = existing.originQuiescent === true ? [] : [{ id: randomUUID(), operation: 'prior command lifecycle unavailable', proof: null }];
}
if (existing && !Array.isArray(existing.pendingProcesses)) throw new Error('Recovery process evidence is invalid.');
const label = `daynight.compat.recovery=${runId}`;
const password = randomBytes(24).toString('hex');
const signal = new AbortController();
const cancel = (): void => signal.abort(new Error('Recovery interrupted.'));
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
if (!args.cleanup) {
  await mkdir(path.join(runtime, 'bin'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(runtime, 'storage'), { mode: 0o700 });
}
const receipt: Record<string, unknown> = existing ?? { schemaVersion: 4, runId, candidate: args.candidate, baseline: args.baseline, repair: args['legacy-diagnostic'] ? legacyRepairRevision : args['repair-revision'] ?? null, resources, status: 'running', phase: 'prepare', originQuiescent: false, pendingDocker: [], pendingProcesses: [], cleanup: { verified: false }, compensation: 'Run this script with --cleanup, --repository and --directory for this receipt; unresolved operations remain unverified.' };
let saveQueue: Promise<void> = Promise.resolve();
const save = async (): Promise<void> => {
  const data = `${JSON.stringify(receipt, null, 2)}\n`;
  const next = saveQueue.then(async () => {
    const temporary = path.join(directory, 'recovery.json.tmp');
    const file = await open(temporary, 'w', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path.join(directory, 'recovery.json'));
    const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
  });
  saveQueue = next.catch(() => {});
  await next;
};
await save();
const pending = receipt.pendingDocker as { id: string; operation: string }[];
const related = receipt.pendingProcesses as RecoveryProcess[];
const startRelated = async (name: string, values: readonly string[], options: CommandOptions, operation: string): Promise<ManagedCommand> => {
  const entry: RecoveryProcess = { id: randomUUID(), operation, proof: null };
  related.push(entry); await save();
  let child: ManagedCommand;
  try { child = startCommand(name, values, options); }
  catch (error) { related.splice(related.indexOf(entry), 1); await save(); throw error; }
  try {
    const proof = await captureProcessEvidence(child.pid);
    if (proof.pid === proof.group) { entry.proof = proof; await save(); }
  } catch { /* A missing original identity must never be replaced with a guess. */ }
  const finished = (async () => {
    let result: Awaited<ManagedCommand['finished']> | undefined, failure: unknown;
    try { result = await child.finished; } catch (error) { failure = error; }
    try {
      await child.stopProcesses();
      const index = related.indexOf(entry); if (index < 0) throw new Error('Original process evidence disappeared.');
      related.splice(index, 1);
      try { await save(); } catch (error) { related.push(entry); throw error; }
    } catch (error) {
      throw failure === undefined ? error : new AggregateError([failure, error], 'Related process stop was not confirmed.');
    }
    if (failure !== undefined) throw failure;
    return result!;
  })();
  void finished.catch(() => {});
  return { ...child, finished, stop: async () => { await child.stopProcesses(); await finished; } };
};

const mutation = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
  const intent = { id: randomUUID(), operation };
  pending.push(intent); await save();
  const result = await action();
  pending.splice(pending.indexOf(intent), 1);
  try { await save(); } catch (error) { pending.push(intent); throw error; }
  return result;
};
const command = async (name: string, values: string[], cwd = repository, timeoutMs = 120_000, environment = process.env) => {
  const executable = path.basename(name);
  const operation = ['git', 'go', 'docker', 'openssl'].includes(executable) ? `${executable} ${values[0] ?? ''}` : executable;
  receipt.command = operation; await save();
  console.log(`Recovery command: ${operation} (${String(receipt.phase)})`);
  const execute = async () => {
    const child = await startRelated(name, values, { cwd, env: environment, signal: signal.signal, timeoutMs, onOutput: () => {} }, operation);
    try {
      const result = await child.finished;
      if (result.exitCode !== 0) throw new Error(`Command exited with status ${result.exitCode}.`);
      return result;
    } catch (error) {
      const diagnostic = child.diagnostics();
      const source = `${diagnostic.stdout}\n${diagnostic.stderr}`;
      const codes = [...new Set(source.match(/\b(?:ERR_[A-Z0-9_]+|E[A-Z]{2,})\b/g) ?? [])].slice(0, 20);
      const locations = [...new Set(source.match(/\b[A-Za-z0-9_.-]+\.(?:go|ts|tsx|mts):\d+(?::\d+)?/g) ?? [])].slice(0, 20);
      const categories = [
        [/temporary failure resolving|could not resolve|name resolution|no such host/i, 'dns-resolution'],
        [/connection refused/i, 'connection-refused'], [/permission denied/i, 'permission-denied'],
        [/no space left/i, 'storage-full'], [/timed? out|deadline exceeded/i, 'timeout'],
        [/not found|no such file or directory/i, 'not-found'],
      ].filter(([pattern]) => (pattern as RegExp).test(source)).map(([, category]) => category);
      const details = { phase: receipt.phase, command: operation, category: error instanceof Error ? error.name : 'unknown', exit: diagnostic.exit, truncated: diagnostic.truncated, codes, locations, categories };
      await writeFile(path.join(directory, 'failure.json'), `${JSON.stringify(details, null, 2)}\n`, { mode: 0o600 });
      const readback = JSON.parse(await readFile(path.join(directory, 'failure.json'), 'utf8')) as { phase?: unknown; command?: unknown };
      if (readback.phase !== receipt.phase || readback.command !== operation) throw new Error('Failure diagnostic readback mismatch.');
      receipt.failure = { phase: receipt.phase, command: operation, path: 'failure.json' }; await save();
      throw new Error(`Recovery ${operation} failed; see failure.json.`, { cause: error });
    }
  };
  return name === 'docker' ? await mutation(operation, execute) : await execute();
};
const observe = async (values: string[], timeoutMs = 15_000) => await (await startRelated('docker', values, { cwd: repository, env: process.env, timeoutMs, onOutput: () => {} }, 'docker observation')).finished;
const clone = async (name: string, revision: string): Promise<string> => {
  const destination = path.join(runtime, name);
  receipt.phase = `clone-${name}`; await save();
  await command('git', ['clone', '--no-hardlinks', '--no-checkout', repository, destination]);
  await command('git', ['checkout', '--detach', revision], destination);
  const head = await command('git', ['rev-parse', 'HEAD'], destination);
  const shallow = await command('git', ['rev-parse', '--is-shallow-repository'], destination);
  if (head.stdout.trim() !== revision || shallow.stdout.trim() !== 'false') throw new Error(`${name} source identity mismatch.`);
  return destination;
};
const overlay = async (source: string, name: string): Promise<string> => {
  const module = path.join(source, 'packages/daynight-server');
  const raw = JSON.parse(await readFile(path.join(module, 'scripts/unit-overlay.json'), 'utf8')) as { Replace: Record<string, string> };
  const mapping = Object.fromEntries(Object.entries(raw.Replace).map(([from, to]) => [path.join(module, from), path.join(module, to)]));
  const filename = path.join(runtime, `${name}-overlay.json`);
  await writeFile(filename, JSON.stringify({ Replace: mapping }));
  return filename;
};
const cache = path.join(repository, '.tmp', 'product-e2e-cache');
const buildEnv = { ...process.env, GOCACHE: path.join(cache, 'go-build'), GOMODCACHE: path.join(cache, 'go-mod'), GOPATH: path.join(cache, 'go'), GOENV: 'off', GOTOOLCHAIN: 'go1.27.2', CGO_ENABLED: '0', CI: 'true' };
const hash = async (filename: string): Promise<string> => createHash('sha256').update(await readFile(filename)).digest('hex');
const address = async (container: string): Promise<string> => {
  const result = await observe(['container', 'inspect', container]);
  if (result.exitCode !== 0) throw new Error(`Could not inspect ${container} network.`);
  const objects = JSON.parse(result.stdout) as { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }[];
  const ip = objects[0]?.NetworkSettings?.Networks?.[resources.network]?.IPAddress;
  if (!ip || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) throw new Error(`Could not resolve ${container} internal address.`);
  return ip;
};
const waitReady = async (container: string, values: string[]): Promise<void> => {
  const until = performance.now() + 60_000;
  while (performance.now() < until) {
    signal.signal.throwIfAborted();
    const result = await observe(['exec', container, ...values]);
    if (result.exitCode === 0) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${container} did not become ready.`);
};
const inspectOwned = async (kind: 'container' | 'network' | 'volume' | 'image', name: string, inspect = observe): Promise<boolean> => {
  const observed = await inspect([kind, 'inspect', name]);
  if (observed.exitCode !== 0) {
    const missing = [`no such ${kind}: ${name}`, `no such object: ${name}`,
      ...(kind === 'network' ? [`network ${name} not found`] : []),
      ...(kind === 'volume' ? [`get ${name}: no such volume`] : [])];
    if (observed.exitCode === 1 && missing.some(value => observed.stderr.toLowerCase().includes(value.toLowerCase()))) return false;
    throw new Error(`Could not inspect owned ${kind} ${name}.`);
  }
  const objects = JSON.parse(observed.stdout) as { Config?: { Labels?: Record<string, string> }; Labels?: Record<string, string> }[];
  const labels = objects[0]?.Config?.Labels ?? objects[0]?.Labels;
  if (labels?.['daynight.compat.recovery'] !== runId) throw new Error(`Ownership label mismatch for ${kind} ${name}.`);
  return true;
};
let failure: unknown;
try {
  if (args.cleanup) throw new Error('Compensation only.');
  if (!args['legacy-diagnostic']) {
    const result = await runAuthenticatedRecovery({ repository, directory, runtime, candidate: args.candidate!, baseline: args.baseline!, runId,
      repair: args['repair-revision'] && args['repair-artifact'] && args['repair-artifact-sha256'] ? { revision: args['repair-revision'], artifact: path.resolve(args['repair-artifact']), sha256: args['repair-artifact-sha256'] } : undefined,
      resources: extendedResources, signal: signal.signal, command, observe, clone, mutation, startRelated,
      oldCli: args['old-cli'] ? path.resolve(args['old-cli']) : undefined,
      sharedCandidate: args['candidate-artifact'] ? { binary: path.resolve(args['candidate-artifact']), sha256: args['candidate-artifact-sha256']!, manifest: path.resolve(args['candidate-manifest']!) } : undefined,
      phase: async name => { receipt.phase = name; await save(); },
      browserOwner: async name => { receipt.browserOwner = name; await save(); },
      evidence: async (stage, value) => { const evidence = (receipt.evidence ??= {}) as Record<string, unknown>; evidence[stage] = value; await save(); } });
    receipt.fixture = result.fixture; receipt.artifacts = result.artifacts; receipt.recovery = result.recovery;
    receipt.fixtureVerification = { verified: true, mode: 'normal-login-baseline-container' };
    receipt.acceptance = { authentication: 'normal', execution: 'dedicated-container' };
    receipt.phase = 'complete'; receipt.status = 'passed';
  } else {
  const candidate = await clone('candidate', args.candidate!);
  const baseline = await clone('old', args.baseline!);
  const repair = await clone('repair', legacyRepairRevision);
  const candidateTree = await command('git', ['rev-parse', `${args.candidate}:packages/daynight-server`]);
  const repairTree = await command('git', ['rev-parse', `${legacyRepairRevision}:packages/daynight-server`]);
  if (candidateTree.stdout.trim() !== repairTree.stdout.trim()) throw new Error('The confirmed replacement no longer has the candidate Server tree.');
  receipt.phase = 'prepare-probe'; await save();
  const probe = await readFile(path.join(repository, 'packages/e2e_tests/src/subtask-compat-recovery-test.go.txt'));
  receipt.phase = 'build-production-candidate'; await save();
  // Build in the private clone; dependency links are read-only inputs from the shared checkout.
  await symlink(path.join(repository, 'node_modules'), path.join(candidate, 'node_modules'), 'dir');
  await symlink(path.join(repository, 'packages/daynight-web/node_modules'), path.join(candidate, 'packages/daynight-web/node_modules'), 'dir');
  const candidateWeb = path.join(candidate, 'packages/daynight-web');
  await command(path.join(repository, 'packages/daynight-web/node_modules/.bin/tsc'), ['--project', 'tsconfig.build.json'], candidateWeb, 600_000, buildEnv);
  await command(path.join(repository, 'packages/daynight-web/node_modules/.bin/vite'), ['build'], candidateWeb, 600_000, buildEnv);
  await command(process.execPath, ['scripts/publish-assets.mts'], candidateWeb, 60_000, buildEnv);
  await rm(path.join(candidateWeb, 'node_modules'));
  await rm(path.join(candidate, 'node_modules'));
  await command('go', ['build', '-trimpath', '-o', path.join(runtime, 'bin/server-candidate'), './cmd/daynight-server'], path.join(candidate, 'packages/daynight-server'), 600_000, buildEnv);
  const candidateBuildInfo = await command('go', ['version', '-m', path.join(runtime, 'bin/server-candidate')]);
  if (!candidateBuildInfo.stdout.includes(`\tbuild\tvcs.revision=${args.candidate}\n`) || !candidateBuildInfo.stdout.includes('\tbuild\tvcs.modified=false\n')) throw new Error('Production candidate build identity mismatch.');
  receipt.phase = 'prepare-legacy-test'; await save();
  await writeFile(path.join(candidate, 'packages/daynight-server/cmd/daynight-server/s1_recovery_evidence_test.go'), probe);
  const helper = path.join(candidate, 'packages/daynight-server/cmd/daynight-server/webhook_controlled_lifecycle_test.go');
  const original = await readFile(helper, 'utf8');
  const adapted = original.replace('_, daynightRoot, err := parseCommand(', 'options, err := parseCommand(').replace('config.LoadServer(daynightRoot, os.LookupEnv)', 'config.LoadServer(options.root, os.LookupEnv)');
  if (adapted === original || adapted.includes('_, daynightRoot, err := parseCommand(') || adapted.includes('config.LoadServer(daynightRoot, os.LookupEnv)')) throw new Error('Controlled Webhook helper adaptation did not match the reviewed candidate.');
  await writeFile(helper, adapted);
  const [candidateOverlay, oldOverlay, repairOverlay] = await Promise.all([overlay(candidate, 'candidate'), overlay(baseline, 'old'), overlay(repair, 'repair')]);
  for (const [source, overlayFile, binary] of [[baseline, oldOverlay, 'server122'], [repair, repairOverlay, 'server-repair']] as const) {
    await command('go', ['build', '-trimpath', `-overlay=${overlayFile}`, '-o', path.join(runtime, 'bin', binary), './cmd/daynight-server'], path.join(source, 'packages/daynight-server'), 600_000, buildEnv);
  }
  receipt.artifacts = { candidate: await hash(path.join(runtime, 'bin/server-candidate')), candidateBuildRevision: args.candidate, candidateWeb: 'production build', server122: await hash(path.join(runtime, 'bin/server122')), repair: await hash(path.join(runtime, 'bin/server-repair')), candidateServerTree: candidateTree.stdout.trim(), baselineWeb: 'unit fixture overlay', repairWeb: 'unit fixture overlay', testHelperWeb: 'unit fixture overlay', probeSHA256: await hash(path.join(repository, 'packages/e2e_tests/src/subtask-compat-recovery-test.go.txt')) };
  receipt.phase = 'prepare-containers'; await save();
  await writeFile(path.join(runtime, 'postgres.env'), `POSTGRES_USER=daynight\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=daynight\n`, { mode: 0o600 });
  await command('docker', ['network', 'create', '--internal', '--label', label, resources.network]);
  await command('docker', ['volume', 'create', '--label', label, resources.volume]);
  await command('docker', ['run', '--detach', '--name', resources.postgres, '--label', label, '--network', resources.network, '--env-file', path.join(runtime, 'postgres.env'), '--mount', `type=volume,src=${resources.volume},dst=/var/lib/postgresql`, 'postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650']);
  await command('docker', ['run', '--detach', '--name', resources.redis, '--label', label, '--network', resources.network, 'redis:8.10.3@sha256:1f88291b4c57bdf249f02eb085a8669889b2d2954e91d4de5118a5da6b78dd53', 'redis-server', '--save', '', '--appendonly', 'no', '--maxmemory', '64mb', '--maxmemory-policy', 'noeviction']);
  await waitReady(resources.postgres, ['pg_isready', '-h', '127.0.0.1', '-U', 'daynight', '-d', 'daynight']);
  await waitReady(resources.redis, ['redis-cli', 'ping']);
  const postgresAddress = await address(resources.postgres), redisAddress = await address(resources.redis);
  const wrapper = `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);const i=args.indexOf('--dbname');if(i<0)process.exit(2);const u=new URL(args[i+1]);u.hostname='127.0.0.1';u.port='5432';args[i+1]=u.toString();const r=spawnSync('docker',['exec',${JSON.stringify(resources.postgres)},'pg_dump',...args],{stdio:'inherit'});process.exit(r.status??1);\n`;
  await writeFile(path.join(runtime, 'bin/pg_dump'), wrapper, { mode: 0o700 });
  const env = { ...buildEnv, V1_RUNTIME: runtime, DAYNIGHT_TEST_DATABASE_URL: `postgres://daynight:${password}@${postgresAddress}:5432/daynight?sslmode=disable`, DAYNIGHT_TEST_REDIS_URL: `redis://${redisAddress}:6379/0` };
  const selected = 'TestS1PairedRecoveryEvidence|TestV1PrecommitLockFailureRestoresOldServer|TestTaskAncestorMigrationCommittedStartupFailureAndRecovery|TestWorkerActiveClaimMigrationProcessRecovery|TestServerProcessMigrationFailuresNeverListenAndRecover';
  receipt.phase = 'go-test'; await save();
  let pendingTestOutput = '';
  let lastTest: string | null = null;
  const test = await startRelated('go', ['test', '-v', '-count=1', '-timeout=3m', `-overlay=${candidateOverlay}`, '-tags=startupshutdown,webhooktest,s1evidence', '-run', selected, './cmd/daynight-server'], {
    cwd: path.join(candidate, 'packages/daynight-server'), env, signal: signal.signal, timeoutMs: 420_000,
    onOutput: (channel, chunk) => {
      if (channel !== 'stdout') return;
      const lines = (pendingTestOutput + chunk).split('\n');
      pendingTestOutput = lines.pop()!.slice(-4096);
      for (const line of lines) {
        const running = line.match(/^\s*=== RUN\s+([A-Za-z0-9_\/-]+)\s*$/);
        if (running) lastTest = running[1]!;
        if (/^\s*(?:=== RUN\s+|--- (?:PASS|FAIL|SKIP):\s+)[A-Za-z0-9_\/-]+(?: \([0-9.]+s\))?\s*$/.test(line)) console.log(line);
      }
    },
  }, 'go test');
  let result;
  try { result = await test.finished; }
  finally {
    const diagnostic = test.diagnostics();
    // Only Go test protocol lines and file/line locations are retained. Arbitrary
    // failure text can contain generated PATs, URLs, request bodies or secrets.
    const sanitize = (output: string): string => output.split('\n').map(line => {
      const marker = line.match(/^\s*((?:=== (?:RUN|PAUSE|CONT)\s+|--- (?:PASS|FAIL|SKIP):\s+)[A-Za-z0-9_\/-]+(?: \([0-9.]+s\))?|PASS|FAIL(?:\s+[A-Za-z0-9_./-]+)?|ok\s+[A-Za-z0-9_./-]+\s+[0-9.]+s)$/);
      if (marker) return marker[1]!;
      const evidence = line.match(/external_effect=(?:true|false) receiver_requests=\d+ effect_sha256=(?:none|[a-f0-9]+) snapshot_sha256=[a-f0-9]+ ledger_preserved=(?:true|false) attachment_restored=(?:true|false) post_upgrade_write_removed=(?:true|false) endpoint_reconciliation=(?:true|false)/);
      if (evidence) return evidence[0];
      for (const proof of [
        'production candidate ready on migrated ledger; HTTP GET/PUT/GET succeeded',
        'controlled Webhook transport process used for external-effect boundary',
        'after candidate committed migration and failed listener, distinct e520 repair build ready on candidate124 ledger; HTTP GET/PUT/GET succeeded; exact ledger unchanged',
        'actual old122 historical deleted Goal: visibility, parent, status, version and updated_at preserved; child backfilled',
        'candidate lock deadline before commit; fresh connection confirms identical baseline122 ledger; actual old server returned ready',
      ]) if (line.endsWith(proof)) return proof;
      const location = line.match(/^\s*([^\s/:]+\.go:\d+(?::\d+)?):/);
      if (location) {
        const words = [...line.matchAll(/\b(timed out|timeout|failed|failure|unexpected|mismatch|not ready|not found|refused|changed|did not|undefined|error)\b/gi)].map(match => match[0]!.toLowerCase());
        return `${location[1]}: diagnostic redacted${words.length ? `; keywords: ${[...new Set(words)].join(', ')}` : ''}`;
      }
      return '';
    }).filter(Boolean).join('\n');
    await writeFile(path.join(directory, 'recovery.log'), JSON.stringify({ phase: 'go-test', exit: diagnostic.exit, truncated: diagnostic.truncated, stdout: sanitize(diagnostic.stdout), stderr: sanitize(diagnostic.stderr) }, null, 2) + '\n', { mode: 0o600 });
    receipt.testDiagnostics = { path: 'recovery.log', lastTest, exit: diagnostic.exit, truncated: diagnostic.truncated }; await save();
  }
  if (result.exitCode !== 0) throw new Error(`Recovery go test failed (exit=${result.exitCode}); see recovery.log.`);
  const names = ['TestS1PairedRecoveryEvidence', 'TestV1PrecommitLockFailureRestoresOldServer', 'TestTaskAncestorMigrationCommittedStartupFailureAndRecovery', 'TestWorkerActiveClaimMigrationProcessRecovery', 'TestServerProcessMigrationFailuresNeverListenAndRecover'];
  for (const name of names) if (!result.stdout.includes(`--- PASS: ${name} `)) throw new Error(`Recovery test did not pass: ${name}`);
  for (const value of ['external_effect=false receiver_requests=0', 'external_effect=true receiver_requests=1', 'ledger_preserved=true attachment_restored=true post_upgrade_write_removed=true', 'production candidate ready on migrated ledger; HTTP GET/PUT/GET succeeded', 'controlled Webhook transport process used for external-effect boundary']) if (!result.stdout.includes(value)) throw new Error(`Recovery evidence missing: ${value}`);
  receipt.diagnosticTests = names;
  receipt.phase = 'fixture-verification';
  receipt.fixtureVerification = { verified: false, reason: 'Normal UniAuth login, baseline-created Goal and dedicated recovery container are not established by this probe.' };
  await save();
  throw new Error('Legacy diagnostic is not authenticated container acceptance.');
  }
} catch (error) {
  if (!args.cleanup) {
    failure = error; receipt.status = 'failed';
    if (!receipt.failure) {
      const allowed = new Set(['UniAuth source identity mismatch.', 'Repair Server tree differs from candidate.', 'Controlled Webhook seam adaptation failed.',
        'Recovery acceptance incomplete: authenticated container fixture is not implemented.', 'Legacy diagnostic is not authenticated container acceptance.', 'Baseline npm CLI artifact is required.', 'Baseline npm CLI integrity mismatch.', 'Repair artifact identity is invalid.', 'Repair artifact digest mismatch.', 'Repair artifact provenance or reproducible build mismatch.', 'Candidate artifact build settings do not match registry extraction.', 'Candidate build settings are ambiguous.', 'Recovery build platform is unsupported.', 'The task migration is not the first pending migration.', 'Baseline ledger does not match its registry.', 'Candidate startup left a partial migration ledger.', 'Candidate startup ledger does not match its registry.', 'Candidate startup outcome is unconfirmed; listener retained.', 'Explicit repair artifact, revision and SHA-256 are required.', 'Candidate combination artifact is required.', 'Repair migration registry differs from candidate.', 'Baseline migration registry is not a strict candidate prefix.',
        'Baseline ledger is not 122.', 'Precommit failure changed baseline ledger.', 'Committed migration or historical Goal backfill mismatch.',
        'Restored ledger differs from backup.', 'Post-upgrade write remains after restore.', 'Unexpected Webhook delivery before migration.',
        'Recovery browser failed waiting for auth-ready.', 'Recovery browser failed waiting for fixture-ready.', 'Recovery browser failed waiting for verified.']);
      const message = error instanceof Error && (allowed.has(error.message) || (/^Recovery browser failed at [a-z-]+ \((?:Error|TimeoutError|AssertionError|unknown)\)(?: [a-z0-9-]+)?\.$/.test(error.message) || /^Recovery browser (?:timed out|exited) at [a-z-]+ waiting for [a-z-]+\.$/.test(error.message) || /^Selected Server exited before readiness \(exit=\d+\)\.$/.test(error.message))) ? error.message : 'Details withheld; inspect the phase and command.';
      const location = error instanceof Error ? error.stack?.match(/subtask-compat-recovery-[a-z-]+\.ts:\d+(?::\d+)?/)?.[0] : undefined;
      const details = { phase: receipt.phase, command: receipt.command ?? null, category: error instanceof Error ? error.name : 'unknown', message, location: location ?? null };
      await writeFile(path.join(directory, 'failure.json'), `${JSON.stringify(details, null, 2)}\n`, { mode: 0o600 });
      JSON.parse(await readFile(path.join(directory, 'failure.json'), 'utf8'));
      receipt.failure = { phase: receipt.phase, command: receipt.command ?? null, path: 'failure.json' };
    }
  }
}
finally {
  const cleanupFailures: unknown[] = [];
  const cleanupDeadline = performance.now() + 120_000;
  const cleanupObserve = async (values: string[]) => {
    const remaining = cleanupDeadline - performance.now();
    if (remaining <= 0) throw new Error('Recovery cleanup deadline exceeded.');
    return await observe(values, Math.min(15_000, remaining));
  };
  let quiescent = true;
  try { assertCommandQuiescence(); }
  catch (error) { quiescent = false; cleanupFailures.push(error); }
  if (!args.cleanup) receipt.originQuiescent = quiescent;
  // Cleanup has an independent deadline and never inherits the cancelled signal.
  // Unknown Docker requests remain unknown even after observing their resources.
  const extra = resources as Partial<typeof extendedResources>;
  const cleanupResources: RecoveryResource[] = [
    ...([extra.controlled, extra.repair, extra.candidate, extra.old, extra.auth].filter((value): value is string => value !== undefined).map(name => ({ kind: 'container' as const, name }))),
    { kind: 'container', name: resources.redis }, { kind: 'container', name: resources.postgres }, { kind: 'volume', name: resources.volume },
    ...(extra.ingress ? [{ kind: 'network' as const, name: extra.ingress }] : []), { kind: 'network', name: resources.network },
    ...(extra.image ? [{ kind: 'image' as const, name: extra.image }] : []),
  ];
  const cleanup = await cleanupRecoveryResources({ repository, runId, mode: args.cleanup ? 'independent' : 'owner', browserOwner: receipt.browserOwner,
    processes: related, resources: cleanupResources, deadline: Date.now() + Math.max(0, cleanupDeadline - performance.now()), save,
    inspect: async resource => await inspectOwned(resource.kind, resource.name, cleanupObserve),
    stop: async resource => await mutation(`stop ${resource.kind} ${resource.name}`, async () => {
      const stopped = await cleanupObserve(['stop', '--time', '10', resource.name]);
      if (stopped.exitCode !== 0) throw new Error(`Could not stop owned ${resource.kind} ${resource.name}.`);
    }),
    remove: async resource => await mutation(`remove ${resource.kind} ${resource.name}`, async () => {
      const removed = await cleanupObserve([resource.kind, 'rm', resource.name]);
      if (removed.exitCode !== 0) throw new Error(`Could not remove owned ${resource.kind} ${resource.name}.`);
    }),
  });
  cleanupFailures.push(...cleanup.failures);
  const verified = quiescent && receipt.originQuiescent === true && cleanup.usersStopped && pending.length === 0 && cleanupFailures.length === 0;
  if (!verified && cleanupFailures.length === 0) cleanupFailures.push(new Error('Recovery cleanup remains unverified.'));
  receipt.cleanup = { verified, quiescent, originQuiescent: receipt.originQuiescent, pendingDocker: pending.length, usersStopped: cleanup.usersStopped, pendingProcesses: related.length, observations: cleanup.observations, failures: cleanupFailures.map(String) };
  if (verified) {
    await rm(runtime, { recursive: true, force: true });
    if (typeof receipt.browserOwner === 'string') await rm(receipt.browserOwner, { recursive: true, force: true });
  }
  if (!verified) receipt.status = 'failed';
  await save();
  await lock.close();
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  if (cleanupFailures.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupFailures], 'Recovery or cleanup failed; retained evidence identifies the run.');
}
if (failure !== undefined) throw failure;
if (args.cleanup) {
  if (!(receipt.cleanup as { verified: boolean }).verified) throw new Error('Compensation observations are recorded; unresolved outcomes remain unverified. Repeat after external resolution.');
  console.log(`Recovery resources removed: ${path.join(directory, 'recovery.json')}`);
} else console.log(`Recovery passed: ${path.join(directory, 'recovery.json')}`);
