import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishAssets, validateAssets, type PublicationPaths } from './publish-assets.mts';

const temporaryRoot = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
const script = fileURLToPath(new URL('./publish-assets.mts', import.meta.url));
const html = '<!doctype html><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">';

const put = async (root: string, path: string, contents: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
};

const build = async (root: string): Promise<void> => {
  await put(root, 'index.html', html);
  await put(root, 'assets/app.js', 'console.log("new application");');
  await put(root, 'assets/app.css', 'body { color: blue; }');
  await put(root, 'assets/nested/chunk.js', 'export const ready = true;');
};

const fixture = async (run: (paths: PublicationPaths, root: string) => Promise<void>): Promise<void> => {
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, 'publisher-test-'));
  const paths = { source: join(root, 'source'), destination: join(root, 'server/dist'), temporaryRoot: join(root, 'staging') };
  await build(paths.source);
  await put(paths.destination, 'index.html', 'previous page');
  await put(paths.destination, 'assets/old.js', 'previous code');
  await mkdir(paths.temporaryRoot);
  try { await run(paths, root); }
  finally { await rm(root, { recursive: true, force: true }); }
};

const unchanged = async (paths: PublicationPaths): Promise<void> => {
  assert.equal(await readFile(join(paths.destination, 'index.html'), 'utf8'), 'previous page');
  assert.equal(await readFile(join(paths.destination, 'assets/old.js'), 'utf8'), 'previous code');
  assert.deepEqual(await readdir(paths.temporaryRoot), []);
};

test('publishes complete fresh output and replaces every previous asset', async () => {
  await fixture(async (paths) => {
    await put(paths.source, 'robots.txt', 'User-agent: *');
    assert.equal(await publishAssets(paths), 5);
    assert.equal(await readFile(join(paths.destination, 'index.html'), 'utf8'), html);
    assert.equal(await readFile(join(paths.destination, 'assets/app.js'), 'utf8'), 'console.log("new application");');
    assert.equal(await readFile(join(paths.destination, 'assets/nested/chunk.js'), 'utf8'), 'export const ready = true;');
    assert.equal(await readFile(join(paths.destination, 'robots.txt'), 'utf8'), 'User-agent: *');
    await assert.rejects(lstat(join(paths.destination, 'assets/old.js')), /ENOENT/);
    assert.deepEqual(await readdir(paths.temporaryRoot), []);
    await put(paths.source, 'index.html', '<script src="/assets/next.js"></script>');
    await rm(join(paths.source, 'assets'), { recursive: true });
    await put(paths.source, 'assets/next.js', 'console.log("replacement");');
    assert.equal(await publishAssets(paths), 3);
    assert.deepEqual(await readdir(join(paths.destination, 'assets')), ['next.js']);
    assert.equal(await validateAssets(paths.destination), 3);
    assert.deepEqual(await readdir(paths.temporaryRoot), []);
  });
});

test('creates the generated destination when there is no previous publication', async () => {
  await fixture(async (paths, root) => {
    await rm(join(root, 'server'), { recursive: true });
    assert.equal(await publishAssets(paths), 4);
    assert.equal(await validateAssets(paths.destination), 4);
    assert.deepEqual(await readdir(paths.temporaryRoot), []);
  });
});

test('rejects absent source, index, assets, and entry references without touching prior output', async () => {
  await fixture(async (paths) => {
    await assert.rejects(publishAssets({ ...paths, source: join(paths.source, 'missing') }), /ENOENT/);
    await rm(join(paths.source, 'index.html'));
    await assert.rejects(publishAssets(paths), /missing index.html/);
    await put(paths.source, 'index.html', html);
    await rm(join(paths.source, 'assets'), { recursive: true });
    await assert.rejects(publishAssets(paths), /missing generated assets/);
    await build(paths.source);
    await put(paths.source, 'index.html', '<main>No script loaded</main>');
    await assert.rejects(publishAssets(paths), /does not reference generated assets/);
    await unchanged(paths);
  });
});

test('requires every reference to name an existing regular local asset without path escaping', async () => {
  await fixture(async (paths) => {
    for (const reference of [
      '/assets/missing.js', '/assets', '/assets/', '/assets/../index.html', '/assets/%2e%2e/index.html',
      '/assets/nested/../../outside.js', 'https://example.test/app.js', '//example.test/app.js',
      '../assets/app.js', '/assets/app.js?version=1', '/assets/app.js#fragment', '/assets/%00app.js',
      '/assets/\\app.js', '/assets/%zz', '/index.html', '',
    ]) {
      await put(paths.source, 'index.html', `<script src="${reference}"></script>`);
      await assert.rejects(publishAssets(paths), /asset reference|invalid or missing asset/, reference);
    }
    for (const attribute of ["src='/assets/app.js'", 'src=/assets/app.js', 'SRC = "/assets/app.js"']) {
      await put(paths.source, 'index.html', `<script ${attribute}></script>`);
      assert.equal(await validateAssets(paths.source), 4);
    }
    await unchanged(paths);
  });
});

test('rejects ordinary files where source, destination, or staging directories are required', async () => {
  await fixture(async (paths, root) => {
    const file = join(root, 'file');
    await writeFile(file, 'not a directory');
    await assert.rejects(publishAssets({ ...paths, source: file }), /ordinary directory/);
    await assert.rejects(publishAssets({ ...paths, destination: file }), /ordinary directory/);
    await assert.rejects(publishAssets({ ...paths, temporaryRoot: file }), /EEXIST|ENOTDIR/);
    await unchanged(paths);
  });
});

test('rejects overlapping source, destination, and staging paths', async () => {
  await fixture(async (paths, root) => {
    for (const invalid of [
      { ...paths, destination: paths.source },
      { ...paths, destination: join(paths.source, 'server') },
      { ...paths, source: root },
      { ...paths, temporaryRoot: paths.source },
      { ...paths, temporaryRoot: join(paths.destination, '.tmp') },
    ]) await assert.rejects(publishAssets(invalid), /must not overlap/);
    await unchanged(paths);
  });
});

test('rejects source and destination symlinks and any nested linked entries', { skip: process.platform === 'win32' }, async () => {
  await fixture(async (paths, root) => {
    const linked = join(root, 'linked');
    await symlink(paths.source, linked);
    await assert.rejects(publishAssets({ ...paths, source: linked }), /ordinary directory/);
    await assert.rejects(publishAssets({ ...paths, destination: linked }), /ordinary directory/);
    await symlink(paths.source, join(paths.source, 'assets/linked'));
    await assert.rejects(publishAssets(paths), /symbolic link or nonregular/);
    await rm(join(paths.source, 'assets/linked'));
    await symlink(join(paths.source, 'assets/app.js'), join(paths.source, 'assets/alias.js'));
    await assert.rejects(publishAssets(paths), /symbolic link or nonregular/);
    await unchanged(paths);
  });
});

test('rejects nonregular build entries without trying to copy or read them', { skip: process.platform === 'win32' }, async () => {
  await fixture(async (paths) => {
    const result = spawnSync('mkfifo', [join(paths.source, 'assets/pipe')], { timeout: 1000, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(publishAssets(paths), /symbolic link or nonregular/);
    await unchanged(paths);
  });
});

test('copy errors preserve the prior tree, retain the filesystem cause, and remove incomplete staging', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  await fixture(async (paths) => {
    const unreadable = join(paths.source, 'assets/private.js');
    await writeFile(unreadable, 'private');
    await chmod(unreadable, 0);
    try {
      await assert.rejects(publishAssets(paths), (error: unknown) => {
        assert.ok(error instanceof Error && 'code' in error);
        assert.equal(error.code, 'EACCES');
        return true;
      });
      await unchanged(paths);
    } finally { await chmod(unreadable, 0o600); }
  });
});

test('rename errors preserve the prior tree and clean the staged complete copy', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  await fixture(async (paths) => {
    const parent = dirname(paths.destination);
    await chmod(parent, 0o500);
    try {
      await assert.rejects(publishAssets(paths), (error: unknown) => {
        assert.ok(error instanceof Error && 'code' in error);
        assert.equal(error.code, 'EACCES');
        return true;
      });
      await unchanged(paths);
    } finally { await chmod(parent, 0o700); }
  });
});

test('CLI resolves its known package paths independently of cwd and exits nonzero on publication errors', async () => {
  await fixture(async (_paths, root) => {
    const packageDirectory = join(root, 'packages/daynight-web');
    const relocated = join(packageDirectory, 'scripts/publish-assets.mts');
    const destination = join(root, 'packages/daynight-server/internal/service/webui/dist');
    await mkdir(dirname(relocated), { recursive: true });
    await copyFile(script, relocated);
    const run = (args: string[] = []) => {
      const result = spawnSync(process.execPath, [relocated, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
      assert.ifError(result.error);
      return result;
    };
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ENOENT/);
    await build(join(packageDirectory, 'dist'));
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /Published 4 frontend files/);
    assert.equal(await validateAssets(destination), 4);
    await rm(join(packageDirectory, 'dist/assets/app.js'));
    const invalid = run();
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /invalid or missing asset/);
    assert.equal(await validateAssets(destination), 4);
    const usage = run(['unexpected']);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /Usage:/);
    assert.deepEqual(await readdir(join(root, '.tmp')), []);
  });
});
