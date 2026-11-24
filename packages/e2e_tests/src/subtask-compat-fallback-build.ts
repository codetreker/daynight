import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startCommand, assertCommandQuiescence, type CommandResult } from './command.ts';
import { readRegisteredMigrations } from './subtask-compat-recovery-manifest.ts';
import { migrationManifestHash } from './subtask-compat-recovery-migrations.ts';
import { fallbackBaseline, fallbackPatchSHA256, verifyFallbackArtifact } from './subtask-compat-recovery-provenance.ts';

const args = parseArgs({ options: { output: { type: 'string' } } }).values;
if (!args.output) throw new Error('Supply --output with a new directory for the fallback artifact.');
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || !process.version.startsWith('v24.')) throw new Error('Fallback builds require Linux and Node 24.');
const repository = path.resolve(import.meta.dirname, '../../..');
const output = path.resolve(args.output);
const patch = path.join(import.meta.dirname, 'subtask-compat-fallback.patch');
const hash = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');
const treeHash = async (root: string): Promise<string> => {
  const digest = createHash('sha256');
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename, `${name}/`);
      else if (entry.isFile()) digest.update(name).update('\0').update(await readFile(filename)).update('\0');
      else throw new Error('Web distribution contains a nonregular entry.');
    }
  };
  await walk(root, ''); return digest.digest('hex');
};
const command = async (name: string, values: string[], cwd = repository, timeoutMs = 120_000, environment = process.env): Promise<CommandResult> => {
  console.log(`Fallback build: ${path.basename(name)} ${values[0] ?? ''}`);
  const child = startCommand(name, values, { cwd, env: environment, timeoutMs, onOutput: (channel, chunk) => (channel === 'stdout' ? process.stdout : process.stderr).write(chunk) });
  const result = await child.finished;
  if (result.exitCode !== 0) throw new Error(`Fallback build command failed (${path.basename(name)} exit ${result.exitCode}).`);
  return result;
};
if (await hash(patch) !== fallbackPatchSHA256) throw new Error('Fallback patch digest mismatch.');
await command('git', ['diff', '--quiet', fallbackBaseline, 'HEAD', '--', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'patches', 'packages/daynight-web/package.json']);
const temporaryRoot = path.join(repository, '.tmp'); await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(path.join(temporaryRoot, 'fallback-build-'));
const architecture = process.arch === 'x64' ? 'amd64' : 'arm64';
const env = { ...process.env, GOENV: 'off', GOWORK: 'off', GOFLAGS: '', GOEXPERIMENT: '', GOTOOLCHAIN: 'go1.27.2', CGO_ENABLED: '0', GOOS: 'linux', GOARCH: architecture,
  ...(architecture === 'amd64' ? { GOAMD64: 'v1' } : { GOARM64: 'v8.0' }), CI: 'true' };
try {
  const builds: { web: string; server: string; ledger: string; info: string }[] = [];
  for (const name of ['first', 'reproduction']) {
    const source = path.join(temporary, name);
    await command('git', ['clone', '--no-hardlinks', '--no-checkout', repository, source]);
    await command('git', ['checkout', '--detach', fallbackBaseline], source);
    if ((await command('git', ['rev-parse', 'HEAD'], source)).stdout.trim() !== fallbackBaseline || (await command('git', ['rev-parse', '--is-shallow-repository'], source)).stdout.trim() !== 'false') throw new Error('Fallback source identity mismatch.');
    const registryInput = { source, probe: path.join(import.meta.dirname, 'subtask-compat-recovery-manifest-probe.go.txt'), overlayFile: path.join(temporary, `${name}-registry.json`), environment: env, command };
    const baselineLedger = migrationManifestHash((await readRegisteredMigrations(registryInput)).entries);
    await command('git', ['apply', '--unidiff-zero', '--check', patch], source); await command('git', ['apply', '--unidiff-zero', patch], source);
    const fallbackLedger = migrationManifestHash((await readRegisteredMigrations(registryInput)).entries);
    if (baselineLedger !== fallbackLedger || await hash(patch) !== fallbackPatchSHA256) throw new Error('Fallback patch or registry changed.');
    const web = path.join(source, 'packages/daynight-web');
    await symlink(path.join(repository, 'node_modules'), path.join(source, 'node_modules'), 'dir');
    await symlink(path.join(repository, 'packages/daynight-web/node_modules'), path.join(web, 'node_modules'), 'dir');
    await command(path.join(repository, 'packages/daynight-web/node_modules/.bin/tsc'), ['--project', 'tsconfig.build.json'], web, 600_000, env);
    await command(path.join(repository, 'packages/daynight-web/node_modules/.bin/vite'), ['build'], web, 600_000, env);
    await command(process.execPath, ['scripts/publish-assets.mts'], web, 60_000, env);
    await rm(path.join(web, 'node_modules')); await rm(path.join(source, 'node_modules'));
    const embedded = path.join(source, 'packages/daynight-server/internal/service/webui/dist');
    const webDigest = await treeHash(embedded), binary = path.join(temporary, `server-${name}`);
    await command('go', ['build', '-trimpath', '-o', binary, './cmd/daynight-server'], path.join(source, 'packages/daynight-server'), 600_000, env);
    const info = (await command('go', ['version', '-m', binary], repository, 30_000, env)).stdout;
    builds.push({ web: webDigest, server: await hash(binary), ledger: fallbackLedger, info });
  }
  const first = builds[0]!, reproduced = builds[1]!;
  verifyFallbackArtifact({ baseline: fallbackBaseline, patchSHA256: await hash(patch), baselineLedgerSHA256: first.ledger, fallbackLedgerSHA256: reproduced.ledger,
    webSHA256: first.web, reproducedWebSHA256: reproduced.web, serverSHA256: first.server, reproducedServerSHA256: reproduced.server, buildInfo: first.info });
  verifyFallbackArtifact({ baseline: fallbackBaseline, patchSHA256: await hash(patch), baselineLedgerSHA256: first.ledger, fallbackLedgerSHA256: reproduced.ledger,
    webSHA256: first.web, reproducedWebSHA256: reproduced.web, serverSHA256: first.server, reproducedServerSHA256: reproduced.server, buildInfo: reproduced.info });
  await mkdir(output, { recursive: false, mode: 0o700 });
  await cp(path.join(temporary, 'server-first'), path.join(output, 'daynight-server-fallback'), { errorOnExist: true, force: false });
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify({ kind: 'patched-baseline-recovery', baseline: fallbackBaseline, patchSHA256: fallbackPatchSHA256, migrationRegistrySHA256: first.ledger, webSHA256: first.web, serverSHA256: first.server, reproducible: true, buildInfo: first.info }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Patched baseline fallback artifact and manifest: ${output}`);
} finally {
  assertCommandQuiescence();
  await rm(temporary, { recursive: true, force: true });
}
