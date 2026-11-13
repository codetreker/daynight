import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../../src/api/operation.js";
import { ApiError } from "../../../../src/api/client.js";
import { resolveConfigurationPaths } from "../../../../src/config/paths.js";
import { BotEnvironmentCleanupError, prepareBotEnvironment, prepareBotStateDirectory } from "../../../../src/commands/worker/bots/environment.js";
import { HerdrCommandError, runHerdrCommand, type HerdrCommand } from "../../../../src/commands/worker/herdr/command.js";

import { BotCliProbeCleanupError } from "../../../../src/commands/worker/bots/cli-probe.js";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const serverOrigin = "https://daynight.example";
const token = "fixture-cli-pat";
const roots: string[] = [];
const resources: { release(): Promise<void> }[] = [];
const userResponse = (id = owner, principal = id) => new Response(JSON.stringify({ id, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: other, kind: "personal", name: null } }), { headers: { "content-type": "application/json", "Daynight-User-ID": principal } });
const fixture = async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../../.tmp");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "bot-env-")); roots.push(root);
  const homeDirectory = path.join(root, "home"), cwd = path.join(root, "ordinary-directory"), stateDirectory = path.join(root, "worker-config");
  await Promise.all([mkdir(homeDirectory), mkdir(cwd), mkdir(stateDirectory)]);
  const workerPaths = resolveConfigurationPaths(homeDirectory, path, { DN_CONFIG_DIR: stateDirectory });
  const config = async (extra = "", configuredToken: string | null = token) => writeFile(workerPaths.configFile, `serverUrl: ${serverOrigin}\n${configuredToken === null ? "" : `serverToken: ${configuredToken}\n`}${extra}`);
  await config();
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: homeDirectory, CODEX_HOME: path.join(homeDirectory, "native-codex"), DN_CONFIG_DIR: path.join(root, "wrong-config"), DAYNIGHT_CONTROLLER_TOKEN: "fixture-relay-secret" };
  const options = { homeDirectory, cwd, workerPaths, serverOrigin, ownerUserId: owner, botId: other, environment, signal: new AbortController().signal };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => userResponse());
  const runCommand = vi.fn(async (command: HerdrCommand) => ({ stdout: `Usage: daynight ${command.args.slice(0, -1).join(" ")} [--json]\n`, stderr: "" }));
  return { root, config, options, dependencies: { fetch, runCommand }, fetch, runCommand };
};
afterEach(async () => {
  for (const resource of resources.splice(0)) await resource.release();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Bot CLI environment preparation", () => {
  it("uses the target Worker configuration outside Git and preserves real home and PATH", async () => {
    const f = await fixture();
    const prepared = await prepareBotEnvironment(f.options, f.dependencies); resources.push(prepared);
    expect(prepared.environment).toEqual({ ...f.options.environment, DN_CONFIG_DIR: f.options.workerPaths.stateDirectory, DAYNIGHT_CONTROLLER_TOKEN: undefined, DAYNIGHT_BOT_ID: other, DAYNIGHT_BOT_STATE_DIR: path.join(f.options.workerPaths.stateDirectory, "bots", other, "state") });
    expect(Object.hasOwn(prepared.environment, "DAYNIGHT_CONTROLLER_TOKEN")).toBe(false);
    expect(f.options.environment.DAYNIGHT_CONTROLLER_TOKEN).toBe("fixture-relay-secret");
    expect(f.options.environment.DN_CONFIG_DIR).not.toBe(prepared.environment.DN_CONFIG_DIR);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(String(f.fetch.mock.calls[0]![0])).toBe(`${serverOrigin}/api/v1/me`);
    expect(new Headers(f.fetch.mock.calls[0]![1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(f.runCommand.mock.calls.map(([command]) => command.args)).toEqual([
      ["project", "list", "--help"], ["project", "show", "--help"],
      ["task", "list", "--help"], ["task", "show", "--help"],
      ["bot", "list", "--help"], ["bot", "show", "--help"],
      ["worker", "list", "--help"], ["worker", "show", "--help"],
    ]);
    expect(f.runCommand.mock.calls.every(([command]) => command.cwd === f.options.cwd && command.environment === prepared.environment)).toBe(true);
    expect(JSON.stringify(prepared)).not.toContain(token);
    expect(prepared.aliasDirectory).toBeNull();
  });

  it("rejects a different server before authenticating or executing a child", async () => {
    const f = await fixture();
    await expect(prepareBotEnvironment({ ...f.options, serverOrigin: "https://other.example" }, f.dependencies)).rejects.toThrow(/server/);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("keeps private claim state across preparations and alias release", async () => {
    const f = await fixture();
    f.options.environment.DAYNIGHT_BOT_ID = owner;
    f.options.environment.DAYNIGHT_BOT_STATE_DIR = path.join(f.root, "wrong-bot");
    const prepared = await prepareBotEnvironment(f.options, f.dependencies); resources.push(prepared);
    const directory = prepared.environment.DAYNIGHT_BOT_STATE_DIR!;
    expect(prepared.environment.DAYNIGHT_BOT_ID).toBe(other);
    expect(directory).toBe(path.join(f.options.workerPaths.stateDirectory, "bots", other, "state"));
    if (process.platform !== "win32") expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const retained = path.join(directory, "claim-fixture.json");
    await writeFile(retained, "retained claim", { mode: 0o600 });
    await prepared.release();
    expect(await prepareBotStateDirectory(f.options.workerPaths, other)).toBe(directory);
    expect(await readFile(retained, "utf8")).toBe("retained claim");
    const second = await prepareBotStateDirectory(f.options.workerPaths, owner);
    expect(second).not.toBe(directory);
    expect(await readdir(second)).toEqual([]);
  });

  it.each(["../outside", "00000000-0000-0000-0000-000000000000", "11111111-1111-4111-8111-11111111111A"])("rejects invalid Bot identity %s before preparing a child", async botId => {
    const f = await fixture();
    await expect(prepareBotEnvironment({ ...f.options, botId }, f.dependencies)).rejects.toThrow(/Bot ID/);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.runCommand).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("rejects a linked Bot state path without changing its target", async () => {
    const f = await fixture(), outside = path.join(f.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    const botRoot = path.join(f.options.workerPaths.stateDirectory, "bots", other);
    await mkdir(botRoot, { recursive: true, mode: 0o700 });
    await symlink(outside, path.join(botRoot, "state"));
    await expect(prepareBotEnvironment(f.options, f.dependencies)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    expect(f.runCommand).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("rejects nonprivate existing state without silently changing permissions", async () => {
    const f = await fixture();
    const directory = await prepareBotStateDirectory(f.options.workerPaths, other);
    await chmod(directory, 0o755);
    await expect(prepareBotEnvironment(f.options, f.dependencies)).rejects.toThrow(/private/);
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("requires paths derived from the target Worker configuration root", async () => {
    const f = await fixture();
    await expect(prepareBotEnvironment({ ...f.options, workerPaths: { ...f.options.workerPaths, configFile: path.join(f.root, "elsewhere.yml") } }, f.dependencies)).rejects.toThrow(/configuration paths/);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([[other, other], [owner, other]])("rejects owner or authenticated-principal mismatch (%s, %s)", async (id, principal) => {
    const f = await fixture(); f.fetch.mockImplementation(async () => userResponse(id, principal));
    await expect(prepareBotEnvironment(f.options, f.dependencies)).rejects.toBeInstanceOf(ApiError);
    expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("never substitutes the relay token when the CLI PAT is missing", async () => {
    const f = await fixture(); await f.config("", null);
    await expect(prepareBotEnvironment(f.options, f.dependencies)).rejects.toThrow(/daynight login/);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.runCommand).not.toHaveBeenCalled();
  });

  it.each([401, 403])("retains HTTP %s when normal CLI authentication is rejected", async status => {
    const f = await fixture();
    f.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: { code: status === 401 ? "unauthenticated" : "forbidden", message: "Credential rejected.", requestId: "fixture-request" } }), { status, headers: { "content-type": "application/json" } }));
    await expect(prepareBotEnvironment(f.options, f.dependencies)).rejects.toMatchObject({ status });
    expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("rejects an old executable that omits remote Worker query capability", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async command => command.args[0] === "worker" ? { stdout: "Usage: daynight worker <command>\n", stderr: "" } : original(command));
    await expect(prepareBotEnvironment(f.options, f.dependencies)).rejects.toThrow(/worker list/);
  });

  it("does not expose child stderr through failure causes", async () => {
    const f = await fixture();
    f.runCommand.mockRejectedValue(new HerdrCommandError("private-secret-in-message", 1, null, "private-secret-in-stderr"));
    try { await prepareBotEnvironment(f.options, f.dependencies); throw new Error("Expected refusal"); }
    catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("CLI capability");
      expect(String(error)).not.toContain("private-secret");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("detects a changed CLI configuration before returning launch permission", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async command => { await f.config("", "replacement-pat"); return original(command); });
    await expect(prepareBotEnvironment(f.options, f.dependencies)).rejects.toThrow(/configuration changed/);
  });

  it("honors cancellation before reading credentials or running commands", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort(new Error("cancelled-before-start"));
    await expect(prepareBotEnvironment({ ...f.options, signal: controller.signal }, f.dependencies)).rejects.toThrow(/cancel/);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("executes current packaged CLI help in a real child without a Git repository", async () => {
    const f = await fixture();
    const main = path.resolve(import.meta.dirname, "../../../../dist/main.js");
    const prepared = await prepareBotEnvironment(f.options, {
      fetch: f.fetch,
      runCommand: (command, operation) => runHerdrCommand({ ...command, file: process.execPath, args: [main, ...command.args] }, operation),
    }); resources.push(prepared);
    expect(prepared.environment.HOME).toBe(f.options.homeDirectory);
    await expect(stat(path.join(f.options.cwd, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it.skipIf(process.platform === "win32")("uses configured aliases, owns their lifetime, and cleans failed preparations", async () => {
    const f = await fixture();
    const executable = path.join(f.root, "alternate-daynight");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve(import.meta.dirname, "../../../../dist/main.js"))} "$@"\n`, { mode: 0o700 });
    await f.config(`agentCliAliases:\n  daynight: ${JSON.stringify(executable)}\n`);
    const prepared = await prepareBotEnvironment(f.options, { fetch: f.fetch }); resources.push(prepared);
    expect(prepared.bindings[0]?.target).toBe(executable);
    expect(prepared.environment.PATH).toBe(`${prepared.aliasDirectory}${path.delimiter}${f.options.environment.PATH}`);
    expect((await stat(prepared.aliasDirectory!)).isDirectory()).toBe(true);
    await prepared.release(); await prepared.release();
    await expect(stat(prepared.aliasDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
    f.runCommand.mockRejectedValue(new Error("missing executable"));
    await expect(prepareBotEnvironment(f.options, f.dependencies)).rejects.toThrow(/CLI capability/);
    expect(await readdir(path.join(f.options.workerPaths.stateDirectory, "agent-cli-aliases"))).toEqual([]);
  }, 30_000);

  it("joins a cancelled CLI probe and propagates cancellation", async () => {
    const f = await fixture(); const controller = new AbortController();
    const pending = prepareBotEnvironment({ ...f.options, signal: controller.signal }, {
      fetch: f.fetch,
      runCommand: (command, operation) => {
        setTimeout(() => controller.abort(new Error("cancelled-probe")), 30);
        return runHerdrCommand({ ...command, file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, operation);
      },
    });
    await expect(pending).rejects.toThrow(/cancel/);
  });

  it("bounds a hanging CLI probe and rejects its capability", async () => {
    const f = await fixture();
    await expect(prepareBotEnvironment(f.options, {
      fetch: f.fetch,
      runCommand: async command => {
        const operation = createOperation({ limits: { totalMs: 2000, requestMs: 30 } });
        try { return await runHerdrCommand({ ...command, file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, operation); }
        finally { operation.dispose(); }
      },
    })).rejects.toThrow(/CLI capability/);
  });

  it.skipIf(process.platform === "win32")("retains aliases when child cleanup is unconfirmed without leaking child output", async () => {
    const f = await fixture();
    await f.config(`agentCliAliases:\n  daynight: ${JSON.stringify(process.execPath)}\n`);
    const ownership = { launchId: owner, pid: null, process: null, jobObjectName: null, targetStarted: true };
    const retry = vi.fn(async () => {});
    const probeFailure = new BotCliProbeCleanupError(ownership, retry);
    retry.mockRejectedValueOnce(probeFailure);
    f.runCommand.mockRejectedValue(probeFailure);
    try { await prepareBotEnvironment(f.options, f.dependencies); throw new Error("Expected refusal"); }
    catch (error) {
      expect(error).toBeInstanceOf(BotEnvironmentCleanupError);
      const failure = error as BotEnvironmentCleanupError;
      expect(failure.ownership).toBe(ownership);
      const directory = failure.aliasDirectory!;
      expect((await stat(directory)).isDirectory()).toBe(true);
      expect(failure.cause).toBeUndefined();
      await expect(failure.retryCleanup()).rejects.toBe(probeFailure);
      expect((await stat(directory)).isDirectory()).toBe(true);
      await failure.retryCleanup();
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });


  it("keeps malformed configuration scalars out of diagnostics and nested causes", async () => {
    const f = await fixture();
    await writeFile(f.options.workerPaths.configFile, "serverToken: [private-config-secret");
    try { await prepareBotEnvironment(f.options, f.dependencies); throw new Error("Expected refusal"); }
    catch (error) {
      expect(inspect(error, { depth: 20 })).not.toContain("private-config-secret");
      expect(String(error)).toMatch(/configuration|YAML/);
    }
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("preserves authentication status without server-controlled error content", async () => {
    const f = await fixture();
    f.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: {
      code: "unauthenticated", message: "private-api-secret", requestId: "private-api-secret",
    } }), { status: 401, headers: { "content-type": "application/json" } }));
    try { await prepareBotEnvironment(f.options, f.dependencies); throw new Error("Expected refusal"); }
    catch (error) {
      expect(error).toMatchObject({ status: 401 });
      expect(inspect(error, { depth: 20 })).not.toContain("private-api-secret");
      expect(String(error)).toContain("daynight login");
    }
  });

  it.skipIf(process.platform === "win32")("stops ignored-stdio descendants before rejecting unsupported CLI help", async () => {
    const f = await fixture(); const pidFile = path.join(f.root, "descendants");
    const executable = path.join(f.root, "wrapper.cjs");
    await writeFile(executable, `#!${process.execPath}\nconst child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'}); require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, String(child.pid)+'\\n'); child.unref(); console.log('Unsupported CLI');\n`, { mode: 0o700 });
    await f.config(`agentCliAliases:\n  daynight: ${JSON.stringify(executable)}\n`);
    const readPids = async () => (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
    const live = async (pid: number) => {
      try { return !(await promisify(execFile)("ps", ["-p", String(pid), "-o", "stat="])).stdout.trim().startsWith("Z"); }
      catch { return false; }
    };
    try {
      await expect(prepareBotEnvironment(f.options, { fetch: f.fetch })).rejects.toThrow(/advertise/);
      const pids = await readPids(); expect(pids.length).toBeGreaterThan(0);
      expect(await Promise.all(pids.map(live))).toEqual(pids.map(() => false));
      expect(await readdir(path.join(f.options.workerPaths.stateDirectory, "agent-cli-aliases"))).toEqual([]);
    } finally {
      for (const pid of await readPids().catch(() => [])) if (await live(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  }, 30_000);

});
