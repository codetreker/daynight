import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const installTest = process.platform === "win32" ? test.skip : test;
const temporaryRoot = fileURLToPath(new URL("../.tmp/dev-installer-tests/", import.meta.url));
await mkdir(temporaryRoot, { recursive: true });
const moduleUrl = new URL("./dev-install.mjs", import.meta.url);
const fixture = async (t) => {
  const root = await mkdtemp(path.join(temporaryRoot, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "checkout with 'spaces");
  const packageDirectory = path.join(source, "packages/daynight");
  await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ name: "@codetreker/daynight", version: "0.27.0", type: "module", dependencies: { dependency: "1.0.0" } }));
  await writeFile(path.join(packageDirectory, "dist/main.js"), 'import value from "dependency"; if (process.argv[2] === "--version") console.log("0.27.0"); else console.log(JSON.stringify({ value, root: process.env.DN_CONFIG_DIR, home: process.env.HOME, args: process.argv.slice(2) }));\n');
  const dependency = path.join(source, "node_modules/.pnpm/dependency@1.0.0/node_modules/dependency");
  await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "dependency", version: "1.0.0", type: "module", exports: "./index.js" }));
  await writeFile(path.join(dependency, "index.js"), 'export default "original";\n');
  await mkdir(path.join(packageDirectory, "node_modules"));
  await symlink(dependency, path.join(packageDirectory, "node_modules/dependency"));
  return { root, source, packageDirectory, dependency, binDirectory: path.join(root, "bin") };
};
const loadInstaller = async () => {
  const module = await import(moduleUrl.href).catch(() => undefined);
  assert.equal(typeof module?.installDevelopmentBuild, "function", "the local development installer must exist");
  return module.installDevelopmentBuild;
};
const run = (executable, args = [], overrides = {}) => {
  const env = { ...process.env, ...overrides };
  if (overrides.DN_CONFIG_DIR === undefined) delete env.DN_CONFIG_DIR;
  return execFileSync(executable, args, { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
};

installTest("installs a pinned development snapshot, isolates state, and preserves the stable launcher", async (t) => {
  const install = await loadInstaller();
  const f = await fixture(t);
  await mkdir(f.binDirectory);
  const stable = path.join(f.binDirectory, "daynight");
  await writeFile(stable, "stable installation\n");
  const result = await install({ sourceDirectory: f.source, binDirectory: f.binDirectory, build: false, metadata: { commit: "abc123", dirty: true } });
  const executable = path.join(f.binDirectory, "daynight-dev");
  assert.equal(await realpath(executable), result.executable);
  const info = JSON.parse(run(executable, ["--build-info"]));
  assert.equal(info.sourceDirectory, f.source);
  assert.equal(info.commit, "abc123");
  assert.equal(info.dirty, true);
  assert.equal(info.version, "0.27.0");
  const output = JSON.parse(run(executable, ["task", "list"]));
  assert.equal(output.value, "original");
  assert.equal(output.home, process.env.HOME);
  assert.equal(output.root, path.join(process.env.HOME, ".daynight-dev"));
  assert.deepEqual(output.args, ["task", "list"]);
  assert.equal(JSON.parse(run(executable, [], { DN_CONFIG_DIR: path.join(f.root, "custom") })).root, path.join(f.root, "custom"));
  assert.equal(await readFile(stable, "utf8"), "stable installation\n");
});

installTest("existing executable and dependencies stay fixed after rebuilding and changing source dependencies", async (t) => {
  const install = await loadInstaller();
  const f = await fixture(t);
  const options = { sourceDirectory: f.source, binDirectory: f.binDirectory, build: false, metadata: { commit: "abc123", dirty: false } };
  const first = await install(options);
  await writeFile(path.join(f.dependency, "index.js"), 'export default "updated";\n');
  const second = await install(options);
  assert.notEqual(first.executable, second.executable);
  assert.equal(JSON.parse(run(first.executable)).value, "original");
  assert.equal(JSON.parse(run(second.executable)).value, "updated");
  assert.equal(await realpath(path.join(f.binDirectory, "daynight-dev")), second.executable);
});

installTest("refuses an unrelated launcher and leaves a previous good install on preparation failure", async (t) => {
  const install = await loadInstaller();
  const f = await fixture(t);
  await mkdir(f.binDirectory);
  const executable = path.join(f.binDirectory, "daynight-dev");
  await writeFile(executable, "unrelated");
  const options = { sourceDirectory: f.source, binDirectory: f.binDirectory, build: false, metadata: { commit: "abc123", dirty: false } };
  await assert.rejects(install(options), /refus.*replace|not.*owned/i);
  assert.equal(await readFile(executable, "utf8"), "unrelated");
  await rm(executable);
  const first = await install(options);
  await rm(path.join(f.packageDirectory, "dist/main.js"));
  await assert.rejects(install(options));
  assert.equal(await realpath(executable), first.executable);
  assert.equal(JSON.parse(run(executable)).value, "original");
});

installTest("development update is rejected before the business CLI runs", async (t) => {
  const install = await loadInstaller();
  const f = await fixture(t);
  const result = await install({ sourceDirectory: f.source, binDirectory: f.binDirectory, build: false, metadata: { commit: "abc123", dirty: false } });
  assert.throws(() => run(result.executable, ["update"]), (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /pnpm dev:install/);
    assert.equal(error.stdout, "");
    return true;
  });
});

installTest("copies cyclic and peer dependencies while allowing absent optional packages", async (t) => {
  const install = await loadInstaller();
  const f = await fixture(t);
  const peer = path.join(f.source, "node_modules/peer");
  await mkdir(peer, { recursive: true });
  await writeFile(path.join(peer, "package.json"), JSON.stringify({ name: "peer", version: "1.0.0", type: "module", exports: "./index.js", dependencies: { dependency: "1.0.0" } }));
  await writeFile(path.join(peer, "index.js"), 'export default "peer";\n');
  await symlink(f.dependency, path.join(f.source, "node_modules/dependency"));
  await writeFile(path.join(f.dependency, "package.json"), JSON.stringify({ name: "dependency", version: "1.0.0", type: "module", exports: "./index.js", peerDependencies: { peer: "1.0.0" }, optionalDependencies: { "missing-platform-package": "1.0.0" } }));
  await writeFile(path.join(f.dependency, "index.js"), 'import peer from "peer"; export default "with-" + peer;\n');
  const result = await install({ sourceDirectory: f.source, binDirectory: f.binDirectory, build: false, metadata: { commit: "abc123", dirty: true } });
  await rm(path.join(f.source, "node_modules"), { recursive: true, force: true });
  assert.equal(JSON.parse(run(result.executable)).value, "with-peer");
});

installTest("materializes dependency file symlinks so source changes cannot retarget snapshots", async (t) => {
  const install = await loadInstaller();
  const f = await fixture(t);
  const external = path.join(f.root, "linked-source.js");
  await writeFile(external, 'export default "before";\n');
  await rm(path.join(f.dependency, "index.js"));
  await symlink(external, path.join(f.dependency, "index.js"));
  const result = await install({ sourceDirectory: f.source, binDirectory: f.binDirectory, build: false, metadata: { commit: "abc123", dirty: true } });
  await writeFile(external, 'export default "after";\n');
  assert.equal(JSON.parse(run(result.executable)).value, "before");
});


test("Windows installation fails explicitly without modifying launchers", { skip: process.platform !== "win32" }, async () => {
  const install = await loadInstaller();
  await assert.rejects(install(), /requires macOS or Linux/);
});

installTest("a snapshot that cannot load does not replace the previous working entry", async (t) => {
  const install = await loadInstaller();
  const f = await fixture(t);
  const options = { sourceDirectory: f.source, binDirectory: f.binDirectory, build: false, metadata: { commit: "abc123", dirty: false } };
  const first = await install(options);
  await writeFile(path.join(f.dependency, "index.js"), 'throw new Error("cannot load dependency"); export default "bad";\n');
  await assert.rejects(install(options), /cannot load dependency/);
  assert.equal(await realpath(path.join(f.binDirectory, "daynight-dev")), first.executable);
  assert.equal(JSON.parse(run(first.executable)).value, "original");
});
