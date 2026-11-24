import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { sourceFingerprint } from './build.ts';
import { fallbackBaseline, fallbackPatchSHA256, verifyCandidateBuild, verifyCandidateCombination, verifyFallbackArtifact, verifyRepairArtifact } from './subtask-compat-recovery-provenance.ts';
import { readRegisteredMigrations } from './subtask-compat-recovery-manifest.ts';
import { migrationLedgerQuery, migrationManifestHash, observeMigrationLedger, requireMigrationPlan, requireSettledCandidateLedger, type MigrationEntry } from './subtask-compat-recovery-migrations.ts';
import { type CommandOptions, type ManagedCommand, type CommandResult } from './command.ts';
import { initializeRunOwnership, startOwnedPlaywright } from './fixture-owner.ts';
import { recoveryControl } from './subtask-compat-recovery-control.ts';

type Resources = { network: string; ingress: string; volume: string; postgres: string; redis: string; auth: string; old: string; candidate: string; repair: string; controlled: string; image: string };
type Context = {
  repository: string; directory: string; runtime: string; candidate: string; baseline: string; repair?: { revision: string; artifact: string; sha256: string }; runId: string; resources: Resources; signal: AbortSignal;
  command: (name: string, values: string[], cwd?: string, timeoutMs?: number, environment?: NodeJS.ProcessEnv) => Promise<CommandResult>;
  observe: (values: string[]) => Promise<CommandResult>;
  clone: (name: string, revision: string) => Promise<string>;
  mutation: <T>(operation: string, action: () => Promise<T>) => Promise<T>;
  startRelated: (name: string, values: readonly string[], options: CommandOptions, operation: string) => Promise<ManagedCommand>;
  phase: (name: string) => Promise<void>;
  browserOwner: (directory: string) => Promise<void>;
  evidence: (stage: string, value: Record<string, unknown>) => Promise<void>;
  sharedCandidate?: { binary: string; sha256: string; manifest: string };
  oldCli?: string;
};
type Fixture = { user: string; project: string; goal: string; child: string; hiddenGoal: string; hiddenChild: string; endpoint: string; token: string };
const postgresImage = 'postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650';
const redisImage = 'redis:8.10.3@sha256:1f88291b4c57bdf249f02eb085a8669889b2d2954e91d4de5118a5da6b78dd53';
const nodeImage = 'node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const authRevision = '0978963813fcefd9d553f6cb9bcc319084c764b3';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');
const hashTree = async (root: string): Promise<string> => {
  const digest = createHash('sha256');
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${prefix}${entry.name}`, filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename, `${name}/`);
      else if (entry.isFile()) digest.update(name).update('\0').update(await readFile(filename)).update('\0');
      else throw new Error('Attachment backup contains a nonregular entry.');
    }
  };
  await walk(root, ''); return digest.digest('hex');
};
const pause = async (ms: number, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted(); await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); }; signal.addEventListener('abort', abort, { once: true });
  });
};
const reservePorts = async (): Promise<number[]> => {
  const listeners: Server[] = [], ports: number[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      const server = createServer(); listeners.push(server);
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('Port allocation failed.'); ports.push(addr.port);
    }
  } finally { for (const server of listeners) if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  return ports;
};

export const runAuthenticatedRecovery = async (ctx: Context): Promise<Record<string, unknown>> => {
  const { repository, runtime, directory, resources, signal, command, observe } = ctx;
  if (!ctx.oldCli) throw new Error('Baseline npm CLI artifact is required.');
  if (!ctx.sharedCandidate) throw new Error('Candidate combination artifact is required.');
  if (!ctx.repair) throw new Error('Explicit repair artifact, revision and SHA-256 are required.');
  if (!/^[a-f0-9]{40}$/.test(ctx.repair.revision) || !/^[a-f0-9]{64}$/.test(ctx.repair.sha256)) throw new Error('Repair artifact identity is invalid.');
  if (ctx.baseline !== fallbackBaseline) throw new Error('The fallback patch requires its fixed baseline.');
  const oldCliIntegrity = 'sha512-T85y9vOcRHjHvjFImEoDpOs25JxQkfSOLkSbmwUgVZi8S/KsQnVx3EJ5+r6Q/vwoGEP64HIPKdNHdUOVxpDe9w==';
  const integrity = async (): Promise<string> => `sha512-${createHash('sha512').update(await readFile(ctx.oldCli!)).digest('base64')}`;
  if (await integrity() !== oldCliIntegrity) throw new Error('Baseline npm CLI integrity mismatch.');
  const cache = path.join(repository, '.tmp', 'product-e2e-cache');
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined;
  if (process.platform !== 'linux' || architecture === undefined) throw new Error('Recovery build platform is unsupported.');
  const env = { ...process.env, GOCACHE: path.join(cache, 'go-build'), GOMODCACHE: path.join(cache, 'go-mod'), GOPATH: path.join(cache, 'go'), GOENV: 'off', GOWORK: 'off', GOFLAGS: '', GOEXPERIMENT: '', GOTOOLCHAIN: 'go1.27.2', CGO_ENABLED: '0', GOOS: 'linux', GOARCH: architecture,
    ...(architecture === 'amd64' ? { GOAMD64: 'v1' } : { GOARM64: 'v8.0' }), CI: 'true' };
  const artifacts = path.join(runtime, 'artifacts'), run = path.join(runtime, 'run'), privateDir = path.join(run, 'private');
  await mkdir(artifacts, { recursive: true, mode: 0o700 }); await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const candidate = await ctx.clone('candidate', ctx.candidate), baseline = await ctx.clone('old', ctx.baseline), repair = await ctx.clone('repair', ctx.repair.revision);
  const fallback = await ctx.clone('fallback', ctx.baseline), fallbackCopy = await ctx.clone('fallback-copy', ctx.baseline);
  const fallbackPatch = path.join(repository, 'packages/e2e_tests/src/subtask-compat-fallback.patch');
  if (await hash(fallbackPatch) !== fallbackPatchSHA256) throw new Error('Fallback patch digest mismatch.');
  for (const source of [fallback, fallbackCopy]) {
    await command('git', ['apply', '--unidiff-zero', '--check', fallbackPatch], source);
    await command('git', ['apply', '--unidiff-zero', fallbackPatch], source);
  }
  const candidateTree = (await command('git', ['rev-parse', `${ctx.candidate}:packages/daynight-server`])).stdout.trim();
  const repairTree = (await command('git', ['rev-parse', `${ctx.repair.revision}:packages/daynight-server`])).stdout.trim();
  const dependencyInputs = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'patches', 'packages/daynight-web/package.json'];
  await command('git', ['diff', '--quiet', ctx.baseline, ctx.candidate, '--', ...dependencyInputs]);
  await command('git', ['diff', '--quiet', ctx.repair.revision, ctx.candidate, '--', ...dependencyInputs]);
  const buildWeb = async (source: string, cli: boolean): Promise<void> => {
    const web = path.join(source, 'packages/daynight-web');
    await symlink(path.join(repository, 'node_modules'), path.join(source, 'node_modules'), 'dir');
    await symlink(path.join(repository, 'packages/daynight-web/node_modules'), path.join(web, 'node_modules'), 'dir');
    await command(path.join(repository, 'packages/daynight-web/node_modules/.bin/tsc'), ['--project', 'tsconfig.build.json'], web, 600_000, env);
    await command(path.join(repository, 'packages/daynight-web/node_modules/.bin/vite'), ['build'], web, 600_000, env);
    await command(process.execPath, ['scripts/publish-assets.mts'], web, 60_000, env);
    if (cli) {
      const pkg = path.join(source, 'packages/daynight');
      await symlink(path.join(repository, 'packages/daynight/node_modules'), path.join(pkg, 'node_modules'), 'dir');
      await command(process.execPath, ['scripts/clean-dist.ts'], pkg, 60_000, env);
      await command(path.join(repository, 'packages/daynight/node_modules/.bin/tsc'), ['-p', 'tsconfig.build.json'], pkg, 600_000, env);
      await command(process.execPath, ['scripts/copy-resources.ts'], pkg, 60_000, env);
      await command(process.execPath, ['scripts/package-image-validation.ts', path.join(artifacts, 'image-validator')], pkg, 60_000, env);
      await mkdir(path.join(artifacts, 'cli')); await cp(path.join(pkg, 'dist'), path.join(artifacts, 'cli/dist'), { recursive: true });
      await cp(path.join(pkg, 'package.json'), path.join(artifacts, 'cli/package.json'));
      await symlink(path.join(repository, 'packages/daynight/node_modules'), path.join(artifacts, 'cli/node_modules'), 'dir');
      await rm(path.join(pkg, 'node_modules'));
    }
    await rm(path.join(web, 'node_modules')); await rm(path.join(source, 'node_modules'));
  };
  await ctx.phase('build-candidate'); await buildWeb(candidate, true);
  await ctx.phase('build-baseline'); await buildWeb(baseline, false);
  await ctx.phase('build-repair-web'); await buildWeb(repair, false);
  await ctx.phase('build-fallback-web'); await buildWeb(fallback, false); await buildWeb(fallbackCopy, false);
  const candidateBinary = path.join(artifacts, 'server-candidate');
  const shared = ctx.sharedCandidate;
  const manifest: unknown = JSON.parse(await readFile(shared.manifest, 'utf8'));
  const candidateFingerprint = await sourceFingerprint(candidate, signal);
  verifyCandidateCombination({ manifest, candidate: ctx.candidate, baseline: ctx.baseline, sha256: shared.sha256, sourceFingerprint: candidateFingerprint });
  const candidateFile = await lstat(shared.binary);
  if (!candidateFile.isFile() || candidateFile.isSymbolicLink() || await hash(shared.binary) !== shared.sha256) throw new Error('Shared candidate digest mismatch.');
  await cp(shared.binary, candidateBinary);
  if (await hash(candidateBinary) !== shared.sha256 || await hash(shared.binary) !== shared.sha256) throw new Error('Shared candidate changed while copying.');
  await ctx.phase('verify-repair-artifact');
  const repairFile = await lstat(ctx.repair.artifact);
  if (!repairFile.isFile() || repairFile.isSymbolicLink() || await hash(ctx.repair.artifact) !== ctx.repair.sha256) throw new Error('Repair artifact digest mismatch.');
  const repairBinary = path.join(artifacts, 'server-repair'); await cp(ctx.repair.artifact, repairBinary);
  await command('go', ['build', '-trimpath', '-o', path.join(artifacts, 'server122'), './cmd/daynight-server'], path.join(baseline, 'packages/daynight-server'), 600_000, env);
  const fallbackBinary = path.join(artifacts, 'server-fallback'), reproducedFallback = path.join(runtime, 'fallback-reproduced');
  await command('go', ['build', '-trimpath', '-o', fallbackBinary, './cmd/daynight-server'], path.join(fallback, 'packages/daynight-server'), 600_000, env);
  await command('go', ['build', '-trimpath', '-o', reproducedFallback, './cmd/daynight-server'], path.join(fallbackCopy, 'packages/daynight-server'), 600_000, env);
  const reproducedRepair = path.join(runtime, 'repair-reproduced');
  await command('go', ['build', '-trimpath', '-o', reproducedRepair, './cmd/daynight-server'], path.join(repair, 'packages/daynight-server'), 600_000, env);
  const repairInfo = await command('go', ['version', '-m', repairBinary], repository, 30_000, env);
  const repairProof = { revision: ctx.repair.revision, expectedSHA256: ctx.repair.sha256, suppliedSHA256: await hash(ctx.repair.artifact),
    copiedSHA256: await hash(repairBinary), reproducedSHA256: await hash(reproducedRepair) };
  await ctx.evidence('repairArtifact', { ...repairProof, verified: false });
  verifyRepairArtifact({ ...repairProof, buildInfo: repairInfo.stdout });
  await ctx.evidence('repairArtifact', { ...repairProof, verified: true });
  for (const [name, expected] of [['server-candidate', ctx.candidate], ['server122', ctx.baseline]] as const) {
    const build = await command('go', ['version', '-m', path.join(artifacts, name)], repository, 30_000, env);
    if (name === 'server-candidate') verifyCandidateBuild({ revision: expected, architecture, buildInfo: build.stdout });
    else if (!build.stdout.includes('\tpath\tgithub.com/codetreker/daynight/packages/daynight-server/cmd/daynight-server\n') ||
        !build.stdout.includes(`\tbuild\tvcs.revision=${expected}\n`) || !build.stdout.includes('\tbuild\tvcs.modified=false\n')) throw new Error(`${name} provenance mismatch.`);
  }
  await ctx.phase('migration-registries');
  const registryProbe = path.join(repository, 'packages/e2e_tests/src/subtask-compat-recovery-manifest-probe.go.txt');
  const probeSHA256 = await hash(registryProbe);
  const sourceFingerprints = { candidate: candidateFingerprint, baseline: await sourceFingerprint(baseline, signal), repair: await sourceFingerprint(repair, signal) };
  const registries: Record<string, MigrationEntry[]> = {};
  const probes: Record<string, { registry: 'legacy' | 'baseline'; sha256: string }> = {};
  for (const [name, source, revision] of [['baseline', baseline, ctx.baseline], ['candidate', candidate, ctx.candidate], ['repair', repair, ctx.repair.revision]] as const) {
    const observed = await readRegisteredMigrations({ source, probe: registryProbe, overlayFile: path.join(runtime, `${name}-registry-overlay.json`), environment: env, command });
    registries[name] = observed.entries;
    probes[name] = { registry: observed.registry, sha256: observed.probeSHA256 };
    if (await hash(registryProbe) !== probeSHA256 || await sourceFingerprint(source, signal) !== sourceFingerprints[name]) throw new Error('Migration registry source changed during observation.');
    await ctx.evidence(`${name}Registry`, { revision, sourceFingerprint: sourceFingerprints[name], probeSHA256, probe: probes[name], entries: registries[name], sha256: migrationManifestHash(registries[name]!) });
  }
  const baselineManifest = registries.baseline!, candidateManifest = registries.candidate!, repairManifest = registries.repair!;
  const fallbackRegistry = await readRegisteredMigrations({ source: fallback, probe: registryProbe, overlayFile: path.join(runtime, 'fallback-registry-overlay.json'), environment: env, command });
  const fallbackProof = { baseline: ctx.baseline, patchSHA256: await hash(fallbackPatch), baselineLedgerSHA256: migrationManifestHash(baselineManifest),
    fallbackLedgerSHA256: migrationManifestHash(fallbackRegistry.entries), webSHA256: await hashTree(path.join(fallback, 'packages/daynight-web/dist')),
    reproducedWebSHA256: await hashTree(path.join(fallbackCopy, 'packages/daynight-web/dist')), serverSHA256: await hash(fallbackBinary), reproducedServerSHA256: await hash(reproducedFallback) };
  if (await hashTree(path.join(fallback, 'packages/daynight-server/internal/service/webui/dist')) !== fallbackProof.webSHA256 ||
      await hashTree(path.join(fallbackCopy, 'packages/daynight-server/internal/service/webui/dist')) !== fallbackProof.reproducedWebSHA256) throw new Error('Published fallback Web differs from its source build.');
  const fallbackInfo = await command('go', ['version', '-m', fallbackBinary], repository, 30_000, env);
  verifyFallbackArtifact({ ...fallbackProof, buildInfo: fallbackInfo.stdout });
  await ctx.evidence('fallbackArtifact', { ...fallbackProof, verified: true });
  const manifestEvidence = { baselineRevision: ctx.baseline, candidateRevision: ctx.candidate, repairRevision: ctx.repair.revision, sourceFingerprints, probeSHA256, probes,
    baseline: baselineManifest, candidate: candidateManifest, repair: repairManifest,
    baselineSHA256: migrationManifestHash(baselineManifest), candidateSHA256: migrationManifestHash(candidateManifest), repairSHA256: migrationManifestHash(repairManifest) };
  try { requireMigrationPlan(baselineManifest, candidateManifest, repairManifest); }
  catch (error) { await ctx.evidence('migrationRegistries', { ...manifestEvidence, comparison: 'incompatible' }); throw error; }
  // The precommit lock scenario depends on migration 123 being the first new migration.
  if (candidateManifest[baselineManifest.length]?.version !== 123) throw new Error('The task migration is not the first pending migration.');
  const baselineVersion = baselineManifest.at(-1)!.version, candidateVersion = candidateManifest.at(-1)!.version;
  await ctx.evidence('migrationRegistries', { ...manifestEvidence, comparison: 'matched' });
  await ctx.phase('install-baseline-cli');
  const oldCliRoot = path.join(privateDir, 'old-cli'); await mkdir(oldCliRoot, { mode: 0o700 });
  await command('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', oldCliRoot, ctx.oldCli], repository, 300_000, env);
  if (await integrity() !== oldCliIntegrity) throw new Error('Baseline npm CLI integrity mismatch.');
  const oldCliEntry = path.join(oldCliRoot, 'node_modules/@codetreker/daynight/dist/main.js');
  if ((await command(process.execPath, [oldCliEntry, '--version'], repository, 30_000, env)).stdout.trim() !== '0.72.0') throw new Error('Baseline npm CLI version mismatch.');
  await ctx.phase('build-controlled-webhook');
  const helper = path.join(candidate, 'packages/daynight-server/cmd/daynight-server/webhook_controlled_lifecycle_test.go');
  const original = await readFile(helper, 'utf8');
  const adapted = original.replace('_, daynightRoot, err := parseCommand(', 'options, err := parseCommand(').replace('config.LoadServer(daynightRoot, os.LookupEnv)', 'config.LoadServer(options.root, os.LookupEnv)');
  if (adapted === original || adapted.includes('_, daynightRoot, err := parseCommand(') || adapted.includes('config.LoadServer(daynightRoot, os.LookupEnv)')) throw new Error('Controlled Webhook seam adaptation failed.');
  await writeFile(helper, adapted);
  const module = path.join(candidate, 'packages/daynight-server');
  const overlay = JSON.parse(await readFile(path.join(module, 'scripts/unit-overlay.json'), 'utf8')) as { Replace: Record<string, string> };
  const overlayFile = path.join(runtime, 'controlled-overlay.json');
  await writeFile(overlayFile, JSON.stringify({ Replace: Object.fromEntries(Object.entries(overlay.Replace).map(([from, to]) => [path.join(module, from), path.join(module, to)])) }));
  await command('go', ['test', '-c', '-o', path.join(artifacts, 'controlled.test'), `-overlay=${overlayFile}`, '-tags=startupshutdown,webhooktest', './cmd/daynight-server'], module, 600_000, env);
  await ctx.phase('build-uniauth');
  const authCache = path.join(cache, 'uniauth-source'), authSource = path.join(runtime, 'uniauth-source');
  await command('git', ['clone', '--no-hardlinks', '--no-checkout', authCache, authSource]);
  await command('git', ['checkout', '--detach', authRevision], authSource);
  if ((await command('git', ['rev-parse', 'HEAD'], authSource)).stdout.trim() !== authRevision) throw new Error('UniAuth source identity mismatch.');
  const authConsole = path.join(authSource, 'web/console');
  await symlink(path.join(authCache, 'web/console/node_modules'), path.join(authConsole, 'node_modules'), 'dir');
  await command(path.join(authCache, 'web/console/node_modules/.bin/tsc'), ['--noEmit'], authConsole, 600_000, env);
  await command(path.join(authCache, 'web/console/node_modules/.bin/vite'), ['build'], authConsole, 600_000, env);
  await rm(path.join(authConsole, 'node_modules'));
  await command('go', ['build', '-trimpath', '-o', path.join(artifacts, 'uniauth'), './cmd/uniauth'], authSource, 600_000, env);
  for (const [name, subject, san] of [['provider', 'Provider', 'DNS:github.com,DNS:api.github.com'], ['daynight', 'Daynight', 'DNS:app.daynight.localhost,DNS:preview.daynight.localhost,DNS:*.preview.daynight.localhost'], ['receiver', 'Receiver', 'DNS:receiver.example']] as const) {
    await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', `/CN=${subject}`, '-addext', `subjectAltName=${san}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', path.join(artifacts, `${name}-key.pem`), '-out', path.join(artifacts, `${name}-ca.pem`)], repository, 30_000, env);
  }
  await mkdir(path.join(artifacts, 'runtime')); await cp(path.join(repository, 'packages/e2e_tests/src'), path.join(artifacts, 'runtime/src'), { recursive: true });
  await writeFile(path.join(artifacts, 'runtime/package.json'), '{"type":"module"}\n');
  const buildContext = path.join(runtime, 'docker-context'); await mkdir(buildContext);
  const dockerfile = path.join(buildContext, 'Dockerfile');
  await writeFile(dockerfile, `FROM ${nodeImage}\nRUN apt-get update && apt-get install --yes --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*\n`);
  await ctx.phase('build-recovery-image');
  await command('docker', ['build', '--label', `daynight.compat.recovery=${ctx.runId}`, '--file', dockerfile, '--tag', resources.image, buildContext], repository, 600_000);
  const [serverPort, authPort, proxyPort, receiverPort] = await reservePorts();
  if (!serverPort || !authPort || !proxyPort || !receiverPort) throw new Error('Recovery ports missing.');
  const password = randomUUID() + randomUUID();
  const databaseURL = `postgres://daynight:${password}@postgres:5432/daynight?sslmode=disable`;
  await writeFile(path.join(privateDir, 'postgres.env'), `POSTGRES_USER=daynight\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=daynight\n`, { mode: 0o600 });
  await writeFile(path.join(privateDir, 'runtime.json'), JSON.stringify({ serverPort, authPort, proxyPort, receiverPort, databaseURL, uid: process.getuid!(), gid: process.getgid!() }), { mode: 0o600 });
  const tag = `daynight.compat.recovery=${ctx.runId}`;
  await ctx.phase('prepare-isolated-environment');
  await command('docker', ['network', 'create', '--internal', '--label', tag, resources.network]);
  await command('docker', ['network', 'create', '--label', tag, resources.ingress]);
  await command('docker', ['volume', 'create', '--label', tag, resources.volume]);
  await command('docker', ['run', '--detach', '--name', resources.postgres, '--label', tag, '--network', resources.network, '--network-alias', 'postgres', '--env-file', path.join(privateDir, 'postgres.env'), '--mount', `type=volume,src=${resources.volume},dst=/var/lib/postgresql`, postgresImage]);
  await command('docker', ['run', '--detach', '--name', resources.redis, '--label', tag, '--network', resources.network, '--network-alias', 'redis', redisImage, 'redis-server', '--save', '', '--appendonly', 'no', '--maxmemory', '64mb', '--maxmemory-policy', 'noeviction']);
  const readyContainer = async (name: string, args: string[]): Promise<void> => {
    const end = performance.now() + 60_000;
    while (performance.now() < end) { signal.throwIfAborted(); if ((await observe(['exec', name, ...args])).exitCode === 0) return; await pause(250, signal); }
    throw new Error(`Container ${name} readiness failed.`);
  };
  await readyContainer(resources.postgres, ['pg_isready', '-h', '127.0.0.1', '-U', 'daynight', '-d', 'daynight']);
  await readyContainer(resources.redis, ['redis-cli', 'ping']);
  await ctx.phase('start-auth-runtime');
  await command('docker', ['create', '--name', resources.auth, '--label', tag, '--network', resources.ingress, '--cap-add', 'NET_ADMIN',
    '--publish', `127.0.0.1:${serverPort}:${serverPort}`, '--publish', `127.0.0.1:${authPort}:${authPort}`, '--publish', `127.0.0.1:${proxyPort}:${proxyPort}`,
    '--mount', `type=bind,src=${run},dst=/run`, '--mount', `type=bind,src=${artifacts},dst=/opt/e2e,readonly`, '--entrypoint', 'node', resources.image, '/opt/e2e/runtime/src/subtask-compat-recovery-runtime.ts']);
  await command('docker', ['network', 'connect', resources.network, resources.auth]); await command('docker', ['start', resources.auth]);
  const waitFile = async (filename: string): Promise<void> => {
    const end = performance.now() + 90_000;
    while (performance.now() < end) { signal.throwIfAborted(); try { await readFile(filename); return; } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; } await pause(100, signal); }
    throw new Error(`Recovery runtime readiness failed: ${path.basename(filename)}.`);
  };
  await waitFile(path.join(privateDir, 'runtime-ready.json'));
  const runtimeInfo = JSON.parse(await readFile(path.join(privateDir, 'runtime-ready.json'), 'utf8')) as { authURL: string; baseURL: string; proxyURL: string; serverInternal: number };
  const authEnd = performance.now() + 90_000;
  while (true) {
    signal.throwIfAborted();
    try { if ((await fetch(`${runtimeInfo.authURL}/readyz`, { signal: AbortSignal.timeout(1000) })).status === 200) break; } catch { /* Wait for UniAuth. */ }
    if (performance.now() >= authEnd) throw new Error('UniAuth did not become ready.'); await pause(100, signal);
  }
  const browserOwnerDirectory = path.join(repository, '.tmp', 'product-e2e', ctx.runId);
  await mkdir(path.dirname(browserOwnerDirectory), { recursive: true, mode: 0o700 });
  await ctx.browserOwner(browserOwnerDirectory);
  await mkdir(browserOwnerDirectory, { recursive: false, mode: 0o700 });
  await initializeRunOwnership(repository, browserOwnerDirectory);
  const browserInput = path.join(privateDir, 'browser.json');
  await writeFile(browserInput, JSON.stringify({ ...runtimeInfo, receiverPort, directory: run, repository, browserOwnerDirectory, cliEntry: oldCliEntry, resolver: path.join(repository, 'packages/e2e_tests/src/resolve-local.cjs'), certificate: path.join(artifacts, 'daynight-ca.pem') }), { mode: 0o600 });
  const browser = await startOwnedPlaywright({ repository, runDirectory: browserOwnerDirectory, command: process.execPath,
    args: [path.join(repository, 'packages/e2e_tests/src/subtask-compat-recovery-browser.ts'), browserInput], options: { cwd: privateDir,
      env: { ...process.env, TMPDIR: '/proc/self/cwd' }, signal, timeoutMs: 1_200_000, onOutput: () => {} } });
  let browserStopped = false;
  try {
  type Event = { type: string; [key: string]: unknown };
  let eventSequence = 0, commandSequence = 0;
  let browserExit: { code?: number; failed?: boolean } | undefined;
  void browser.finished.then(result => { browserExit = { code: result.exitCode }; }, () => { browserExit = { failed: true }; });
  const browserStage = async (): Promise<string> => {
    try {
      const state = JSON.parse(await readFile(path.join(privateDir, 'browser-phase.json'), 'utf8')) as { phase?: unknown };
      if (typeof state.phase === 'string' && /^[a-z-]+$/.test(state.phase)) return state.phase;
    } catch { /* Missing phase is retained as unknown. */ }
    return 'unknown';
  };
  const nextEvent = async (type: string): Promise<Event> => {
    const filename = path.join(privateDir, `browser-event-${eventSequence++}.json`), end = performance.now() + 120_000;
    while (performance.now() < end) {
      signal.throwIfAborted();
      try {
        const event = JSON.parse(await readFile(filename, 'utf8')) as Event;
        if (event.type !== type) {
          const stage = typeof event.phase === 'string' && /^[a-z-]+$/.test(event.phase) ? event.phase : 'unknown';
          const category = typeof event.category === 'string' && ['Error', 'TimeoutError', 'AssertionError'].includes(event.category) ? event.category : 'unknown';
          const detail = typeof event.detail === 'string' && /^[a-z0-9-]+$/.test(event.detail) ? ` ${event.detail}` : '';
          throw new Error(`Recovery browser failed at ${stage} (${category})${detail}.`);
        }
        return event;
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      if (browserExit) throw new Error(`Recovery browser exited at ${await browserStage()} waiting for ${type}.`);
      await pause(100, signal);
    }
    throw new Error(`Recovery browser timed out at ${await browserStage()} waiting for ${type}.`);
  };
  const tellBrowser = async (operation: string): Promise<void> => {
    const filename = path.join(privateDir, `browser-command-${commandSequence++}.txt`), temporary = `${filename}.tmp`;
    await writeFile(temporary, operation, { mode: 0o600 }); await rename(temporary, filename);
  };
  const expectedBinaries = Object.fromEntries(await Promise.all(['server122', 'server-candidate', 'server-repair', 'server-fallback', 'controlled.test'].map(async name => [name, await hash(path.join(artifacts, name))])));
  const baseServerEnv = `DAYNIGHT_REDIS_URL=redis://redis:6379/0\nDAYNIGHT_IMAGE_NODE_PATH=/usr/local/bin/node\nDAYNIGHT_IMAGE_HELPER_PATH=/opt/e2e/image-validator/image-validation-helper.js\nDAYNIGHT_IMAGE_MANIFEST_PATH=/opt/e2e/image-validator/image-validation-manifest.json\nDAYNIGHT_IMAGE_TEMP_DIRECTORY=/run/private/image-validation\n`;
  await mkdir(path.join(privateDir, 'image-validation'), { mode: 0o700 });
  const serverEnv = path.join(privateDir, 'server.env');
  const startServer = async (name: string, artifact: string, extra = ''): Promise<void> => {
    if (await hash(path.join(artifacts, artifact)) !== expectedBinaries[artifact]) throw new Error('Selected Server artifact changed.');
    await writeFile(serverEnv, baseServerEnv + (extra.includes('DAYNIGHT_WEBHOOK_ENABLED=') ? '' : 'DAYNIGHT_WEBHOOK_ENABLED=0\n') + extra, { mode: 0o600 });
    await command('docker', ['run', '--detach', '--name', name, '--label', tag, '--network', `container:${resources.auth}`, '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--mount', `type=bind,src=${run},dst=/run`, '--mount', `type=bind,src=${artifacts},dst=/opt/e2e,readonly`, '--env-file', serverEnv,
      '--entrypoint', `/opt/e2e/${artifact}`, resources.image, ...(artifact === 'controlled.test' ? ['-test.run=^TestWebhookControlledProcessHelper$'] : ['--root', '/run/private/daynight'])]);
    if (await hash(path.join(artifacts, artifact)) !== expectedBinaries[artifact]) throw new Error('Selected Server artifact changed during startup.');
  };
  const stopServer = async (name: string): Promise<void> => {
    await command('docker', ['stop', '--time', '10', name]);
    const check = await observe(['container', 'inspect', name]);
    const state = check.exitCode === 0 ? (JSON.parse(check.stdout) as { State?: { Running?: boolean; ExitCode?: number } }[])[0]?.State : undefined;
    if (state?.Running !== false || state.ExitCode !== 0) throw new Error('Server did not drain and stop successfully.');
    await command('docker', ['container', 'rm', name]);
  };
  const waitServer = async (container: string): Promise<void> => {
    const ca = await readFile(path.join(artifacts, 'daynight-ca.pem')), end = performance.now() + 60_000;
    while (performance.now() < end) {
      signal.throwIfAborted();
      const inspection = await observe(['container', 'inspect', container]);
      if (inspection.exitCode !== 0) throw new Error('Selected Server container inspection failed.');
      const state = (JSON.parse(inspection.stdout) as { State?: { Running?: boolean; ExitCode?: number } }[])[0]?.State;
      if (state?.Running === false && Number.isInteger(state.ExitCode)) throw new Error(`Selected Server exited before readiness (exit=${state.ExitCode}).`);
      if (state?.Running !== true) throw new Error('Selected Server container state is invalid.');
      try {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const req = httpsGet({ hostname: '127.0.0.1', port: serverPort, path: '/readyz', servername: 'app.daynight.localhost', headers: { Host: `app.daynight.localhost:${serverPort}` }, ca, signal: AbortSignal.timeout(1000) }, response => { response.resume(); resolve(response.statusCode); }); req.once('error', reject);
        });
        if (status === 200) return;
      } catch { /* Wait for the selected Server. */ }
      await pause(100, signal);
    }
    throw new Error('Selected Server readiness timed out.');
  };
  const verifyServedFallback = async (): Promise<number> => {
    const root = path.join(fallback, 'packages/daynight-web/dist'), ca = await readFile(path.join(artifacts, 'daynight-ca.pem'));
    let count = 0;
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = `${prefix}${entry.name}`, filename = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(filename, `${name}/`); continue; }
        if (!entry.isFile()) throw new Error('Fallback Web contains a nonregular entry.');
        const url = name === 'index.html' ? '/' : `/${name.split('/').map(encodeURIComponent).join('/')}`;
        const received = await new Promise<Buffer>((resolve, reject) => {
          const req = httpsGet({ hostname: '127.0.0.1', port: serverPort, path: url, servername: 'app.daynight.localhost', headers: { Host: `app.daynight.localhost:${serverPort}` }, ca, signal: AbortSignal.timeout(10_000) }, response => {
            if (response.statusCode !== 200) { response.resume(); reject(new Error('Fallback Web response failed.')); return; }
            const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('error', reject); response.once('end', () => resolve(Buffer.concat(chunks)));
          }); req.once('error', reject);
        });
        const source = await readFile(filename);
        const expected = name === 'index.html'
          ? Buffer.from(source.toString('utf8').replace('</head>', `<meta name="daynight-preview-origin" content="https://preview.daynight.localhost:${serverPort}"></head>`))
          : source;
        if (!received.equals(expected)) throw new Error('Served fallback Web differs from embedded build.');
        count++;
      }
    };
    await walk(root, '');
    if (count < 2) throw new Error('Fallback Web assets missing.');
    return count;
  };
  const psql = async (sql: string): Promise<string> => {
    const result = await observe(['exec', resources.postgres, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'daynight', '-d', 'daynight', '-c', sql]);
    if (result.exitCode !== 0) throw new Error('Isolated database observation failed.'); return result.stdout.trim();
  };
  const observeLedger = async (stage: string, settled: boolean) => await observeMigrationLedger({
    baseline: baselineManifest, candidate: candidateManifest, settled,
    query: async () => await psql(migrationLedgerQuery),
    record: async value => await ctx.evidence(stage, value),
  });
  const control = async (operation: string): Promise<Record<string, unknown>> => await recoveryControl(privateDir, operation);
  const waitExit = async (name: string): Promise<void> => {
    const result = await observe(['wait', name]); if (result.exitCode !== 0 || !/^\d+$/.test(result.stdout.trim()) || result.stdout.trim() === '0') throw new Error('Candidate did not fail as required.');
  };
    await ctx.phase('normal-authentication'); await nextEvent('auth-ready'); await waitFile(path.join(privateDir, 'server-configured'));
    await ctx.phase('baseline-fixture'); await startServer(resources.old, 'server122', 'DAYNIGHT_WEBHOOK_ENABLED=1\n'); await waitServer(resources.old);
    await tellBrowser('baseline-ready'); const fixtureEvent = await nextEvent('fixture-ready');
    const fixture = JSON.parse(await readFile(path.join(privateDir, 'fixture.json'), 'utf8')) as Fixture;
    for (const key of ['user', 'project', 'goal', 'child', 'hiddenGoal', 'hiddenChild', 'endpoint'] as const) if (!uuid.test(fixture[key]) || fixtureEvent[key] !== undefined && fixtureEvent[key] !== fixture[key]) throw new Error('Fixture identity mismatch.');
    if (fixtureEvent.oldDatabase !== 13) throw new Error('Baseline profile schema was not observed.');
    if (!fixture.token) throw new Error('Device credential missing.');
    await ctx.evidence('baselineFixture', { authentication: 'normal', server: 'baseline-container', project: fixture.project, goal: fixture.goal, child: fixture.child, hiddenGoal: fixture.hiddenGoal, hiddenChild: fixture.hiddenChild });
    const initialLedger = await observeLedger('baselineLedger', true);
    if (initialLedger.state !== 'baseline') throw new Error('Baseline ledger does not match its registry.');
    const ledger = initialLedger.raw;
    const epoch = await psql(`SELECT task_cache_epoch::text FROM projects WHERE id='${fixture.project}'`);
    const projectionQuery = `SELECT jsonb_agg(jsonb_build_array(t.id,t.parent_id,t.status,t.version,t.updated_at,r.effective_deleted_at IS NULL) ORDER BY t.id)::text FROM tasks t JOIN task_resource_rows r ON r.id=t.id WHERE t.id IN ('${fixture.hiddenGoal}','${fixture.hiddenChild}')`;
    const projection = await psql(projectionQuery);
    const oldHidden = await psql(`SELECT effective_deleted_at IS NOT NULL FROM task_resource_rows WHERE id='${fixture.hiddenChild}'`);
    if (oldHidden !== 't' || !uuid.test(epoch) || !projection) throw new Error('Baseline historical Goal evidence missing.');
    await stopServer(resources.old);
    await startServer(resources.old, 'server122'); await waitServer(resources.old);
    await tellBrowser('pending'); await nextEvent('pending'); await stopServer(resources.old);
    if ((await control('count')).count !== 0) throw new Error('Unexpected Webhook delivery before migration.');
    await ctx.phase('snapshot');
    await command('docker', ['exec', resources.postgres, 'pg_dump', '-U', 'daynight', '-d', 'daynight', '--no-owner', '--no-acl', '--file=/tmp/recovery.sql']);
    await command('docker', ['cp', `${resources.postgres}:/tmp/recovery.sql`, path.join(privateDir, 'recovery.sql')]);
    const snapshotHash = await hash(path.join(privateDir, 'recovery.sql'));
    await cp(path.join(privateDir, 'storage'), path.join(privateDir, 'storage-backup'), { recursive: true });
    const storageHash = await hashTree(path.join(privateDir, 'storage-backup'));
    if (await hashTree(path.join(privateDir, 'storage')) !== storageHash) throw new Error('Attachment backup differs from its source.');
    await ctx.evidence('snapshot', { baselineVersion, databaseSHA256: snapshotHash, storageSHA256: storageHash });
    await ctx.phase('precommit-lock');
    try { await ctx.mutation('postgres migration lock', async () => {
      let lockText = '';
      const lock = await ctx.startRelated('docker', ['exec', '-i', resources.postgres, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'daynight', '-d', 'daynight'], { cwd: repository, env: process.env, signal, timeoutMs: 90_000, stdin: 'pipe', onOutput: (channel, chunk) => { if (channel === 'stdout') lockText += chunk; } }, 'database lock');
      try {
        await lock.writeInput("BEGIN; LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE; SELECT 'LOCKED';\n");
        const end = performance.now() + 20_000;
        while (!lockText.includes('LOCKED')) { if (performance.now() >= end) throw new Error('Migration lock barrier timed out.'); await pause(50, signal); }
        await startServer(resources.candidate, 'server-candidate', 'DAYNIGHT_STARTUP_TIMEOUT=2s\n'); await waitExit(resources.candidate);
        const failed = await observe(['logs', resources.candidate]);
        if (failed.exitCode !== 0 || !(failed.stdout + failed.stderr).includes('database migrate failed')) throw new Error('Precommit failure did not identify migration.');
        await command('docker', ['container', 'rm', resources.candidate]);
        await lock.writeInput('ROLLBACK;\\q\n'); lock.endInput();
        if ((await lock.finished).exitCode !== 0) throw new Error('Migration lock release failed.');
      } finally { await lock.stop(); }
    }); } catch (error) {
      try { await observeLedger('precommitInterruptedLedger', false); } catch { /* The observation records an unknown ledger. */ }
      throw error;
    }
    const precommitLedger = await observeLedger('precommitLedger', true);
    if (precommitLedger.state !== 'baseline' || precommitLedger.raw !== ledger) throw new Error('Precommit failure changed baseline ledger.');
    await startServer(resources.old, 'server122'); await waitServer(resources.old); await stopServer(resources.old);
    await ctx.evidence('precommit', { ledgerUnchanged: true, baselineRestarted: true });
    await ctx.phase('committed-startup-failure'); await control('occupy');
    let candidateStopped = false, listenerFailure: unknown, listenerLogs = '';
    try {
      await startServer(resources.candidate, 'server-candidate'); await waitExit(resources.candidate); candidateStopped = true;
      const failed = await observe(['logs', resources.candidate]);
      if (failed.exitCode !== 0) throw new Error('Candidate startup diagnostics are unavailable.');
      listenerLogs = failed.stdout + failed.stderr;
      await command('docker', ['container', 'rm', resources.candidate]);
    } catch (error) { listenerFailure = error; }
    if (candidateStopped) {
      try { await control('release'); } catch (error) { listenerFailure ??= error; }
    } else await ctx.evidence('candidateListener', { released: false, reason: 'candidate-stop-unconfirmed' });
    const committed = await observeLedger('candidateStartupLedger', candidateStopped);
    if (!candidateStopped) throw new Error('Candidate startup outcome is unconfirmed; listener retained.');
    if (listenerFailure !== undefined) throw listenerFailure;
    requireSettledCandidateLedger(committed);
    if (!listenerLogs.includes('HTTP listen failed') || !listenerLogs.includes('address_in_use')) throw new Error('Committed startup failure did not identify the occupied listener.');
    const candidateLedger = committed.raw;
    if (await psql(projectionQuery) !== projection || await psql(`SELECT c.ancestor_deleted_at=g.deleted_at AND c.deleted_at IS NULL FROM tasks c JOIN tasks g ON g.id=c.parent_id WHERE c.id='${fixture.hiddenChild}'`) !== 't') throw new Error('Committed migration or historical Goal backfill mismatch.');
    if (await psql(`SELECT task_cache_epoch::text FROM projects WHERE id='${fixture.project}'`) !== epoch) throw new Error('Migration changed the original cache epoch.');
    const zeroEffects = await control('count'); if (zeroEffects.count !== 0) throw new Error('Unexpected external effect before controlled delivery.');
    await ctx.evidence('committedFailure', { candidateVersion, historicalProjectionPreserved: true, receiverCount: 0 });
    await ctx.phase('same-ledger-repair');
    try {
      await startServer(resources.repair, 'server-repair'); await waitServer(resources.repair);
      await tellBrowser('verify'); await nextEvent('verified');
      await tellBrowser('repair-write'); await nextEvent('repair-written');
      const repairedLedger = await observeLedger('repairLedger', true);
      if (repairedLedger.state !== 'candidate' || repairedLedger.raw !== candidateLedger) throw new Error('Repair changed the candidate ledger.');
      await stopServer(resources.repair);
    } catch (error) {
      try { await observeLedger('repairFailureLedger', false); } catch { /* The observation records an unknown ledger. */ }
      throw error;
    }
    await ctx.evidence('repair', { ready: true, ledgerUnchanged: true, crossClientReadback: true, attachmentWriteReadback: true });
    await ctx.phase('production-candidate'); await startServer(resources.candidate, 'server-candidate'); await waitServer(resources.candidate);
    await tellBrowser('verify'); await nextEvent('verified'); await stopServer(resources.candidate);
    const runningLedger = await observeLedger('candidateReadbackLedger', true);
    if (runningLedger.state !== 'candidate' || runningLedger.raw !== candidateLedger) throw new Error('Candidate readback changed the migration ledger.');
    await ctx.evidence('candidate', { ready: true, crossClientReadback: true });
    await ctx.phase('old-refusal'); await startServer(resources.old, 'server122'); await waitExit(resources.old);
    const oldLogs = await observe(['logs', resources.old]); if (oldLogs.exitCode !== 0 || !(oldLogs.stdout + oldLogs.stderr).includes('database migrate failed')) throw new Error('Old Server refusal lacked migration evidence.');
    await command('docker', ['container', 'rm', resources.old]);
    const refusedLedger = await observeLedger('oldRefusalLedger', true);
    if (refusedLedger.state !== 'candidate' || refusedLedger.raw !== candidateLedger) throw new Error('Old Server refusal changed the candidate ledger.');
    await ctx.evidence('oldRefusal', { refused: true });
    await ctx.phase('controlled-webhook');
    const receiverCA = (await readFile(path.join(artifacts, 'receiver-ca.pem'))).toString('base64');
    await startServer(resources.controlled, 'controlled.test', `DAYNIGHT_WEBHOOK_ENABLED=1\nDAYNIGHT_CONTROLLED_WEBHOOK_HELPER=1\nDAYNIGHT_CONTROLLED_CA=${receiverCA}\nDAYNIGHT_TEST_ROOT=/run/private/daynight\n`);
    await waitServer(resources.controlled); const effectDeadline = performance.now() + 30_000; let effect: Record<string, unknown>;
    while (true) { effect = await control('count'); if (effect.count === 1) break; if (effect.count !== 0 || performance.now() >= effectDeadline) throw new Error('Controlled Webhook effect count mismatch.'); await pause(100, signal); }
    await stopServer(resources.controlled);
    const controlledLedger = await observeLedger('controlledWebhookLedger', true);
    if (controlledLedger.state !== 'candidate' || controlledLedger.raw !== candidateLedger) throw new Error('Controlled Webhook process changed the migration ledger.');
    await ctx.evidence('webhookEffect', { count: effect.count, hashes: effect.hashes });
    await startServer(resources.candidate, 'server-candidate'); await waitServer(resources.candidate);
    await tellBrowser('write'); const post = await nextEvent('written');
    if (typeof post.task !== 'string' || !uuid.test(post.task) || typeof post.originalCacheDigest !== 'string' || !/^[a-f0-9]{64}$/.test(post.originalCacheDigest)) throw new Error('Post-upgrade task or browser cache identity missing.');
    if (await psql(`SELECT count(*) FROM tasks WHERE id='${post.task}'`) !== '1') throw new Error('Post-upgrade write did not persist.');
    await stopServer(resources.candidate);
    const postWriteLedger = await observeLedger('postWriteLedger', true);
    if (postWriteLedger.state !== 'candidate' || postWriteLedger.raw !== candidateLedger) throw new Error('Post-upgrade write changed the migration ledger.');
    await ctx.phase('paired-restore');
    await command('docker', ['exec', resources.postgres, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'daynight', '-d', 'daynight', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;']);
    await command('docker', ['exec', resources.postgres, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'daynight', '-d', 'daynight', '-f', '/tmp/recovery.sql']);
    await rm(path.join(privateDir, 'storage'), { recursive: true }); await cp(path.join(privateDir, 'storage-backup'), path.join(privateDir, 'storage'), { recursive: true });
    if (await hashTree(path.join(privateDir, 'storage')) !== storageHash) throw new Error('Restored attachment storage differs from its backup.');
    const restoredLedger = await observeLedger('restoredLedger', true);
    if (restoredLedger.state !== 'baseline' || restoredLedger.raw !== ledger) throw new Error('Restored ledger differs from backup.');
    if (await psql(`SELECT count(*) FROM tasks WHERE id='${post.task}'`) !== '0') throw new Error('Post-upgrade write remains after restore.');
    await psql(`UPDATE webhook_endpoints SET enabled=false WHERE id='${fixture.endpoint}'; UPDATE projects SET task_cache_epoch=gen_random_uuid()`);
    const restoredEpoch = await psql(`SELECT task_cache_epoch::text FROM projects WHERE id='${fixture.project}'`);
    if (!uuid.test(restoredEpoch) || restoredEpoch === epoch) throw new Error('Restored cache epoch did not rotate.');
    if (await psql(`SELECT enabled FROM webhook_endpoints WHERE id='${fixture.endpoint}'`) !== 'f') throw new Error('Webhook reconciliation did not persist.');
    await startServer(resources.old, 'server-fallback'); await waitServer(resources.old);
    const servedWebFiles = await verifyServedFallback();
    await ctx.evidence('fallbackServedWeb', { sha256: fallbackProof.webSHA256, files: servedWebFiles, exactBytes: true });
    await tellBrowser('verify-cli'); await nextEvent('cli-verified');
    await ctx.evidence('restore', { ledgerRestored: true, attachmentRestored: true, postUpgradeWriteRemoved: true, epochRotated: true, endpointReconciled: true, cliReadback: true, restoredBrowser: 'not-yet-verified' });
    await tellBrowser('verify-restored'); const restored = await nextEvent('restored-verified');
    if (restored.epoch !== restoredEpoch || restored.user !== fixture.user || restored.project !== fixture.project || restored.child !== fixture.child || restored.hiddenChild !== fixture.hiddenChild || restored.originalCacheDigest !== post.originalCacheDigest || restored.sameContext !== true || restored.candidateTabRetired !== true || restored.attachment !== 'paired122' || restored.history !== 'baseline-only' || restored.deletedStatus !== 410) throw new Error('Restored browser evidence mismatch.');
    await tellBrowser('verify-failures'); const failures = await nextEvent('failures-verified');
    if (failures.denied !== true || failures.offline !== true || failures.storage !== true || failures.storageInjected !== true || failures.blocked !== true) throw new Error('Browser failure evidence missing.');
    await tellBrowser('verify-restart'); const restart = await nextEvent('restart-verified');
    if (restart.epoch !== restoredEpoch || restart.user !== fixture.user || restart.kind !== 'persistent-browser-process' || restart.sameProfile !== true) throw new Error('Browser restart evidence mismatch.');
    await tellBrowser('verify-real-storage'); const storageFailure = await nextEvent('real-storage-verified');
    if (storageFailure.errorName !== 'VersionError' || storageFailure.namespace !== 'daynight-task-cache-recovery-12ebdd08') throw new Error('Real browser storage failure evidence missing.');
    await stopServer(resources.old);
    await ctx.evidence('restore', { ledgerRestored: true, attachmentRestored: true, postUpgradeWriteRemoved: true, epochRotated: true, baselineEpoch: epoch, restoredEpoch, endpointReconciled: true, cliReadback: true, restoredBrowser: 'verified', restored, failures, restart, storageFailure });
    await tellBrowser('finish'); if ((await browser.finished).exitCode !== 0) throw new Error('Recovery browser did not stop cleanly.'); browserStopped = true;
    if (ctx.sharedCandidate && await hash(candidateBinary) !== ctx.sharedCandidate.sha256) throw new Error('Shared candidate digest changed during recovery.');
    return { fixture: { user: fixture.user, project: fixture.project, goal: fixture.goal, child: fixture.child, hiddenGoal: fixture.hiddenGoal, hiddenChild: fixture.hiddenChild },
      artifacts: { candidate: await hash(path.join(artifacts, 'server-candidate')), baseline: await hash(path.join(artifacts, 'server122')), repair: await hash(path.join(artifacts, 'server-repair')), fallback: fallbackProof, candidateServerTree: candidateTree, repairServerTree: repairTree, repairRevision: ctx.repair.revision, repairSuppliedSHA256: ctx.repair.sha256, repairReproducedSHA256: await hash(reproducedRepair), authRevision, candidateOrigin: 'candidate-combination', baselineCli: { version: '0.72.0', gitHead: 'f5d73f3275c8e2774a588967a0fbdcd2a261c379', integrity: oldCliIntegrity }, candidateWeb: 'production', baselineWeb: 'production', repairWeb: 'repair production', controlledWebhook: 'test transport' },
      recovery: { baselineVersion, candidateVersion, migrationManifests: manifestEvidence, candidateLedgerState: committed.state, candidateLedgerSettled: committed.settled, precommitLedgerUnchanged: true, candidateLedger, snapshotSHA256: snapshotHash, storageSHA256: storageHash, historicalProjectionPreserved: true, receiverBefore: zeroEffects.count, receiverAfter: effect.count, receiverHashes: effect.hashes, restoredLedger: true, attachmentRestored: true, postUpgradeWriteRemoved: true, epochRotated: true, endpointReconciled: true, browser: { baselineSchema: fixtureEvent.oldDatabase, originalCacheDigest: post.originalCacheDigest, restoredEpoch, restored, failures, restart, storageFailure, servedWebFiles } } };
  } finally {
    if (!browserStopped) await browser.stop();
  }
};
