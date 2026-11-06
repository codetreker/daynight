import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const generator = fileURLToPath(new URL("./create-repo-router.mjs", import.meta.url));
const scratch = fileURLToPath(new URL("../../../../.tmp/repo-router-tests/", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "route 中文 ' "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = Object.fromEntries(["repo", "second-repo", "repo-other", "outside", "state", "stable", "alternate", "home"].map((name) => [name, path.join(root, name)]));
  f.root = root;
  f.output = path.join(root, "router 中文 '");
  await Promise.all(Object.values(f).filter((value) => value !== root && value !== f.output).map((value) => mkdir(value)));
  await mkdir(path.join(f.repo, "nested", "child"), { recursive: true });
  f.program = path.join(root, "fake.mjs");
  await writeFile(f.program, `import { readFileSync } from "node:fs";
const [label, ...args] = process.argv.slice(2);
if (args[0] === "--wait") {
  console.log(JSON.stringify({ label, pid: process.pid }));
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ label, args, root: process.env.DN_CONFIG_DIR ?? null, stdin: readFileSync(0, "utf8") }));
  process.stderr.write("stderr:" + label + "\\n");
  process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
}
`);
  f.executable = async (filename, label) => {
    await writeFile(filename, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(f.program)} ${quote(label)} "$@"\n`, { mode: 0o700 });
    return filename;
  };
  f.dev = await f.executable(path.join(root, "development entry '"), "dev");
  await f.executable(path.join(f.stable, "daynight"), "stable");
  await f.executable(path.join(f.stable, "dn"), "stable-dn");
  await f.executable(path.join(f.alternate, "daynight"), "alternate");
  f.env = { HOME: f.home, PATH: `${f.stable}:/usr/bin:/bin`, LC_ALL: "C" };
  f.args = ["--repo-root", f.repo, "--dev-root", f.state, "--dev-cli", f.dev, "--output", f.output];
  f.generate = (extra = [], args = f.args) => spawnSync(process.execPath, [generator, ...args, ...extra], { cwd: root, env: f.env, encoding: "utf8", timeout: 5000 });
  f.create = (extra = []) => {
    const result = f.generate(extra);
    assert.equal(result.status, 0, result.stderr);
    f.activate = path.join(f.output, "activate.sh");
    f.wrapper = path.join(f.output, "daynight");
  };
  f.run = ({ cwd = f.repo, script = 'daynight "$@"', args = [], env = {}, shell = "/bin/sh", interactive = false, input = "" } = {}) => {
    const preamble = `. ${quote(f.activate)}; `;
    return spawnSync(shell, [...(shell.endsWith("zsh") ? [interactive ? "-fi" : "-f"] : []), "-c", preamble + script, "router-test", ...args], {
      cwd, env: { ...f.env, ...env }, input, encoding: "utf8", timeout: 5000,
    });
  };
  return f;
}

const rows = (result) => {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n").map((line) => JSON.parse(line));
};

test("routes physical roots and descendants while preserving arguments, streams and status", async (t) => {
  const f = await fixture(t);
  f.create(["--repo-root", f["second-repo"], "--include-dn"]);
  const args = ["", "two words", "中文's", "$(not-executed)", "line\nbreak"];
  const result = f.run({ cwd: path.join(f.repo, "nested", "child"), args, input: "input\n\u0000tail", env: { FAKE_EXIT: "23" } });
  assert.equal(result.status, 23);
  assert.equal(result.stderr, "stderr:dev\n");
  assert.deepEqual(JSON.parse(result.stdout), { label: "dev", args, root: await realpath(f.state), stdin: "input\n\u0000tail" });
  assert.equal(rows(f.run({ cwd: f["second-repo"], script: "dn" }))[0].label, "dev");
  assert.equal(rows(f.run({ cwd: f["repo-other"] }))[0].label, "stable");
  const alias = path.join(f.root, "repository-link");
  await symlink(f.repo, alias);
  assert.equal(rows(f.run({ cwd: alias }))[0].label, "dev");
  await symlink(f.outside, path.join(f.repo, "outside-link"));
  assert.equal(rows(f.run({ cwd: path.join(f.repo, "outside-link") }))[0].label, "stable");
  const metadata = JSON.parse(await readFile(path.join(f.output, "router.json"), "utf8"));
  assert.equal(metadata.devRoot, await realpath(f.state));
  assert.deepEqual(metadata.commands, ["daynight", "dn"]);
});

test("noninteractive children route each cwd and activation never exports the development root", async (t) => {
  const f = await fixture(t); f.create();
  for (const shell of ["/bin/sh", "/bin/zsh"]) {
    for (const root of [undefined, "", "original state"]) {
      const env = root === undefined ? {} : { DN_CONFIG_DIR: root };
      const result = f.run({ cwd: f.outside, shell, env, script: `daynight; cd ${quote(f.repo)}; daynight; /bin/sh -c 'daynight'; cd ${quote(f.outside)}; daynight; printf '%s\\n' "\${DN_CONFIG_DIR-unset}"` });
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.trimEnd().split("\n");
      assert.deepEqual(lines.slice(0, 4).map((line) => JSON.parse(line).label), ["stable", "dev", "dev", "stable"]);
      assert.equal(JSON.parse(lines[0]).root, root ?? null);
      assert.equal(JSON.parse(lines[3]).root, root ?? null);
      assert.equal(lines[4] ?? "", root ?? "unset");
    }
  }
});

test("interactive zsh reactivation restores routing after another tool prepends PATH", async (t) => {
  const f = await fixture(t); f.create();
  const result = f.run({ cwd: f.outside, shell: "/bin/zsh", interactive: true, script: `. ${quote(f.activate)}; daynight; PATH=${quote(`${f.alternate}:${f.output}:${f.stable}:/usr/bin:/bin`)}; cd ${quote(f.repo)}; daynight; . ${quote(f.activate)}; daynight; cd ${quote(f.outside)}; daynight; printf '%s\\n' "$PATH"` });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.deepEqual(lines.slice(0, 4).map((line) => JSON.parse(line).label), ["stable", "alternate", "dev", "alternate"]);
  assert.equal(lines[4].split(":").filter((entry) => entry === f.output).length, 1);
});

test("explicit deactivation retires an old route without deleting its files or creating an implicit cwd PATH entry", async (t) => {
  const f = await fixture(t); f.create();
  const newOutput = path.join(f.root, "new-router"), oldDeactivate = path.join(f.output, "deactivate.sh");
  const args = [...f.args]; args[args.indexOf("--repo-root") + 1] = f["second-repo"]; args[args.indexOf("--output") + 1] = newOutput;
  const generated = f.generate([], args); assert.equal(generated.status, 0, generated.stderr);
  for (const shell of ["/bin/sh", "/bin/zsh"]) {
    const result = f.run({ shell, script: `daynight; . ${quote(oldDeactivate)}; . ${quote(path.join(newOutput, "activate.sh"))}; daynight; cd ${quote(f["second-repo"])}; daynight` });
    assert.deepEqual(rows(result).map((row) => row.label), ["dev", "stable", "dev"]);
  }
  assert.match(await readFile(f.wrapper, "utf8"), /Route only/);

  const alias = path.join(f.root, "old-router-link"), managed = path.join(f.state, "agent-cli-aliases", "execution-retained");
  await symlink(f.output, alias); await mkdir(managed, { recursive: true });
  await f.executable(path.join(managed, "daynight"), "managed");
  const retainedPath = `${managed}:${newOutput}::${f.stable}`;
  const preserved = spawnSync("/bin/sh", ["-c", `. ${quote(oldDeactivate)}; printf '%s\\n' "$PATH" "\${DN_CONFIG_DIR-unset}"; daynight`], {
    cwd: f.outside, env: { ...f.env, PATH: `${f.output}:${alias}:${retainedPath}` }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(preserved.status, 0, preserved.stderr);
  const lines = preserved.stdout.trim().split("\n");
  assert.equal(lines[0], retainedPath); assert.equal(lines[1], "unset"); assert.equal(JSON.parse(lines[2]).label, "managed");

  const refused = spawnSync("/bin/sh", ["-c", `. ${quote(oldDeactivate)}; status=$?; printf '%s\\n' "$status" "$PATH"`], {
    cwd: f.outside, env: { ...f.env, PATH: f.output }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(refused.status, 0, refused.stderr);
  assert.deepEqual(refused.stdout.trim().split("\n"), ["1", f.output]);
  assert.match(refused.stderr, /Restore a non-router PATH entry/);
});

test("empty PATH entries survive filtering but a router-only PATH cannot select the current directory", async (t) => {
  const f = await fixture(t); f.create();
  await f.executable(path.join(f.outside, "daynight"), "cwd-command");
  for (const tail of [":", `:${f.stable}`, `${f.stable}:`]) {
    const result = spawnSync(f.wrapper, [], { cwd: f.outside, env: { ...f.env, PATH: `${f.output}:${tail}` }, input: "", encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).label, tail.startsWith(":") ? "cwd-command" : "stable");
  }
  const result = spawnSync(f.wrapper, [], { cwd: f.outside, env: { ...f.env, PATH: f.output }, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /No original daynight executable/);
});

test("fallback excludes symlinked router directories and same-inode command aliases", async (t) => {
  const f = await fixture(t); f.create(["--include-dn"]);
  const directoryAlias = path.join(f.root, "router-link"), hardlinks = path.join(f.root, "hardlinks"), fileLinks = path.join(f.root, "file-links");
  await symlink(f.output, directoryAlias); await mkdir(hardlinks); await mkdir(fileLinks);
  await link(f.wrapper, path.join(hardlinks, "daynight"));
  await symlink(path.join(f.output, "dn"), path.join(fileLinks, "daynight"));
  const result = spawnSync(f.wrapper, [], { cwd: f.outside, env: { ...f.env, PATH: `${directoryAlias}:${hardlinks}:${fileLinks}:${f.stable}` }, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).label, "stable");
});

test("activation preserves a selected managed Agent shim", async (t) => {
  const f = await fixture(t); f.create();
  const managed = path.join(f.state, "agent-cli-aliases", "execution-one");
  await mkdir(managed, { recursive: true });
  await f.executable(path.join(managed, "daynight"), "managed");
  const result = f.run({ env: { PATH: `${managed}:${f.output}:${f.stable}:/usr/bin:/bin`, DN_CONFIG_DIR: f.state }, script: `. ${quote(f.activate)}; daynight` });
  assert.equal(rows(result)[0].label, "managed");
});

test("activation preserves dn-only managed aliases when the router includes dn", async (t) => {
  const f = await fixture(t); f.create(["--include-dn"]);
  const managed = path.join(f.state, "agent-cli-aliases", "dn-only-execution");
  await mkdir(managed, { recursive: true });
  await f.executable(path.join(managed, "dn"), "managed-pinned");
  const originalPath = `${managed}:${f.stable}:/usr/bin:/bin`;
  for (const shell of ["/bin/sh", "/bin/zsh"]) {
    const result = f.run({ shell, env: { PATH: originalPath, DN_CONFIG_DIR: "retained root" }, script: `. ${quote(f.activate)}; dn; /bin/sh -c dn; printf '%s\\n' "$PATH" "$DN_CONFIG_DIR"` });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.deepEqual(lines.slice(0, 2).map((line) => JSON.parse(line).label), ["managed-pinned", "managed-pinned"]);
    assert.equal(lines[2], originalPath);
    assert.equal(lines[3], "retained root");
  }
});

test("a daynight-only router leaves an unrelated managed dn available", async (t) => {
  const f = await fixture(t); f.create();
  const managed = path.join(f.state, "agent-cli-aliases", "dn-only-execution");
  await mkdir(managed, { recursive: true });
  await f.executable(path.join(managed, "dn"), "managed-pinned");
  for (const shell of ["/bin/sh", "/bin/zsh"]) {
    const result = f.run({ shell, env: { PATH: `${managed}:${f.stable}:/usr/bin:/bin` }, script: "daynight; dn" });
    assert.deepEqual(rows(result).map((row) => row.label), ["dev", "managed-pinned"]);
  }
});

test("keeps the development entry link live and never falls back when it disappears", async (t) => {
  const f = await fixture(t);
  const first = f.dev, entry = path.join(f.root, "dev-link");
  await symlink(first, entry); f.args[f.args.indexOf("--dev-cli") + 1] = entry;
  f.create();
  assert.equal(rows(f.run())[0].label, "dev");
  const second = await f.executable(path.join(f.root, "second-dev"), "new-dev");
  await rm(entry); await symlink(second, entry);
  assert.equal(rows(f.run())[0].label, "new-dev");
  await rm(entry);
  const result = f.run(); assert.equal(result.status, 126); assert.equal(result.stdout, "");
  assert.match(result.stderr, /Development executable is unavailable/);
});

test("validates directory isolation, executable access and output ownership before writing", async (t) => {
  const f = await fixture(t);
  const inside = path.join(f.repo, ".daynight-dev"); await mkdir(inside);
  const stateAlias = path.join(f.root, "state-link"); await symlink(inside, stateAlias);
  for (const state of [f.repo, f.root, inside, stateAlias]) {
    const args = [...f.args]; args[args.indexOf("--dev-root") + 1] = state;
    const result = f.generate([], args); assert.notEqual(result.status, 0); assert.match(result.stderr, /overlap/);
  }
  const insideOutput = [...f.args]; insideOutput[insideOutput.indexOf("--output") + 1] = path.join(f.repo, "router");
  assert.match(f.generate([], insideOutput).stderr, /output.*repository/i);
  await chmod(f.dev, 0o600); assert.match(f.generate().stderr, /executable/i); await chmod(f.dev, 0o700);
  f.create();
  const before = await readFile(f.wrapper); assert.match(f.generate().stderr, /already exists/);
  assert.deepEqual(await readFile(f.wrapper), before);
  const aliasOutput = path.join(f.root, "existing-output-link"); await symlink(f.output, aliasOutput);
  const args = [...f.args]; args[args.indexOf("--output") + 1] = aliasOutput;
  assert.match(f.generate([], args).stderr, /already exists/);
  const existingFile = path.join(f.root, "existing-file"); await writeFile(existingFile, "retain this file");
  args[args.indexOf("--output") + 1] = existingFile;
  assert.match(f.generate([], args).stderr, /already exists/);
  assert.equal(await readFile(existingFile, "utf8"), "retain this file");
  const dangling = path.join(f.root, "dangling-output"); await symlink(path.join(f.root, "absent"), dangling);
  args[args.indexOf("--output") + 1] = dangling;
  assert.match(f.generate([], args).stderr, /already exists/);
  const repositoryAlias = path.join(f.root, "output-parent-link"); await symlink(f.repo, repositoryAlias);
  args[args.indexOf("--output") + 1] = path.join(repositoryAlias, "new-router");
  assert.match(f.generate([], args).stderr, /output.*repository/i);
});

test("exec preserves process identity and termination signals", async (t) => {
  const f = await fixture(t); f.create();
  const child = spawn(f.wrapper, ["--wait"], { cwd: f.repo, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const closed = once(child, "close");
  const [chunk] = await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
  assert.equal(JSON.parse(chunk.toString()).pid, child.pid);
  child.kill("SIGTERM");
  const [code, signal] = await closed;
  assert.equal(code, null); assert.equal(signal, "SIGTERM");
});
