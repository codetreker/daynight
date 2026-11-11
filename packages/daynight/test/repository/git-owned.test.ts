import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../src/api/operation.js";
import type { Operation } from "../../src/api/operation.js";
import { RepositoryGitError } from "../../src/repository/git.js";
import { startOwnedRepositoryGit } from "../../src/repository/git-owned.js";

const helpers = vi.hoisted(() => ({ children: [] as ChildProcess[], gitChildren: [] as ChildProcess[], replacement: undefined as string | undefined, gitReplacement: undefined as string | undefined }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = ((...args: unknown[]) => {
    const isHelper = typeof args[0] === "string" && /[\\/]System32[\\/]taskkill\.exe$/i.test(args[0]);
    const child = isHelper && helpers.replacement !== undefined
      ? actual.spawn(process.execPath, [helpers.replacement, (args[1] as string[])[1]!], args[2] as Parameters<typeof actual.spawn>[2])
      : args[0] === "git" && helpers.gitReplacement !== undefined
        ? actual.spawn(process.execPath, [helpers.gitReplacement], args[2] as Parameters<typeof actual.spawn>[2])
        : Reflect.apply(actual.spawn, undefined, args) as ChildProcess;
    if (isHelper) helpers.children.push(child);
    if (args[0] === "git") helpers.gitChildren.push(child);
    return child;
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

const scratch = path.resolve(import.meta.dirname, "../../../../.tmp/repository-git-owned-tests");
const directories: string[] = [];
const operations: Operation[] = [];
const gitEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
const git = (cwd: string, args: string[]): void => {
  execFileSync("git", args, { cwd, env: gitEnvironment(), timeout: 10_000, stdio: "pipe" });
};
const operation = (signal?: AbortSignal): Operation => {
  const op = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs: 12_000 } });
  operations.push(op);
  return op;
};
const repository = async (): Promise<string> => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "Owned Git 中文 "));
  directories.push(root);
  git(root, ["init", "--initial-branch=main"]);
  return root;
};
const configureAlias = async (root: string, source: string): Promise<void> => {
  const script = path.join(root, "fixture.mjs");
  await writeFile(script, source);
  git(root, ["config", "alias.daynight-fixture", `!${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(script.replaceAll("\\", "/"))}`]);
};
const waitForFile = async (filename: string): Promise<string> => {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try { return await readFile(filename, "utf8"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Fixture did not create ${filename}`);
};
const errorText = (value: unknown): string => {
  if (!(value instanceof Error)) return String(value);
  return [String(value), value.cause === undefined ? "" : errorText(value.cause), ...(value instanceof AggregateError ? value.errors.map(errorText) : [])].join(" ");
};
const containsError = (value: unknown, target: unknown): boolean => {
  if (value === target) return true;
  if (!(value instanceof Error)) return false;
  return containsError(value.cause, target) || (value instanceof AggregateError && value.errors.some((item: unknown) => containsError(item, target)));
};

afterEach(async () => {
  for (const op of operations.splice(0)) op.dispose();
  vi.unstubAllEnvs();
  helpers.children.splice(0);
  helpers.gitChildren.splice(0);
  helpers.replacement = undefined;
  helpers.gitReplacement = undefined;
  vi.unstubAllGlobals();
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("returns normal results only after local closure and preserves nonzero exit policy", async () => {
  const root = await repository();
  const success = startOwnedRepositoryGit(root, ["rev-parse", "--is-bare-repository"], operation(), {});
  expect(await success.outcome).toEqual({ kind: "success", result: { stdout: "false\n", stderr: "", exitCode: 0 } });
  expect(await success.joined).toEqual({ kind: "local-closed", cleanupErrors: [] });

  const failure = startOwnedRepositoryGit(root, ["config", "--get", "fixture.missing"], operation(), {});
  const outcome = await failure.outcome;
  expect(outcome.kind).toBe("failure");
  if (outcome.kind !== "failure") throw new Error("Expected a joined failure");
  expect(outcome.settlement).toBe("joined");
  expect(outcome.error).toBeInstanceOf(RepositoryGitError);
  expect(outcome.error).toMatchObject({ exitCode: 1 });
  expect(await failure.joined).toEqual({ kind: "local-closed", cleanupErrors: [] });
  const allowed = startOwnedRepositoryGit(root, ["config", "--get", "fixture.missing"], operation(), { allowExitOne: true });
  expect(await allowed.outcome).toMatchObject({ kind: "success", result: { exitCode: 1 } });
});

it("retains actual spawn failures through joined closure", async () => {
  const root = await repository();
  vi.stubEnv("PATH", "");
  const command = startOwnedRepositoryGit(root, ["version"], operation(), {});
  const outcome = await command.outcome;
  expect(outcome.kind).toBe("failure");
  if (outcome.kind !== "failure") throw new Error("Expected a joined failure");
  expect(outcome.error).toMatchObject({ name: "RepositoryGitError", cause: { code: "ENOENT" } });
  expect(await command.joined).toMatchObject({ kind: "local-closed" });
});

it("retains cancellation while stopping a real Git alias", async () => {
  const root = await repository();
  const marker = path.join(root, "started");
  await configureAlias(root, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ready');\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(1), 8000).unref();\n`);
  const controller = new AbortController();
  const op = operation(controller.signal);
  const command = startOwnedRepositoryGit(root, ["daynight-fixture"], op, {});
  try {
    await waitForFile(marker);
    controller.abort(new Error("fixture cancellation"));
    const outcome = await command.outcome;
    expect(outcome.kind).not.toBe("success");
    if (outcome.kind === "success") throw new Error("Cancellation returned success");
    expect(containsError(outcome.error, op.signal.reason)).toBe(true);
    const settlement = await command.joined;
    expect(settlement.kind).toBe("local-closed");
    if (process.platform === "win32") {
      expect(helpers.children).toHaveLength(1);
      const helper = helpers.children[0]!;
      expect(helper.spawnfile.toLowerCase()).toBe(path.win32.join(process.env.SystemRoot!, "System32", "taskkill.exe").toLowerCase());
      expect(helper.spawnargs.slice(1)).toEqual(["/PID", expect.stringMatching(/^\d+$/), "/T", "/F"]);
      expect(helper.exitCode !== null || helper.signalCode !== null).toBe(true);
      if (helper.exitCode !== 0) expect(settlement.cleanupErrors.length).toBeGreaterThan(0);
    }
  } finally {
    command.requestStop();
    await command.joined;
  }
}, 15_000);

it("reports output overflow and drains to local closure", async () => {
  const root = await repository();
  const config = path.join(root, "large-config");
  await writeFile(config, `[fixture]\nlarge = ${"x".repeat(1_100_000)}\n`);
  const command = startOwnedRepositoryGit(root, ["config", "--file", config, "--get", "fixture.large"], operation(), {});
  const outcome = await command.outcome;
  expect(outcome.kind).not.toBe("success");
  if (outcome.kind === "success") throw new Error("Overflow returned success");
  expect(errorText(outcome.error)).toContain("stdout exceeded its 1048576-byte limit");
  expect((await command.joined).kind).toBe("local-closed");
}, 15_000);

it("reports cleanup pending while an inherited output remains open after root exit", async () => {
  const root = await repository();
  const ready = path.join(root, "leaf-ready");
  const release = path.join(root, "release");
  const leaf = path.join(root, "leaf.mjs");
  await writeFile(leaf, `import { existsSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ready)}, String(process.pid));\nconst poll = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(poll); process.exit(0); } }, 20);\nsetTimeout(() => process.exit(1), 10000).unref();\n`);
  await configureAlias(root, `import { spawn } from 'node:child_process';\nconst leaf = spawn(process.execPath, [${JSON.stringify(leaf)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });\nleaf.unref();\n`);
  const command = startOwnedRepositoryGit(root, ["daynight-fixture"], operation(), { timeoutMs: 1500 });
  try {
    await waitForFile(ready);
    const outcome = await command.outcome;
    expect(outcome.kind).toBe("cleanup-pending");
    if (outcome.kind !== "cleanup-pending") throw new Error("Expected cleanup pending");
    expect(outcome.error).toMatchObject({ code: "repository_git_cleanup_pending" });
    let joined = false;
    void command.joined.then(() => { joined = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(joined).toBe(false);
    await writeFile(release, "release");
    expect((await command.joined).kind).toBe("local-closed");
  } finally {
    await writeFile(release, "release");
    command.requestStop();
    await command.joined;
  }
}, 15_000);

// Native Windows exercises the real fallback after an invalid taskkill path.
it.skipIf(process.platform !== "win32")("retains a Windows stop setup failure and the original cancellation", async () => {
  const root = await repository();
  const marker = path.join(root, "started");
  await configureAlias(root, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ready');\nsetTimeout(() => process.exit(0), 2000);\n`);
  const controller = new AbortController();
  const op = operation(controller.signal);
  const command = startOwnedRepositoryGit(root, ["daynight-fixture"], op, {});
  try {
    await waitForFile(marker);
    vi.stubEnv("SystemRoot", "relative");
    controller.abort(new Error("fixture cancellation"));
    const outcome = await command.outcome;
    expect(outcome.kind).not.toBe("success");
    if (outcome.kind === "success") throw new Error("Cancellation returned success");
    expect(containsError(outcome.error, op.signal.reason)).toBe(true);
    const settlement = await command.joined;
    expect(settlement.cleanupErrors.some((error) => String(error).includes("SystemRoot"))).toBe(true);
    expect(helpers.children).toHaveLength(0);
  } finally {
    command.requestStop();
    await command.joined;
  }
}, 15_000);

// The substituted helper is a real process; it holds its inherited pipe open
// after exiting so helper exit alone cannot satisfy local closure.
it("waits for the stop helper's inherited pipe and retains its failure", async () => {
  const root = await repository();
  const marker = path.join(root, "started");
  const ready = path.join(root, "helper-leaf-ready");
  const release = path.join(root, "helper-leaf-release");
  const leaf = path.join(root, "helper-leaf.mjs");
  const helper = path.join(root, "helper.mjs");
  await configureAlias(root, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(1), 8000).unref();\n`);
  await writeFile(leaf, `import { existsSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ready)}, 'ready');\nconst poll = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(poll); process.exit(0); } }, 20);\nsetTimeout(() => process.exit(1), 10000).unref();\n`);
  await writeFile(helper, `import { spawn } from 'node:child_process';\nimport { readFileSync } from 'node:fs';\nconst leaf = spawn(process.execPath, [${JSON.stringify(leaf)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });\nleaf.unref();\nfor (const pid of [Number(process.argv[2]), Number(readFileSync(${JSON.stringify(marker)}, 'utf8'))]) { try { process.kill(pid, 'SIGKILL'); } catch {} }\nprocess.exit(19);\n`);
  helpers.replacement = helper;
  const realProcess = process;
  vi.stubGlobal("process", new Proxy(realProcess, { get: (target, key, receiver) => key === "platform" ? "win32" : Reflect.get(target, key, receiver) }));
  vi.stubEnv("SystemRoot", "C:\\Windows");
  const controller = new AbortController();
  const op = operation(controller.signal);
  const command = startOwnedRepositoryGit(root, ["daynight-fixture"], op, {});
  try {
    await waitForFile(marker);
    controller.abort(new Error("fixture cancellation"));
    await waitForFile(ready);
    const outcome = await command.outcome;
    expect(outcome.kind).toBe("cleanup-pending");
    if (outcome.kind !== "cleanup-pending") throw new Error("Expected cleanup pending");
    expect(containsError(outcome.error, op.signal.reason)).toBe(true);
    let joined = false;
    void command.joined.then(() => { joined = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(joined).toBe(false);
    await writeFile(release, "release");
    const settlement = await command.joined;
    expect(settlement.cleanupErrors.some((error) => String(error).includes("taskkill failed"))).toBe(true);
    expect(helpers.children).toHaveLength(1);
    expect(helpers.children[0]!.exitCode).toBe(19);
  } finally {
    await writeFile(release, "release");
    command.requestStop();
    await command.joined;
  }
}, 15_000);

// A single real process avoids Git's multi-process taskkill race and proves a
// successful native helper invocation separately from the real Git alias case.
it.skipIf(process.platform !== "win32")("joins a successful native Windows taskkill", async () => {
  const root = await repository();
  const marker = path.join(root, "direct-child-ready");
  const script = path.join(root, "direct-child.mjs");
  await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ready');\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(1), 8000).unref();\n`);
  helpers.gitReplacement = script;
  const controller = new AbortController();
  const op = operation(controller.signal);
  const command = startOwnedRepositoryGit(root, ["fixture"], op, {});
  try {
    await waitForFile(marker);
    controller.abort(new Error("fixture cancellation"));
    const outcome = await command.outcome;
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") throw new Error("Expected joined failure");
    expect(containsError(outcome.error, op.signal.reason)).toBe(true);
    const settlement = await command.joined;
    expect(settlement.cleanupErrors).toEqual([]);
    expect(helpers.children).toHaveLength(1);
    expect(helpers.children[0]!.exitCode).toBe(0);
  } finally {
    command.requestStop();
    await command.joined;
  }
}, 15_000);

it("dispatches an immediate repeated stop only once", async () => {
  const root = await repository();
  const helper = path.join(root, "stop.mjs");
  await writeFile(helper, "try { process.kill(Number(process.argv[2]), 'SIGKILL'); } catch {}\n");
  helpers.replacement = helper;
  const realProcess = process;
  vi.stubGlobal("process", new Proxy(realProcess, { get: (target, key, receiver) => key === "platform" ? "win32" : Reflect.get(target, key, receiver) }));
  vi.stubEnv("SystemRoot", "C:\\Windows");
  const command = startOwnedRepositoryGit(root, ["version"], operation(), {});
  command.requestStop();
  command.requestStop();
  await command.joined;
  expect(helpers.children).toHaveLength(1);
  expect((await command.outcome).kind).toBe("failure");
}, 15_000);

it("retains an output stream error until the real child and both streams close", async () => {
  const root = await repository();
  const marker = path.join(root, "stream-error-ready");
  await configureAlias(root, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ready');\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(1), 8000).unref();\n`);
  const command = startOwnedRepositoryGit(root, ["daynight-fixture"], operation(), {});
  const child = helpers.gitChildren.at(-1)!;
  const closed = { child: false, stdout: false, stderr: false };
  child.once("close", () => { closed.child = true; });
  child.stdout!.once("close", () => { closed.stdout = true; });
  child.stderr!.once("close", () => { closed.stderr = true; });
  const original = new Error("fixture stdout failure");
  try {
    await waitForFile(marker);
    child.stdout!.emit("error", original);
    const outcome = await command.outcome;
    expect(outcome.kind).not.toBe("success");
    if (outcome.kind === "success") throw new Error("Stream error returned success");
    expect(containsError(outcome.error, original)).toBe(true);
    expect((await command.joined).kind).toBe("local-closed");
    expect(closed).toEqual({ child: true, stdout: true, stderr: true });
  } finally {
    command.requestStop();
    await command.joined;
  }
}, 15_000);

it("stops a real child promptly on stdout overflow after long stderr", async () => {
  const root = await repository();
  const script = path.join(root, "large-output.mjs");
  const ready = path.join(root, "large-output-ready");
  const trigger = path.join(root, "large-output-trigger");
  const lateWrite = path.join(root, "large-output-late-write");
  await writeFile(script, `import { existsSync, writeFileSync } from 'node:fs';\nprocess.stderr.write('x'.repeat(32768), () => writeFileSync(${JSON.stringify(ready)}, 'ready'));\nconst poll = setInterval(() => {\n  if (!existsSync(${JSON.stringify(trigger)})) return;\n  clearInterval(poll);\n  process.stdout.write('y'.repeat(1100000));\n  setTimeout(() => writeFileSync(${JSON.stringify(lateWrite)}, 'late'), 400);\n}, 10);\nsetTimeout(() => process.exit(1), 8000).unref();\n`);
  helpers.gitReplacement = script;
  const command = startOwnedRepositoryGit(root, ["fixture"], operation(), {});
  const child = helpers.gitChildren.at(-1)!;
  let stderrBytes = 0;
  child.stderr!.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
  try {
    await waitForFile(ready);
    await expect.poll(() => stderrBytes, { timeout: 5000, interval: 10 }).toBe(32768);
    await writeFile(trigger, "go");
    const outcome = await command.outcome;
    expect(outcome.kind).not.toBe("success");
    if (outcome.kind === "success") throw new Error("Overflow returned success");
    expect(errorText(outcome.error)).toContain("stdout exceeded its 1048576-byte limit");
    expect((await command.joined).kind).toBe("local-closed");
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    await expect(readFile(lateWrite)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    command.requestStop();
    await command.joined;
  }
}, 20_000);
