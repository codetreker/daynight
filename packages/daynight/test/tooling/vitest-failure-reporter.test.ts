import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import type { TestCase } from "vitest/node";
import ImmediateFailureReporter, { FAILURE_DIAGNOSTIC_LIMITS as limits } from "../../scripts/vitest-failure-reporter.js";

const roots: string[] = [];
const packageRoot = path.resolve(import.meta.dirname, "../..");
const directory = () => {
  const base = path.resolve(packageRoot, "../../.tmp/vitest-failure-reporter-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-")); roots.push(root); return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const readEvents = (directory: string) => readdirSync(directory).filter(name => name.endsWith(".jsonl")).flatMap(name => readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
const reported = (errors: unknown[], state = "failed") => ({ module: { moduleId: "fixture.test.ts" }, fullName: "suite > case", result: () => ({ state, errors }) }) as unknown as TestCase;
const fixture = () => {
  const root = directory(), output: string[] = [];
  const reporter = new ImmediateFailureReporter({ directory: root, writeConsole: text => { output.push(text); } });
  reporter.onTestRunStart();
  return { root, reporter, output };
};

test.each(["false", "true"])("CLI configuration preserves Vitest's default reporters with GITHUB_ACTIONS=%s", githubActions => {
  const script = `import { configDefaults } from 'vitest/config';
import { loadConfigFromFile } from 'vite';
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, 'vitest.config.ts');
const reporters = loaded.config.test.reporters;
const failures = reporters.at(-1);
console.log(JSON.stringify({ defaults: configDefaults.reporters, configured: reporters.slice(0, -1), failureCallback: typeof failures.onTestCaseResult, unhandledCallback: loaded.config.test.onUnhandledError === failures.onUnhandledError }));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: packageRoot,
    env: { ...process.env, GITHUB_ACTIONS: githubActions },
    timeout: 20_000,
    maxBuffer: 262_144,
    encoding: "utf8",
    windowsHide: true,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.configured).toEqual(result.defaults);
  expect(result.configured.includes("github-actions")).toBe(githubActions === "true");
  expect(result.failureCallback).toBe("function");
  expect(result.unhandledCallback).toBe(true);
}, 25_000);

test("records only confirmed failures and bounded framework fields", () => {
  const f = fixture(), error = { name: "AssertionError", message: "expected actual to be expected", stack: "AssertionError\n at fixture.test.ts:3:4", actual: "private-extra-marker", expected: "private-extra-marker" };
  for (const state of ["passed", "pending", "skipped"]) f.reporter.onTestCaseResult(reported([error], state));
  expect(readEvents(f.root).filter(event => event.kind.endsWith("failed"))).toEqual([]);
  f.reporter.onTestCaseResult(reported([error]));
  expect(readEvents(f.root).at(-1)).toMatchObject({ kind: "test-failed", file: "fixture.test.ts", test: "suite > case", errors: [{ name: error.name, message: error.message, stack: error.stack }] });
  expect(f.output.join("")).toContain(error.stack);
  expect(JSON.stringify(readEvents(f.root)) + f.output.join("")).not.toContain("private-extra-marker");
});

test("bounds escaped fields, each event and combined run output with visible truncation", () => {
  const f = fixture(), huge = "\u0000😀é".repeat(30_000);
  const error = { name: huge, message: huge, stack: huge };
  for (let index = 0; index < 200; index++) f.reporter.onTestCaseResult(reported([error, error, error]));
  const events = readEvents(f.root), failures = events.filter(event => event.kind === "test-failed");
  expect(failures.length).toBeGreaterThan(0);
  for (const event of events) expect(Buffer.byteLength(JSON.stringify(event) + "\n")).toBeLessThanOrEqual(limits.event);
  for (const event of failures) {
    expect(event.omittedErrors).toBe(1); expect(event.truncated).toContain("errors[0].stack");
    expect(event.errors).toHaveLength(limits.errors);
    for (const value of event.errors) for (const key of ["name", "message", "stack"] as const) {
      expect(Buffer.byteLength(JSON.stringify(value[key]))).toBeLessThanOrEqual(key === "name" ? limits.errorName : limits[key]);
      expect(value[key]).toContain("[truncated]");
    }
  }
  expect(events.filter(event => event.kind === "diagnostics-truncated")).toHaveLength(1);
  const artifactBytes = readdirSync(f.root).reduce((total, name) => total + readFileSync(path.join(f.root, name)).length, 0);
  expect(artifactBytes + Buffer.byteLength(f.output.join(""))).toBeLessThanOrEqual(limits.run);
  expect(f.output.every(value => Buffer.byteLength(value) <= limits.event)).toBe(true);
});

test("bounds event count even when failures have no detailed errors", () => {
  const f = fixture();
  for (let index = 0; index < limits.events + 20; index++) f.reporter.onTestCaseResult(reported([]));
  expect(readEvents(f.root)).toHaveLength(limits.events + 1);
  expect(readEvents(f.root).at(-1)).toMatchObject({ kind: "diagnostics-truncated" });
});

test("records a JSONL write failure once while retaining console failure details", () => {
  const root = directory(), blocked = path.join(root, "file"); writeFileSync(blocked, "not a directory");
  const output: string[] = [], reporter = new ImmediateFailureReporter({ directory: path.join(blocked, "events"), writeConsole: text => { output.push(text); } });
  reporter.onTestRunStart(); reporter.onTestCaseResult(reported([new Error("original assertion")])); reporter.onTestCaseResult(reported([new Error("second assertion")]));
  expect(output.join("")).toContain("original assertion"); expect(output.join("")).toContain("second assertion");
  expect(output.filter(value => value.includes("diagnostic-write-failed"))).toHaveLength(1);
  expect(output.every(value => Buffer.byteLength(value) <= limits.event)).toBe(true);
});

test("records a console write failure through the remaining JSONL sink", () => {
  const root = directory(), reporter = new ImmediateFailureReporter({ directory: root, writeConsole: () => { throw Object.assign(new Error("private-writer-message"), { code: "EPIPE" }); } });
  reporter.onTestRunStart(); reporter.onTestCaseResult(reported([new Error("original assertion")]));
  expect(readEvents(root).filter(event => event.kind === "test-failed")).toHaveLength(1);
  expect(readEvents(root).at(-1)).toMatchObject({ kind: "diagnostic-write-failed", target: "console" });
  expect(JSON.stringify(readEvents(root))).not.toContain("private-writer-message");
  expect(readEvents(root).map(event => event.sequence)).toEqual([1, 2, 3]);
});

test("unhandled callbacks retain Vitest's failure decision and avoid final duplicate reports", () => {
  const f = fixture(), error = { name: "Error", message: "unhandled failure", stack: "Error: unhandled failure\n at fixture.test.ts:1:1" };
  expect(f.reporter.onUnhandledError(error)).toBeUndefined();
  f.reporter.onTestRunEnd([], [error], "failed");
  expect(readEvents(f.root).filter(event => event.kind === "unhandled-error")).toHaveLength(1);
});

const stopChild = (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5_000, stdio: "ignore", windowsHide: true });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
};
async function runFixture(source: string, blocked = false, separateBlocker = false, writeFault = false) {
  const root = directory(), output = path.join(root, "events"), gate = path.join(root, "release"), ready = path.join(root, "ready");
  const reporter = pathToFileURL(path.join(packageRoot, "scripts/vitest-failure-reporter.ts")).href;
  const vitest = pathToFileURL(path.join(packageRoot, "node_modules/vitest/dist/index.js")).href;
  const config = path.join(root, "vitest.config.mts");
  writeFileSync(config, `import Reporter from ${JSON.stringify(reporter)}; const reporter = new Reporter({ directory: ${JSON.stringify(output)} }); export default { root: ${JSON.stringify(root)}, test: { include: ['*.test.mjs'], reporters: ['default', reporter], onUnhandledError: reporter.onUnhandledError, maxWorkers: ${separateBlocker ? 2 : 1}, fileParallelism: ${separateBlocker}, testTimeout: 10000, hookTimeout: 10000 } };`);
  const imports = `import { test, expect, beforeAll, describe } from ${JSON.stringify(vitest)}; import { existsSync, writeFileSync } from 'node:fs'; import { setTimeout as delay } from 'node:timers/promises';\n`;
  const blocker = `test('remains active after failure', async () => { writeFileSync(${JSON.stringify(ready)}, 'ready'); while (!existsSync(${JSON.stringify(gate)})) await delay(20); });`;
  writeFileSync(path.join(root, "fixture.test.mjs"), imports + source + "\n" + (blocked && !separateBlocker ? blocker : ""));
  if (separateBlocker) writeFileSync(path.join(root, "blocker.test.mjs"), imports + blocker);
  if (writeFault) writeFileSync(output, "not a directory");
  const child = spawn(process.execPath, [path.join(packageRoot, "node_modules/vitest/vitest.mjs"), "run", "--config", config], { cwd: packageRoot, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let transcript = "";
  const consume = (chunk: Buffer) => { if (transcript.length < 262_144) transcript += chunk.toString().slice(0, 262_144 - transcript.length); else stopChild(child); };
  child.stdout.on("data", consume); child.stderr.on("data", consume);
  const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const deadline = setTimeout(() => stopChild(child), 20_000);
  return { root, output, ready, child, exit, transcript: () => transcript, release: () => writeFileSync(gate, "release"), async close() { writeFileSync(gate, "release"); stopChild(child); try { await exit; } finally { clearTimeout(deadline); } } };
}

test("real Vitest failure details are readable while a later test is active before final summary", async () => {
  const f = await runFixture("test('first assertion fails', () => { expect('observed').toBe('wanted'); });", true);
  try {
    await vi.waitFor(() => { expect(existsSync(f.ready)).toBe(true); expect(readEvents(f.output).some(event => event.kind === "test-failed")).toBe(true); }, { timeout: 12_000 });
    expect(f.child.exitCode).toBeNull(); expect(f.transcript()).not.toContain("Test Files");
    const failure = readEvents(f.output).find(event => event.kind === "test-failed");
    expect(failure.test).toContain("first assertion fails"); expect(failure.errors[0].message).toContain("wanted");
    expect(failure.errors[0].stack).toContain("fixture.test.mjs"); expect(f.transcript()).toContain("AssertionError");
    f.release(); expect(await f.exit).toBe(1); expect(f.transcript()).toContain("Test Files");
  } finally { await f.close(); }
}, 25_000);

test.each([
  { name: "module initialization", source: "throw new Error('module initialization failure');", kind: "module-failed", message: "module initialization failure", separateBlocker: true },
  { name: "suite hook", source: "describe('hook owner', () => { beforeAll(() => { throw new Error('suite hook failure'); }); test('blocked by hook', () => {}); });", kind: "suite-failed", message: "suite hook failure", separateBlocker: false },
  { name: "unhandled rejection", source: "test('unhandled error', async () => { Promise.reject(new Error('unhandled fixture failure')); await new Promise(resolve => setImmediate(resolve)); });", kind: "unhandled-error", message: "unhandled fixture failure", separateBlocker: false },
])("real Vitest preserves $name errors before final summary and its failing exit", async ({ source, kind, message, separateBlocker }) => {
  const f = await runFixture(source, true, separateBlocker);
  try {
    await vi.waitFor(() => { expect(existsSync(f.ready)).toBe(true); expect(readEvents(f.output).find(event => event.kind === kind)?.errors[0].message).toContain(message); }, { timeout: 12_000 });
    expect(f.child.exitCode).toBeNull(); expect(f.transcript()).not.toContain("Test Files");
    f.release(); expect(await f.exit).toBe(1);
  }
  finally { await f.close(); }
}, 25_000);

test("a real JSONL write failure remains visible and cannot mask a failed Vitest run", async () => {
  const f = await runFixture("test('fails', () => { throw new Error('original failed assertion'); });", false, false, true);
  try { expect(await f.exit).toBe(1); expect(f.transcript()).toContain("diagnostic-write-failed"); expect(f.transcript()).toContain("original failed assertion"); }
  finally { await f.close(); }
}, 25_000);

test("a successful real Vitest run emits no fabricated failure and preserves success", async () => {
  const f = await runFixture("test('passes', () => { expect(1).toBe(1); });");
  try { expect(await f.exit).toBe(0); expect(readEvents(f.output).map(event => event.kind)).toEqual(["run-start", "run-end"]); }
  finally { await f.close(); }
}, 25_000);
