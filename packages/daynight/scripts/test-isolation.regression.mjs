import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const repositoryDirectory = path.resolve(packageDirectory, "../..");
const temporary = path.join(repositoryDirectory, ".tmp");
const sourcePreload = fileURLToPath(new URL("./test-isolation.cts", import.meta.url));
const physicalPath = target => {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try { lstatSync(current); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current)); current = parent; continue;
    }
    return path.join(realpathSync(current), ...missing.reverse());
  }
};
const contains = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const assertTemporaryRoot = () => {
  const expected = path.join(realpathSync(repositoryDirectory), ".tmp");
  const environment = Object.fromEntries(Object.entries(process.env).map(([name, value]) => [name.toUpperCase(), value]));
  const retained = [environment.DN_CONFIG_DIR, ...[environment.HOME, environment.USERPROFILE].filter(home => home !== undefined).map(home => path.join(home, ".daynight"))];
  for (const root of retained.filter(root => root !== undefined).map(physicalPath)) assert.equal(contains(root, expected), false, "Test temporary directories overlap retained state.");
  try {
    assert.equal(lstatSync(temporary).isSymbolicLink(), false);
    assert.equal(realpathSync(temporary), expected);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    mkdirSync(temporary); assert.equal(realpathSync(temporary), expected);
  }
};
const fixture = t => {
  assertTemporaryRoot();
  const directory = mkdtempSync(path.join(temporary, "isolation-regression-"));
  const retained = path.join(directory, ".daynight");
  mkdirSync(path.join(retained, "worker"), { recursive: true });
  mkdirSync(path.join(retained, "controller", "sockets"), { recursive: true });
  const files = new Map([
    [path.join(retained, "config.yml"), "retained configuration\n"],
    [path.join(retained, "worker", "herdr-executions.sqlite"), "retained database bytes\n"],
    [path.join(retained, "controller", "sockets", "sentinel"), "retained socket directory\n"],
  ]);
  for (const [filename, content] of files) writeFileSync(filename, content);
  t.after(() => {
    for (const [filename, content] of files) assert.equal(readFileSync(filename, "utf8"), content);
    assertTemporaryRoot(); assert.equal(realpathSync(directory), directory);
    rmSync(directory, { recursive: true });
  });
  const pseudo = path.join(directory, "checkout");
  const preload = path.join(pseudo, "packages", "daynight", "scripts", "test-isolation.cts");
  mkdirSync(path.dirname(preload), { recursive: true }); copyFileSync(sourcePreload, preload);
  const environment = { ...process.env, DN_CONFIG_DIR: retained, HOME: directory, USERPROFILE: directory };
  delete environment.DAYNIGHT_TEST_ISOLATION; delete environment.NODE_OPTIONS;
  return { directory, retained, pseudo, preload, environment };
};
const probe = (t, body) => {
  const f = fixture(t);
  const source = `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import fsp from 'node:fs/promises';
    import path from 'node:path'; import { createRequire } from 'node:module'; import { execFileSync } from 'node:child_process';
    const isolation = createRequire(${JSON.stringify(f.preload)})(${JSON.stringify(f.preload)});
    const retained = ${JSON.stringify(f.retained)}, fixture = ${JSON.stringify(f.directory)}, checkout = ${JSON.stringify(f.pseudo)};
    try { ${body} } finally { isolation.cleanup(); }
  `;
  return execFileSync(process.execPath, ["--require", f.preload, "--input-type=module", "--eval", source], {
    cwd: packageDirectory, env: f.environment, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
};

test("isolates inherited Daynight state and permits unrelated writes outside the checkout", t => {
  probe(t, `
    assert.equal(process.env.DN_CONFIG_DIR, undefined); assert.notEqual(process.env.HOME, fixture);
    assert.equal(process.env.HOME, process.env.USERPROFILE);
    const { resolveConfigurationPaths } = await import(${JSON.stringify(pathToFileURL(path.join(packageDirectory, "src/config/paths.ts")).href)});
    const paths = resolveConfigurationPaths(process.env.HOME);
    fs.mkdirSync(paths.stateDirectory, { recursive: true }); fs.writeFileSync(paths.configFile, 'fixture configuration');
    assert.throws(() => fs.writeFileSync(path.join(retained, 'config.yml'), 'lost'), /retained Daynight state/);
    await assert.rejects(fsp.writeFile(path.join(retained, 'config.yml'), 'lost'), /retained Daynight state/);
    await new Promise((resolve, reject) => fs.writeFile(path.join(retained, 'config.yml'), 'lost', error => {
      try { assert.match(error.message, /retained Daynight state/); resolve(); } catch (failure) { reject(failure); }
    }));
    assert.throws(() => fs.rmSync(path.join(retained, 'controller'), { recursive: true }), /retained Daynight state/);
    const descriptor = fs.openSync(path.join(retained, 'config.yml'), 'r');
    try { assert.throws(() => fs.fchmodSync(descriptor, 0o600), /retained Daynight state/); } finally { fs.closeSync(descriptor); }
    const handle = await fsp.open(path.join(retained, 'config.yml'), 'r');
    try { await assert.rejects(handle.chmod(0o600), /retained Daynight state/); } finally { await handle.close(); }
    const unrelated = path.join(fixture, 'unrelated'); assert.equal(unrelated.startsWith(checkout + path.sep), false);
    fs.writeFileSync(unrelated, 'allowed'); assert.equal(fs.readFileSync(unrelated, 'utf8'), 'allowed');
    fs.rmSync(unrelated);
  `);
});

test("guards native ESM SQLite constructors and backup destinations", t => {
  probe(t, `
    const { default: Database } = await import('better-sqlite3');
    assert.throws(() => new Database(path.join(retained, 'worker', 'herdr-executions.sqlite')), /retained Daynight state/);
    const db = new Database(path.join(fixture, 'unrelated.sqlite'));
    try {
      db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('fixture');");
      await assert.rejects(db.backup(path.join(retained, 'worker', 'herdr-executions.sqlite')), /retained Daynight state/);
      await db.backup(path.join(fixture, 'unrelated-backup.sqlite'));
      assert.equal(db.prepare('SELECT value FROM sentinel').pluck().get(), 'fixture');
    } finally { db.close(); }
  `);
});

test("isolates real-home child defaults and preserves unrelated explicit environments", t => {
  probe(t, `
    const source = "const fs=require('node:fs');const path=require('node:path');const root=process.env.DN_CONFIG_DIR||path.join(process.env.HOME,'.daynight');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'config.yml'),'child fixture');process.stdout.write(JSON.stringify({home:process.env.HOME,root:process.env.DN_CONFIG_DIR,guard:process.env.DAYNIGHT_TEST_ISOLATION}));";
    const output = JSON.parse(execFileSync(process.execPath, ['-e', source], { env: { PATH: process.env.PATH, HOME: fixture, USERPROFILE: fixture, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000 }));
    assert.equal(output.home, process.env.HOME); assert.equal(output.root, undefined); assert.ok(output.guard);
    assert.throws(() => execFileSync(process.execPath, ['-e', source], { env: { ...process.env, DN_CONFIG_DIR: retained }, timeout: 10_000 }), /retained Daynight state/);
    const custom = path.join(fixture, 'unrelated-state');
    const explicit = JSON.parse(execFileSync(process.execPath, ['-e', source], { env: { ...process.env, HOME: fixture, USERPROFILE: fixture, DN_CONFIG_DIR: custom, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000 }));
    assert.equal(explicit.home, fixture); assert.equal(explicit.root, custom);
    const blocked = "require('node:fs').writeFileSync(" + JSON.stringify(path.join(retained,'config.yml')) + ",'lost');";
    assert.throws(() => execFileSync(process.execPath, ['-e', blocked], { env: { PATH: process.env.PATH, NODE_OPTIONS: '' }, timeout: 10_000, stdio: 'pipe' }), /retained Daynight state/);
  `);
});

test("protects symbolic aliases while permitting unrelated directory links", t => {
  probe(t, `
    const alias = path.join(fixture, 'retained-alias');
    fs.symlinkSync(retained, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => fs.writeFileSync(path.join(alias, 'config.yml'), 'lost'), /retained Daynight state/);
    assert.throws(() => fs.rmSync(path.join(alias, 'controller'), { recursive: true }), /retained Daynight state/);
    if (process.platform !== 'win32') {
      const final = path.join(fixture, 'final'), dangling = path.join(fixture, 'dangling');
      fs.symlinkSync(path.join(retained, 'config.yml'), final); fs.symlinkSync(path.join(retained, 'new-file'), dangling);
      await assert.rejects(fsp.writeFile(final, 'lost'), /retained Daynight state/);
      assert.throws(() => fs.writeFileSync(dangling, 'lost'), /retained Daynight state/);
      fs.unlinkSync(final); fs.unlinkSync(dangling);
    }
    const unrelated = path.join(fixture, 'unrelated-directory'), link = path.join(fixture, 'unrelated-link');
    fs.mkdirSync(unrelated); fs.symlinkSync(unrelated, link, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(link, 'allowed'), 'allowed'); fs.unlinkSync(link); fs.unlinkSync(alias);
  `);
});

test("checks recursive copy destinations that reach retained state", t => {
  probe(t, `
    const source = path.join(fixture, 'copy-source'), destination = path.join(fixture, 'copy-destination');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true }); fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, 'nested', 'config.yml'), 'lost');
    fs.symlinkSync(retained, path.join(destination, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => fs.cpSync(source, destination, { recursive: true, dereference: true }), /retained Daynight state/);
    await assert.rejects(fsp.cp(source, destination, { recursive: true, dereference: true }), /retained Daynight state/);
    const filtered = path.join(fixture, 'filtered-copy'), calls = [];
    fs.cpSync(source, filtered, { recursive: true, filter: (from, to) => { calls.push(to); return !from.endsWith('config.yml'); } });
    assert.ok(calls.length >= 3); assert.equal(fs.existsSync(path.join(filtered, 'nested', 'config.yml')), false);
  `);
});

test("rejects bootstrap temporary directories redirected into retained state", t => {
  for (const target of [".tmp", "retained-alias"]) {
    const f = fixture(t);
    const retained = target === "retained-alias" ? path.join(f.pseudo, ".tmp") : f.retained;
    if (target === "retained-alias") mkdirSync(retained);
    writeFileSync(path.join(retained, "bootstrap-sentinel"), "retained bootstrap directory");
    const before = readdirSync(retained).sort(), alias = path.join(f.pseudo, target);
    symlinkSync(retained, alias, process.platform === "win32" ? "junction" : "dir");
    const environment = { ...f.environment, DN_CONFIG_DIR: target === "retained-alias" ? alias : f.retained };
    assert.throws(() => execFileSync(process.execPath, ["--require", f.preload, "--eval", "throw new Error('Bootstrap must reject before evaluation');"], {
      cwd: f.pseudo, env: environment, encoding: "utf8", timeout: 10_000, stdio: "pipe",
    }), /retained Daynight state/);
    assert.deepEqual(readdirSync(retained).sort(), before);
  }
});

test("protects the OS default Daynight home when home environment variables are absent", t => {
  const f = fixture(t), environment = { ...f.environment };
  delete environment.HOME; delete environment.USERPROFILE;
  const source = `
    const assert = require('node:assert/strict'), os = require('node:os'), path = require('node:path');
    const isolation = require(${JSON.stringify(f.preload)});
    try { assert.throws(() => isolation.assertSafePath(path.join(os.userInfo().homedir, '.daynight', 'sentinel')), /retained Daynight state/); }
    finally { isolation.cleanup(); }
  `;
  execFileSync(process.execPath, ["--require", f.preload, "--eval", source], {
    cwd: packageDirectory, env: environment, encoding: "utf8", timeout: 10_000, stdio: "pipe",
  });
});


test("permits Windows named pipes while retaining namespace disk protection", t => {
  if (process.platform !== "win32") return t.skip("Windows pipe namespaces require the native Windows runner.");
  const f = fixture(t);
  const pipePrefix = "\\\\.\\pipe\\";
  const source = `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
    import { createRequire } from 'node:module';
    const lstat = fs.lstatSync;
    fs.lstatSync = (target, ...options) => {
      if (String(target).toLowerCase().startsWith(${JSON.stringify(pipePrefix)})) throw new Error('Named pipes must not be inspected as disk paths.');
      return lstat(target, ...options);
    };
    const isolation = createRequire(${JSON.stringify(f.preload)})(${JSON.stringify(f.preload)});
    try {
      assert.doesNotThrow(() => isolation.assertSafePath(${JSON.stringify(pipePrefix + "daynight-isolation-nonexistent-pipe")}));
      const disk = path.toNamespacedPath(${JSON.stringify(path.join(f.retained, "config.yml"))});
      assert.throws(() => isolation.assertSafePath(disk), /retained Daynight state/);
      assert.throws(() => fs.writeFileSync(disk, 'lost'), /retained Daynight state/);
    } finally { isolation.cleanup(); }
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: packageDirectory, env: f.environment, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
});
