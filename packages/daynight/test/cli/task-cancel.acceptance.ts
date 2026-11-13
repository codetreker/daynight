import type { ChildProcess } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import type { Task, WorkerClaim } from "../../src/api/types.js";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";
import { withTaskObservation } from "../fixtures/task-observation.js";

it("cancels through both installed native launchers and reconciles an unknown result without replay", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const fixture = path.join(receipt.root, ".tmp", "Task cancellation 中文");
  const state = path.join(fixture, "configuration");
  const home = path.join(fixture, "home");
  const temporary = path.join(fixture, "temporary");
  const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
  const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
  const claimId = "dddddddd-4444-4444-8444-444444444444";
  const principal = "cccccccc-3333-4333-8333-333333333333";
  const time = "2026-11-06T00:00:00.123456789Z";
  const cancelledAt = "2026-11-07T00:00:00.987654321Z";
  const original: Task = { type: "task", parentId: null,
    id: taskId, projectId, title: "  Existing <result&> 中文😀  ", description: "# Preserved\n\nTask materials",
    tags: [], properties: { pullRequests: [{ url: "opaque", title: "Existing result" }] }, status: "done", allowAgents: true,
    requiredPlatform: "windows", assignedTo: principal, version: 9_007_199_254_740_993n,
    startedAt: time, completedAt: time, cancelledAt: null, createdAt: time, updatedAt: time,
    dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
  };
  const worker: WorkerClaim = {
    claimId, state: "active", userId: principal, workerId: taskId, machine: { id: claimId, name: "Native fixture" },
    platform: "windows", agent: "codex", agentControlMode: "web", worktreeId: projectId, phase: "executing",
    herdr: null, nativeSessionId: null, claimedAt: time,
  };
  const resourcePath = `/api/v1/projects/${projectId}/tasks/${taskId}`;
  let current = original;
  let mode: "write" | "active" | "unknown" = "write";
  const requests: { method: string; path: string; body: unknown }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    request.on("end", () => {
      const body = chunks.length === 0 ? null : parseApiJson(Buffer.concat(chunks).toString("utf8"));
      requests.push({ method: request.method!, path: request.url!, body });
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Daynight-User-ID", principal);
      if (request.method === "GET" && request.url === `/api/v1/projects/${projectId}`) {
        response.end(stringifyApiJson({ id: projectId, name: "Native cancellation", repoUrl: "https://example.test/cancel.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: claimId, version: 1n }, createdAt: time, updatedAt: time }));
      } else if (request.method === "GET" && request.url === resourcePath) response.end(stringifyApiJson(current));
      else if (request.method === "GET" && request.url === `${resourcePath}?include=session`) response.end(stringifyApiJson(withTaskObservation(current)));
      else if (request.method === "PUT" && request.url === `${resourcePath}/status`) {
        if (mode === "active") {
          response.writeHead(409);
          response.end(stringifyApiJson({ error: { code: "invalid_transition", message: "Release the active worker before cancellation.", requestId: "active-cancel" } }));
          return;
        }
        const input = body as { version: bigint; status: string };
        if (input.version !== current.version || input.status !== "cancelled") {
          response.writeHead(409);
          response.end(stringifyApiJson({ error: { code: "version_conflict", message: "The task version changed.", requestId: "cancel-conflict" } }));
          return;
        }
        if (current.status !== "cancelled") current = { ...current, status: "cancelled", cancelledAt, updatedAt: cancelledAt, version: current.version + 1n, ready: false };
        if (mode === "unknown") response.destroy();
        else response.end(stringifyApiJson(current));
      } else { response.writeHead(404); response.end(stringifyApiJson({ error: { code: "not_found", message: "Unexpected fixture route.", requestId: "cancel-route" } })); }
    });
  });
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, {
    HOME: home, USERPROFILE: home, DN_CONFIG_DIR: state,
    APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(fixture, "config"), XDG_CACHE_HOME: path.join(fixture, "cache"),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(fixture, "git-global"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1",
  });
  const children = new Map<ChildProcess, Promise<unknown>>();
  const invoke = async (launcher: string, args: readonly string[]) => {
    const child = crossSpawn(launcher, ["task", ...args, "--project", projectId], { cwd: path.parse(receipt.root).root, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", launchFailure: unknown;
    child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.once("error", (cause) => { launchFailure = cause; });
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => { children.delete(child); resolve(code); }));
    children.set(child, closed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
      if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Native cancellation launcher exceeded twenty seconds."); }
      if (launchFailure !== undefined) throw launchFailure;
      return { code, stdout, stderr };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const cancel = (version: bigint) => ["set-status", taskId.toUpperCase(), "cancelled", "--if-version", String(version)];
  let failure: unknown;
  try {
    await mkdir(home, { recursive: true }); await mkdir(state, { recursive: true }); await mkdir(temporary, { recursive: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing native cancellation listener.");
    await writeFile(path.join(state, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    const alias = path.join(path.dirname(receipt.launcherPath), process.platform === "win32" ? "dn.cmd" : "dn");
    for (const launcher of [receipt.launcherPath, alias]) {
      mode = "write"; current = original;
      const before = requests.length;
      const result = await invoke(launcher, cancel(original.version));
      expect(result.code, result.stderr).toBe(0); expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Status: cancelled"); expect(result.stdout).toContain(`Cancelled at: ${cancelledAt}`);
      expect(current).toEqual({ ...original, status: "cancelled", cancelledAt, updatedAt: cancelledAt, version: original.version + 1n });
      expect(requests.slice(before).map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
      expect(requests.at(-1)!.body).toEqual({ version: original.version, status: "cancelled" });
      const version = current.version;
      const same = await invoke(launcher, cancel(version));
      expect(same.code, same.stderr).toBe(0); expect(current.version).toBe(version); expect(current.cancelledAt).toBe(cancelledAt);
      const noIo = requests.length;
      const invalid = await invoke(launcher, [...cancel(version), "--claim-id", claimId]);
      expect(invalid.code).toBe(2); expect(requests).toHaveLength(noIo);
      mode = "active";
      current = { ...original, status: "in_progress", completedAt: null, properties: { ...original.properties, worker: { ...worker, state: "active" } } };
      const active = current;
      const rejected = await invoke(launcher, cancel(current.version));
      expect(rejected.code).toBe(1); expect(rejected.stdout).toBe(""); expect(rejected.stderr).toContain("invalid_transition:");
      expect(current).toBe(active);
    }
    for (const launcher of [receipt.launcherPath, alias]) {
      mode = "write";
      current = { ...original, type: "goal", status: "todo", allowAgents: false, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, ready: false, progress: { total: 0, done: 0, cancelled: 0, unfinished: 0 } };
      const before = requests.length;
      const refused = await invoke(launcher, cancel(current.version));
      expect(refused.code).toBe(1); expect(refused.stderr).toContain("automatic claims");
      expect(requests.slice(before).map(({ method }) => method)).toEqual(["GET", "GET"]);
      const accepted = await invoke(launcher, [...cancel(current.version), "--force"]);
      expect(accepted.code, accepted.stderr).toBe(0); expect(accepted.stdout).toContain("Status: cancelled");
      expect(requests.slice(before).map(({ method }) => method)).toEqual(["GET", "GET", "GET", "GET", "PUT"]);
      expect(requests.at(-1)!.body).toEqual({ version: original.version, status: "cancelled" });
    }
    mode = "write";
    current = { ...original, status: "todo", startedAt: null, completedAt: null, cancelledAt: null, ready: true };
    const cancelledUnowned = await invoke(receipt.launcherPath, cancel(current.version));
    expect(cancelledUnowned.code, cancelledUnowned.stderr).toBe(0);
    expect(current).toMatchObject({ status: "cancelled", cancelledAt, properties: original.properties });
    expect(current.properties.worker).toBeUndefined();
    const cancelledRead = await invoke(receipt.launcherPath, ["show", taskId, "--json"]);
    expect(cancelledRead.code, cancelledRead.stderr).toBe(0); expect(parseApiJson(cancelledRead.stdout)).toEqual(withTaskObservation(current));
    mode = "unknown"; current = original;
    const beforeUnknown = requests.length;
    const unknown = await invoke(receipt.launcherPath, cancel(current.version));
    expect(unknown.code).toBe(1); expect(unknown.stdout).toBe(""); expect(unknown.stderr).toContain("outcome is unconfirmed");
    expect(requests.slice(beforeUnknown).filter(({ method }) => method === "PUT")).toHaveLength(1);
    const read = await invoke(receipt.launcherPath, ["show", taskId, "--json"]);
    expect(read.code, read.stderr).toBe(0); expect(parseApiJson(read.stdout)).toEqual(withTaskObservation(current));
    expect(requests.slice(beforeUnknown).map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: `/api/v1/projects/${projectId}` },
      { method: "GET", path: resourcePath },
      { method: "PUT", path: `${resourcePath}/status` },
      { method: "GET", path: `/api/v1/projects/${projectId}` },
      { method: "GET", path: `${resourcePath}?include=session` },
    ]);
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) { try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); } }
  try { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause))); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  try { await lstat(receipt.root); cleanup.push(new Error("Native cancellation fixture retained its runtime directory.")); }
  catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) cleanup.push(cause); }
  if (cleanup.length !== 0) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Native cancellation acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 180_000);
