import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { createOperation, type Operation } from "../../../src/api/operation.js";
import { readCodexConfiguration } from "../../../src/commands/worker/herdr/codex-config.js";

const directories: string[] = [], operations: Operation[] = [];
afterEach(async () => { operations.splice(0).forEach(op => op.dispose()); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const fixture = async (mode?: string, requestMs = 5000) => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/codex-config-tests"); await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(path.join(parent, "test-")); directories.push(cwd);
  const pidPath = path.join(cwd, "pid");
  const operation = createOperation({ limits: { requestMs, totalMs: 15_000 } }); operations.push(operation);
  const options = { args: ["--no-daemon", "resume", "native-id", "--profile=work", "-c", 'shell_environment_policy.set.PATH="/tools"', "--enable", "hooks", "--disable=something", "--no-alt-screen"], cwd, executable: fileURLToPath(new URL("./fixtures/codex-config.mjs", import.meta.url)), environment: { ...process.env, CODEX_CONFIG_TEST_PID: pidPath, ...(mode ? { CODEX_CONFIG_TEST_MODE: mode } : {}) } };
  const stopped = async () => { const pid = Number(await readFile(pidPath, "utf8")); expect(() => process.kill(pid, 0)).toThrow(); };
  return { options, operation, stopped, pidPath };
};

test.skipIf(process.platform === "win32").each([undefined, "ignore-eof"])("reads only configuration with the same cwd and ordered flags, then joins its process (%s)", async mode => {
  const f = await fixture(mode);
  expect(await readCodexConfiguration(f.options, f.operation)).toMatchObject({ config: { shell_environment_policy: { set: { PATH: "/native/bin" } } }, probe: { cwd: f.options.cwd, args: ["--profile=work", "-c", 'shell_environment_policy.set.PATH="/tools"', "--enable", "hooks", "--disable=something", "app-server", "--stdio"], params: { cwd: f.options.cwd, includeLayers: false } } });
  await f.stopped();
}, 15_000);

test.skipIf(process.platform === "win32").each(["unresponsive", "excess", "error"])("fails and joins the configuration process on %s", async mode => {
  const f = await fixture(mode, mode === "unresponsive" ? 2500 : 5000);
  await expect(readCodexConfiguration(f.options, f.operation)).rejects.toThrow();
  await f.stopped();
}, 15_000);

test.skipIf(process.platform === "win32")("cancellation joins the owned configuration process", async () => {
  const f = await fixture("unresponsive");
  const result = readCodexConfiguration(f.options, f.operation);
  const failed = expect(result).rejects.toThrow("selected profile");
  await vi.waitFor(async () => { expect(Number(await readFile(f.pidPath, "utf8"))).toBeGreaterThan(0); }, { timeout: 5000 });
  f.operation.dispose(); await failed; await f.stopped();
}, 15_000);
