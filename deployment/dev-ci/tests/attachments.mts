import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login } from '../../../packages/daynight-server/scripts/auth-fixture.mts';

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), '../../..');
const deployment = path.join(repository, 'deployment/dev-ci');
const runner = path.join(deployment, 'run.sh');
const storageRoot = '/var/lib/daynight/storage';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const json = async (file: string, value: unknown) => {
  await writeFile(`${file}.next`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${file}.next`, file);
};

const command = async (args: string[], options: { input?: string; output?: string; timeout?: number } = {}) => {
  const input = options.input ? openSync(options.input, 'r') : undefined;
  const output = options.output ? openSync(options.output, 'w', 0o600) : undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('docker', args, {
        cwd: repository,
        stdio: [input ?? 'ignore', output ?? 'pipe', 'inherit'],
        timeout: options.timeout ?? 180_000,
      });
      let stdout = '';
      child.stdout?.on('data', chunk => { stdout += chunk; });
      child.on('error', reject);
      child.on('exit', (code, signal) => code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`docker ${args.join(' ')} failed: ${code ?? signal}`)));
    });
  } finally {
    if (input !== undefined) closeSync(input);
    if (output !== undefined) closeSync(output);
  }
};

const waitFor = async <T>(operation: () => Promise<T | undefined>, label: string, timeout = 180_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result !== undefined) return result;
    await pause();
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const readJson = async (file: string) => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

type Metadata = { path: string; contentType: string; sizeBytes: number; createdAt: string; updatedAt: string };
type Ready = { runId: string; project: string; projectId: string; taskId: string; volumes: string[] };
type TaskSync = { mode: 'snapshot' | 'delta'; epoch: string; project: { id: string }; tasks: { id: string }[] };

const projectCheck = async (name: string, root: string) => {
  const runId = process.env.DAYNIGHT_DEV_CI_RUN_ID;
  assert.match(runId!, /^[0-9]{14}-[0-9]+-[0-9]{5}$/);
  const project = `daynight-dev-ci-${runId}`;
  const authEnvironment = process.env.DAYNIGHT_DEV_CI_AUTH_ENV_FILE;
  assert.ok(authEnvironment, 'dev-ci runner must provide its private authentication environment');
  assert.ok(process.env.DAYNIGHT_AUTH_FIXTURE_DESCRIPTOR, 'dev-ci runner must provide its private authentication fixture descriptor');
  const compose = ['compose', '--env-file', authEnvironment, '--project-directory', deployment,
    '--file', path.join(deployment, 'compose.yaml'), '--project-name', project];
  const directory = path.join(root, name);
  await mkdir(directory);
  const actions: string[] = [];
  const receipt = { project, runId, storageRoot, actions, result: 'running' };
  const act = async (action: string) => {
    actions.push(action);
    await json(path.join(directory, 'receipt.json'), receipt);
    console.log(`${name}: ${action}`);
  };
  await act('verify fresh production-image volume');
  const composeCommand = (args: string[], options?: Parameters<typeof command>[1]) => command([...compose, ...args], options);
  const discoverOrigin = async () => {
    const endpoint = await composeCommand(['port', 'gateway', '80']);
    assert.match(endpoint, /^127\.0\.0\.1:[0-9]+$/);
    return `http://${endpoint}`;
  };
  const reconfigure = async (bootstrap = false) => await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', [runner, '--reconfigure', runId!, ...(bootstrap ? ['--bootstrap'] : [])], {
      cwd: repository, stdio: 'inherit', timeout: 180_000,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`dev-ci reconfiguration failed: ${code ?? signal}`)));
  });
  let origin = await discoverOrigin();
  let authenticated = await login({ origin });
  const request = async (route: string, init?: RequestInit, status = 200) => {
    const response = await authenticated.request(route, { ...init, signal: AbortSignal.timeout(15_000) });
    if (response.status !== status) await response.body?.cancel();
    assert.equal(response.status, status, `${init?.method ?? 'GET'} ${route}`);
    return response;
  };
  const volumeCheck = async () => {
    const serverId = await composeCommand(['ps', '--quiet', 'server']);
    const [container] = JSON.parse(await command(['inspect', serverId]));
    assert.equal(container.Config.User, '10001:10001');
    assert.deepEqual(container.Config.Entrypoint, ['/usr/local/bin/daynight-server']);
    const mount = container.Mounts.find((entry: { Destination: string }) => entry.Destination === storageRoot);
    assert.equal(mount.Type, 'volume');
    assert.equal(mount.Name, `${project}_attachment-data`);
    assert.equal(await composeCommand(['exec', '-T', 'server', 'id', '-u']), '10001');
    assert.equal(await composeCommand(['exec', '-T', 'server', 'stat', '-c', '%u:%g', storageRoot]), '10001:10001');
    await json(path.join(directory, 'volume.json'), {
      project, serverId, imageId: container.Image, user: container.Config.User,
      entrypoint: container.Config.Entrypoint, volumeName: mount.Name, destination: mount.Destination,
      rootOwnership: '10001:10001',
    });
    return mount.Name as string;
  };
  const attachmentVolume = await volumeCheck();
  const volumes = (await command(['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`])).split('\n').sort();
  assert.deepEqual(volumes, [`${project}_attachment-data`, `${project}_postgres-data`]);
  for (const volume of volumes) {
    const [state] = JSON.parse(await command(['volume', 'inspect', volume]));
    assert.equal(state.Labels['com.docker.compose.project'], project);
  }
  const createdProject = await (await request('/api/v1/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Attachment persistence ${name}`, repoUrl: 'https://github.com/example/attachment-persistence.git' }),
  }, 201)).json();
  assert.match(createdProject.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const createdTask = await (await request(`/api/v1/projects/${createdProject.id}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Persist nested attachment files', description: name }),
  }, 201)).json();
  const prefix = `/api/v1/projects/${createdProject.id}/tasks/${createdTask.id}`;
  const syncObservations: { phase: string; epoch: string; mode: string; taskIds: string[] }[] = [];
  const taskSync = async (phase: string, query?: URLSearchParams) => {
    const suffix = query ? `?${query}` : '';
    const result = await (await request(`/api/v1/projects/${createdProject.id}/task-sync${suffix}`)).json() as TaskSync;
    assert.match(result.epoch, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(result.project.id, createdProject.id);
    assert.equal(result.mode, 'snapshot');
    assert.deepEqual(result.tasks.map(task => task.id), [createdTask.id]);
    syncObservations.push({ phase, epoch: result.epoch, mode: result.mode, taskIds: result.tasks.map(task => task.id) });
    await json(path.join(directory, 'task-sync.json'), { project, projectId: createdProject.id, observations: syncObservations });
    return result;
  };
  const files = [
    { path: 'docs/nested/design.md', type: 'text/markdown', bytes: Buffer.from(`# ${name}\nNested UTF-8 附件\n`) },
    { path: 'assets/blob.bin', type: 'application/octet-stream', bytes: Buffer.from([0, 255, 128, 13, 10, ...Buffer.from(name)]) },
    { path: 'mockup/index.html', type: 'text/html', bytes: Buffer.from(`<!doctype html><link rel="stylesheet" href="./assets/style.css"><p>${name}</p>`) },
    { path: 'mockup/assets/style.css', type: 'text/css', bytes: Buffer.from(`body { color: ${name === 'primary' ? 'red' : 'blue'}; }\n`) },
  ];
  const encode = (relative: string) => relative.split('/').map(encodeURIComponent).join('/');
  const metadata: Metadata[] = [];
  await act('upload nested text, binary and HTML/CSS through gateway');
  for (const file of files) {
    const saved = await (await request(`${prefix}/attachments/files/${encode(file.path)}`, {
      method: 'PUT', headers: { 'Content-Type': file.type }, body: file.bytes,
    }, 201)).json() as Metadata;
    assert.deepEqual(Object.keys(saved).sort(), ['contentType', 'createdAt', 'path', 'sizeBytes', 'updatedAt']);
    assert.equal(saved.path, file.path);
    assert.equal(saved.contentType, file.type);
    assert.equal(saved.sizeBytes, file.bytes.length);
    assert.ok(Number.isFinite(Date.parse(saved.createdAt)));
    assert.equal(saved.updatedAt, saved.createdAt);
    metadata.push(saved);
  }
  metadata.sort((left, right) => left.path < right.path ? -1 : 1);
  await json(path.join(directory, 'attachments.json'), {
    project, projectId: createdProject.id, taskId: createdTask.id, metadata,
    files: files.map(file => ({ path: file.path, sha256: hash(file.bytes) })),
  });
  const verify = async () => {
    const page = await (await request(`${prefix}/attachments?limit=100`)).json();
    assert.deepEqual(page, { items: metadata, nextCursor: null });
    for (const file of files) {
      for (const kind of ['attachments/files', 'preview']) {
        const response = await request(`${prefix}/${kind}/${encode(file.path)}`);
        assert.equal(Number(response.headers.get('content-length')), file.bytes.length);
        assert.equal(response.headers.get('content-type'), file.type);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(response.headers.get('content-disposition')!, kind === 'preview' ? /^inline/ : /^attachment/);
        assert.equal(hash(new Uint8Array(await response.arrayBuffer())), hash(file.bytes));
      }
    }
    const htmlUrl = new URL(`${origin}${prefix}/preview/mockup/index.html`);
    const css = await request(new URL('./assets/style.css', htmlUrl).href);
    assert.equal(css.status, 200);
    assert.equal(hash(new Uint8Array(await css.arrayBuffer())), hash(files[3].bytes));
  };
  const newUpload = async (relative: string) => {
    const bytes = Buffer.from(`new nonroot write: ${name}`);
    const result = await request(`${prefix}/attachments/files/${relative}`, {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: bytes,
    }, 201);
    assert.equal((await result.json()).sizeBytes, bytes.length);
    assert.equal(hash(new Uint8Array(await (await request(`${prefix}/attachments/files/${relative}`)).arrayBuffer())), hash(bytes));
  };
  const dump = path.join(directory, 'postgres.sql');
  const archive = path.join(directory, 'attachments.tar');
  try {
    await verify();
    if (name === 'primary') {
      const initialSync = await taskSync('before restart');
      await act('stop and restart server, then verify exact metadata, bytes and task cache epoch');
      await composeCommand(['stop', '--timeout', '20', 'server']);
      await composeCommand(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '120', 'server']);
      assert.equal(await discoverOrigin(), origin);
      assert.equal((await taskSync('after restart')).epoch, initialSync.epoch);
      await verify();
      await act('force recreate production stack while retaining both volumes');
      await composeCommand(['down', '--remove-orphans', '--timeout', '20']);
      await reconfigure();
      origin = await discoverOrigin();
      authenticated = await login({ origin });
      assert.equal(await volumeCheck(), attachmentVolume);
      assert.equal((await taskSync('after recreation')).epoch, initialSync.epoch);
      await verify();
      const backedUpSync = await taskSync('before backup');
      await act('stop server writes and capture paired PostgreSQL dump and attachment archive');
      await composeCommand(['stop', '--timeout', '20', 'server']);
      const stopped = JSON.parse(await command(['inspect', await composeCommand(['ps', '--all', '--quiet', 'server'])]));
      assert.equal(stopped[0].State.Running, false);
      await composeCommand(['exec', '-T', 'postgres', 'pg_dump', '--no-owner', '--no-acl', '-U', 'daynight', '-d', 'daynight'], { output: dump });
      await composeCommand(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'server', '-C', storageRoot, '-cpf', '-', '.'], { output: archive });
      await json(path.join(directory, 'backup.json'), {
        project, stoppedWrites: true, taskCacheEpoch: backedUpSync.epoch, dumpSha256: hash(await readFile(dump)), archiveSha256: hash(await readFile(archive)),
        attachments: files.map(file => ({ path: file.path, sha256: hash(file.bytes) })), metadata,
      });
      await act('destroy only this project and its volumes, then restore the matching pair into fresh volumes');
      await composeCommand(['down', '--volumes', '--remove-orphans', '--timeout', '20']);
      assert.equal(await command(['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`]), '');
      await reconfigure(true);
      await waitFor(async () => {
        const id = await composeCommand(['ps', '--quiet', 'postgres']);
        const [state] = JSON.parse(await command(['inspect', id]));
        return state.State.Health.Status === 'healthy' ? true : undefined;
      }, 'fresh PostgreSQL health');
      await composeCommand(['exec', '-T', 'postgres', 'psql', '--set', 'ON_ERROR_STOP=1', '-U', 'daynight', '-d', 'daynight'], { input: dump });
      await composeCommand(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'server', '-C', storageRoot, '-xpf', '-'], { input: archive });
      await act('rotate the restored fixture project task cache epoch before starting the server');
      const rotated = await composeCommand(['exec', '-T', 'postgres', 'psql', '--set', 'ON_ERROR_STOP=1', '-U', 'daynight', '-d', 'daynight',
        '--command', `UPDATE projects SET task_cache_epoch = gen_random_uuid() WHERE id = '${createdProject.id}'::uuid`]);
      assert.equal(rotated, 'UPDATE 1');
      await reconfigure();
      origin = await discoverOrigin();
      authenticated = await login({ origin });
      await volumeCheck();
      const restoredSync = await taskSync('after restore');
      assert.notEqual(restoredSync.epoch, backedUpSync.epoch);
      const oldEpochSync = await taskSync('old epoch after restore', new URLSearchParams({
        epoch: backedUpSync.epoch, since: '9999-12-31T23:59:59Z',
      }));
      assert.equal(oldEpochSync.epoch, restoredSync.epoch);
      await verify();
      await newUpload('restored/new.txt');
      await act('paired restore replaces the task cache epoch, returns an old-epoch snapshot and preserves attachment reads and writes');
    }
    const ready: Ready = { project, runId: runId!, projectId: createdProject.id, taskId: createdTask.id, volumes };
    await json(path.join(root, `${name}-ready.json`), ready);
    const peerName = name === 'primary' ? 'secondary' : 'primary';
    const peer = await waitFor(() => readJson(path.join(root, `${peerName}-ready.json`)), `${peerName} readiness`, 900_000) as Ready;
    await request(`/api/v1/projects/${peer.projectId}`, undefined, 404);
    await request(`/api/v1/projects/${peer.projectId}/tasks/${peer.taskId}/preview/docs/nested/design.md`, undefined, 404);
    assert.ok(volumes.every(volume => !peer.volumes.includes(volume)));
    await composeCommand(['exec', '-T', 'server', 'test', '-f', `${storageRoot}/task-attachments/${createdTask.id}/docs/nested/design.md`]);
    await composeCommand(['exec', '-T', 'server', 'sh', '-c', 'test ! -e "$1"', 'sh', `${storageRoot}/task-attachments/${peer.taskId}`]);
    await json(path.join(root, `${name}-isolated.json`), { project, peer: peer.project, isolated: true });
    if (name === 'secondary') {
      await waitFor(() => readJson(path.join(root, 'verify-survivor.json')), 'primary project cleanup', 900_000);
      await verify();
      await newUpload('survivor/new.txt');
      await act('other project cleanup leaves metadata, bytes, previews and new uploads usable');
      await json(path.join(root, 'survived.json'), { project, survived: true });
    }
    await waitFor(() => readJson(path.join(root, `${name}-finish.json`)), `${name} finish`, 900_000);
    receipt.result = 'passed';
  } catch (error) {
    receipt.result = 'failed';
    throw error;
  } finally {
    await json(path.join(directory, 'receipt.json'), receipt);
    await rm(dump, { force: true });
    await rm(archive, { force: true });
  }
};

const main = async () => {
  await mkdir(path.join(repository, '.tmp'), { recursive: true });
  const root = await mkdtemp(path.join(repository, '.tmp/attachment-deployment-'));
  const sources = [
    'deployment/dev-ci/tests/attachments.mts', 'deployment/dev-ci/run.sh', 'deployment/dev-ci/auth.mts',
    'deployment/dev-ci/compose.yaml', 'deployment/localhost/compose.yaml',
    'deployment/localhost/Dockerfile', 'deployment/localhost/nginx.conf',
    'packages/daynight-server/scripts/auth-fixture.mts',
    'packages/daynight-server/scripts/prepare-uniauth-fixture.mts',
    'packages/daynight-server/testdata/uniauth-fixture/main.go',
  ];
  await json(path.join(root, 'ownership.json'), {
    owner: 'attachment-deployment-check', createdAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    sources: await Promise.all(sources.map(async source => ({ path: source, sha256: hash(await readFile(path.join(repository, source))) }))),
  });
  console.log(`Attachment deployment evidence: ${root}`);
  const running = ['primary', 'secondary'].map(name => {
    const child = spawn('bash', [runner, process.execPath, script, '--project', name, root], { cwd: repository, stdio: 'inherit' });
    const state = { child, name, exit: undefined as number | null | undefined, signal: null as string | null };
    child.on('exit', (code, signal) => { state.exit = code; state.signal = signal; });
    child.on('error', error => { console.error(error); state.exit = 1; });
    return state;
  });
  const completed = new Set<string>();
  let interruption: string | undefined;
  const interrupt = (signal: string) => {
    interruption = signal;
    for (const state of running) if (state.exit === undefined) state.child.kill('SIGTERM');
  };
  const onInterrupt = () => interrupt('SIGINT');
  const onTerminate = () => interrupt('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const observe = async (filename: string) => waitFor(async () => {
    if (interruption) throw new Error(`Attachment check interrupted by ${interruption}`);
    for (const process of running) {
      if (process.exit !== undefined && !completed.has(process.name)) throw new Error(`${process.name} runner exited before ${filename}: ${process.exit ?? process.signal}`);
    }
    return readJson(path.join(root, filename));
  }, filename, 1_200_000);
  const ended = async (name: string) => {
    const state = running.find(entry => entry.name === name)!;
    await waitFor(async () => state.exit !== undefined ? true : undefined, `${name} cleanup`);
    assert.equal(state.exit, 0, `${name}: ${state.signal ?? state.exit}`);
    const ready = await readJson(path.join(root, `${name}-ready.json`)) as Ready;
    const manifest = await readJson(path.join(repository, '.tmp/dev-ci', ready.runId, 'manifest.json'));
    assert.equal(manifest.cleanupResult, 'passed');
    assert.deepEqual(manifest.volumeNames.sort(), ready.volumes);
    for (const resource of [['ps', '--all', '--quiet'], ['volume', 'ls', '--quiet'], ['network', 'ls', '--quiet']]) {
      assert.equal(await command([...resource, '--filter', `label=com.docker.compose.project=${ready.project}`]), '');
    }
    assert.equal(await command(['image', 'ls', '--quiet', `daynight-dev-ci:${ready.runId}`]), '');
    completed.add(name);
  };
  try {
    await Promise.all(['primary-isolated.json', 'secondary-isolated.json'].map(observe));
    await json(path.join(root, 'primary-finish.json'), true);
    await ended('primary');
    await json(path.join(root, 'verify-survivor.json'), true);
    await observe('survived.json');
    await json(path.join(root, 'secondary-finish.json'), true);
    await ended('secondary');
    await json(path.join(root, 'result.json'), { result: 'passed', cleanupResult: 'passed' });
    console.log('PASS production attachment volume permissions, persistence, isolation, paired restore, task cache epoch and cleanup');
  } catch (error) {
    await json(path.join(root, 'result.json'), { result: 'failed', error: String(error) });
    throw error;
  } finally {
    for (const state of running) if (state.exit === undefined) state.child.kill('SIGTERM');
    await Promise.all(running.map(state => waitFor(async () => state.exit !== undefined ? true : undefined, `${state.name} runner termination`)));
    for (const name of ['primary', 'secondary']) {
      await rm(path.join(root, name, 'postgres.sql'), { force: true });
      await rm(path.join(root, name, 'attachments.tar'), { force: true });
    }
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
};

try {
  if (process.argv[2] === '--project') await projectCheck(process.argv[3], process.argv[4]);
  else {
    assert.equal(process.argv.length, 2);
    await main();
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
