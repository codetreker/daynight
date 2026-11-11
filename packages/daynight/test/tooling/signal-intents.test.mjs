import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { observeValidation } from "../../scripts/observe-native-validation.mjs";

const roots = [];
const packageRoot = path.resolve(import.meta.dirname, "../..");
const preload = path.join(packageRoot, "scripts/signal-intents.cjs");
const directory = () => {
  const base = path.resolve(packageRoot, "../../.tmp/signal-intent-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-")); roots.push(root); return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const readEvents = output => {
  const root = path.join(output, "signals");
  return existsSync(root) ? readdirSync(root).flatMap(name => readFileSync(path.join(root, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))) : [];
};
async function fixture(source, enabled = true) {
  const root = directory(), output = path.join(root, "evidence"), resultFile = path.join(root, "result.json");
  const script = path.join(root, "fixture.cjs");
  writeFileSync(script, `const fs = require('node:fs'); const assert = require('node:assert/strict');
const save = value => fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(value));
setTimeout(() => process.exit(91), 8000).unref();
${source}\n`);
  // The macOS CI parent already has the preload. Disable its configuration for
  // the native baseline without removing the retained-state isolation preload.
  const inherited = process.env.DAYNIGHT_SIGNAL_INTENTS_DIRECTORY;
  if (!enabled) delete process.env.DAYNIGHT_SIGNAL_INTENTS_DIRECTORY;
  let result;
  try { result = await observeValidation({ output, command: [process.execPath, script, "private-argument-marker"], signalIntents: enabled, platform: "other" }); }
  finally { if (inherited === undefined) delete process.env.DAYNIGHT_SIGNAL_INTENTS_DIRECTORY; else process.env.DAYNIGHT_SIGNAL_INTENTS_DIRECTORY = inherited; }
  return { root, output, result, events: readEvents(output), saved: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : undefined };
}

it("records opt-in bootstrap and a signal-0 request without changing its return", async () => {
  const f = await fixture("save({ pid: process.pid, parent: process.ppid, result: process.kill(process.pid, 0) });");
  expect(f.result.exitCode).toBe(0); expect(f.saved.result).toBe(true);
  expect(f.events.find(event => event.kind === "bootstrap")).toMatchObject({ pid: f.saved.pid, ppid: f.saved.parent, executable: path.basename(process.execPath) });
  expect(f.events.find(event => event.kind === "signal-intent")).toMatchObject({ pid: f.saved.pid, api: "process.kill", target: { type: "number", value: f.saved.pid }, signal: { type: "number", value: 0 } });
  expect(JSON.stringify(f.events)).not.toContain("private-argument-marker");
});

it("leaves the command uninstrumented unless explicitly enabled", async () => {
  const f = await fixture("save(process.kill(process.pid, 0));", false);
  expect(f.result.exitCode).toBe(0); expect(f.saved).toBe(true); expect(f.events).toEqual([]);
});

it.skipIf(process.platform === "win32")("retains the intent before a real self-SIGKILL prevents any return", async () => {
  const f = await fixture("process.kill(process.pid, 'SIGKILL'); save('unreachable');");
  expect(f.result).toMatchObject({ code: null, signal: "SIGKILL", exitCode: 137 });
  expect(f.saved).toBeUndefined();
  expect(f.events.at(-1)).toMatchObject({ kind: "signal-intent", pid: f.result.pid, target: { type: "number", value: f.result.pid }, signal: { type: "string", value: "SIGKILL" } });
});

it("keeps receivers, invalid arguments and thrown values without diagnostic coercion", async () => {
  const source = `
const { ChildProcess } = require('node:child_process');
const calls = []; let coerced = 0, pidGets = 0;
const receiver = new Proxy(process, { get(target, key, self) { calls.push(String(key)); return Reflect.get(target, key, self); } });
const result = Reflect.apply(process.kill, receiver, [process.pid, 0, { toJSON() { coerced++; } }]);
const bad = { toJSON() { coerced++; }, valueOf() { coerced++; }, toString() { coerced++; } };
const errors = [];
for (const args of [[bad, 0], [process.pid, bad], [process.pid, 'PRIVATE_SIGNAL_ARGUMENT']]) {
  try { Reflect.apply(process.kill, process, args); } catch (error) { errors.push({ name: error.name, code: error.code }); }
}
const child = new ChildProcess();
Object.defineProperty(child, 'pid', { get() { pidGets++; throw new Error('pid getter must not run'); } });
const childResult = child.kill(0);
const proxyCalls = [];
const proxy = new Proxy(new ChildProcess(), { get(target, key, self) { proxyCalls.push(String(key)); return Reflect.get(target, key, self); }, getOwnPropertyDescriptor() { throw new Error('diagnostic inspected proxy'); } });
const proxyResult = Reflect.apply(ChildProcess.prototype.kill, proxy, [0]);
save({ result, childResult, proxyResult, calls, proxyCalls, errors, coerced, pidGets });`;
  const baseline = await fixture(source, false), observed = await fixture(source);
  expect(baseline.result.exitCode).toBe(0); expect(observed.result.exitCode).toBe(0);
  expect(observed.saved).toEqual(baseline.saved);
  expect(observed.saved).toMatchObject({ result: true, childResult: false, proxyResult: false, pidGets: 0 });
  expect(observed.events.filter(event => event.kind === "signal-intent")).toHaveLength(6);
  expect(JSON.stringify(observed.events)).not.toContain("PRIVATE_SIGNAL_ARGUMENT");
});

it("captures call sites without invoking custom stack or serialization hooks", async () => {
  const f = await fixture(`
let hooks = 0;
Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, get() { hooks++; throw new Error('custom prepareStackTrace'); } });
Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, get() { hooks++; throw new Error('custom toJSON'); } });
const originalApply = Reflect.apply; Reflect.apply = () => { hooks++; throw new Error('custom apply'); };
function requestedFromFixture() { return process.kill(process.pid, 0); }
const result = requestedFromFixture();
Reflect.apply = originalApply; delete Error.prepareStackTrace; delete Object.prototype.toJSON;
save({ result, hooks });`);
  expect(f.result.exitCode).toBe(0); expect(f.saved).toEqual({ result: true, hooks: 0 });
  const event = f.events.find(event => event.kind === "signal-intent");
  expect(event.stack.some(frame => frame.function === "requestedFromFixture" && frame.file.endsWith("fixture.cjs"))).toBe(true);
});

it("rethrows the exact value from the original receiver access once", async () => {
  const f = await fixture(`
const { ChildProcess } = require('node:child_process');
const sentinel = {}; let accesses = 0;
const receiver = new Proxy(new ChildProcess(), { get() { accesses++; throw sentinel; } });
try { Reflect.apply(ChildProcess.prototype.kill, receiver, [0]); } catch (error) { save({ same: error === sentinel, accesses }); }`);
  expect(f.result.exitCode).toBe(0);
  expect(f.saved).toEqual({ same: true, accesses: 1 });
});

it("does not read inherited argument slots for omitted parameters", async () => {
  const source = `
const child = new (require('node:child_process').ChildProcess)(); let reads = 0, code;
Object.defineProperty(Object.prototype, '0', { configurable: true, get() { reads++; return 'inherited argument'; } });
try { process.kill(); } catch (error) { code = error.code; }
const result = child.kill(); delete Object.prototype[0]; save({ reads, code, result });`;
  const baseline = await fixture(source, false), observed = await fixture(source);
  expect(baseline.result.exitCode).toBe(0); expect(observed.result.exitCode).toBe(0);
  expect(observed.saved).toEqual(baseline.saved);
});

it("does not invoke inherited array setters while collecting call sites", async () => {
  const source = `
let writes = 0;
Object.defineProperty(Array.prototype, '0', { configurable: true, set() { writes++; } });
const result = process.kill(process.pid, 0); delete Array.prototype[0]; save({ writes, result });`;
  const baseline = await fixture(source, false), observed = await fixture(source);
  expect(baseline.result.exitCode).toBe(0); expect(observed.result.exitCode).toBe(0);
  expect(observed.saved).toEqual(baseline.saved);
});

it.skipIf(process.platform === "win32")("forwards default ChildProcess.kill and a negative owned process group exactly once", async () => {
  const f = await fixture(`
const { spawn } = require('node:child_process'); const { once } = require('node:events');
(async () => {
  const outcomes = [];
  for (const group of [false, true]) {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { detached: true, stdio: 'ignore' });
    try {
      await once(child, 'spawn'); const exited = once(child, 'exit');
      const result = group ? process.kill(-child.pid, 'SIGKILL') : child.kill();
      const [code, signal] = await exited; outcomes.push({ pid: child.pid, group, result, code, signal });
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  }
  save(outcomes);
})().catch(error => { console.error(error); process.exitCode = 1; });`);
  expect(f.result.exitCode).toBe(0);
  expect(f.saved.map(({ result, code, signal }) => ({ result, code, signal }))).toEqual([{ result: true, code: null, signal: "SIGTERM" }, { result: true, code: null, signal: "SIGKILL" }]);
  const sender = f.events.filter(event => event.pid === f.result.pid && event.kind === "signal-intent");
  expect(sender).toHaveLength(4);
  expect(sender[0]).toMatchObject({ api: "ChildProcess.kill", target: { value: f.saved[0].pid }, signal: { type: "undefined" }, signalSupplied: false });
  expect(sender[2]).toMatchObject({ api: "process.kill", target: { value: -f.saved[1].pid }, signal: { value: "SIGKILL" } });
});

function direct(source, { blocked = false } = {}) {
  const root = directory(), output = path.join(root, "evidence"), target = path.join(output, "signals");
  mkdirSync(output); if (blocked) writeFileSync(target, "not a directory");
  const script = path.join(root, "direct.cjs"); writeFileSync(script, source);
  const result = spawnSync(process.execPath, [script], { env: { ...process.env, DAYNIGHT_SIGNAL_INTENTS_DIRECTORY: target, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}` }, encoding: "utf8", timeout: 10_000, maxBuffer: 262_144 });
  expect(result.error).toBeUndefined();
  return { root, output, result, events: blocked ? [] : readEvents(output) };
}

it.skipIf(process.platform === "win32")("continues a real self-SIGKILL when the diagnostic directory is unwritable", () => {
  const f = direct("process.kill(process.pid, 'SIGKILL');", { blocked: true });
  expect(f.result.signal).toBe("SIGKILL");
  const failures = f.result.stderr.trim().split("\n").map(line => JSON.parse(line));
  expect(failures).toHaveLength(1); expect(failures[0].kind).toBe("diagnostic-write-failed");
});

it("bounds diagnostic output and visibly omits later requests while forwarding all calls", () => {
  const f = direct("let successes = 0; for (let i = 0; i < 2000; i++) if (process.kill(process.pid, 0)) successes++; process.stdout.write(String(successes));");
  expect(f.result.status).toBe(0); expect(f.result.stdout).toBe("2000");
  expect(f.events.filter(event => event.kind === "diagnostics-truncated")).toHaveLength(1);
  expect(f.events.at(-1).kind).toBe("diagnostics-truncated");
  const limits = f.events[0].limits;
  expect(f.events.length).toBeLessThanOrEqual(limits.events + 1);
  const files = readdirSync(path.join(f.output, "signals"));
  expect(files).toHaveLength(1);
  expect(readFileSync(path.join(f.output, "signals", files[0])).length).toBeLessThanOrEqual(limits.bytes);
  for (const event of f.events) expect(Buffer.byteLength(JSON.stringify(event) + "\n")).toBeLessThanOrEqual(limits.event);
});

it("bounds escaped frame fields without discarding the signal identity", () => {
  const f = direct(`new Function('return function ' + 'é'.repeat(2000) + '() { process.kill(process.pid, 0); }')()();`);
  expect(f.result.status).toBe(0);
  const event = f.events.find(value => value.kind === "signal-intent");
  expect(event.target.value).toBe(event.pid);
  const frame = event.stack.find(value => value.function.includes("[truncated]"));
  expect(frame).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(frame.function))).toBeLessThanOrEqual(f.events[0].limits.field);
  expect(Buffer.byteLength(JSON.stringify(event) + "\n")).toBeLessThanOrEqual(f.events[0].limits.event);
});

it("preserves an earlier preload and records actual Vitest fork workers inheriting isolation", async () => {
  const root = directory(), marker = path.join(root, "worker-"), prior = path.join(root, "prior.cjs");
  writeFileSync(prior, "globalThis.priorPreload = true;");
  const config = path.join(root, "vitest.config.mts");
  const base = pathToFileURL(path.join(packageRoot, "vitest.config.ts")).href;
  writeFileSync(config, `import base from ${JSON.stringify(base)}; export default { ...base, root: ${JSON.stringify(root)}, test: { ...base.test, globalSetup: [], include: ['*.test.mjs'], pool: 'forks', maxWorkers: 2, testTimeout: 5000, hookTimeout: 5000 } };`);
  const vitestImport = pathToFileURL(path.join(packageRoot, "node_modules/vitest/dist/index.js")).href;
  for (const name of ["one", "two"]) writeFileSync(path.join(root, `${name}.test.mjs`), `import { test, expect } from ${JSON.stringify(vitestImport)}; import { writeFileSync } from 'node:fs'; import { kill } from 'node:process'; test('worker ${name}', () => { expect(globalThis.priorPreload).toBe(true); expect(process.env.DAYNIGHT_TEST_ISOLATION).toBeTruthy(); expect(kill(process.pid, 0)).toBe(true); writeFileSync(${JSON.stringify(marker + name)}, String(process.pid)); });`);
  const f = await fixture(`
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, [${JSON.stringify(path.join(packageRoot, "node_modules/vitest/vitest.mjs"))}, 'run', '--config', ${JSON.stringify(config)}], {
  cwd: ${JSON.stringify(packageRoot)}, env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS + ' --require=' + ${JSON.stringify(JSON.stringify(prior))}, NO_COLOR: '1', FORCE_COLOR: '0' }, encoding: 'utf8', timeout: 15000, maxBuffer: 262144
});
save({ status: result.status, error: result.error?.code, stderr: result.stderr, stdout: result.stdout }); process.exitCode = result.status ?? 1;`);
  expect(f.result.exitCode, f.saved?.stderr).toBe(0); expect(f.saved.error).toBeUndefined();
  const pids = ["one", "two"].map(name => Number(readFileSync(marker + name, "utf8")));
  expect(new Set(pids).size).toBe(2);
  for (const pid of pids) {
    expect(f.events.find(event => event.kind === "bootstrap" && event.pid === pid)?.hooks).toMatchObject({ "process.kill": true, "ChildProcess.kill": true });
    expect(f.events.some(event => event.kind === "signal-intent" && event.pid === pid && event.signal.value === 0)).toBe(true);
  }
}, 25_000);

it("does not claim coverage for a descendant that removes the diagnostic preload", async () => {
  const f = await fixture(`
const { spawnSync } = require('node:child_process');
const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid)); process.kill(process.pid, 0)'], { env: { NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 5000 });
save({ status: child.status, pid: Number(child.stdout) });`);
  expect(f.result.exitCode).toBe(0); expect(f.saved.status).toBe(0);
  expect(f.events.some(event => event.pid === f.saved.pid)).toBe(false);
});
