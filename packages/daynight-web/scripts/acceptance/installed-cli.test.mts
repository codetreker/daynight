import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { processIdentity, requireGroupStopped } from './identity.mts';
import { createAcceptanceCli, recordCliProcess, recoverCliProcesses, validateInstalledCli, type InstalledCliReceipt } from './installed-cli.mts';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const acceptance = join(repository, 'packages/daynight-web/.tmp/acceptance');
const privateRoot = join(repository, 'packages/daynight-web/.tmp/acceptance-private');
const source = { gitSha: '0123456789abcdef0123456789abcdef01234567', gitTreeSha: 'b'.repeat(40), dirty: true };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fixture = async (run: (value: { directory: string; receiptPath: string; receipt: InstalledCliReceipt; evidence: Record<string, unknown> }) => Promise<void>): Promise<void> => {
  const directory = join(acceptance, `20261021123456-${randomUUID()}`);
  const root = join(directory, 'installed-cli');
  const entryPath = join(root, 'consumer install/node_modules/@codetreker/daynight/dist/main.js');
  const launcherPath = join(root, 'consumer install/node_modules/.bin', process.platform === 'win32' ? 'daynight.cmd' : 'daynight');
  const tarballPath = join(root, 'daynight.tgz');
  await mkdir(dirname(entryPath), { recursive: true });
  await mkdir(dirname(launcherPath), { recursive: true });
  await writeFile(entryPath, `
    if(process.argv[2]==='bytes')process.stdout.write(Buffer.from([0,255,128,10]));
    else if(process.argv[2]==='missing'){process.stderr.write('not_found\\n');process.exitCode=1;}
    else if(process.argv[2]==='leak'){const{readFileSync}=await import('node:fs');process.stderr.write(readFileSync(process.env.HOME+'/.daynight/config.yml'));process.exitCode=1;}
    else if(process.argv[2]==='colors'){const{WriteStream}=await import('node:tty');WriteStream.prototype.getColorDepth();process.stdout.write('color-safe\\n');}
    else if(process.argv[2]==='wait'){const{writeFileSync}=await import('node:fs');writeFileSync(process.argv[3],String(process.pid));setInterval(()=>{},1000);}
    else {process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HOME})+'\\n');}
  `);
  await writeFile(tarballPath, 'packed fixture');
  await writeFile(launcherPath, 'launcher');
  const manifest = JSON.parse(await readFile(join(repository, 'packages/daynight/package.json'), 'utf8')) as { version: string };
  await writeFile(join(dirname(dirname(entryPath)), 'package.json'), JSON.stringify({ name: '@codetreker/daynight', version: manifest.version, bin: { daynight: 'dist/main.js' }, type: 'module' }));
  const receipt: InstalledCliReceipt = { schemaVersion: 1, root, packageVersion: manifest.version, tarballPath, tarballSha256: hash(await readFile(tarballPath)),
    nodePath: process.execPath, entryPath, entrySha256: hash(await readFile(entryPath)), launcherPath, source };
  const receiptPath = join(root, 'installed-cli.json');
  const evidence = { runId: directory.split('/').at(-1), source, installedCli: { root, receiptPath, receipt } };
  await writeFile(receiptPath, JSON.stringify(receipt));
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence));
  const originalReceipt = process.env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT;
  const ci = process.env.CI;
  delete process.env.CI;
  process.env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT = receiptPath;
  try { await run({ directory, receiptPath, receipt, evidence }); }
  finally {
    if (originalReceipt === undefined) delete process.env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT; else process.env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT = originalReceipt;
    if (ci === undefined) delete process.env.CI; else process.env.CI = ci;
    await rm(directory, { recursive: true, force: true });
    await rm(join(privateRoot, basename(directory)), { recursive: true, force: true });
  }
};

const within = async <T,>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 5_000);
  })]); }
  finally { clearTimeout(timer); }
};

test('installed bridge validates parent artifact evidence and preserves installed CLI output', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await fixture(async ({ directory, receiptPath, receipt }) => {
    assert.deepEqual(await validateInstalledCli(receiptPath, directory), receipt);
    const workspace = join(directory, 'native/functional/test-results/cli');
    const cli = await createAcceptanceCli('http://127.0.0.1:12345', workspace, 'dnpat_private-test-token');
    assert.deepEqual(await cli.read(['bytes']), Buffer.from([0, 255, 128, 10]));
    const ordinary = await cli.run(['text']);
    assert.equal(ordinary.exitCode, 0);
    assert.equal(ordinary.stdout.endsWith('\n'), true);
    const paths = JSON.parse(ordinary.stdout) as { cwd: string; home: string };
    assert.equal(paths.cwd, join(workspace, 'workspace'));
    assert.equal(paths.home.startsWith(join(privateRoot, basename(directory), 'cli') + '/'), true);
    assert.equal(paths.home.startsWith(directory + '/'), false);
    await assert.rejects(readFile(join(workspace, 'home/.daynight/config.yml')), { code: 'ENOENT' });
    assert.equal(await readFile(join(paths.home, '.daynight/config.yml'), 'utf8'), 'serverUrl: "http://127.0.0.1:12345"\nserverToken: "dnpat_private-test-token"\n');
    assert.equal((await stat(join(paths.home, '.daynight/config.yml'))).mode & 0o777, 0o600);
    assert.equal((await readFile(join(directory, 'evidence.json'), 'utf8')).includes('dnpat_private-test-token'), false);
    assert.deepEqual(await cli.run(['missing']), { exitCode: 1, stdout: '', stderr: 'not_found\n' });
    await assert.rejects(cli.read(['missing']), /not_found/);
    assert.equal((await readdir(join(directory, 'cli-processes'))).length, 4);
    await cli.close();
    await cli.close();
    await assert.rejects(readFile(join(paths.home, '.daynight/config.yml')), { code: 'ENOENT' });
    await assert.rejects(cli.run(['text']), /already closed/);
    assert.deepEqual(await validateInstalledCli(receiptPath, directory), receipt);
    await recoverCliProcesses(directory, receiptPath, receipt);
  });
});

test('an explicit installed receipt is independent of the ambient receipt without changing its default', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await fixture(async ({ directory, receiptPath }) => {
    const ambientReceipt = join(directory, 'unrelated-receipt.json');
    process.env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT = ambientReceipt;
    const workspace = join(directory, 'native/auth-combined/cli');
    const cli = await createAcceptanceCli('http://127.0.0.1:12345', workspace, 'dnpat_explicit-receipt-token', receiptPath);
    try {
      assert.deepEqual(await cli.read(['bytes']), Buffer.from([0, 255, 128, 10]));
      assert.equal(process.env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT, ambientReceipt);
      await assert.rejects(createAcceptanceCli('http://127.0.0.1:12345', join(directory, 'default-receipt'),
        'dnpat_explicit-receipt-token'), { code: 'ENOENT' });
      assert.equal(process.env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT, ambientReceipt);
    } finally { await cli.close(); }
  });
});

test('receipt validation rejects source, package, hash and containment changes', async () => {
  await fixture(async ({ directory, receiptPath, receipt, evidence }) => {
    for (const changed of [
      { ...receipt, source: { ...source, gitSha: 'f'.repeat(40) } },
      { ...receipt, source: { ...source, gitTreeSha: 'f'.repeat(40) } },
      { ...receipt, source: { ...source, dirty: false } },
      { ...receipt, packageVersion: '999.0.0' },
      { ...receipt, entryPath: process.execPath },
      { ...receipt, root: dirname(directory) },
    ]) {
      await writeFile(receiptPath, JSON.stringify(changed));
      await assert.rejects(validateInstalledCli(receiptPath, directory));
    }
    await writeFile(receiptPath, JSON.stringify(receipt));
    await writeFile(receipt.tarballPath, 'changed tarball');
    await assert.rejects(validateInstalledCli(receiptPath, directory), /hash/);
    await writeFile(receipt.tarballPath, 'packed fixture');
    await writeFile(receipt.entryPath, 'changed entry');
    await assert.rejects(validateInstalledCli(receiptPath, directory), /hash/);
    await writeFile(join(directory, 'evidence.json'), JSON.stringify({ ...evidence, source: { ...source, dirty: false } }));
    await assert.rejects(validateInstalledCli(receiptPath, directory), /source/);
  });
});

test('receipt validation requires an exact valid tree identity in both source records', async () => {
  await fixture(async ({ directory, receiptPath, receipt, evidence }) => {
    for (const gitTreeSha of [undefined, 'invalid', 'f'.repeat(40)]) {
      await writeFile(join(directory, 'evidence.json'), JSON.stringify({ ...evidence, source: { ...source, gitTreeSha } }));
      await assert.rejects(validateInstalledCli(receiptPath, directory), /source/);
    }
    const withoutTree = { ...receipt, source: { gitSha: source.gitSha, dirty: source.dirty } };
    await writeFile(receiptPath, JSON.stringify(withoutTree));
    await writeFile(join(directory, 'evidence.json'), JSON.stringify({ ...evidence,
      source: withoutTree.source, installedCli: { root: receipt.root, receiptPath, receipt: withoutTree } }));
    await assert.rejects(validateInstalledCli(receiptPath, directory), /source/);
  });
});

test('CI receipt validation requires the clean exact GitHub source', async () => {
  await fixture(async ({ directory, receiptPath }) => {
    process.env.CI = 'true';
    await assert.rejects(validateInstalledCli(receiptPath, directory), /clean GITHUB_SHA/);
  });
});

test('recovery terminates only recorded installed CLI groups', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await fixture(async ({ directory, receiptPath, receipt }) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: { ...process.env,
      DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT: receiptPath, DAYNIGHT_ACCEPTANCE_RUN_DIRECTORY: directory } });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      await recordCliProcess(directory, receiptPath, child);
      await recoverCliProcesses(directory, receiptPath, receipt);
      await closed;
      assert.equal(child.signalCode, 'SIGTERM');
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
  });
});

test('recovery waits for the parent to reap a terminated installed CLI child', { skip: process.platform !== 'linux' }, async (context) => {
  await fixture(async ({ directory, receiptPath, receipt }) => {
    const module = new URL('./installed-cli.mts', import.meta.url).href;
    const env = { ...process.env };
    delete env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT;
    delete env.DAYNIGHT_ACCEPTANCE_RUN_DIRECTORY;
    const supervisor = spawn(process.execPath, ['--input-type=module', '--eval', `
      import { spawn } from 'node:child_process';
      import { readSync } from 'node:fs';
      import { recordCliProcess } from ${JSON.stringify(module)};
      const [directory, receiptPath] = process.argv.slice(1);
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore',
        env: { ...process.env, DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT: receiptPath, DAYNIGHT_ACCEPTANCE_RUN_DIRECTORY: directory } });
      const closed = new Promise((resolve) => child.once('close', resolve));
      const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));
      try {
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        await recordCliProcess(directory, receiptPath, child);
        await send({ kind: 'registered', pid: child.pid });
        readSync(0, Buffer.alloc(1), 0, 1, null);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
        await send({ kind: 'closed', signal: child.signalCode });
        process.disconnect();
      }
    `, directory, receiptPath], { detached: true, env, stdio: ['pipe', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    supervisor.stderr!.on('data', (bytes: Buffer) => { stderr += bytes.toString(); });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => supervisor.once('close', (code, signal) => resolve({ code, signal })));
    let closedSignal: unknown;
    supervisor.on('message', (message) => { if ((message as { kind: string }).kind === 'closed') closedSignal = (message as { signal: unknown }).signal; });
    const registered = new Promise<number>((resolve, reject) => {
      supervisor.once('error', reject);
      supervisor.once('message', (message) => {
        const value = message as { kind: string; pid: number };
        if (value.kind !== 'registered' || !Number.isSafeInteger(value.pid)) reject(new Error('Supervisor did not register its CLI child.'));
        else resolve(value.pid);
      });
    });
    let recovering: Promise<{ error?: unknown }> | undefined;
    let restoreKill = () => {};
    let failure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      const pid = await within(registered, 'supervised CLI registration');
      const identity = await processIdentity(pid);
      assert.notEqual(identity, null);
      await writeFile(join(directory, 'held-reap-processes.json'), JSON.stringify({ supervisor: await processIdentity(supervisor.pid!), child: identity }));
      const checked = Promise.withResolvers<void>();
      const nativeKill = process.kill;
      const kill = context.mock.method(process, 'kill', (group: number, signal?: NodeJS.Signals | number) => {
        const result = nativeKill(group, signal);
        if (group === -pid && signal === 0) checked.resolve();
        return result;
      });
      restoreKill = () => kill.mock.restore();
      let settled = false;
      recovering = recoverCliProcesses(directory, receiptPath, receipt).then(() => { settled = true; return {}; }, (error: unknown) => { settled = true; return { error }; });
      const zombieObservation = new AbortController();
      try {
        // A successful group probe does not establish the held child's exit state.
        await within((async () => {
          await checked.promise;
          while (!zombieObservation.signal.aborted) {
            const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            assert.equal(fields[19], identity!.startTicks, 'The held CLI child retains its original process identity.');
            assert.equal(Number(fields[2]), identity!.group, 'The held CLI child retains its original process group.');
            if (fields[0] === 'Z') return;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        })(), 'terminated CLI zombie state');
      } finally { zombieObservation.abort(); }
      assert.equal(await processIdentity(pid), null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, 'Recovery must wait until the parent reaps the terminated group member.');
      // The synchronous read prevents the supervisor's event loop from reaping its child.
      supervisor.stdin!.end(Buffer.of(1));
      const result = await within(recovering, 'reaped CLI recovery');
      assert.equal(result.error, undefined);
      assert.deepEqual(await within(done, 'supervisor cleanup'), { code: 0, signal: null }, stderr);
      assert.equal(closedSignal, 'SIGTERM');
      requireGroupStopped(pid);
    } catch (error) { failure = error; }
    finally {
      try { if (!supervisor.stdin!.destroyed) supervisor.stdin!.end(Buffer.of(1)); }
      catch (error) { cleanupFailures.push(error); }
      try { await within(done, 'supervisor final cleanup'); }
      catch (error) { cleanupFailures.push(error); }
      if (recovering !== undefined) {
        try { const result = await within(recovering, 'recovery final cleanup'); if (result.error !== undefined) cleanupFailures.push(result.error); }
        catch (error) { cleanupFailures.push(error); }
      }
      restoreKill();
    }
    if (cleanupFailures.length > 0) throw new AggregateError(failure === undefined ? cleanupFailures : [failure, ...cleanupFailures], 'CLI recovery assertion or fixture cleanup failed.');
    if (failure !== undefined) throw failure;
  });
});

test('recovery preserves live groups without ownership and rejects changed receipts before signalling', { skip: !['linux', 'darwin'].includes(process.platform) }, async (context) => {
  for (const refusal of ['unowned', 'identity', 'executable', 'ownership', 'path'] as const) await fixture(async ({ directory, receiptPath, receipt }) => {
    const env = { ...process.env };
    delete env.DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT;
    delete env.DAYNIGHT_ACCEPTANCE_RUN_DIRECTORY;
    if (refusal !== 'unowned') Object.assign(env, { DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT: receiptPath, DAYNIGHT_ACCEPTANCE_RUN_DIRECTORY: directory });
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env });
    const closed = new Promise<void>((resolve) => child.once('close', resolve));
    const signals: unknown[] = [];
    const nativeKill = process.kill;
    const kill = context.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => { if (signal !== 0) signals.push([pid, signal]); return nativeKill(pid, signal); });
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      await recordCliProcess(directory, receiptPath, child);
      if (refusal === 'identity' || refusal === 'ownership') {
        const names = await readdir(join(directory, 'cli-processes'));
        assert.equal(names.length, 1);
        const path = join(directory, 'cli-processes', names[0]!);
        const record = JSON.parse(await readFile(path, 'utf8')) as { directory: string; identity: { startTicks: string } };
        if (refusal === 'identity') record.identity.startTicks = '0'; else record.directory = dirname(directory);
        await writeFile(path, JSON.stringify(record));
      }
      const expected = { unowned: /group is still running/, identity: /leader identity changed/, executable: /unexpected executable/, ownership: /receipt ownership differs/, path: /paths do not belong/ };
      await assert.rejects(recoverCliProcesses(directory, refusal === 'path' ? join(directory, 'wrong.json') : receiptPath,
        refusal === 'executable' ? { ...receipt, nodePath: '/bin/sh' } : receipt), expected[refusal]);
      assert.deepEqual(signals, []);
      assert.notEqual(await processIdentity(child.pid!), null);
      assert.equal(child.signalCode, null);
    } finally {
      kill.mock.restore();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  });
});

test('an exclusive fixture root failure preserves a preexisting installation', async () => {
  await fixture(async ({ directory, receipt }) => {
    const before = await readFile(receipt.entryPath);
    const producer = await import(new URL('../../../daynight/test/fixtures/installed-cli.ts', import.meta.url).href) as {
      createInstalledCli: (options: { temporaryRoot: string; rootDirectory: string }) => Promise<unknown>;
    };
    await assert.rejects(producer.createInstalledCli({ temporaryRoot: directory, rootDirectory: receipt.root }), { code: 'EEXIST' });
    assert.deepEqual(await readFile(receipt.entryPath), before);
    assert.equal(await readFile(receipt.tarballPath, 'utf8'), 'packed fixture');
  });
});

test('captured CLI output disables inherited forced color without changing the parent environment', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await fixture(async ({ directory }) => {
    const previousForce = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    process.env.NO_COLOR = '1';
    try {
      const workspace = join(directory, 'native/functional/test-results/color-cli');
      const cli = await createAcceptanceCli('http://127.0.0.1:12345', workspace, 'dnpat_private-test-token');
      try {
        const result = await cli.run(['colors']);
        assert.equal(result.exitCode, 0);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, 'color-safe\n');
        assert.equal(process.env.FORCE_COLOR, '1');
        assert.equal(process.env.NO_COLOR, '1');
      } finally { await cli.close(); }
    } finally {
      if (previousForce === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = previousForce;
      if (previousNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previousNoColor;
    }
  });
});


test('CLI recovery removes private credentials while preserving installed evidence and unrelated private runs', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await fixture(async ({ directory, receiptPath, receipt }) => {
    const workspace = join(directory, 'native/functional/test-results/recovery-cli');
    const cli = await createAcceptanceCli('http://127.0.0.1:12345', workspace, 'dnpat_private-test-token');
    const result = await cli.run(['text']);
    const { home } = JSON.parse(result.stdout) as { home: string };
    const unrelated = join(privateRoot, `20261021123456-${randomUUID()}`, 'cli/other/home/.daynight/config.yml');
    await mkdir(dirname(unrelated), { recursive: true });
    await writeFile(unrelated, 'operator-private-configuration', { mode: 0o600 });
    try {
      await assert.rejects(cli.read(['leak']), (error: Error) => {
        assert.match(error.message, /exposed its private acceptance credential/);
        assert.equal(error.message.includes('dnpat_private-test-token'), false);
        return true;
      });
      await recoverCliProcesses(directory, receiptPath, receipt);
      await assert.rejects(readFile(join(home, '.daynight/config.yml')), { code: 'ENOENT' });
      assert.equal(await readFile(unrelated, 'utf8'), 'operator-private-configuration');
      assert.deepEqual(await validateInstalledCli(receiptPath, directory), receipt);
    } finally {
      await cli.close();
      await rm(join(privateRoot, unrelated.slice(privateRoot.length + 1).split('/')[0]!), { recursive: true, force: true });
    }
  });
});

test('CLI cancellation stops its command group while a sibling target keeps its process and credentials', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await fixture(async ({ directory, receiptPath, receipt }) => {
    const controllers = [new AbortController(), new AbortController()];
    const clients = await Promise.all(['native/auth-combined', 'container/auth-combined'].map((target, index) =>
      createAcceptanceCli('http://127.0.0.1:12345', join(directory, target, 'cli'), 'dnpat_cancel-test-token', receiptPath, controllers[index]!.signal)));
    const ready = controllers.map((_controller, index) => join(directory, `waiting-${index}`));
    const runs = clients.map((client, index) => client.run(['wait', ready[index]!]).then(() => ({ error: undefined }), (error: unknown) => ({ error })));
    const waitForPid = async (path: string): Promise<number> => {
      const deadline = performance.now() + 5_000;
      for (;;) {
        try { return Number(await readFile(path, 'utf8')); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        if (performance.now() >= deadline) throw new Error('CLI command did not start.');
        await new Promise((done) => setTimeout(done, 10));
      }
    };
    try {
      const pids = await Promise.all(ready.map(waitForPid));
      const sibling = await processIdentity(pids[1]!);
      assert.ok(sibling);
      const reason = new Error('Cancel native combined acceptance.');
      controllers[0]!.abort(reason);
      const { error } = await within(runs[0]!, 'cancelled CLI settlement');
      assert.ok(error instanceof Error);
      assert.equal(error.cause, reason);
      requireGroupStopped(pids[0]!);
      assert.deepEqual(await processIdentity(pids[1]!), sibling);
      assert.deepEqual(await clients[1]!.read(['bytes']), Buffer.from([0, 255, 128, 10]));
      const homes = await readdir(join(privateRoot, basename(directory), 'cli'));
      assert.equal(homes.length, 2);
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(runs);
      await Promise.all(clients.map((client) => client.close()));
      await recoverCliProcesses(directory, receiptPath, receipt);
    }
  });
});
