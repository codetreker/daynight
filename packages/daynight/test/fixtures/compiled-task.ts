import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import type { Project, Task, TaskGraph } from "../../src/api/types.js";
import { observedFixtureResponse, withTaskObservation } from "./task-observation.js";

const executable = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const batchRunner = fileURLToPath(new URL("./compiled-task-batch.mjs", import.meta.url));
export const projectId = "a1b2c3d4-1111-4222-8333-123456789abc";
export const taskId = "b1b2c3d4-1111-4222-8333-123456789abc";
export const secondId = "b1b2c3d4-1111-4222-8333-123456789abd";
export const thirdId = "b1b2c3d4-1111-4222-8333-123456789abe";
export const accountId = "a1b2c3d4-1111-4222-8333-123456789abe";
export const time = "2026-10-20T00:00:00.123456789Z";
export const project: Project = { id: projectId, name: "Project 中文", repoUrl: "git@git.example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: time, updatedAt: time };
export const task = (partial: Partial<Task> = {}): Task => ({ type: "task", parentId: null, id: taskId, projectId, title: "Task 中文", description: "", tags: [], properties: { pullRequests: [] }, status: "todo", allowAgents: false, assignedTo: null, requiredPlatform: null, version: 1n, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, ...partial });
export const taskListItem = (value: Task) => withTaskObservation({
  type: value.type, parentId: value.parentId, id: value.id, projectId: value.projectId, title: value.title, tags: value.tags, properties: value.properties,
  status: value.status, allowAgents: value.allowAgents, assignedTo: value.assignedTo, requiredPlatform: value.requiredPlatform, version: value.version, startedAt: value.startedAt, completedAt: value.completedAt, cancelledAt: value.cancelledAt, createdAt: value.createdAt, updatedAt: value.updatedAt,
  dependsOn: value.dependsOn, externalDependsOn: value.externalDependsOn, blockedBy: value.blockedBy, ready: value.ready,
});
export const graph = (): TaskGraph => ({
  observedAt: time,
  project,
  summary: { total: 1, proposed: 0, todo: 1, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 0 },
  tasks: [{ type: "task", parentId: null, id: taskId, titlePreview: "Task 中文", titleTruncated: false, allowAgents: false, assignedTo: null, requiredPlatform: null, status: "todo", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time }],
});
export const taskPath = `/api/v1/projects/${projectId}/tasks`;
export const projectPath = `/api/v1/projects/${projectId}`;
export const blockedReview = ["/commands/review/runtime.js", "/commands/review/store.js", "/commands/review/adapters/", "better-sqlite3"];
const blockedExplicit = ["/repository/", ...blockedReview];
export const respond = (response: ServerResponse, value: unknown, status = 200): void => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(stringifyApiJson(status === 200 ? observedFixtureResponse(value, response.req.url!) : value)); };
export const refuse = (response: ServerResponse, code: string, requestId: string, status: number, details?: unknown): void => respond(response, { error: { code, message: "Controlled task refusal.", requestId, ...(details === undefined ? {} : { details }) } }, status);

type CapturedRequest = { method: string; pathname: string; query: URLSearchParams; bodyText: string; body: unknown; contentType: string | undefined; bytes: Buffer };
export type Result = { code: number | null; stdout: string; stdoutBytes: Buffer; stderr: string };
type InvokeOptions = { blocked?: readonly string[]; cwd?: string; git?: boolean };

export const fixture = async () => {
  const temporary = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "task CLI 中文-"));
  const home = path.join(root, "home");
  const caller = path.join(root, "caller");
  const emptyPath = path.join(root, "empty-path");
  const hook = path.join(root, "imports.mjs");
  await mkdir(caller); await mkdir(emptyPath);
  await writeFile(hook, `import { registerHooks } from 'node:module';
const blocked = JSON.parse(process.env.DAYNIGHT_TEST_BLOCK_IMPORTS);
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (blocked.some(value => specifier.includes(value) || resolved.url.includes(value))) throw new Error('Unexpected module import: ' + specifier);
  return resolved;
} });
`);
  const nativeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
  const environment = { ...nativeEnvironment, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "git-global") };
  const servers: Server[] = [];
  const active = new Set<ReturnType<typeof spawn>>();
  const startProgram = (program: string, args: readonly string[], options: InvokeOptions = {}) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(hook).href, program, ...args], {
      cwd: options.cwd ?? caller, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...environment, ...(options.git ? {} : { PATH: emptyPath, Path: emptyPath }), DAYNIGHT_TEST_BLOCK_IMPORTS: JSON.stringify(options.blocked ?? blockedExplicit) },
    });
    active.add(child);
    const result = new Promise<Result>((resolve, reject) => {
      const output: Buffer[] = [];
      let stderr = "";
      let failure: Error | undefined;
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (value: Buffer) => { output.push(value); });
      child.stderr.on("data", (value: string) => { stderr += value; });
      child.once("error", (error) => { failure = error; });
      const timer = setTimeout(() => { failure = new Error("Compiled task command exceeded its test deadline."); child.kill("SIGKILL"); }, 20_000);
      child.once("close", (code) => {
        active.delete(child); clearTimeout(timer);
        if (failure !== undefined) reject(failure); else { const stdoutBytes = Buffer.concat(output); resolve({ code, stdout: stdoutBytes.toString("utf8"), stdoutBytes, stderr }); }
      });
    });
    return { child, result };
  };
  const start = (args: readonly string[], options?: InvokeOptions) => startProgram(executable, ["task", ...args], options);
  const invoke = (args: readonly string[], options?: InvokeOptions) => start(args, options).result;
  const invokeBatch = async (argumentSets: readonly (readonly string[])[], blocked: readonly string[] = blockedExplicit) => {
    const batch = await startProgram(batchRunner, [JSON.stringify(argumentSets)], { blocked }).result;
    expect(batch.code, batch.stderr).toBe(0);
    expect(batch.stderr).toBe("");
    const results = JSON.parse(batch.stdout) as Pick<Result, "code" | "stdout" | "stderr">[];
    expect(results).toHaveLength(argumentSets.length);
    return results;
  };
  const serve = async (handler: (request: CapturedRequest, response: ServerResponse) => void) => {
    const requests: CapturedRequest[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      request.on("end", () => {
        const url = new URL(request.url!, "http://localhost");
        const bytes = Buffer.concat(chunks);
        const bodyText = bytes.toString("utf8");
        const contentType = request.headers["content-type"];
        const captured = { method: request.method!, pathname: url.pathname, query: url.searchParams, bodyText, body: bytes.length === 0 ? null : contentType?.startsWith("application/json") ? parseApiJson(bodyText) : bytes, contentType, bytes };
        requests.push(captured);
        if (captured.method === "GET" && captured.pathname === projectPath) respond(response, project);
        else if (captured.method === "GET" && captured.pathname === "/api/v1/me") respond(response, { id: accountId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "personal" as const, name: null } });
        else handler(captured, response);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing controlled HTTP listener.");
    const serverUrl = `http://127.0.0.1:${address.port}`;
    await mkdir(path.join(home, ".daynight"), { recursive: true });
    await writeFile(path.join(home, ".daynight/config.yml"), `serverUrl: ${serverUrl}\nserverToken: fixture-token\n`);
    return { requests, serverUrl };
  };
  const git = (cwd: string, args: readonly string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: environment, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  const initializeRepository = async (directory: string) => {
    await mkdir(directory, { recursive: true });
    git(directory, ["init", "--initial-branch=main"]);
    git(directory, ["config", "url.https://git.example/.insteadOf", "fixture:"]);
    git(directory, ["remote", "add", "origin", "fixture:Org/Repo.git"]);
  };
  const close = async () => {
    await Promise.all([...active].map((child) => new Promise<void>((resolve) => { child.once("close", () => resolve()); child.kill("SIGKILL"); })));
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
    await rm(root, { recursive: true, force: true });
  };
  return { root, home, caller, invoke, invokeBatch, start, serve, git, initializeRepository, close };
};

export const explicit = ["--project", projectId];
