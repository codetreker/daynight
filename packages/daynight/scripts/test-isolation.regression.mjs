import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const repositoryDirectory = path.resolve(packageDirectory, "../..");
const temporary = path.join(repositoryDirectory, ".tmp");
const preload = fileURLToPath(new URL("./test-isolation.cts", import.meta.url));
const physicalPath = target => {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try { lstatSync(current); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
      continue;
    }
    return path.join(realpathSync(current), ...missing.reverse());
  }
};
const assertTemporaryRoot = () => {
  const expected = path.join(realpathSync(repositoryDirectory), ".tmp");
  const environment = Object.fromEntries(Object.entries(process.env).map(([name, value]) => [name.toUpperCase(), value]));
  const retained = [environment.DN_CONFIG_DIR, ...[environment.HOME, environment.USERPROFILE].filter(home => home !== undefined).map(home => path.join(home, ".daynight"))];
  for (const root of retained.filter(root => root !== undefined).map(physicalPath)) {
    const relative = path.relative(root, expected);
    assert.ok(relative !== "" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)), "Test temporary directories overlap retained state.");
  }
  try {
    assert.equal(lstatSync(temporary).isSymbolicLink(), false);
    assert.equal(realpathSync(temporary), expected);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    mkdirSync(temporary);
    assert.equal(realpathSync(temporary), expected);
  }
};

const probe = (t, body) => {
  assertTemporaryRoot();
  const directory = mkdtempSync(path.join(temporary, "isolation-regression-"));
  const retained = path.join(directory, "retained");
  mkdirSync(retained);
  mkdirSync(path.join(retained, "worker"));
  mkdirSync(path.join(retained, "controller", "sockets"), { recursive: true });
  const files = new Map([
    [path.join(retained, "config.yml"), "retained configuration\n"],
    [path.join(retained, "worker", "herdr-executions.sqlite"), "retained database bytes\n"],
    [path.join(retained, "controller", "sockets", "sentinel"), "retained socket directory\n"],
  ]);
  for (const [filename, content] of files) writeFileSync(filename, content);
  t.after(() => {
    for (const [filename, content] of files) assert.equal(readFileSync(filename, "utf8"), content);
    assertTemporaryRoot();
    assert.equal(realpathSync(directory), directory);
    rmSync(directory, { recursive: true });
  });
  const environment = { ...process.env, DN_CONFIG_DIR: retained, HOME: directory, USERPROFILE: directory };
  delete environment.DAYNIGHT_TEST_ISOLATION;
  delete environment.NODE_OPTIONS;
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import path from 'node:path';
    import { createRequire } from 'node:module';
    import { execFileSync } from 'node:child_process';
    const require = createRequire(${JSON.stringify(preload)});
    const isolation = require(${JSON.stringify(preload)});
    const retained = ${JSON.stringify(retained)};
    const fixture = ${JSON.stringify(directory)};
    try { ${body} }
    finally { isolation.cleanup(); }
  `;
  return execFileSync(process.execPath, ["--require", preload, "--input-type=module", "--eval", source], {
    cwd: packageDirectory, env: environment, encoding: "utf8", timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
};

test("isolates an inherited configuration root before real CLI paths are imported", t => {
  probe(t, `
    assert.equal(process.env.DN_CONFIG_DIR, undefined);
    assert.notEqual(process.env.HOME, fixture);
    assert.equal(process.env.HOME, process.env.USERPROFILE);
    const { resolveConfigurationPaths } = await import('./src/config/paths.ts');
    const paths = resolveConfigurationPaths(process.env.HOME);
    fs.mkdirSync(paths.stateDirectory, { recursive: true });
    fs.writeFileSync(paths.configFile, 'fixture configuration');
    assert.equal(fs.readFileSync(paths.configFile, 'utf8'), 'fixture configuration');
    assert.throws(() => fs.writeFileSync(path.join(retained, 'config.yml'), 'lost'), /retained state/);
    await assert.rejects(fsp.writeFile(path.join(retained, 'config.yml'), 'lost'), /retained state/);
    await new Promise((resolve, reject) => fs.writeFile(path.join(retained, 'config.yml'), 'lost', error => {
      try { assert.match(error.message, /retained state/); resolve(); } catch (failure) { reject(failure); }
    }));
    assert.throws(() => fs.rmSync(path.join(retained, 'controller'), { recursive: true }), /retained state/);
    assert.throws(() => fs.writeFileSync(path.join(fixture, '..', '..', '..', 'outside-isolation'), 'lost'), /escapes isolated/);
    const descriptor = fs.openSync(path.join(retained, 'config.yml'), 'r');
    try { assert.throws(() => fs.fchmodSync(descriptor, 0o600), /retained state/); }
    finally { fs.closeSync(descriptor); }
    const handle = await fsp.open(path.join(retained, 'config.yml'), 'r');
    try { await assert.rejects(handle.chmod(0o600), /retained state/); }
    finally { await handle.close(); }
  `);
});

test("guards native ESM SQLite constructors and backup destinations", t => {
  probe(t, `
    const { default: Database } = await import('better-sqlite3');
    assert.throws(() => new Database(path.join(retained, 'worker', 'herdr-executions.sqlite')), /retained state/);
    const db = new Database(path.join(fixture, 'isolated.sqlite'));
    try {
      db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('fixture');");
      await assert.rejects(db.backup(path.join(retained, 'worker', 'herdr-executions.sqlite')), /retained state/);
      assert.equal(db.prepare('SELECT value FROM sentinel').pluck().get(), 'fixture');
    } finally { db.close(); }
  `);
});

test("reinserts isolation into stripped child environments and rejects explicit retained roots", t => {
  probe(t, `
    const source = "const fs=require('node:fs');const path=require('node:path');fs.mkdirSync(path.join(process.env.HOME,'.daynight'),{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'.daynight','config.yml'),'child fixture');process.stdout.write(JSON.stringify({home:process.env.HOME,root:process.env.DN_CONFIG_DIR,guard:process.env.DAYNIGHT_TEST_ISOLATION}));";
    const output = JSON.parse(execFileSync(process.execPath, ['-e', source], { env: { PATH: process.env.PATH, HOME: ${JSON.stringify(repositoryDirectory)}, USERPROFILE: ${JSON.stringify(repositoryDirectory)}, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000 }));
    assert.equal(output.home, process.env.HOME);
    assert.equal(output.root, undefined);
    assert.ok(output.guard);
    assert.throws(() => execFileSync(process.execPath, ['-e', source], { env: { ...process.env, DN_CONFIG_DIR: retained }, timeout: 10_000 }), /retained state/);
    const blocked = "require('node:fs').writeFileSync(" + JSON.stringify(path.join(retained,'config.yml')) + ",'lost');";
    assert.throws(() => execFileSync(process.execPath, ['-e', blocked], { env: { PATH: process.env.PATH, NODE_OPTIONS: '' }, timeout: 10_000, stdio: 'pipe' }), /retained state/);
  `);
});

test("rejects final, ancestor and dangling symlink destinations before mutation", t => {
  if (process.platform === "win32") return t.skip("Symlink privileges are not available on every Windows runner; junction escape is covered separately.");
  probe(t, `
    const alias = path.join(fixture, 'retained-alias');
    fs.symlinkSync(retained, alias);
    assert.throws(() => fs.writeFileSync(path.join(alias, 'config.yml'), 'lost'), /retained state/);
    assert.throws(() => fs.rmSync(path.join(alias, 'controller'), { recursive: true }), /retained state/);
    const external = path.join(fixture, 'external');
    fs.symlinkSync(path.dirname(${JSON.stringify(repositoryDirectory)}), external);
    assert.throws(() => fs.mkdirSync(path.join(external, 'outside-isolation'), { recursive: true }), /symbolic link outside/);
    const dangling = path.join(fixture, 'dangling');
    fs.symlinkSync(path.join(retained, 'new-file'), dangling);
    assert.throws(() => fs.writeFileSync(dangling, 'lost'), /ENOENT/);
    const final = path.join(fixture, 'final');
    fs.symlinkSync(path.join(retained, 'config.yml'), final);
    await assert.rejects(fsp.writeFile(final, 'lost'), /retained state/);
    fs.unlinkSync(alias); fs.unlinkSync(external); fs.unlinkSync(dangling); fs.unlinkSync(final);
  `);
});

test("rejects Windows junction traversal to retained state", t => {
  if (process.platform !== "win32") return t.skip("Windows junction behavior is verified on the native Windows runner.");
  probe(t, `
    const alias = path.join(fixture, 'retained-junction');
    fs.symlinkSync(retained, alias, 'junction');
    assert.throws(() => fs.writeFileSync(path.join(alias, 'config.yml'), 'lost'), /retained state/);
    assert.throws(() => fs.rmSync(path.join(alias, 'controller'), { recursive: true }), /retained state/);
    fs.unlinkSync(alias);
  `);
});

test("checks every recursive copy destination before traversing a retained-state link", t => {
  probe(t, `
    const source = path.join(fixture, 'copy-source');
    const destination = path.join(fixture, 'copy-destination');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, 'nested', 'config.yml'), 'lost');
    fs.symlinkSync(retained, path.join(destination, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => fs.cpSync(source, destination, { recursive: true, dereference: true }), /retained state/);
    await assert.rejects(fsp.cp(source, destination, { recursive: true, dereference: true }), /retained state/);
    const filtered = path.join(fixture, 'filtered-copy');
    const calls = [];
    fs.cpSync(source, filtered, { recursive: true, filter: (from, to) => { calls.push(to); return !from.endsWith('config.yml'); } });
    assert.ok(calls.length >= 3);
    assert.equal(fs.existsSync(path.join(filtered, 'nested', 'config.yml')), false);
  `);
});

test("rejects redirected temporary roots before bootstrap creates any directories", t => {
  assertTemporaryRoot();
  const directory = mkdtempSync(path.join(temporary, "isolation-bootstrap-"));
  t.after(() => {
    assertTemporaryRoot();
    assert.equal(realpathSync(directory), directory);
    rmSync(directory, { recursive: true });
  });
  for (const target of [".tmp", "packages/daynight/.tmp", "retained-alias"]) {
    const pseudo = path.join(directory, target.replaceAll("/", "-"));
    const scripts = path.join(pseudo, "packages", "daynight", "scripts");
    const guard = path.join(scripts, "test-isolation.cts");
    mkdirSync(scripts, { recursive: true });
    copyFileSync(preload, guard);
    const retained = target === "retained-alias" ? path.join(pseudo, ".tmp") : path.join(pseudo, "retained");
    mkdirSync(retained);
    writeFileSync(path.join(retained, "sentinel"), "retained bootstrap directory");
    const alias = path.join(pseudo, target);
    symlinkSync(retained, alias, process.platform === "win32" ? "junction" : "dir");
    const environment = { ...process.env, HOME: directory, USERPROFILE: directory, DN_CONFIG_DIR: target === "retained-alias" ? alias : retained };
    delete environment.DAYNIGHT_TEST_ISOLATION;
    delete environment.NODE_OPTIONS;
    assert.throws(() => execFileSync(process.execPath, ["--require", guard, "--eval", "throw new Error('Bootstrap should reject before evaluation');"], {
      cwd: pseudo, env: environment, encoding: "utf8", timeout: 10_000, stdio: "pipe",
    }), /redirected|overlap retained state/);
    assert.deepEqual(readdirSync(retained), ["sentinel"]);
    assert.equal(readFileSync(path.join(retained, "sentinel"), "utf8"), "retained bootstrap directory");
  }
});
