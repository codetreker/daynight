import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crossSpawn from "cross-spawn";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import type { Project, Task, WorkerClaim } from "../../src/api/types.js";
import { createInstalledCli, terminateInstalledProcess } from "../fixtures/installed-cli.js";

const workspace = path.resolve(import.meta.dirname, "../../../..");
const id = "a1b2c3d4-1111-4222-8333-123456789abc";
const alternateId = "a1b2c3d4-1111-4222-8333-123456789abd";
const unrelatedId = "a1b2c3d4-1111-4222-8333-123456789abe";
const taskId = "b1b2c3d4-1111-4222-8333-123456789abc";
const ordinaryId = "c1b2c3d4-1111-4222-8333-123456789abc";
const externalId = "d1b2c3d4-1111-4222-8333-123456789abc";
const claimId = "e1b2c3d4-1111-4222-8333-123456789abc";
const time = "2026-10-20T00:00:00.123456789Z";
const workerClaim: WorkerClaim = { claimId, state: "active", userId: alternateId, workerId: unrelatedId, machine: { id: alternateId, name: "Worker machine" }, platform: "linux", agent: "codex", worktreeId: ordinaryId, phase: "executing", herdr: { session: "w", workspaceId: "original-workspace", paneId: "original-pane" }, nativeSessionId: "original-native-session", claimedAt: time };
const project = (projectId = id, repoUrl = "git@git.example:Org/Repo.git"): Project => ({ id: projectId, name: "Project 中文", repoUrl, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time });
const task = (projectId = id): Task => ({ id: taskId, projectId, title: "Task 中文", description: "", properties: { worker: null, pullRequests: [] }, status: "todo", allowAgents: false, requiredPlatform: null, version: 1n, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
const taskListItem = (value: Task): Omit<Task, "description"> => ({
  id: value.id, projectId: value.projectId, title: value.title, properties: value.properties,
  status: value.status, allowAgents: value.allowAgents, requiredPlatform: value.requiredPlatform, version: value.version, startedAt: value.startedAt, completedAt: value.completedAt, createdAt: value.createdAt, updatedAt: value.updatedAt,
  dependsOn: value.dependsOn, externalDependsOn: value.externalDependsOn, blockedBy: value.blockedBy, ready: value.ready,
});
const send = (response: ServerResponse, value: unknown, status = 200): void => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(stringifyApiJson(value)); };
const fault = (response: ServerResponse, code: string, requestId: string, status: number, details?: unknown): void => send(response, { error: { code, message: "Native acceptance refusal.", requestId, ...(details === undefined ? {} : { details }) } }, status);
type Result = { code: number | null; stdout: string; stderr: string };
type RequestRecord = { method: string; path: string; body: unknown };
type Transport = "launcher" | "node-entry";

it("runs the actual installed launcher through native project/task discovery, persistence and failure lifecycles", async () => {
  const evidencePath = path.join(workspace, ".tmp/project-task-evidence.json");
  await rm(evidencePath, { force: true });
  const installed = await createInstalledCli();
  const { receipt } = installed;
  const scenarios: string[] = [];
  const requests: RequestRecord[] = [];
  const servers: Server[] = [];
  const children = new Map<ChildProcess, Promise<unknown>>();
  let failure: unknown;
  const home = path.join(receipt.root, "home");
  const state = path.join(home, ".daynight");
  const outside = path.join(receipt.root, "outside Git");
  const repository = path.join(receipt.root, "repository 中文");
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(receipt.root, "git-global"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  let projects = [project(unrelatedId, "https://other.example/Unrelated/Repo"), project()];
  let properties: Task["properties"] = { worker: null, pullRequests: [] };
  let description = "";
  let allowAgents = false;
  let requiredPlatform: Task["requiredPlatform"] = null;
  let dependencies: Pick<Task, "dependsOn" | "externalDependsOn"> = { dependsOn: [], externalDependsOn: [] };
  let broken: "none" | "page" | "json" | "dependency" | "write" | "hold" | "conflict" | "forbidden" = "none";
  let readyPage: { items: readonly Task[]; nextCursor: string | null } | undefined;
  let listResponseTask: Task | undefined;
  let received: (() => void) | undefined;
  const configure = async (serverUrl: string): Promise<void> => { await mkdir(state, { recursive: true }); await writeFile(path.join(state, "config.yml"), `serverUrl: ${serverUrl}\nserverToken: fixture-token\nrepositories: invalid-for-review\n`); };
  const listen = async (): Promise<string> => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      request.on("end", () => {
        const url = new URL(request.url!, "http://localhost");
        const body = chunks.length === 0 ? null : parseApiJson(Buffer.concat(chunks).toString("utf8"));
        requests.push({ method: request.method!, path: `${url.pathname}${url.search}`, body });
        const parts = url.pathname.split("/");
        const projectId = parts[4]!;
        if (url.pathname === "/api/v1/projects") {
          if (request.method === "POST") { send(response, { ...project(), ...(body as { name: string; repoUrl: string }) }, 201); return; }
          if (broken === "page" && url.searchParams.has("cursor")) { fault(response, "internal_error", "native-later-page", 500); return; }
          const remaining = url.searchParams.has("cursor") ? projects.slice(1) : projects.slice(0, 1);
          send(response, { items: remaining, nextCursor: !url.searchParams.has("cursor") && projects.length > 1 ? "native page+/=?" : null }); return;
        }
        if (parts.length === 5) {
          const found = projects.find((item) => item.id === projectId);
          if (found === undefined) fault(response, "not_found", "native-project-missing", 404); else send(response, found);
          return;
        }
        if (broken === "json") { response.writeHead(200, { "Content-Type": "application/json" }); response.end("{"); return; }
        if (request.method !== "GET") {
          if (broken === "write") { response.socket!.destroy(); return; }
          if (broken === "hold") { response.writeHead(201, { "Content-Type": "application/json" }); response.write('{"id":'); received?.(); return; }
          if (broken === "conflict") { fault(response, "version_conflict", "native-version-conflict", 409); return; }
          if (broken === "forbidden") { fault(response, "forbidden", "native-worker-owner-refusal", 403); return; }
          if (broken === "dependency") { fault(response, "dependency_unsatisfied", "native-dependency-refusal", 409, { taskIds: [taskId] }); return; }
          if (parts.length === 8) {
            const input = body as { status: Task["status"]; version: bigint; claimId?: string };
            const status = input.status;
            if (input.claimId !== undefined) {
              const worker = properties.worker;
              if (worker === null || worker.claimId !== input.claimId) { fault(response, "claim_conflict", "native-worker-claim-refusal", 409); return; }
              const sameState = worker.state === "completed";
              properties = { ...properties, worker: { ...worker, state: "completed" } };
              send(response, { ...task(projectId), ...dependencies, description, properties, allowAgents, requiredPlatform, status: "done", ready: false, startedAt: time, completedAt: time, version: input.version + (sameState ? 0n : 1n) }); return;
            }
            send(response, { ...task(projectId), ...dependencies, description, properties, allowAgents, requiredPlatform, status, ready: status === "todo", version: input.version + 1n }); return;
          }
          if (request.method === "PATCH" && typeof body === "object" && body !== null && "allowAgents" in body && typeof body.allowAgents === "boolean") allowAgents = body.allowAgents;
          if (request.method === "POST") requiredPlatform = null;
          if (typeof body === "object" && body !== null && "requiredPlatform" in body) requiredPlatform = body.requiredPlatform as Task["requiredPlatform"];
          if (typeof body === "object" && body !== null && "description" in body && typeof body.description === "string") description = body.description;
          if (request.method === "POST") dependencies = { dependsOn: [], externalDependsOn: [] };
          const dependencyFields = body as Partial<Pick<Task, "dependsOn" | "externalDependsOn">>;
          dependencies = { ...dependencies, ...(dependencyFields.dependsOn === undefined ? {} : { dependsOn: dependencyFields.dependsOn }), ...(dependencyFields.externalDependsOn === undefined ? {} : { externalDependsOn: dependencyFields.externalDependsOn }) };
          send(response, { ...task(projectId), ...dependencies, description, requiredPlatform, ...(request.method === "PATCH" ? { allowAgents } : {}), ...(body as object), ...((body as { properties?: unknown }).properties === undefined ? {} : { properties: { ...(body as { properties: object }).properties, worker: null } }), ...(request.method === "POST" ? { status: "todo", ready: true } : {}), version: request.method === "PATCH" ? 9_007_199_254_740_994n : 1n }, request.method === "POST" ? 201 : 200); return;
        }
        if (parts[5] === "task-graph") { send(response, { observedAt: time, project: project(projectId), summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 }, tasks: [] }); return; }
        if (parts.length === 7) {
          const status = properties.worker?.state === "active" ? "in_progress" : properties.worker?.state === "completed" ? "done" : "todo";
          send(response, { ...task(projectId), ...dependencies, description, properties, allowAgents, requiredPlatform, status, ready: status === "todo", ...(properties.worker === null ? {} : { startedAt: time, completedAt: status === "done" ? time : null }), version: 9_007_199_254_740_993n }); return;
        }
        if (readyPage !== undefined && url.searchParams.get("ready") === "true") { send(response, readyPage); return; }
        if (broken === "page" && url.searchParams.has("cursor")) { fault(response, "internal_error", "native-later-page", 500); return; }
        send(response, { items: [listResponseTask ?? { ...task(projectId), ...dependencies, properties, allowAgents, requiredPlatform }], nextCursor: broken === "page" ? "native later page" : null });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing native acceptance listener.");
    return `http://127.0.0.1:${address.port}`;
  };
  const start = (args: readonly string[], cwd = outside, isolated = false, transport: Transport = "launcher") => {
    const command = transport === "launcher" ? receipt.launcherPath : receipt.nodePath;
    const commandArguments = transport === "launcher" ? [...args] : [receipt.entryPath, ...args];
    const child = crossSpawn(command, commandArguments, { cwd, env: { ...environment, ...(isolated ? { NODE_OPTIONS: `--import=${pathToFileURL(path.join(receipt.root, "isolation.mjs")).href}` } : {}) }, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", problem: Error | undefined;
    child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (value: string) => { stdout += value; }); child.stderr!.on("data", (value: string) => { stderr += value; });
    child.once("error", (cause) => { problem = cause; });
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => { children.delete(child); resolve(code); }));
    children.set(child, closed);
    const result = (async (): Promise<Result> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([closed.then((code) => ({ code })), new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === "timeout") {
        const timeout = new Error(`Installed task command exceeded 20 seconds: ${args[0]} ${args[1]}`);
        try { await terminateInstalledProcess(child, closed); }
        catch (cleanupError) { throw new AggregateError([timeout, cleanupError], "Installed command and cleanup failed."); }
        throw timeout;
      }
      if (problem !== undefined) throw problem;
      return { code: outcome.code, stdout, stderr };
    })();
    return { child, result };
  };
  const invoke = async (args: readonly string[], cwd = outside, expected = 0, isolated = false, transport: Transport = "launcher"): Promise<Result> => {
    const result = await start(args, cwd, isolated, transport).result;
    expect(result.code, result.stderr).toBe(expected);
    if (expected !== 0) expect(result.stdout).toBe("");
    return result;
  };
  const git = (cwd: string, args: readonly string[], input?: string): string => execFileSync("git", ["-C", cwd, ...args], { env: environment, encoding: "utf8", timeout: 20_000, stdio: ["pipe", "pipe", "pipe"], ...(input === undefined ? {} : { input }) }).trim();
  const initialize = async (location: string): Promise<void> => {
    await mkdir(location, { recursive: true }); git(location, ["init", "--initial-branch=main"]);
    git(location, ["config", "url.https://git.example/.insteadOf", "fixture:"]); git(location, ["remote", "add", "origin", "fixture:Org/Repo.git"]);
  };
  const binding = (location: string): string => path.join(location, ".daynight/project.yml");
  const readBinding = async (location: string): Promise<{ projectId: string; serverUrl: string; repoIdentity: string }> => parse(await readFile(binding(location), "utf8")) as { projectId: string; serverUrl: string; repoIdentity: string };
  const mutations = (): number => requests.filter(({ method }) => method !== "GET").length;
  try {
    await mkdir(outside); await mkdir(home);
    await writeFile(path.join(receipt.root, "isolation.mjs"), `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,nextResolve){const result=nextResolve(specifier,context);if(['/repository/git.js','/repository/binding.js','/repository/context.js','/commands/review/runtime.js','better-sqlite3','node:child_process'].some(value=>specifier.includes(value)||result.url.includes(value)))throw new Error('Unexpected business import: '+specifier);return result;}});`);
    expect((await invoke(["task", "--help"], outside, 0, true)).stdout).toContain("Usage: daynight task");
    expect((await invoke(["task", "set-status", "--help"], outside, 0, true)).stdout).toContain("--claim-id <claim-id>");
    await invoke(["task", "set-status", taskId, "done", "--if-version", "9223372036854775808"], outside, 2, true);
    for (const args of [
      ["create", "--title", "Title", "--pull-request-url="],
      ["update", taskId, "--pull-request-title="],
      ["update", taskId, "--pull-request-url=", "--clear-pull-requests"],
      ["update", taskId, "--pull-request-title=", "--clear-pull-requests"],
      ["update", taskId, "--status", "done"],
      ["create", "--title", "Title", "--allow-agents", "true"],
      ["update", taskId, "--allow-agents", "yes"],
      ["set-status", taskId, "todo", "--claim-id", claimId],
      ["set-status", taskId, "done", "--claim-id=invalid"],
      ["set-status", taskId, "done", "--claim-id", claimId, `--claim-id=${claimId}`],
      ["ready", "--allow-agents=TRUE"],
      ["create", "--title", "Title", "--required-platform", "darwin"],
      ["update", taskId, "--required-platform", "linux", "--clear-required-platform"],
      ["list", "--compatible-platform", "any"],
      ...["approve", "unapprove", "claim", "complete"].flatMap((action) => [[action, "invalid"], [action, taskId, "--if-version=0"], [action, taskId, "--status=todo"]]),
    ]) await invoke(["task", ...args], outside, 2, true);

    await invoke(["task", "ready", "--limit", "101"], outside, 2, true);
    expect(await readdir(home)).toEqual([]); scenarios.push("installed-launcher-help-and-usage-before-config");
    const firstUrl = await listen(); const secondUrl = await listen(); await configure(firstUrl);
    const explicit = ["--project", id];
    const listed = await invoke(["project", "list", "--json"], outside, 0, true);
    expect(parseApiJson(listed.stdout)).toEqual(projects);
    const existingProject = await invoke(["project", "create", "Different name", "--repo", project().repoUrl], outside, 0, true);
    expect(existingProject.stdout).toContain("Project already exists.");
    const createdProject = await invoke(["project", "create", "Native 名称", "--repo", "https://git.example/Native/New.git"], outside, 0, true);
    expect(createdProject.stdout).toContain("Project created.");
    expect(requests.at(-1)!.body).toEqual({ name: "Native 名称", repoUrl: "https://git.example/Native/New.git" });
    expect(parseApiJson((await invoke(["project", "show", id, "--json"], outside, 0, true)).stdout)).toEqual(project());
    expect(parseApiJson((await invoke(["task", "show", taskId, "--json", ...explicit], outside, 0, true)).stdout)).toEqual({ ...task(), version: 9_007_199_254_740_993n });
    const createdTask = await invoke(["task", "create", "--title", "Native task", ...explicit], outside, 0, true);
    expect(createdTask.stdout).toContain("Status: todo");
    expect(createdTask.stdout).toContain("Automatic execution: false");
    for (const status of ["todo", "in_progress", "done"] as const) {
      for (const explicitVersion of [false, true]) {
        const before = requests.length;
        const result = await invoke(["task", "set-status", taskId.toUpperCase(), status, ...(explicitVersion ? ["--if-version", "9007199254740993"] : []), ...explicit], outside, 0, true);
        expect(result.stdout).toContain(`Status: ${status}`);
        expect(result.stdout).toContain("Version: 9007199254740994");
        expect(requests.slice(before).map(({ method, path: pathname }) => `${method} ${pathname}`)).toEqual([`GET /api/v1/projects/${id}`, ...(explicitVersion ? [] : [`GET /api/v1/projects/${id}/tasks/${taskId}`]), `PUT /api/v1/projects/${id}/tasks/${taskId}/status`]);
        expect(requests.at(-1)!.body).toEqual({ version: 9_007_199_254_740_993n, status });
      }
    }
    scenarios.push("installed-set-status-observed-and-explicit-lossless-versions");
    const workerProperties = { worker: workerClaim, pullRequests: [{ url: "opaque\0delivery", title: "Worker evidence" }] };
    for (const explicitVersion of [false, true]) {
      properties = workerProperties;
      const before = requests.length;
      const result = await invoke(["task", "set-status", taskId.toUpperCase(), "done", "--claim-id", claimId.toUpperCase(), ...(explicitVersion ? ["--if-version", "9007199254740993"] : []), ...explicit], outside, 0, true);
      expect(result.stdout).toContain("Status: done");
      expect(result.stdout).toContain("Version: 9007199254740994");
      expect(requests.slice(before).map(({ method, path: pathname }) => `${method} ${pathname}`)).toEqual([`GET /api/v1/projects/${id}`, ...(explicitVersion ? [] : [`GET /api/v1/projects/${id}/tasks/${taskId}`]), `PUT /api/v1/projects/${id}/tasks/${taskId}/status`]);
      expect(requests.at(-1)!.body).toEqual({ version: 9_007_199_254_740_993n, claimId, status: "done" });
      expect(parseApiJson((await invoke(["task", "show", taskId, "--json", ...explicit], outside, 0, true)).stdout)).toMatchObject({ status: "done", properties: { ...workerProperties, worker: { ...workerClaim, state: "completed" } } });
    }
    const noopBefore = requests.length;
    expect((await invoke(["task", "set-status", taskId, "done", `--claim-id=${claimId}`, "--if-version", "9223372036854775807", ...explicit], outside, 0, true)).stdout).toContain("Version: 9223372036854775807");
    expect(requests.slice(noopBefore).map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(requests.at(-1)!.body).toEqual({ version: 9_223_372_036_854_775_807n, claimId, status: "done" });
    properties = workerProperties;
    for (const refusal of [
      { mode: "none", inputClaimId: ordinaryId, code: "claim_conflict" },
      { mode: "forbidden", inputClaimId: claimId, code: "forbidden" },
      { mode: "conflict", inputClaimId: claimId, code: "version_conflict" },
      { mode: "write", inputClaimId: claimId, code: "unconfirmed" },
    ] as const) {
      broken = refusal.mode;
      const before = requests.length;
      const result = await invoke(["task", "set-status", taskId, "done", "--claim-id", refusal.inputClaimId, "--if-version", "9007199254740993", ...explicit], outside, 1, true);
      expect(result.stderr).toContain("worker.complete");
      expect(result.stderr).toContain(refusal.code);
      expect(requests.slice(before).map(({ method }) => method)).toEqual(["GET", "PUT"]);
    }
    broken = "none";
    properties = { worker: null, pullRequests: [] };
    scenarios.push("installed-explicit-worker-claim-completion-history-noop-refusals-and-unknown-write");
    for (const permission of [true, false]) {
      const before = requests.length;
      const changed = await invoke(["task", "update", taskId, "--allow-agents", String(permission), "--if-version", "9223372036854775807", ...explicit], outside, 0, true);
      expect(changed.stdout).toContain(`Automatic execution: ${permission}`);
      expect(requests.slice(before).map(({ method }) => method)).toEqual(["GET", "PATCH"]);
      expect(requests.at(-1)!.body).toEqual({ version: 9_223_372_036_854_775_807n, allowAgents: permission });
      expect(parseApiJson((await invoke(["task", "list", "--allow-agents", String(permission), "--ready", "--json", ...explicit], outside, 0, true)).stdout)).toEqual([taskListItem({ ...task(), allowAgents: permission })]);
      expect(new URL(requests.at(-1)!.path, firstUrl).searchParams.get("allowAgents")).toBe(String(permission));
      readyPage = { items: [{ ...task(), allowAgents: permission }], nextCursor: "unfollowed permission page" };
      const readyBefore = requests.length;
      expect(parseApiJson((await invoke(["task", "ready", "--allow-agents", String(permission), "--limit", "1", "--json", ...explicit], outside, 0, true)).stdout)).toEqual(readyPage.items);
      expect(requests.slice(readyBefore).length).toBe(2);
      expect(new URL(requests.at(-1)!.path, firstUrl).searchParams.get("allowAgents")).toBe(String(permission));
      readyPage = undefined;
    }
    scenarios.push("installed-automatic-permission-true-false-exact-version-filtered-list-and-bounded-ready");
    const beforeRemoved = requests.length;
    await invoke(["task", "list", "--status", "proposed", "--json", ...explicit], outside, 2, true);
    await invoke(["task", "set-status", taskId, "proposed", ...explicit], outside, 2, true);
    for (const action of ["approve", "unapprove", "claim", "complete"]) await invoke(["task", action, taskId, ...explicit], outside, 2, true);
    expect(requests).toHaveLength(beforeRemoved);
    scenarios.push("installed-removed-status-and-actions-rejected-before-io");
    for (const platform of ["windows", "linux", "macos"] as const) {
      const created = await invoke(["task", "create", "--title", "Native platform", "--required-platform", platform, ...explicit], outside, 0, true);
      expect(created.stdout).toContain(`Required platform: ${platform}`);
      expect(requests.at(-1)!.body).toEqual({ title: "Native platform", requiredPlatform: platform });
      const statusAt = requests.length;
      expect((await invoke(["task", "set-status", taskId, "todo", "--if-version", "9007199254740993", ...explicit], outside, 0, true)).stdout).toContain(`Required platform: ${platform}`);
      expect(requests.slice(statusAt).map(({ method }) => method)).toEqual(["GET", "PUT"]);
      expect(requests.at(-1)!.body).toEqual({ version: 9_007_199_254_740_993n, status: "todo" });
      const changed = await invoke(["task", "update", taskId, "--required-platform", platform, "--if-version", "9223372036854775807", ...explicit], outside, 0, true);
      expect(changed.stdout).toContain(`Required platform: ${platform}`);
      expect(requests.at(-1)!.body).toEqual({ version: 9_223_372_036_854_775_807n, requiredPlatform: platform });
      expect(parseApiJson((await invoke(["task", "show", taskId, "--json", ...explicit], outside, 0, true)).stdout)).toMatchObject({ requiredPlatform: platform });
      const listed = await invoke(["task", "list", "--compatible-platform", platform, "--allow-agents", "false", "--ready", "--json", ...explicit], outside, 0, true);
      expect(parseApiJson(listed.stdout)).toEqual([taskListItem({ ...task(), requiredPlatform: platform })]);
      expect(Object.fromEntries(new URL(requests.at(-1)!.path, firstUrl).searchParams)).toEqual({ ready: "true", allowAgents: "false", compatiblePlatform: platform, limit: "100" });
      readyPage = { items: [{ ...task(), requiredPlatform: platform }], nextCursor: "unfollowed platform page" };
      const before = requests.length;
      expect(parseApiJson((await invoke(["task", "ready", "--compatible-platform", platform, "--limit", "1", "--json", ...explicit], outside, 0, true)).stdout)).toEqual(readyPage.items);
      expect(requests.slice(before).length).toBe(2);
      expect(Object.fromEntries(new URL(requests.at(-1)!.path, firstUrl).searchParams)).toEqual({ ready: "true", limit: "1", compatiblePlatform: platform });
      readyPage = undefined;
    }
    expect((await invoke(["task", "update", taskId, "--clear-required-platform", "--if-version", "9007199254740993", ...explicit], outside, 0, true)).stdout).toContain("Required platform: any");
    expect(requests.at(-1)!.body).toEqual({ version: 9_007_199_254_740_993n, requiredPlatform: null });
    expect(parseApiJson((await invoke(["task", "show", taskId, "--json", ...explicit], outside, 0, true)).stdout)).toMatchObject({ requiredPlatform: null, allowAgents: false });
    scenarios.push("installed-platform-create-set-clear-readback-compatible-query-and-bounded-ready");
    const emptyDescriptionList = parseApiJson((await invoke(["task", "list", "--status", "todo", "--ready", "--json", ...explicit], outside, 0, true)).stdout) as Record<string, unknown>[];
    expect(emptyDescriptionList).toEqual([taskListItem(task())]);
    expect(emptyDescriptionList[0]).not.toHaveProperty("description");
    expect(JSON.parse((await invoke(["task", "graph", "--json", ...explicit], outside, 0, true)).stdout).tasks).toEqual([]);
    scenarios.push("installed-project-task-operations-server-only-config-explicit-isolation");

    const dependencyCreateAt = requests.length;
    await invoke(["task", "create", "--title", "Mixed prerequisites", "--depends-on", ordinaryId.toUpperCase(), "--external-depends-on", externalId, ...explicit], outside, 0, true);
    expect(requests.slice(dependencyCreateAt).map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(requests.at(-1)!.body).toEqual({ title: "Mixed prerequisites", dependsOn: [ordinaryId, externalId], externalDependsOn: [externalId] });
    expect(parseApiJson((await invoke(["task", "show", taskId, "--json", ...explicit], outside, 0, true)).stdout)).toMatchObject({ dependsOn: [ordinaryId, externalId], externalDependsOn: [externalId] });
    const dependencyCases = [
      { fields: ["--title", "Preserve prerequisites"], body: { title: "Preserve prerequisites" }, dependsOn: [ordinaryId, externalId], externalDependsOn: [externalId] },
      { fields: ["--external-depends-on", externalId], body: { dependsOn: [externalId], externalDependsOn: [externalId] }, dependsOn: [externalId], externalDependsOn: [externalId] },
      { fields: ["--depends-on", ordinaryId], body: { dependsOn: [ordinaryId], externalDependsOn: [] }, dependsOn: [ordinaryId], externalDependsOn: [] },
      { fields: ["--clear-dependencies"], body: { dependsOn: [], externalDependsOn: [] }, dependsOn: [], externalDependsOn: [] },
    ];
    for (const item of dependencyCases) {
      const before = requests.length;
      await invoke(["task", "update", taskId, ...item.fields, "--if-version", "9223372036854775807", ...explicit], outside, 0, true);
      expect(requests.slice(before).map(({ method }) => method)).toEqual(["GET", "PATCH"]);
      expect(requests.at(-1)!.body).toEqual({ version: 9_223_372_036_854_775_807n, ...item.body });
      expect(parseApiJson((await invoke(["task", "show", taskId, "--json", ...explicit], outside, 0, true)).stdout)).toMatchObject({ dependsOn: item.dependsOn, externalDependsOn: item.externalDependsOn });
    }
    const duplicateAt = requests.length;
    await invoke(["task", "create", "--title", "Duplicate prerequisite", "--external-depends-on", externalId, "--depends-on", externalId.toUpperCase(), ...explicit], outside, 2, true);
    expect(requests).toHaveLength(duplicateAt);
    scenarios.push("installed-ordinary-and-external-complete-replacement-omission-clearing-and-pre-io-duplicate-rejection");

    // The Windows .cmd launcher passes command text through cmd.exe. Line breaks
    // are exercised through this same installation's Node entry below.
    // https://github.com/moxystudio/node-cross-spawn/blob/77cd97f3ca7b62c904a63a698fc4a79bf41977d0/lib/parse.js#L38-L62
    const pullRequests = [{ url: "", title: "" }, { url: "-arbitrary=a,b", title: " 标题 ,=() " }, { url: "-arbitrary=a,b", title: " 标题 ,=() " }];
    const pairs = ["--pull-request-url=", "--pull-request-url=-arbitrary=a,b", "--pull-request-title=", "--pull-request-title", pullRequests[1]!.title, "--pull-request-title", pullRequests[2]!.title, "--pull-request-url=-arbitrary=a,b"];
    const createdWithPr = await invoke(["task", "create", "--title", "PR task", ...pairs, ...explicit], outside, 0, true);
    expect(requests.at(-1)!.body).toEqual({ title: "PR task", properties: { pullRequests } });
    expect(createdWithPr.stdout).toContain("Pull requests: 3");
    expect(createdWithPr.stdout).toContain(" 标题 ,=() ");
    properties = { worker: null, pullRequests: [...pullRequests, { url: "\0 arbitrary\ttext", title: "\0\n\r\u001b[2J" }] };
    expect(parseApiJson((await invoke(["task", "show", taskId, "--json", ...explicit], outside, 0, true)).stdout)).toEqual({ ...task(), properties, version: 9_007_199_254_740_993n });
    expect(parseApiJson((await invoke(["task", "list", "--json", ...explicit], outside, 0, true)).stdout)).toEqual([taskListItem({ ...task(), properties })]);
    listResponseTask = { ...task(), description: "List description\n\u001b[2J", properties, version: 9_223_372_036_854_775_807n };
    for (const flags of [[], ["--all"], ["--status", "todo"], ["--ready"], ["--all", "--ready"], ["--status", "todo", "--ready"]]) {
      const json = (await invoke(["task", "list", ...flags, "--json", ...explicit], outside, 0, true)).stdout;
      const items = parseApiJson(json) as Record<string, unknown>[];
      expect(items).toEqual([taskListItem(listResponseTask)]);
      expect(items[0]).not.toHaveProperty("description");
      expect(json).toContain('"version":9223372036854775807');
      expect(json.endsWith("\n")).toBe(true);
    }
    listResponseTask = undefined;
    scenarios.push("installed-list-json-omits-empty-and-nonempty-description-with-raw-pr-and-int64");
    for (const args of [["task", "show", taskId, ...explicit], ["task", "list", ...explicit]]) {
      const output = (await invoke(args, outside, 0, true)).stdout;
      expect(output).toContain("\\u0000 arbitrary\\ttext");
      expect(output).toContain("4. Title: \\u0000\\n\\r\\u001b[2J");
    }
    const replaceAt = requests.length;
    await invoke(["task", "update", taskId, ...pairs, ...explicit], outside, 0, true);
    expect(requests.slice(replaceAt).map(({ method }) => method)).toEqual(["GET", "GET", "PATCH"]);
    expect(requests.at(-1)!.body).toEqual({ version: 9_007_199_254_740_993n, properties: { pullRequests } });
    const clearAt = requests.length;
    expect((await invoke(["task", "update", taskId, "--clear-pull-requests", "--if-version", "9223372036854775807", ...explicit], outside, 0, true)).stdout).toContain("Pull requests: 0");
    expect(requests.slice(clearAt).map(({ method }) => method)).toEqual(["GET", "PATCH"]);
    expect(requests.at(-1)!.body).toEqual({ version: 9_223_372_036_854_775_807n, properties: { pullRequests: [] } });
    properties = { worker: null, pullRequests: [] };
    scenarios.push("installed-pr-pairing-empty-duplicates-raw-text-json-replace-and-clear");

    const multiline = [{ url: " arbitrary\r\nURL ", title: " 标题\n\r\u001b[2J " }, { url: "", title: "" }, { url: " arbitrary\r\nURL ", title: " 标题\n\r\u001b[2J " }];
    const multilineProperties = { pullRequests: multiline };
    const multilinePairs = ["--pull-request-title", multiline[0]!.title, "--pull-request-url", multiline[0]!.url, "--pull-request-url=", "--pull-request-url", multiline[2]!.url, "--pull-request-title=", "--pull-request-title", multiline[2]!.title];
    const createdMultiline = await invoke(["task", "create", "--title", "Multiline PR task", ...multilinePairs, ...explicit], outside, 0, true, "node-entry");
    expect(requests.at(-1)!.body).toEqual({ title: "Multiline PR task", properties: multilineProperties });
    expect(createdMultiline.stdout).toContain("1. Title:  标题\\n\\r\\u001b[2J \n     URL:  arbitrary\\r\\nURL ");
    properties = { ...multilineProperties, worker: null };
    const multilineUpdateAt = requests.length;
    await invoke(["task", "update", taskId, ...multilinePairs, ...explicit], outside, 0, true, "node-entry");
    expect(requests.slice(multilineUpdateAt).map(({ method }) => method)).toEqual(["GET", "GET", "PATCH"]);
    expect(requests.at(-1)!.body).toEqual({ version: 9_007_199_254_740_993n, properties: multilineProperties });
    for (const args of [["task", "show", taskId], ["task", "list"]]) {
      const json = await invoke([...args, "--json", ...explicit], outside, 0, true, "node-entry");
      expect(parseApiJson(json.stdout)).toEqual(args[1] === "list" ? [taskListItem({ ...task(), properties })] : { ...task(), properties, version: 9_007_199_254_740_993n });
      expect((await invoke([...args, ...explicit], outside, 0, true, "node-entry")).stdout).toContain(" 标题\\n\\r\\u001b[2J ");
    }
    properties = { worker: null, pullRequests: [] };
    scenarios.push("installed-node-entry-pr-multiline-create-update-and-readback");

    const markdown = [
      "# Markdown 中文 task", "", "> Preserve original bytes.", "", "- [x] GFM item", "",
      "| 名称 | Value |", "| --- | --- |", "| 保留 | `a < b` |", "", "```ts",
      'const message = "中文 <tag> & value";', "```", "", "[方案与验收](plan.md)",
      "![图示](images/示意%20图.png)", "", "<b>raw HTML</b>", "",
    ].join("\r\n");
    const markdownCreateAt = requests.length;
    await invoke(["task", "create", "--title", "Markdown task", "--description", markdown, ...explicit], outside, 0, true, "node-entry");
    expect(requests.slice(markdownCreateAt).map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(requests.at(-1)!.body).toEqual({ title: "Markdown task", description: markdown });
    const readMarkdown = parseApiJson((await invoke(["task", "show", taskId, "--json", ...explicit], outside, 0, true)).stdout) as Task;
    expect(Buffer.from(readMarkdown.description)).toEqual(Buffer.from(markdown));
    const replacement = "## Replacement 替换\r\n\r\n- Complete field replacement\r\n\r\n[方案与验收](plan.md)\r\n";
    const markdownUpdateAt = requests.length;
    await invoke(["task", "update", taskId, "--description", replacement, "--if-version", "9007199254740993", ...explicit], outside, 0, true, "node-entry");
    expect(requests.slice(markdownUpdateAt).map(({ method }) => method)).toEqual(["GET", "PATCH"]);
    expect(requests.at(-1)!.body).toEqual({ version: 9_007_199_254_740_993n, description: replacement });
    const replaced = parseApiJson((await invoke(["task", "show", taskId, "--json", ...explicit], outside, 0, true)).stdout) as Task;
    expect(Buffer.from(replaced.description)).toEqual(Buffer.from(replacement));
    description = "";
    scenarios.push("installed-markdown-unicode-crlf-gfm-code-links-create-replace-and-json-readback");

    const installedAuthoring = await readFile(path.join(path.dirname(receipt.entryPath), "commands/skill/skills/using-daynight/references/create-task.md"), "utf8");
    const packagedBrief = /```markdown\r?\n([\s\S]*?)\r?\n```/.exec(installedAuthoring)?.[1];
    expect(packagedBrief).toBeDefined();
    const brief = packagedBrief!;
    for (const content of ["## 问题与行动", "## 范围与交付", "## 完成条件", "[方案与验收](plan.md)", "[交互原型](mockui/index.html)"]) expect(brief).toContain(content);
    const briefCreateAt = requests.length;
    expect((await invoke(["task", "create", "--title", "Packaged Markdown brief", "--description", brief, ...explicit], outside, 0, true, "node-entry")).stdout).toContain("Status: todo");
    expect(requests.slice(briefCreateAt).map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(requests.at(-1)!.body).toEqual({ title: "Packaged Markdown brief", description: brief });
    for (const status of ["todo", "in_progress", "done"] as const) {
      const actionAt = requests.length;
      await invoke(["task", "set-status", taskId, status, "--if-version", "9007199254740993", ...explicit], outside, 0, true, "node-entry");
      expect(requests.slice(actionAt).map(({ method }) => method)).toEqual(["GET", "PUT"]);
      expect(requests.at(-1)!.body).toEqual({ version: 9_007_199_254_740_993n, status });
      const retained = parseApiJson((await invoke(["task", "show", taskId, "--json", ...explicit], outside, 0, true, "node-entry")).stdout) as Task;
      expect(Buffer.from(retained.description)).toEqual(Buffer.from(brief));
    }
    description = "";
    scenarios.push("installed-packaged-markdown-brief-original-bytes-across-status-changes");

    const readyTask = { ...task(), description: "Ready details", properties: { worker: null, pullRequests: [{ url: "\0 arbitrary URL", title: "Ready\nPR" }] }, version: 9_223_372_036_854_775_807n };
    readyPage = { items: [readyTask], nextCursor: "native unrequested next page" };
    const readyAt = requests.length;
    expect(parseApiJson((await invoke(["task", "ready", "--limit=1", "--json", ...explicit], outside, 0, true)).stdout)).toEqual([readyTask]);
    expect(requests.slice(readyAt).map(({ path: pathname }) => pathname)).toEqual([`/api/v1/projects/${id}`, `/api/v1/projects/${id}/tasks?ready=true&limit=1`]);
    expect((await invoke(["task", "ready", "--limit=1", ...explicit], outside, 0, true)).stdout).toContain("1. Title: Ready\\nPR\n     URL: \\u0000 arbitrary URL");
    readyPage = { items: [], nextCursor: null };
    expect((await invoke(["task", "ready", ...explicit], outside, 0, true)).stdout).toBe("No ready tasks.\n");
    expect(requests.at(-1)!.path).toBe(`/api/v1/projects/${id}/tasks?ready=true&limit=10`);
    readyPage = { items: [readyTask, { ...readyTask, id: alternateId }], nextCursor: null };
    expect((await invoke(["task", "ready", "--limit=1", "--json", ...explicit], outside, 1, true)).stderr).toContain("task.ready");
    readyPage = { items: [{ ...readyTask, status: "in_progress", ready: false }], nextCursor: null };
    expect((await invoke(["task", "ready", "--json", ...explicit], outside, 1, true)).stderr).toContain("task.ready");
    readyPage = undefined;
    scenarios.push("installed-ready-single-bounded-page-int64-empty-and-protocol-refusals");

    await initialize(repository); const nested = path.join(repository, "nested 中文"); await mkdir(nested);
    await writeFile(path.join(repository, ".gitignore"), "# Keep original\r\n");
    await chmod(path.join(repository, ".gitignore"), 0o640);
    await invoke(["task", "create", "--title", "Discover before mutation"], nested);
    expect(await readBinding(repository)).toEqual({ serverUrl: firstUrl, repoIdentity: "git.example/Org/Repo", projectId: id });
    expect(await readFile(path.join(repository, ".gitignore"), "utf8")).toContain("# Keep original\r\n");
    expect(git(repository, ["check-ignore", "--", ".daynight/", ".daynight/project.yml"]).split(/\r?\n/)).toEqual([".daynight/", ".daynight/project.yml"]);
    if (process.platform !== "win32") { expect((await lstat(path.join(repository, ".gitignore"))).mode & 0o777).toBe(0o640); expect((await lstat(binding(repository))).mode & 0o777).toBe(0o600); }
    expect(await readdir(path.join(repository, ".daynight"))).toEqual(["project.yml"]);
    scenarios.push("native-root-subdirectory-insteadOf-ssh-https-discovery-ignore-and-modes");

    projects.push(project(alternateId)); const cachedAt = requests.length;
    await invoke(["task", "ready", "--limit", "1", "--json"], repository);
    expect(requests.slice(cachedAt).filter(({ path: pathname }) => pathname.startsWith("/api/v1/projects?"))).toEqual([]);
    const original = await readFile(binding(repository), "utf8");
    await invoke(["task", "list", "--json", "--project", unrelatedId], repository, 0, true);
    expect(await readFile(binding(repository), "utf8")).toBe(original);
    projects = [project(alternateId)]; await invoke(["task", "list"], repository);
    expect((await readBinding(repository)).projectId).toBe(alternateId);
    projects = [project(alternateId, "https://other.example/Other/Repo"), project()]; await invoke(["task", "list"], repository);
    expect((await readBinding(repository)).projectId).toBe(id);
    if (process.platform !== "win32") await chmod(binding(repository), 0o640);
    const beforeReplacement = await lstat(binding(repository));
    await configure(secondUrl); await invoke(["task", "list"], repository);
    expect((await readBinding(repository)).serverUrl).toBe(secondUrl);
    if (process.platform !== "win32") {
      const replaced = await lstat(binding(repository));
      expect(replaced.mode & 0o777).toBe(0o640);
      expect(replaced.ino).not.toBe(beforeReplacement.ino);
    }
    git(repository, ["remote", "set-url", "origin", "git@git.example:Different/Repo.git"]); projects = [project(id, "https://git.example/Different/Repo")];
    await invoke(["task", "list"], repository); expect((await readBinding(repository)).repoIdentity).toBe("git.example/Different/Repo");
    scenarios.push("stable-cache-explicit-bypass-cached404-mismatch-server-and-origin-changes");

    git(repository, ["remote", "set-url", "origin", "fixture:Org/Repo.git"]); await configure(firstUrl); projects = [project()];
    await rm(path.join(repository, ".daynight"), { recursive: true });
    const blob = git(repository, ["hash-object", "-w", "--stdin"], "fixture\n");
    const tree = git(repository, ["mktree"], `100644 blob ${blob}\tREADME.txt\n`);
    const commit = git(repository, ["hash-object", "-t", "commit", "-w", "--stdin"], `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nFixture\n`);
    git(repository, ["update-ref", "refs/heads/main", commit]); git(repository, ["reset", "--hard", "main"]);
    const worktree = path.join(receipt.root, "linked worktree"); git(repository, ["worktree", "add", "--detach", worktree]);
    await invoke(["task", "list"], worktree); expect((await readBinding(worktree)).projectId).toBe(id);
    expect(await readFile(binding(worktree), "utf8")).toContain("repoIdentity: git.example/Org/Repo");
    const parent = path.join(receipt.root, "submodule parent"); await initialize(parent);
    git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", repository, "module 中文"]);
    const submodule = path.join(parent, "module 中文"); git(submodule, ["remote", "set-url", "origin", "ssh://git@git.example/Org/Repo.git"]);
    await invoke(["task", "list"], submodule); expect((await readBinding(submodule)).projectId).toBe(id);
    expect((await lstat(path.join(submodule, ".git"))).isFile()).toBe(true);
    scenarios.push("native-linked-worktree-and-submodule-own-binding");

    const fresh = async (name: string): Promise<string> => { const location = path.join(receipt.root, name); await initialize(location); return location; };
    const missing = await fresh("missing project"); projects = [];
    expect((await invoke(["task", "list"], missing, 1)).stderr).toContain("Project does not exist");
    projects = [project(), project(alternateId)];
    const beforeAmbiguous = mutations();
    const ambiguous = await invoke(["task", "create", "--title", "Ambiguous"], missing, 1);
    expect(ambiguous.stderr).toContain("Multiple projects"); expect(ambiguous.stderr).toContain(alternateId); expect(mutations()).toBe(beforeAmbiguous);
    broken = "page";
    const beforePage = mutations(); await invoke(["task", "create", "--title", "Page failure"], missing, 1);
    expect(mutations()).toBe(beforePage); await expect(readFile(binding(missing))).rejects.toMatchObject({ code: "ENOENT" });
    broken = "none"; projects = [project()];
    scenarios.push("complete-discovery-zero-ambiguous-later-page-no-mutation");

    const locked = await fresh("locked repository"); await mkdir(path.join(locked, ".daynight"));
    const lock = `${binding(locked)}.lock`;
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `import{open,unlink}from'node:fs/promises';const file=process.argv[1];const h=await open(file,'wx',0o600);await h.writeFile(JSON.stringify({pid:process.pid,token:'native-owner-token'})+'\\n');process.stdout.write('ready\\n');process.on('SIGTERM',async()=>{await h.close();await unlink(file);process.exit(0)});setInterval(()=>{},1000);`, lock], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const holderClosed = new Promise<void>((resolve) => holder.once("close", () => { children.delete(holder); resolve(); }));
    children.set(holder, holderClosed);
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([
      new Promise<void>((resolve, reject) => { holder.once("error", reject); holder.stdout.once("data", () => resolve()); }),
      holderClosed.then(() => { throw new Error("Lock owner exited before readiness"); }),
      new Promise<never>((_resolve, reject) => { readyTimer = setTimeout(() => reject(new Error("Lock owner did not reach its readiness barrier.")), 5_000); }),
    ]); } finally { if (readyTimer !== undefined) clearTimeout(readyTimer); }
    const lockBytes = await readFile(lock, "utf8"); const beforeLock = mutations();
    expect((await invoke(["task", "create", "--title", "Locked"], locked, 1)).stderr).toContain("locked");
    expect(await readFile(lock, "utf8")).toBe(lockBytes); expect(mutations()).toBe(beforeLock);
    await terminateInstalledProcess(holder, holderClosed);
    await rm(lock, { force: true });
    const corrupt = await fresh("corrupt repository"); await mkdir(path.join(corrupt, ".daynight")); await writeFile(binding(corrupt), "broken: [");
    expect((await invoke(["task", "create", "--title", "Corrupt"], corrupt, 1)).stderr).toContain("Invalid repository binding");
    await rm(binding(corrupt)); await mkdir(binding(corrupt));
    expect((await invoke(["task", "list"], corrupt, 1)).stderr).toContain("regular file");
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await rm(binding(corrupt), { recursive: true });
      await writeFile(binding(corrupt), JSON.stringify({ serverUrl: firstUrl, repoIdentity: "git.example/Org/Repo", projectId: id }));
      await chmod(binding(corrupt), 0o000);
      const unreadable = await invoke(["task", "list"], corrupt, 1);
      expect(unreadable.stderr).toContain("Cannot read repository binding");
      expect(unreadable.stderr).toContain("EACCES");
      await chmod(binding(corrupt), 0o600);
      scenarios.push("posix-real-binding-permission-read-failure");
    }
    const badIgnore = await fresh("bad ignore repository"); await mkdir(path.join(badIgnore, ".gitignore"));
    const beforeLocal = mutations(); await invoke(["task", "create", "--title", "Local failure"], badIgnore, 1); expect(mutations()).toBe(beforeLocal);
    scenarios.push("real-lock-owner-contention-corrupt-and-nonregular-metadata-local-preparation");

    projects = [project()];
    const updateAt = requests.length; await invoke(["task", "update", taskId, "--description=", "--clear-dependencies", ...explicit]);
    const defaultUpdate = requests.slice(updateAt); expect(defaultUpdate.map(({ method }) => method)).toEqual(["GET", "GET", "PATCH"]);
    expect(defaultUpdate[2]!.body).toEqual({ description: "", dependsOn: [], externalDependsOn: [], version: 9_007_199_254_740_993n });
    broken = "conflict"; const conflictAt = requests.length;
    expect((await invoke(["task", "set-status", taskId, "done", "--if-version", "9223372036854775807", ...explicit], outside, 1)).stderr).toContain("native-version-conflict");
    expect(requests.slice(conflictAt).map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect((requests.at(-1)!.body as { version: bigint }).version).toBe(9_223_372_036_854_775_807n);
    broken = "dependency";
    const rejected = await invoke(["task", "create", "--title", "Dependency refusal", "--depends-on", taskId, ...explicit], outside, 1);
    expect(rejected.stderr).toContain("native-dependency-refusal"); expect(rejected.stderr).toContain(taskId);
    broken = "json"; await invoke(["task", "show", taskId, "--json", ...explicit], outside, 1);
    broken = "page"; expect((await invoke(["task", "list", "--json", ...explicit], outside, 1)).stderr).toContain("native-later-page");
    broken = "write"; const beforeWrite = mutations();
    expect((await invoke(["task", "create", "--title", "Unconfirmed", ...explicit], outside, 1)).stderr).toContain("unconfirmed"); expect(mutations()).toBe(beforeWrite + 1);
    scenarios.push("installed-int64-default-and-explicit-patch-refusal-bad-json-late-page-unconfirmed-write");
    if (process.platform !== "win32") {
      broken = "hold"; const ready = new Promise<void>((resolve) => { received = resolve; });
      const active = start(["task", "create", "--title", "Cancelled", ...explicit]);
      await Promise.race([ready, active.result.then((result) => { throw new Error(`Installed CLI exited before signal probe: ${result.stderr}`); })]);
      active.child.kill("SIGINT"); const result = await active.result;
      expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("cancelled"); expect(result.stderr).toContain("unconfirmed"); scenarios.push("actual-posix-sigint-cancels-installed-mutation");
    }
    expect(createHash("sha256").update(await readFile(receipt.entryPath)).digest("hex")).toBe(receipt.entrySha256);
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) { try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); } }
  for (const server of servers) { try { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause))); } catch (cause) { cleanup.push(cause); } }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  let removed = false; try { await lstat(receipt.root); } catch (cause) { if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") removed = true; else cleanup.push(cause); }
  await writeFile(evidencePath, `${JSON.stringify({ schemaVersion: 1, success: failure === undefined && cleanup.length === 0 && removed, platform: process.platform, nodeVersion: process.version, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256, source: receipt.source }, scenarios, requests: requests.map(({ method, path: pathname }) => ({ method, path: pathname })), cleanup: { installationRemoved: removed, childrenExited: children.size === 0, serversClosed: servers.every((server) => !server.listening), errors: cleanup.length } }, null, 2)}\n`, { mode: 0o600 });
  if (cleanup.length !== 0) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Installed project/task acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
  expect(removed).toBe(true);
}, 180_000);
