import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import Database from "better-sqlite3";
import { parse } from "yaml";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

type Result = { code: number | null; stdout: string; stderr: string };
type Action = { waitFor: string; input: string; write?: { file: string; contents: string } } | { waitFor: string; signal: "SIGTERM" };
const firstId = "a1b2c3d4-1111-4222-8333-123456789abc";
const secondId = "a1b2c3d4-1111-4222-8333-123456789abd";
const inaccessibleId = "a1b2c3d4-1111-4222-8333-123456789abe";
const workerId = "a1b2c3d4-1111-4222-8333-123456789abf";
const timestamp = "2026-10-27T00:00:00Z";
const projects = [
  { id: firstId, name: "First project 中文", repoUrl: "https://github.com/WorkerAcceptance/First.git" },
  { id: secondId, name: "Second project", repoUrl: "https://github.com/WorkerAcceptance/Second.git" },
].map((project) => ({ ...project, settings: { version: 1, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1 }, createdAt: timestamp, updatedAt: timestamp }));
const addPrompt = "Run tasks from which existing Daynight Projects?";
const removePrompt = "Remove which existing Daynight Projects from worker configuration?";
const token = "worker-repository-fixture-credential";
let installed: Awaited<ReturnType<typeof createAcceptanceCli>>;
let sequence = 0;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => { installed = await createAcceptanceCli(); });
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
afterAll(async () => { await installed?.cleanup(); });

const environment = (home: string): NodeJS.ProcessEnv => {
  const result = { ...process.env };
  for (const name of Object.keys(result)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|CODEX_|NODE_OPTIONS$|DAYNIGHT_)/i.test(name)) delete result[name];
  return { ...result, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
};

const capture = async (child: ChildProcess, input?: string): Promise<Result> => {
  let stdout = "", stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  if (input !== undefined) child.stdin!.end(input);
  let launchFailure: Error | undefined;
  child.once("error", (cause) => { launchFailure = cause; });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 15_000); })]);
    if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error(`Worker repository command exceeded fifteen seconds: ${stderr}`); }
    if (launchFailure !== undefined) throw launchFailure;
    return { code, stdout, stderr };
  } finally { if (timer !== undefined) clearTimeout(timer); }
};

const pipe = (args: string[], home: string): Promise<Result> => capture(crossSpawn(installed.receipt.launcherPath, args, {
  cwd: home, env: environment(home), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
}));
const terminal = async (args: string[], home: string, actions: Action[]): Promise<Result> => {
  const result = await capture(spawn("python3", ["-u", path.join(import.meta.dirname, "review-configuration-pty.py")], {
    cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"],
  }), JSON.stringify({ command: [installed.receipt.launcherPath, ...args], cwd: home, environment: environment(home), actions }));
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Result;
};

const fresh = async (runtime = false) => {
  const home = path.join(installed.receipt.root, `worker repositories ${sequence++}`, "home 中文");
  const configuration = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(configuration), { recursive: true });
  const calls: { method: string; path: string; authorization: string | undefined }[] = [];
  const reports: { taskInventory: { claims: unknown[] } | null; assistantHost?: unknown }[] = [];
  let failure = false;
  const cloudDesired = { revision: "1", updatedAt: timestamp, value: { maxConcurrent: 3, pollIntervalMs: 60000, recoveryLimit: 3, native: { agent: "codex", model: null, args: [] }, projects: [] } };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    calls.push({ method: request.method!, path: request.url!, authorization: request.headers.authorization });
    const send = (status: number, value: unknown): void => { response.writeHead(status, { "Content-Type": "application/json", "Daynight-User-ID": firstId }); response.end(JSON.stringify(value)); };
    if (runtime && request.method === "GET" && url.pathname === "/api/v1/me") {
      send(200, { id: firstId, email: null, emailVerified: null, name: "Worker fixture", avatarUrl: null, personalTeam: { id: secondId, kind: "personal", name: null } });
      return;
    }
    if (runtime && request.method === "GET" && url.pathname === `/api/v1/me/workers/${workerId}/configuration`) {
      response.setHeader("Daynight-Worker-Configuration", "1");
      send(200, { desired: cloudDesired, observationRevision: "0", observation: null });
      return;
    }
    if (runtime && request.method === "POST" && url.pathname === `/api/v1/me/workers/${workerId}/report`) {
      response.setHeader("Daynight-Worker-Configuration", "1");
      let body = "";
      request.setEncoding("utf8").on("data", (value: string) => { body += value; });
      request.once("end", () => { reports.push(JSON.parse(body) as (typeof reports)[number]); const now = new Date().toISOString(); send(200, { observedAt: now, lastReportedAt: now, configuration: { desired: cloudDesired, observationRevision: "0", observationAccepted: false } }); });
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/api/v1/projects") {
      send(500, { error: { code: "internal_error", message: "Unexpected non-project request.", requestId: "worker-unexpected-request" } });
      return;
    }
    if (failure) { send(403, { error: { code: "forbidden", message: "Fixture Project access refused.", requestId: "worker-project-refusal" } }); return; }
    const later = url.searchParams.get("cursor") === "second page+/=?";
    send(200, { items: [projects[later ? 1 : 0]], nextCursor: later ? null : "second page+/=?" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((cause) => cause === undefined ? resolve() : reject(cause));
    server.closeAllConnections();
  }));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing worker repository fixture listener.");
  const connection = `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${token}\n`;
  const source = `# Existing shared configuration\n${connection}${runtime ? `workerId: ${workerId}\n` : ""}review:\n  repositories: []\nworker:\n  maxConcurrent: 3\n  agent: codex\n`;
  await writeFile(configuration, source, { mode: 0o600 });
  const decoded = async (): Promise<Record<string, unknown>> => parse(await readFile(configuration, "utf8")) as Record<string, unknown>;
  const unchanged = async (expected = source): Promise<void> => {
    expect(await readFile(configuration, "utf8")).toBe(expected);
    expect(await readdir(home)).toEqual([".daynight"]);
    expect(await readdir(path.dirname(configuration))).toEqual(["config.yml"]);
  };
  return { home, configuration, calls, reports, connection, source, decoded, unchanged, fail: () => { failure = true; } };
};

it("adds, lists and removes existing remote Projects through the installed launcher without starting resources", async () => {
  const f = await fresh();
  const empty = await pipe(["worker", "repo", "list", "--json"], f.home);
  expect(empty.code, empty.stderr).toBe(0);
  expect(JSON.parse(empty.stdout)).toEqual([]);
  expect(f.calls).toEqual([]);
  for (const project of projects) {
    const added = await pipe(["worker", "repo", "add", "--project", project.id], f.home);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toBe("");
    expect(added.stderr).toContain("This local selection is imported when the Worker first connects to cloud management.");
    expect(added.stdout + added.stderr).not.toContain(token);
  }
  const expected = projects.map((project) => ({ projectId: project.id, remote: project.repoUrl, path: path.join(f.home, "daynights", "github.com", "WorkerAcceptance", project.id === firstId ? "First" : "Second") }));
  const listed = await pipe(["worker", "repo", "list", "--json"], f.home);
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.stderr).toBe("");
  expect(JSON.parse(listed.stdout)).toEqual(expected);
  expect(await f.decoded()).toMatchObject({ serverToken: token, review: { repositories: [] }, worker: { agent: "codex", maxConcurrent: 3, repositories: expected } });
  const text = await pipe(["worker", "repo", "list"], f.home);
  expect(text.code, text.stderr).toBe(0);
  expect(text.stdout).toContain(firstId);
  expect(text.stdout).toContain(secondId);
  const beforeNoop = await readFile(f.configuration, "utf8");
  expect((await pipe(["worker", "repo", "add", "--project", firstId], f.home)).code).toBe(0);
  expect(await readFile(f.configuration, "utf8")).toBe(beforeNoop);
  for (const project of projects) expect((await pipe(["worker", "repo", "remove", "--project", project.id], f.home)).code).toBe(0);
  expect(await f.decoded()).toMatchObject({ serverToken: token, review: { repositories: [] }, worker: { agent: "codex", maxConcurrent: 3, repositories: [] } });
  expect((await pipe(["worker", "repo", "list"], f.home)).stdout).toBe("No worker repositories configured.\n");
  expect(await readdir(f.home)).toEqual([".daynight"]);
  expect(await readdir(path.dirname(f.configuration))).toEqual(["config.yml"]);
  expect(f.calls).toHaveLength(10);
  expect(f.calls.every((call) => call.method === "GET" && call.authorization === `Bearer ${token}`)).toBe(true);
  expect(f.calls.filter((call) => new URL(call.path, "http://localhost").searchParams.get("cursor") === "second page+/=?")).toHaveLength(5);
});

it("requires a known accessible Project and rejects raw URLs and path overrides before changing configuration", async () => {
  const f = await fresh();
  for (const operation of ["add", "remove"]) {
    const unavailable = await pipe(["worker", "repo", operation, "--project", inaccessibleId], f.home);
    expect(unavailable.code).toBe(1);
    expect(unavailable.stderr).toContain("does not exist or is not accessible");
    await f.unchanged();
  }
  const beforeInvalid = f.calls.length;
  for (const args of [
    ["worker", "repo", "add", projects[0]!.repoUrl],
    ["worker", "repo", "add", "--project", firstId, "--path", "arbitrary"],
    ["worker", "repo", "remove", "--project", "not-a-uuid"],
  ]) {
    const rejected = await pipe(args, f.home);
    expect(rejected.code).toBe(2);
    expect(rejected.stdout).toBe("");
    await f.unchanged();
  }
  expect(f.calls).toHaveLength(beforeInvalid);
});

it("requires terminal selection for no-argument repository add without creating runtime state", async () => {
  const f = await fresh();
  const result = await pipe(["worker", "repo", "add"], f.home);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("requires terminal input and stderr");
  expect(result.stderr).toContain("worker repo add --project <project-id>");
  await f.unchanged();
  expect(f.calls).toHaveLength(2);
});

it("preserves configuration and reports remote Project failures before explicit repository selection", async () => {
  const f = await fresh();
  f.fail();
  for (const args of [["worker", "repo", "add", "--project", firstId], ["worker", "repo", "add"]]) {
    const result = await pipe(args, f.home);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("forbidden");
    expect(result.stderr).not.toContain(token);
    await f.unchanged();
  }
  expect(f.calls).toHaveLength(2);
});

it.skipIf(process.platform === "win32")("runs a zero-repository installed worker noninteractively, excludes a duplicate runner and stops cleanly", async () => {
  const f = await fresh(true);
  // An empty PATH excludes native providers; the absolute installed Node entry
  // still exercises the packaged command and SQL resources. The Git ceiling
  // prevents the enclosing test checkout from acting as this ordinary cwd's repo.
  const emptyBin = path.join(path.dirname(f.home), "empty-bin");
  await mkdir(emptyBin);
  const env = { ...environment(f.home), PATH: emptyBin, DN_CONFIG_DIR: path.dirname(f.configuration), GIT_CEILING_DIRECTORIES: path.dirname(f.home) };
  const launch = () => {
    const child = spawn(installed.receipt.nodePath, [installed.receipt.entryPath, "worker", "run"], { cwd: f.home, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    const closed = new Promise<Result>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve({ code, stdout, stderr }));
    });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) await terminateInstalledProcess(child, closed); else await closed; });
    return { child, closed, stderr: () => stderr };
  };
  const first = launch();
  await vi.waitFor(() => { expect(first.child.exitCode, first.stderr()).toBeNull(); expect(first.stderr()).toContain("Foreground worker"); }, { timeout: 15_000 });
  await vi.waitFor(() => expect(f.reports.some(report => report.taskInventory?.claims.length === 0)).toBe(true), { timeout: 15_000 });
  const second = launch();
  await vi.waitFor(() => expect(second.child.exitCode, second.stderr()).not.toBeNull(), { timeout: 15_000 });
  const duplicate = await second.closed;
  expect(duplicate.code).toBe(1);
  expect(duplicate.stderr).toContain("instance lock");
  expect(first.child.exitCode).toBeNull();
  first.child.kill("SIGTERM");
  await vi.waitFor(() => expect(first.child.exitCode, first.stderr()).not.toBeNull(), { timeout: 15_000 });
  const stopped = await first.closed;
  expect(stopped.code, stopped.stderr).toBe(0);
  expect(stopped.stdout).toBe("");
  expect(stopped.stderr).not.toContain(addPrompt);
  expect(stopped.stderr).not.toContain(token);
  expect(await readFile(f.configuration, "utf8")).toBe(f.source);
  expect(await readdir(f.home)).toEqual([".daynight"]);
  const db = new Database(path.join(path.dirname(f.configuration), "worker", "state.sqlite"), { readonly: true });
  try {
    expect(db.pragma("user_version", { simple: true })).toBe(11);
    for (const table of ["projects", "tasks", "cleanup_schedules", "bots", "bot_executions"]) expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
  } finally { db.close(); }
  expect(f.calls.every(call => call.path === "/api/v1/me" || call.path === `/api/v1/me/workers/${workerId}/configuration` || call.path === `/api/v1/me/workers/${workerId}/report`)).toBe(true);
  expect(f.reports.every(report => report.assistantHost === undefined)).toBe(true);
});

it.skipIf(process.platform === "win32")("selects and removes multiple Projects with the real terminal checkbox", async () => {
  const f = await fresh();
  const added = await terminal(["worker", "repo", "add"], f.home, [{ waitFor: addPrompt, input: "a\r" }]);
  expect(added.code, added.stderr).toBe(0);
  expect(added.stdout).toBe("");
  const listed = await pipe(["worker", "repo", "list", "--json"], f.home);
  expect((JSON.parse(listed.stdout) as { projectId: string }[]).map(({ projectId }) => projectId)).toEqual([firstId, secondId]);
  const removed = await terminal(["worker", "repo", "remove"], f.home, [{ waitFor: removePrompt, input: "a\r" }]);
  expect(removed.code, removed.stderr).toBe(0);
  expect(removed.stdout).toBe("");
  expect((await f.decoded()).worker).toMatchObject({ maxConcurrent: 3, agent: "codex", repositories: [] });
  expect(await readdir(f.home)).toEqual([".daynight"]);
  expect(await readdir(path.dirname(f.configuration))).toEqual(["config.yml"]);
});

it.skipIf(process.platform === "win32")("cancels the explicit repository Project selector before saving configuration or creating worker resources", async () => {
  const f = await fresh();
  const result = await terminal(["worker", "repo", "add"], f.home, [{ waitFor: addPrompt, signal: "SIGTERM" }]);
  expect(result.code, result.stderr).toBe(1);
  expect(result.stderr).toContain("Worker repository configuration cancelled.");
  expect(result.stdout).toBe("");
  expect(result.stdout + result.stderr).not.toContain(token);
  expect(f.calls).toHaveLength(2);
  await f.unchanged();
});

it.skipIf(process.platform === "win32")("refuses a concurrent worker repository edit without overwriting it", async () => {
  const f = await fresh();
  const concurrent = `${f.connection}worker:\n  maxConcurrent: 9\n  repositories:\n    - projectId: ${secondId}\n      remote: ${projects[1]!.repoUrl}\n      path: ../concurrent-checkout\n`;
  const result = await terminal(["worker", "repo", "add"], f.home, [{ waitFor: addPrompt, write: { file: f.configuration, contents: concurrent }, input: "a\r" }]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("changed while selecting projects");
  expect(result.stdout).toBe("");
  await f.unchanged(concurrent);
});

it.skipIf(process.platform === "win32")("preserves unrelated configuration changes made while selecting a Project", async () => {
  const f = await fresh();
  const concurrent = `# Concurrent independent settings\n${f.connection}review:\n  pollIntervalMs: 1800\nworker:\n  maxConcurrent: 9\n  agent: codex\n`;
  const result = await terminal(["worker", "repo", "add"], f.home, [{ waitFor: addPrompt, write: { file: f.configuration, contents: concurrent }, input: "a\r" }]);
  expect(result.code, result.stderr).toBe(0);
  expect(await f.decoded()).toMatchObject({ serverToken: token, review: { pollIntervalMs: 1800 }, worker: { maxConcurrent: 9, agent: "codex", repositories: projects.map(({ id, repoUrl }) => ({ projectId: id, remote: repoUrl })) } });
  expect(await readdir(f.home)).toEqual([".daynight"]);
  expect(await readdir(path.dirname(f.configuration))).toEqual(["config.yml"]);
});
