import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const setup = async (options: { gitCommand: string; gitArgs?: string[]; stream?: string; badReady?: boolean }) => {
  const base = path.resolve("../../.tmp/pipe-ready-fixture"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "fixture-")); roots.push(root);
  const receipt = path.join(root, "receipt.jsonl"), ready = path.join(root, options.badReady ? "missing/ready" : "ready"), release = path.join(root, "release"), leaf = path.join(root, "leaf.mjs");
  const fixture = pathToFileURL(path.resolve("test/commands/worker/pipe-ready-fixture.mjs")).href;
  await writeFile(leaf, `import { runLeaf } from ${JSON.stringify(fixture)}; runLeaf(${JSON.stringify({ ready, release, receipt })});\n`);
  const wrapper = path.join(root, "wrapper.mjs");
  await writeFile(wrapper, `import { runWrapper } from ${JSON.stringify(fixture)}; runWrapper(${JSON.stringify({ ...options, stream: options.stream ?? "stdout", ready, rootReady: path.join(root, "root-ready"), release, leaf, receipt })});\n`);
  const child = spawn(process.execPath, [wrapper], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); children.push(child);
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout!.on("data", chunk => stdout.push(chunk)); child.stderr!.on("data", chunk => stderr.push(chunk));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const events = async (): Promise<Array<Record<string, unknown>>> => (await readFile(receipt, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  return { root, receipt, ready, release, child, closed, events, stdout, stderr };
};

const stages = (events: Array<Record<string, unknown>>) => events.map(event => event.stage);
const assertOrder = (observed: unknown[], expected: string[]) => {
  let index = -1;
  for (const stage of expected) { index = observed.indexOf(stage, index + 1); expect(index, `missing or out-of-order stage ${stage}`).toBeGreaterThanOrEqual(0); }
};

it("records a real spawn failure without publishing ready or leaking the command", async () => {
  const f = await setup({ gitCommand: path.join(process.cwd(), "secret-missing-executable") });
  expect((await f.closed).code).not.toBe(0);
  const events = await f.events();
  assertOrder(stages(events), ["wrapper-start", "git-spawn-attempt", "git-error", "git-close"]);
  expect(events.find(event => event.stage === "git-error")).toMatchObject({ code: "ENOENT" });
  expect(events.find(event => event.stage === "git-close")).toMatchObject({ started: false, exited: false, stdout: "unknown", stderr: "unknown" });
  expect(stages(events)).not.toContain("ready-success");
  expect(JSON.stringify(events)).not.toContain("secret-missing-executable");
  await expect(access(f.ready)).rejects.toMatchObject({ code: "ENOENT" });
});

it("records a nonzero exit and forwards output without retaining secrets", async () => {
  const secret = "private-token-in-git-output";
  const f = await setup({ gitCommand: process.execPath, gitArgs: ["-e", `console.log(${JSON.stringify(secret)}); console.error(${JSON.stringify(secret)}); process.exit(17)`] });
  expect((await f.closed).code).toBe(17);
  const events = await f.events();
  assertOrder(stages(events), ["git-spawn-attempt", "git-spawn", "git-exit", "git-close"]);
  expect(events.find(event => event.stage === "git-exit")).toMatchObject({ code: 17, signal: null });
  expect(events.find(event => event.stage === "git-close")).toMatchObject({ started: true, exited: true, code: 17 });
  expect(stages(events)).not.toContain("ready-attempt");
  expect(Buffer.concat(f.stdout).toString()).toContain(secret);
  expect(Buffer.concat(f.stderr).toString()).toContain(secret);
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(events)).not.toContain(f.root);
});

it("records abnormal Git termination without treating it as success", async () => {
  const f = await setup({ gitCommand: process.execPath, gitArgs: ["-e", "process.kill(process.pid, 'SIGTERM')"] });
  expect((await f.closed).code).not.toBe(0);
  const events = await f.events();
  assertOrder(stages(events), ["git-spawn", "git-exit", "git-close"]);
  const exit = events.find(event => event.stage === "git-exit")!;
  expect(exit.code !== 0 || exit.signal !== null).toBe(true);
  expect(stages(events)).not.toContain("ready-attempt");
});

it("records leaf ready write failure after Git succeeds", async () => {
  const f = await setup({ gitCommand: process.execPath, gitArgs: ["-e", "process.exit(0)"], badReady: true });
  await f.closed;
  const events = await f.events();
  assertOrder(stages(events), ["git-spawn", "git-exit", "git-close", "leaf-spawn-attempt", "leaf-start", "ready-attempt", "ready-error"]);
  expect(events.find(event => event.stage === "ready-error")).toMatchObject({ marker: "pipe", code: "ENOENT" });
  expect(stages(events)).not.toContain("ready-success");
});

it("publishes the ready gate and holds the inherited output open until release", async () => {
  const f = await setup({ gitCommand: process.execPath, gitArgs: ["-e", "process.stdout.write('fixture-output')"] });
  let closed = false; void f.closed.then(() => { closed = true; });
  try {
    await vi.waitFor(async () => { await access(f.ready); }, { timeout: 5000, interval: 20 });
    expect(closed).toBe(false);
    await writeFile(f.release, "release");
    expect((await f.closed).code).toBe(0);
    const events = await f.events();
    assertOrder(stages(events), ["git-spawn", "git-exit", "git-close", "leaf-spawn-attempt", "leaf-start", "ready-attempt", "ready-success"]);
    expect(events.find(event => event.stage === "ready-success")).toMatchObject({ marker: "pipe" });
    expect(Buffer.concat(f.stdout).toString()).toContain("fixture-output");
  } finally { await writeFile(f.release, "release"); await f.closed; }
}, 10_000);

it.each(["child", "helper"])("publishes the %s holder marker only after Git closes", async stream => {
  const f = await setup({ gitCommand: process.execPath, gitArgs: ["-e", "process.exit(0)"], stream });
  try {
    const marker = stream === "helper" ? path.join(f.root, "root-ready") : f.ready;
    await vi.waitFor(async () => { await access(marker); }, { timeout: 5000, interval: 20 });
    await vi.waitFor(async () => { expect(stages(await f.events())).toContain("ready-success"); }, { timeout: 5000, interval: 20 });
    const events = await f.events();
    assertOrder(stages(events), ["git-spawn", "git-exit", "git-close", "ready-attempt", "ready-success"]);
    expect(events.find(event => event.stage === "ready-success")).toMatchObject({ marker: stream === "helper" ? "root" : "pipe" });
    expect(f.child.exitCode).toBeNull();
  } finally { await writeFile(f.release, "release"); expect((await f.closed).code).toBe(0); }
}, 10_000);
