import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import type { Project, Task, TaskAttachment, TaskGraph } from "../../src/api/types.js";

const executable = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const projectId = "a1b2c3d4-1111-4222-8333-123456789abc";
const taskId = "b1b2c3d4-1111-4222-8333-123456789abc";
const secondId = "b1b2c3d4-1111-4222-8333-123456789abd";
const thirdId = "b1b2c3d4-1111-4222-8333-123456789abe";
const time = "2026-10-20T00:00:00.123456789Z";
const project: Project = { id: projectId, name: "Project 中文", repoUrl: "git@git.example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task = (partial: Partial<Task> = {}): Task => ({ id: taskId, projectId, title: "Task 中文", description: "", properties: { worker: null, pullRequests: [] }, status: "todo", allowAgents: false, requiredPlatform: null, version: 1n, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, ...partial });
const taskListItem = (value: Task): Omit<Task, "description"> => ({
  id: value.id, projectId: value.projectId, title: value.title, properties: value.properties,
  status: value.status, allowAgents: value.allowAgents, requiredPlatform: value.requiredPlatform, version: value.version, startedAt: value.startedAt, completedAt: value.completedAt, createdAt: value.createdAt, updatedAt: value.updatedAt,
  dependsOn: value.dependsOn, externalDependsOn: value.externalDependsOn, blockedBy: value.blockedBy, ready: value.ready,
});
const graph = (): TaskGraph => ({
  observedAt: time,
  project,
  summary: { total: 1, todo: 1, inProgress: 0, done: 0, ready: 1, blocked: 0 },
  tasks: [{ id: taskId, titlePreview: "Task 中文", titleTruncated: false, allowAgents: false, requiredPlatform: null, status: "todo", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, startedAt: null, completedAt: null, createdAt: time, updatedAt: time }],
});
const taskPath = `/api/v1/projects/${projectId}/tasks`;
const projectPath = `/api/v1/projects/${projectId}`;
const blockedReview = ["/commands/review/runtime.js", "/commands/review/store.js", "/commands/review/adapters/", "better-sqlite3"];
const blockedExplicit = ["/repository/", ...blockedReview];
const respond = (response: ServerResponse, value: unknown, status = 200): void => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(stringifyApiJson(value)); };
const refuse = (response: ServerResponse, code: string, requestId: string, status: number, details?: unknown): void => respond(response, { error: { code, message: "Controlled task refusal.", requestId, ...(details === undefined ? {} : { details }) } }, status);

type CapturedRequest = { method: string; pathname: string; query: URLSearchParams; bodyText: string; body: unknown; contentType: string | undefined; bytes: Buffer };
type Result = { code: number | null; stdout: string; stdoutBytes: Buffer; stderr: string };
type InvokeOptions = { blocked?: readonly string[]; cwd?: string; git?: boolean };

const fixture = async () => {
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
  const start = (args: readonly string[], options: InvokeOptions = {}) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(hook).href, executable, "task", ...args], {
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
  const invoke = (args: readonly string[], options?: InvokeOptions) => start(args, options).result;
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
  return { root, home, caller, invoke, start, serve, git, initializeRepository, close };
};

const explicit = ["--project", projectId];

const attachmentPath = `${taskPath}/${taskId}/attachments`;
const attachment = (relativePath: string, bytes: Uint8Array, contentType = "application/octet-stream"): TaskAttachment => ({ path: relativePath, sizeBytes: bytes.byteLength, contentType, createdAt: time, updatedAt: time });

describe("compiled task attachment commands", () => {
  it("uploads one real file with encoded paths, overwrites it, lists complete metadata, and removes it", async () => {
    const f = await fixture();
    try {
      const bytes = Buffer.from([0, 255, 128, 10, 13, 65]);
      const file = path.join(f.caller, "source.bin");
      await writeFile(file, bytes);
      const relativePath = "资料%?#/renamed.html";
      const encoded = relativePath.split("/").map(encodeURIComponent).join("/");
      let writes = 0;
      const metadata = attachment(relativePath, bytes, "text/html");
      const other = attachment("docs/second.md", Buffer.from("second"), "text/markdown");
      const { requests } = await f.serve((request, response) => {
        if (request.method === "PUT") { writes++; respond(response, metadata, writes === 1 ? 201 : 200); }
        else if (request.method === "DELETE") { response.writeHead(204); response.end(); }
        else if (request.pathname === attachmentPath) respond(response, request.query.has("cursor") ? { items: [other], nextCursor: null } : { items: [metadata], nextCursor: "next page+/=?" });
        else refuse(response, "not_found", "unexpected-attachment-route", 404);
      });
      for (const expectedWrites of [1, 2]) {
        const result = await f.invoke(["attachment", "put", taskId.toUpperCase(), file, "--path", relativePath, ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain(`Path: ${relativePath}`);
        expect(writes).toBe(expectedWrites);
        const request = requests.filter(({ method }) => method === "PUT").at(-1)!;
        expect(request.pathname).toBe(`${attachmentPath}/files/${encoded}`);
        expect(request.bytes).toEqual(bytes);
        expect(request.contentType).toBe("text/html");
      }
      const listed = await f.invoke(["attachment", "list", taskId, "--json", ...explicit]);
      expect(listed.code, listed.stderr).toBe(0);
      expect(parseApiJson(listed.stdout)).toEqual([metadata, other]);
      expect(requests.filter(({ pathname }) => pathname === attachmentPath).at(-1)!.query.get("cursor")).toBe("next page+/=?");
      const tree = await f.invoke(["attachment", "list", taskId, "--tree", ...explicit]);
      expect(tree.code, tree.stderr).toBe(0);
      expect(tree.stdout).toBe("├── docs/\n│   └── second.md\n└── 资料%?#/\n    └── renamed.html\n");
      const removed = await f.invoke(["attachment", "remove", taskId, relativePath, ...explicit]);
      expect(removed.code, removed.stderr).toBe(0);
      expect(removed.stdout).toBe("Attachment removed.\n");
      expect(requests.at(-1)!.pathname).toBe(`${attachmentPath}/files/${encoded}`);
    } finally { await f.close(); }
  }, 60_000);

  it("uses source basenames and rejects a source directory without network activity", async () => {
    const f = await fixture();
    try {
      const { requests } = await f.serve((request, response) => respond(response, attachment("source.unknown-extension", request.bytes), 201));
      const directory = await f.invoke(["attachment", "put", taskId, f.caller, ...explicit]);
      expect(directory.code).toBe(2);
      expect(directory.stdoutBytes).toHaveLength(0);
      expect(directory.stderr).toContain("Attachment source must be a regular file.");
      expect(requests).toHaveLength(0);
      await writeFile(path.join(f.caller, "source.unknown-extension"), Buffer.alloc(0));
      const uploaded = await f.invoke(["attachment", "put", taskId, "source.unknown-extension", ...explicit]);
      expect(uploaded.code, uploaded.stderr).toBe(0);
      expect(requests.at(-1)!.pathname).toBe(`${attachmentPath}/files/source.unknown-extension`);
      expect(requests.at(-1)!.contentType).toBe("application/octet-stream");
      expect(requests.at(-1)!.bytes).toHaveLength(0);
    } finally { await f.close(); }
  }, 60_000);

  it("prints nothing when a later metadata page fails", async () => {
    const f = await fixture();
    try {
      const { requests } = await f.serve((request, response) => request.query.has("cursor")
        ? refuse(response, "internal_error", "attachment-page-two", 500)
        : respond(response, { items: [attachment("first", Buffer.from("first"))], nextCursor: "page-two" }));
      const result = await f.invoke(["attachment", "list", taskId, "--json", ...explicit]);
      expect(result.code).toBe(1);
      expect(result.stdoutBytes).toHaveLength(0);
      expect(result.stderr).toContain("attachment-page-two");
      expect(requests).toHaveLength(3);
    } finally { await f.close(); }
  }, 60_000);

  it("preserves arbitrary binary and empty reads without an extra byte", async () => {
    const f = await fixture();
    try {
      const bytes = Buffer.from([0, 255, 254, 192, 128, 13, 10]);
      let current = bytes;
      const { requests } = await f.serve((_request, response) => { response.writeHead(200, { "Content-Type": "application/octet-stream" }); response.end(current); });
      const result = await f.invoke(["attachment", "read", taskId, ...explicit, "--", "-中文%?#.bin"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdoutBytes).toEqual(bytes);
      expect(result.stderr).toBe("");
      expect(requests.at(-1)!.pathname).toBe(`${attachmentPath}/files/${encodeURIComponent("-中文%?#.bin")}`);
      current = Buffer.alloc(0);
      const empty = await f.invoke(["attachment", "read", taskId, "empty", ...explicit]);
      expect(empty.code, empty.stderr).toBe(0);
      expect(empty.stdoutBytes).toHaveLength(0);
      expect(empty.stderr).toBe("");
    } finally { await f.close(); }
  }, 60_000);

  it("returns a failure after a read is interrupted and preserves only the received prefix", async () => {
    const f = await fixture();
    try {
      const prefix = Buffer.from([0, 255, 128, 65]);
      await f.serve((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "1024" });
        response.write(prefix);
        const timer = setTimeout(() => response.destroy(), 100);
        response.once("close", () => clearTimeout(timer));
      });
      const result = await f.invoke(["attachment", "read", taskId, "broken.bin", ...explicit]);
      expect(result.code).toBe(1);
      expect(result.stdoutBytes).toEqual(prefix);
      expect(result.stderr).toContain("attachment.read");
      expect(result.stderr).toContain("[response]");
    } finally { await f.close(); }
  }, 60_000);

  it("discovers the project from real Git and reuses the binding for attachment operations", async () => {
    const f = await fixture();
    try {
      await f.initializeRepository(f.caller);
      const { requests } = await f.serve((request, response) => {
        if (request.pathname === "/api/v1/projects") respond(response, { items: [project], nextCursor: null });
        else respond(response, { items: [attachment("docs/a.md", Buffer.alloc(0), "text/markdown")], nextCursor: null });
      });
      const options = { git: true, blocked: blockedReview };
      const first = await f.invoke(["attachment", "list", taskId, "--json"], options);
      expect(first.code, first.stderr).toBe(0);
      expect(parseApiJson(first.stdout)).toEqual([attachment("docs/a.md", Buffer.alloc(0), "text/markdown")]);
      expect(existsSync(path.join(f.caller, ".daynight/project.yml"))).toBe(true);
      const before = requests.length;
      const cached = await f.invoke(["attachment", "list", taskId, "--tree"], options);
      expect(cached.code, cached.stderr).toBe(0);
      expect(requests.slice(before).map(({ pathname }) => pathname)).toEqual([projectPath, attachmentPath]);
    } finally { await f.close(); }
  }, 60_000);
});

describe("compiled task commands", () => {
  it("updates explicit permission values and filters list/ready before printing with the compiled CLI", async () => {
    const f = await fixture();
    let current = task({ version: 9_007_199_254_740_993n });
    try {
      const { requests } = await f.serve((request, response) => {
        if (request.method === "PATCH") {
          const input = request.body as { version: bigint; allowAgents: boolean };
          current = { ...current, allowAgents: input.allowAgents, version: input.version + 1n };
          respond(response, current);
        } else if (request.pathname === `${taskPath}/${taskId}`) respond(response, current);
        else respond(response, { items: [current], nextCursor: request.query.get("limit") === "1" ? "not-followed" : null });
      });
      for (const allowAgents of [true, false]) {
        const version = current.version;
        const before = requests.length;
        const result = await f.invoke(["update", taskId, "--allow-agents", String(allowAgents), "--if-version", version.toString(), ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain(`Automatic execution: ${allowAgents}`);
        expect(requests.slice(before).map(({ method }) => method)).toEqual(["GET", "PATCH"]);
        expect(requests.at(-1)!.body).toEqual({ version, allowAgents });
        const listed = await f.invoke(["list", "--allow-agents", String(allowAgents), "--ready", "--json", ...explicit]);
        expect(listed.code, listed.stderr).toBe(0);
        expect(parseApiJson(listed.stdout)).toEqual([taskListItem(current)]);
        expect(Object.fromEntries(requests.at(-1)!.query)).toEqual({ ready: "true", allowAgents: String(allowAgents), limit: "100" });
        const readyBefore = requests.length;
        const ready = await f.invoke(["ready", "--allow-agents", String(allowAgents), "--limit", "1", "--json", ...explicit]);
        expect(ready.code, ready.stderr).toBe(0);
        expect(parseApiJson(ready.stdout)).toEqual([current]);
        expect(requests.slice(readyBefore).length).toBe(2);
        expect(Object.fromEntries(requests.at(-1)!.query)).toEqual({ ready: "true", limit: "1", allowAgents: String(allowAgents) });
      }
    } finally { await f.close(); }
  }, 60_000);

  it("keeps all operation help and malformed arguments independent of configuration and business imports", async () => {
    const f = await fixture();
    try {
      const helpBlocked = ["/api/", "/config/", "/repository/", "/commands/server/", "/commands/task/rendering.js", "better-sqlite3"];
      for (const args of [[], ["--help"], ...["create", "list", "ready", "show", "update", "set-status", "delete", "graph"].map((name) => [name, "--help"]), ["attachment"], ["attachment", "--help"], ...["put", "list", "read", "remove"].map((name) => ["attachment", name, "--help"])]) {
        const result = await f.invoke(args, { blocked: helpBlocked });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain("Usage: daynight task");
        expect(result.stderr).toBe("");
        if (args[0] === "list") {
          expect(result.stdout).toContain("Print task fields except description as JSON");
          expect(result.stdout).toContain("--json omits description and preserves every other task field");
        } else if (["ready", "show", "graph"].includes(args[0]!)) {
          expect(result.stdout).toContain("Print the complete API resource data as JSON");
        }
      }
      const validationBlocked = ["/api/client.js", "/api/operation.js", "/config/", "/repository/", "/commands/server/", "/commands/task/rendering.js", "better-sqlite3"];
      for (const args of [
        ["create"], ["create", "--title", "\u0085"], ["update", taskId],
        ["create", "--title", "Title", "--external-depends-on", "invalid"], ["update", taskId, "--external-depends-on", "invalid"],
        ["update", taskId, "--depends-on", secondId, "--external-depends-on", secondId.toUpperCase()],
        ["create", "--title", "Title", "--external-depends-on", secondId, "--external-depends-on", secondId],
        ["update", taskId, "--external-depends-on", secondId, "--clear-dependencies"],
        ["update", taskId, "--description", "", "--depends-on", secondId, "--clear-dependencies"],
        ["create", "--title", "Title", "--pull-request-url="],
        ["update", taskId, "--pull-request-title="],
        ["update", taskId, "--pull-request-url=", "--clear-pull-requests"],
        ["update", taskId, "--pull-request-title=", "--clear-pull-requests"],
        ["update", taskId, "--status", "invalid"],
        ["update", taskId, "--status", "done", "--if-version", "9223372036854775808"],
        ["show", "invalid"], ["list", "--project", "invalid"], ["list", "--ready", "false"], ["list", "--all", "--status", "todo"], ["list", "--status", "done", "--all"], ["graph", "--unknown"],
        ["ready", "--limit", "0"], ["ready", "--limit", "101"], ["ready", "--limit=1e1"], ["ready", "--limit=1.5"], ["ready", "--limit=+1"], ["ready", "--status", "todo"],
        ...["approve", "unapprove", "claim", "complete"].flatMap((action) => [[action], [action, "invalid"], [action, taskId, "--if-version=0"], [action, taskId, "--if-version=9223372036854775808"], [action, taskId, "--status=todo"]]),
        ["attachment", "list", "invalid"], ["attachment", "list", taskId, "--tree", "--json"],
        ["attachment", "put", taskId, "missing.txt", "--path", "../escape"],
        ["attachment", "read", taskId, "/absolute"], ["attachment", "remove", taskId, "a//b"],
      ]) {
        const result = await f.invoke(args, { blocked: validationBlocked });
        expect(result.code, result.stderr).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("Unexpected module import");
        expect(result.stderr).not.toContain("configuration file");
      }
      await expect(readdir(f.home)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(f.caller)).toEqual([]);
    } finally { await f.close(); }
  }, 60_000);

  it("retains external dependency classifications in every compiled read shape and reports their count separately", async () => {
    const f = await fixture();
    try {
      const current = task({ allowAgents: true, description: "Complete Markdown\n\n```text\nexternal dependency\n```", version: 9_223_372_036_854_775_807n, dependsOn: [secondId, thirdId], externalDependsOn: [thirdId] });
      const graphValue: TaskGraph = {
        ...graph(),
        summary: { total: 3, todo: 1, inProgress: 0, done: 2, ready: 1, blocked: 0 },
        tasks: [
          { ...graph().tasks[0]!, allowAgents: current.allowAgents, dependsOn: current.dependsOn, externalDependsOn: current.externalDependsOn },
          { ...graph().tasks[0]!, id: secondId, status: "done", ready: false },
          { ...graph().tasks[0]!, id: thirdId, status: "done", ready: false },
        ],
      };
      await f.serve((request, response) => {
        if (request.pathname.endsWith("/task-graph")) respond(response, graphValue);
        else if (request.pathname === taskPath) respond(response, { items: [current], nextCursor: null });
        else respond(response, current);
      });
      for (const command of ["show", "list", "ready", "graph"]) {
        const args = command === "show" ? [command, taskId] : [command];
        const human = await f.invoke([...args, ...explicit]);
        expect(human.code, human.stderr).toBe(0);
        expect(human.stdout).toContain("Automatic execution: true");
        expect(human.stdout).toContain(`Depends on: ${secondId}, ${thirdId}`);
        expect(human.stdout).toContain(`External dependencies (1): ${thirdId}`);
        const json = await f.invoke([...args, "--json", ...explicit]);
        expect(json.code, json.stderr).toBe(0);
        const resource = parseApiJson(json.stdout);
        expect(resource).toEqual(command === "list" ? [taskListItem(current)] : command === "ready" ? [current] : command === "graph" ? graphValue : current);
        if (command === "list") expect(resource).not.toHaveProperty("0.description");
        if (command !== "graph") expect(json.stdout).toContain('"version":9223372036854775807');
      }
    } finally { await f.close(); }
  }, 60_000);

  it("soft-deletes through the compiled entrypoint with observed and explicit exact versions", async () => {
    const f = await fixture();
    try {
      const current = task({ version: 9_007_199_254_740_993n });
      const { requests } = await f.serve((request, response) => {
        if (request.method === "DELETE") { response.writeHead(204); response.end(); }
        else respond(response, current);
      });
      for (const version of [undefined, "9223372036854775807"]) {
        const before = requests.length;
        const result = await f.invoke(["delete", taskId.toUpperCase(), ...(version === undefined ? [] : ["--if-version", version]), ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(`Task deleted. Stored data and attachments are retained.\nID: ${taskId}\nProject: ${projectId}\n`);
        expect(requests.slice(before).map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
          `GET ${projectPath}`, ...(version === undefined ? [`GET ${taskPath}/${taskId}`] : []), `DELETE ${taskPath}/${taskId}`,
        ]);
        expect(requests.at(-1)!.bodyText).toBe(`{"version":${version === undefined ? current.version : version}}`);
      }
    } finally { await f.close(); }
  }, 60_000);

  it("sets all three statuses with precise observed or supplied versions and same-status no-ops", async () => {
    const f = await fixture();
    try {
      let current = task({ requiredPlatform: "windows", description: "Status details", version: 9_007_199_254_740_993n });
      const { requests } = await f.serve((request, response) => {
        if (request.method === "PUT") {
          const { status } = request.body as { status: Task["status"] };
          if (current.status !== status) current = { ...current, status, ready: status === "todo", version: current.version + 1n };
        }
        respond(response, current, request.pathname === taskPath ? 201 : 200);
      });
      const created = await f.invoke(["create", "--title", "Status", ...explicit]);
      expect(created.code, created.stderr).toBe(0);
      expect(created.stdout).toContain("Status: todo");
      for (const status of ["todo", "in_progress", "done", "todo"] as const) {
        const version = current.version;
        const expectedVersion = current.status === status ? version : version + 1n;
        const before = requests.length;
        const explicitVersion = status === "in_progress";
        const result = await f.invoke(["set-status", taskId.toUpperCase(), status, ...(explicitVersion ? ["--if-version", String(version)] : []), ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain(`Status: ${status}`);
        expect(result.stdout).toContain(`Version: ${expectedVersion}`);
        expect(result.stdout).toContain("Description: Status details");
        expect(result.stdout).toContain("Required platform: windows");
        expect(requests.slice(before).map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, ...(explicitVersion ? [] : [`GET ${taskPath}/${taskId}`]), `PUT ${taskPath}/${taskId}/status`]);
        expect(requests.at(-1)!.body).toEqual({ version, status });
        expect(requests.at(-1)!.bodyText).toBe(`{"version":${version},"status":"${status}"}`);
      }
    } finally { await f.close(); }
  }, 60_000);

  it("lists unfinished tasks in stable global priority order and includes done tasks with --all", async () => {
    const f = await fixture();
    try {
      const identifiedTask = (suffix: string, title: string, partial: Partial<Task>): Task => task({ id: `b1b2c3d4-1111-4222-8333-123456789a${suffix}`, title, ...partial });
      const blockedFirst = identifiedTask("01", "Blocked first", { ready: false, dependsOn: [secondId], blockedBy: [secondId] });
      const doneFirst = identifiedTask("02", "Done first", { status: "done", ready: false });
      const readyFirst = identifiedTask("03", "Ready first", { description: "Description omitted from list JSON", version: 9_223_372_036_854_775_807n });
      const progressFirst = identifiedTask("04", "Progress first", { status: "in_progress", ready: false });
      const readySecond = identifiedTask("05", "Ready second", {});
      const progressSecond = identifiedTask("06", "Progress second", { status: "in_progress", ready: false });
      const blockedSecond = identifiedTask("07", "Blocked second", { ready: false, dependsOn: [thirdId], blockedBy: [thirdId] });
      const doneSecond = identifiedTask("08", "Done second", { status: "done", ready: false });
      const cursor = "next priority page+/=?";
      const { requests } = await f.serve((request, response) => respond(response, request.query.has("cursor")
        ? { items: [readySecond, progressSecond, blockedSecond, doneSecond], nextCursor: null }
        : { items: [blockedFirst, doneFirst, readyFirst, progressFirst], nextCursor: cursor }));
      const unfinished = [progressFirst, progressSecond, readyFirst, readySecond, blockedFirst, blockedSecond];
      for (const includeAll of [false, true]) {
        const args = ["list", ...(includeAll ? ["--all"] : []), ...explicit];
        const expected = includeAll ? [...unfinished, doneFirst, doneSecond] : unfinished;
        const json = await f.invoke([...args, "--json"]);
        expect(json.code, json.stderr).toBe(0);
        const listed = parseApiJson(json.stdout) as Record<string, unknown>[];
        expect(listed).toEqual(expected.map(taskListItem));
        for (const item of listed) expect(item).not.toHaveProperty("description");
        expect(json.stdout.endsWith("\n")).toBe(true);
        expect(json.stdout).toContain('"version":9223372036854775807');
        const text = await f.invoke(args);
        expect(text.code, text.stderr).toBe(0);
        expect(text.stdout.match(/^Title: .*$/gm)).toEqual(expected.map(({ title }) => `Title: ${title}`));
        for (const field of ["Description:", "Version:", "Created:", "Updated:"]) expect(text.stdout).not.toContain(field);
        expect(text.stdout).toContain(`Depends on: ${secondId}`);
        expect(text.stdout).toContain(`Blocked by: ${thirdId}`);
      }
      expect(requests.filter(({ pathname }) => pathname === taskPath).map(({ query }) => Object.fromEntries(query))).toEqual(Array.from({ length: 4 }, () => [
        { limit: "100" }, { limit: "100", cursor },
      ]).flat());
    } finally { await f.close(); }
  }, 60_000);

  it("preserves execution timestamps and graph observation time in JSON without expanding human output", async () => {
    const f = await fixture();
    try {
      const completed = task({ status: "done", ready: false, startedAt: "2026-10-19T23:00:00Z", completedAt: time });
      const value: TaskGraph = {
        observedAt: time, project,
        summary: { total: 1, todo: 0, inProgress: 0, done: 1, ready: 0, blocked: 0 },
        tasks: [{ ...graph().tasks[0]!, status: "done", ready: false, startedAt: completed.startedAt, completedAt: completed.completedAt }],
      };
      await f.serve((request, response) => respond(response, request.pathname.endsWith("/task-graph") ? value
        : request.pathname === taskPath ? { items: [completed], nextCursor: null } : completed));
      const shown = await f.invoke(["show", taskId, "--json", ...explicit]);
      expect(shown.code, shown.stderr).toBe(0);
      expect(parseApiJson(shown.stdout)).toEqual(completed);
      const listed = await f.invoke(["list", "--all", "--json", ...explicit]);
      expect(listed.code, listed.stderr).toBe(0);
      expect(parseApiJson(listed.stdout)).toEqual([taskListItem(completed)]);
      const graphed = await f.invoke(["graph", "--json", ...explicit]);
      expect(graphed.code, graphed.stderr).toBe(0);
      expect(parseApiJson(graphed.stdout)).toEqual(value);
      const text = await f.invoke(["list", "--all", ...explicit]);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).not.toMatch(/Started:|Completed:|Observed:/);
    } finally { await f.close(); }
  }, 60_000);

  it("rejects removed proposed resources and filters", async () => {
    const f = await fixture();
    try {
      const { requests } = await f.serve((_request, response) => respond(response, { ...task(), status: "proposed", ready: false }));
      const shown = await f.invoke(["show", taskId, ...explicit]);
      expect(shown.code).toBe(1);
      expect(shown.stdout).toBe("");
      const before = requests.length;
      for (const args of [["list", "--status", "proposed"], ["set-status", taskId, "proposed"], ...["approve", "unapprove", "claim", "complete"].map((action) => [action, taskId])]) {
        const result = await f.invoke([...args, ...explicit]);
        expect(result.code).toBe(2);
      }
      expect(requests).toHaveLength(before);
    } finally { await f.close(); }
  }, 60_000);

  it("keeps explicit status and readiness filters conjunctive with unfinished and all-state lists", async () => {
    const f = await fixture();
    try {
      const readyTask = task();
      const progressTask = task({ id: secondId, status: "in_progress", ready: false });
      const doneTask = task({ id: thirdId, status: "done", ready: false });
      const items = [doneTask, readyTask, progressTask];
      const { requests } = await f.serve((request, response) => respond(response, {
        items: items.filter((item) => (!request.query.has("status") || item.status === request.query.get("status")) && (!request.query.has("ready") || item.ready)),
        nextCursor: null,
      }));
      const cases: readonly { args: readonly string[]; expected: readonly Task[]; query: Record<string, string> }[] = [
        { args: ["--status", "done"], expected: [doneTask], query: { status: "done", limit: "100" } },
        { args: ["--ready"], expected: [readyTask], query: { ready: "true", limit: "100" } },
        { args: ["--all", "--ready"], expected: [readyTask], query: { ready: "true", limit: "100" } },
        { args: ["--status", "todo", "--ready"], expected: [readyTask], query: { status: "todo", ready: "true", limit: "100" } },
        { args: ["--status", "in_progress", "--ready"], expected: [], query: { status: "in_progress", ready: "true", limit: "100" } },
        { args: ["--status", "done", "--ready"], expected: [], query: { status: "done", ready: "true", limit: "100" } },
      ];
      for (const { args, expected, query } of cases) {
        const result = await f.invoke(["list", ...args, "--json", ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        const listed = parseApiJson(result.stdout) as Record<string, unknown>[];
        expect(listed).toEqual(expected.map(taskListItem));
        for (const item of listed) expect(item).not.toHaveProperty("description");
        expect(Object.fromEntries(requests.at(-1)!.query)).toEqual(query);
      }
    } finally { await f.close(); }
  }, 60_000);

  it("prints empty text and JSON when only completed tasks remain", async () => {
    const f = await fixture();
    try {
      await f.serve((_request, response) => respond(response, { items: [task({ status: "done", ready: false })], nextCursor: null }));
      const text = await f.invoke(["list", ...explicit]);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toBe("No tasks.\n");
      const json = await f.invoke(["list", "--json", ...explicit]);
      expect(json.code, json.stderr).toBe(0);
      expect(parseApiJson(json.stdout)).toEqual([]);
      expect(json.stdout).toBe("[]\n");
    } finally { await f.close(); }
  }, 60_000);

  it("preserves ordered raw PR lists and full JSON through mutations, full task reads, and compact lists", async () => {
    const f = await fixture();
    try {
      const supplied = [{ url: "", title: "" }, { url: "-arbitrary=a,b", title: " 标题\n\u001b[2J " }, { url: "-arbitrary=a,b", title: " 标题\n\u001b[2J " }];
      const returned = { worker: null, pullRequests: [...supplied, { url: "\0not a URL", title: "\0" }] };
      let current = task({ title: "Task 中文\n\u001b[2J", description: "Full description\n\u001b[2J", properties: returned, version: 9_223_372_036_854_775_807n });
      let conflict = false;
      const { requests } = await f.serve((request, response) => {
        if (request.method === "POST") respond(response, current, 201);
        else if (request.method === "PATCH") {
          if (conflict) refuse(response, "version_conflict", "pr-conflict", 409);
          else {
            const input = request.body as { readonly properties?: { readonly pullRequests: Task["properties"]["pullRequests"] } };
            current = { ...current, ...(request.body as object), ...(input.properties === undefined ? {} : { properties: { ...input.properties, worker: current.properties.worker } }) };
            respond(response, current);
          }
        } else if (request.pathname === taskPath) respond(response, { items: [current], nextCursor: null });
        else respond(response, current);
      });
      const pairs = ["--pull-request-url=", "--pull-request-title=", "--pull-request-url=-arbitrary=a,b", "--pull-request-url=-arbitrary=a,b", "--pull-request-title", supplied[1]!.title, "--pull-request-title", supplied[2]!.title];
      const created = await f.invoke(["create", "--title", "Title", ...pairs, ...explicit]);
      expect(created.code, created.stderr).toBe(0);
      expect(requests.find(({ method }) => method === "POST")!.body).toEqual({ title: "Title", properties: { pullRequests: supplied } });
      expect(created.stdout).toContain("Pull requests: 4");
      expect(created.stdout).toContain("4. Title: \\u0000\n     URL: \\u0000not a URL");
      for (const field of ["Description: Full description\\n\\u001b[2J", "Version: 9223372036854775807", `Created: ${time}`, `Updated: ${time}`]) expect(created.stdout).toContain(field);
      for (const command of [["show", taskId], ["list"]]) {
        const json = await f.invoke([...command, "--json", ...explicit]);
        expect(json.code, json.stderr).toBe(0);
        const parsed = parseApiJson(json.stdout);
        expect(parsed).toEqual(command[0] === "list" ? [taskListItem(current)] : current);
        if (command[0] === "list") expect((parsed as Record<string, unknown>[])[0]).not.toHaveProperty("description");
        else expect(parsed).toHaveProperty("description", current.description);
        expect(json.stdout).toContain('"version":9223372036854775807');
        const text = await f.invoke([...command, ...explicit]);
        expect(text.code, text.stderr).toBe(0);
        expect(text.stdout).toContain(" 标题\\n\\u001b[2J ");
        expect(text.stdout).toContain("\\u0000not a URL");
        for (const field of [`ID: ${taskId}`, `Project: ${projectId}`, "Title: Task 中文\\n\\u001b[2J", "Pull requests: 4", "Status: todo", "Ready: true", "Depends on: none", "Blocked by: none"]) expect(text.stdout).toContain(field);
        for (const field of ["Description:", "Version:", "Created:", "Updated:"]) {
          if (command[0] === "list") expect(text.stdout).not.toContain(field);
          else expect(text.stdout).toContain(field);
        }
        expect(text.stdout).not.toContain("\u001b");
      }
      const before = requests.length;
      const replaced = await f.invoke(["update", taskId, ...pairs, ...explicit]);
      expect(replaced.code, replaced.stderr).toBe(0);
      for (const field of ["Description: Full description\\n\\u001b[2J", "Version: 9223372036854775807", `Created: ${time}`, `Updated: ${time}`]) expect(replaced.stdout).toContain(field);
      expect(requests.slice(before).map(({ method }) => method)).toEqual(["GET", "GET", "PATCH"]);
      expect(requests.at(-1)!.body).toEqual({ version: 9_223_372_036_854_775_807n, properties: { pullRequests: supplied } });
      const clearAt = requests.length;
      const cleared = await f.invoke(["update", taskId, "--clear-pull-requests", "--if-version", "9223372036854775807", ...explicit]);
      expect(cleared.code, cleared.stderr).toBe(0);
      expect(cleared.stdout).toContain("Pull requests: 0");
      expect(requests.slice(clearAt).map(({ method }) => method)).toEqual(["GET", "PATCH"]);
      expect(requests.at(-1)!.body).toEqual({ version: 9_223_372_036_854_775_807n, properties: { pullRequests: [] } });
      conflict = true;
      const conflictAt = requests.length;
      const refused = await f.invoke(["update", taskId, ...pairs, ...explicit]);
      expect(refused.code).toBe(1); expect(refused.stdout).toBe(""); expect(refused.stderr).toContain("pr-conflict");
      expect(requests.slice(conflictAt).map(({ method }) => method)).toEqual(["GET", "GET", "PATCH"]);
    } finally { await f.close(); }
  }, 60_000);

  it("requests a single bounded ready page and preserves full task JSON and empty output", async () => {
    const f = await fixture();
    try {
      let items = [task({ description: "Ready details", properties: { worker: null, pullRequests: [{ url: "\0 arbitrary URL", title: "Ready\nPR" }] }, version: 9_223_372_036_854_775_807n })];
      let cursor: string | null = "unrequested next page";
      const { requests } = await f.serve((request, response) => {
        if (request.query.has("cursor")) refuse(response, "internal_error", "unexpected-ready-cursor", 500);
        else respond(response, { items, nextCursor: cursor });
      });
      const ready = await f.invoke(["ready", "--limit", "1", "--json", ...explicit]);
      expect(ready.code, ready.stderr).toBe(0);
      expect(parseApiJson(ready.stdout)).toEqual(items);
      expect(ready.stdout).toContain('"version":9223372036854775807');
      expect(requests).toHaveLength(2);
      expect(Object.fromEntries(requests[1]!.query)).toEqual({ ready: "true", limit: "1" });
      const text = await f.invoke(["ready", "--limit", "1", ...explicit]);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toContain("1. Title: Ready\\nPR\n     URL: \\u0000 arbitrary URL");
      for (const field of ["Description: Ready details", "Version: 9223372036854775807", `Created: ${time}`, `Updated: ${time}`]) expect(text.stdout).toContain(field);
      items = []; cursor = null;
      const empty = await f.invoke(["ready", ...explicit]);
      expect(empty.code, empty.stderr).toBe(0); expect(empty.stdout).toBe("No ready tasks.\n");
      expect(Object.fromEntries(requests.at(-1)!.query)).toEqual({ ready: "true", limit: "10" });
      expect(await readdir(f.caller)).toEqual([]);
    } finally { await f.close(); }
  }, 60_000);

  it("creates, shows, lists and graphs explicit projects without Git or repository imports", async () => {
    const f = await fixture();
    try {
      const title = "Task 中文\n\u001b[31m";
      const createdTask = task({ title, dependsOn: [secondId], blockedBy: [secondId], ready: false });
      const second = task({ id: secondId, title: "Second" });
      const cursor = "next page+/=?";
      const { requests } = await f.serve((request, response) => {
        if (request.method === "POST") respond(response, createdTask, 201);
        else if (request.pathname === `${taskPath}/${taskId}`) respond(response, createdTask);
        else if (request.pathname.endsWith("/task-graph")) respond(response, graph());
        else respond(response, request.query.has("cursor") ? { items: [second], nextCursor: null } : { items: [task()], nextCursor: cursor });
      });
      const created = await f.invoke(["create", "--title", title, "--description", "", "--depends-on", secondId, ...explicit]);
      expect(created.code, created.stderr).toBe(0);
      expect(created.stdout).toContain("Task created.");
      expect(created.stdout).toContain(taskId);
      expect(created.stdout).toContain("Task 中文\\n\\u001b[31m");
      expect(requests.find(({ method }) => method === "POST")!.body).toEqual({ title, description: "", dependsOn: [secondId], externalDependsOn: [] });

      const shown = await f.invoke(["show", taskId.toUpperCase(), "--project", projectId.toUpperCase(), "--json"]);
      expect(shown.code, shown.stderr).toBe(0);
      expect(parseApiJson(shown.stdout)).toEqual(createdTask);

      const listed = await f.invoke(["list", "--status", "todo", "--ready", "--json", ...explicit]);
      expect(listed.code, listed.stderr).toBe(0);
      expect(parseApiJson(listed.stdout)).toEqual([task(), second].map(taskListItem));
      const pages = requests.filter(({ pathname }) => pathname === taskPath).filter(({ method }) => method === "GET");
      expect(pages.map(({ query }) => Object.fromEntries(query))).toEqual([
        { status: "todo", ready: "true", limit: "100" }, { status: "todo", ready: "true", limit: "100", cursor },
      ]);
      const graphed = await f.invoke(["graph", "--json", ...explicit]);
      expect(graphed.code, graphed.stderr).toBe(0);
      expect(parseApiJson(graphed.stdout)).toEqual(graph());
      expect([created, shown, listed, graphed].every(({ stderr }) => stderr === "")).toBe(true);
      expect(requests.filter(({ pathname }) => pathname === projectPath)).toHaveLength(4);
      expect(await readdir(f.caller)).toEqual([]);
      expect(await readdir(path.join(f.home, ".daynight"))).toEqual(["config.yml"]);
    } finally { await f.close(); }
  }, 60_000);

  it("sends complete dependency classifications while preserving omitted fields through the compiled entrypoint", async () => {
    const f = await fixture();
    try {
      const current = task({ version: 9_007_199_254_740_993n, dependsOn: [secondId], externalDependsOn: [secondId] });
      const { requests } = await f.serve((request, response) => respond(response, request.method === "GET" ? current : { ...current, ...(request.body as object), version: current.version + 1n }, request.method === "POST" ? 201 : 200));
      const cases = [
        { args: ["create", "--title", "Mixed", "--depends-on", thirdId.toUpperCase(), "--external-depends-on", secondId], body: { title: "Mixed", dependsOn: [secondId, thirdId], externalDependsOn: [secondId] } },
        { args: ["update", taskId, "--external-depends-on", thirdId], body: { dependsOn: [thirdId], externalDependsOn: [thirdId] } },
        { args: ["update", taskId, "--depends-on", secondId], body: { dependsOn: [secondId], externalDependsOn: [] } },
        { args: ["update", taskId, "--clear-dependencies"], body: { dependsOn: [], externalDependsOn: [] } },
        { args: ["update", taskId, "--description", "Preserve classifications"], body: { description: "Preserve classifications" } },
      ];
      for (const { args, body } of cases) {
        requests.length = 0;
        const update = args[0] === "update";
        const result = await f.invoke([...args, ...(update ? ["--if-version", "9223372036854775807"] : []), ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        expect(requests.map(({ method }) => method)).toEqual(["GET", update ? "PATCH" : "POST"]);
        expect(requests[1]!.body).toEqual({ ...(update ? { version: 9_223_372_036_854_775_807n } : {}), ...body });
      }
    } finally { await f.close(); }
  }, 60_000);

  it("submits one precise PATCH using the read version or an explicit full-int64 version and compiles dependency input", async () => {
    const f = await fixture();
    try {
      let refusal: "none" | "version" | "dependencies" = "none";
      const current = task({ version: 9_007_199_254_740_993n });
      const { requests } = await f.serve((request, response) => {
        if (request.method === "GET") respond(response, current);
        else if (refusal === "version") refuse(response, "version_conflict", "task-version-conflict", 409);
        else if (refusal === "dependencies") refuse(response, "invalid_input", "task-dependency-input", 400);
        else respond(response, { ...current, version: current.version + 1n });
      });
      const updated = await f.invoke(["update", taskId, "--description=", "--clear-dependencies", ...explicit]);
      expect(updated.code, updated.stderr).toBe(0);
      expect(updated.stdout).toContain("Task updated.");
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `GET ${taskPath}/${taskId}`, `PATCH ${taskPath}/${taskId}`]);
      expect(requests[2]!.body).toEqual({ description: "", dependsOn: [], externalDependsOn: [], version: current.version });
      expect(requests[2]!.bodyText).toContain('"version":9007199254740993');

      requests.length = 0; refusal = "version";
      const conflict = await f.invoke(["set-status", taskId, "done", "--if-version", "9223372036854775807", ...explicit]);
      expect(conflict.code).toBe(1); expect(conflict.stdout).toBe("");
      expect(conflict.stderr).toContain("version_conflict"); expect(conflict.stderr).toContain("task-version-conflict");
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `PUT ${taskPath}/${taskId}/status`]);
      expect(requests[1]!.bodyText).toContain('"version":9223372036854775807');
      expect(requests[1]!.body).toEqual({ version: 9_223_372_036_854_775_807n, status: "done" });

      requests.length = 0; refusal = "dependencies";
      const rejected = await f.invoke(["update", taskId, "--if-version", "2", "--depends-on", thirdId, "--depends-on", secondId, ...explicit]);
      expect(rejected.code).toBe(1); expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain("task-dependency-input");
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `PATCH ${taskPath}/${taskId}`]);
      expect(requests[1]!.body).toEqual({ dependsOn: [secondId, thirdId], externalDependsOn: [], version: 2n });
    } finally { await f.close(); }
  }, 60_000);

  it("keeps failed pages and graphs out of stdout and reports unconfirmed writes without retries", async () => {
    const f = await fixture();
    try {
      let mode: "pages" | "graph" | "write" = "pages";
      const { requests } = await f.serve((request, response) => {
        if (mode === "write") response.socket!.destroy();
        else if (mode === "graph") refuse(response, "graph_limit_exceeded", "task-graph-limit", 409, { nodeCount: 1001, edgeCount: 0, maxNodes: 1000, maxEdges: 5000 });
        else if (request.query.has("cursor")) refuse(response, "internal_error", "task-later-page", 500);
        else respond(response, { items: [task()], nextCursor: "later page" });
      });
      const failedPage = await f.invoke(["list", "--json", ...explicit]);
      expect(failedPage.code).toBe(1); expect(failedPage.stdout).toBe("");
      expect(failedPage.stderr).toContain("internal_error"); expect(failedPage.stderr).toContain("task-later-page");
      expect(requests.filter(({ pathname }) => pathname === taskPath)).toHaveLength(2);
      mode = "graph";
      const failedGraph = await f.invoke(["graph", "--json", ...explicit]);
      expect(failedGraph.code).toBe(1); expect(failedGraph.stdout).toBe("");
      for (const value of ["graph_limit_exceeded", "task-graph-limit", "1001", "1000", "5000"]) expect(failedGraph.stderr).toContain(value);
      mode = "write";
      const uncertain = await f.invoke(["create", "--title", "Uncertain", ...explicit]);
      expect(uncertain.code).toBe(1); expect(uncertain.stdout).toBe("");
      for (const value of ["task.create", projectId, "unconfirmed"]) expect(uncertain.stderr).toContain(value);
      expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    } finally { await f.close(); }
  }, 60_000);

  it("discovers from real Git before creating a task, reuses its binding and prevents mutation when local preparation fails", async () => {
    const f = await fixture();
    try {
      await f.initializeRepository(f.caller);
      const subdirectory = path.join(f.caller, "source files"); await mkdir(subdirectory);
      await writeFile(path.join(f.caller, ".gitignore"), "# Keep this rule\r\n");
      let bindingPresentAtMutation = false;
      const { requests, serverUrl } = await f.serve((request, response) => {
        if (request.pathname === "/api/v1/projects") respond(response, request.query.has("cursor")
          ? { items: [project], nextCursor: null }
          : { items: [{ ...project, id: thirdId, repoUrl: "https://other.example/Other/Repo" }], nextCursor: "project page two" });
        else if (request.method === "POST") {
          bindingPresentAtMutation = existsSync(path.join(f.caller, ".daynight/project.yml")) && readFileSync(path.join(f.caller, ".gitignore"), "utf8").includes("/.daynight/");
          respond(response, task(), 201);
        } else respond(response, { items: [task()], nextCursor: null });
      });
      const options = { git: true, cwd: subdirectory, blocked: blockedReview };
      const created = await f.invoke(["create", "--title", "Automatic"], options);
      expect(created.code, created.stderr).toBe(0);
      expect(bindingPresentAtMutation).toBe(true);
      expect(parse(await readFile(path.join(f.caller, ".daynight/project.yml"), "utf8"))).toEqual({ serverUrl, repoIdentity: "git.example/Org/Repo", projectId });
      expect(await readFile(path.join(f.caller, ".gitignore"), "utf8")).toContain("# Keep this rule\r\n");
      expect(f.git(f.caller, ["check-ignore", "--", ".daynight/", ".daynight/project.yml"]).trim().split(/\r?\n/)).toEqual([".daynight/", ".daynight/project.yml"]);
      const discoveries = requests.filter(({ pathname }) => pathname === "/api/v1/projects");
      expect(discoveries).toHaveLength(2);
      expect(discoveries[1]!.query.get("cursor")).toBe("project page two");
      const beforeCached = requests.length;
      const cached = await f.invoke(["list", "--json"], options);
      expect(cached.code, cached.stderr).toBe(0);
      expect(parseApiJson(cached.stdout)).toEqual([taskListItem(task())]);
      expect(requests.slice(beforeCached).map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `GET ${taskPath}`]);
      const beforeReady = requests.length;
      const ready = await f.invoke(["ready", "--limit=1", "--json"], options);
      expect(ready.code, ready.stderr).toBe(0);
      expect(parseApiJson(ready.stdout)).toEqual([task()]);
      expect(requests.slice(beforeReady).map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `GET ${taskPath}`]);
      expect(Object.fromEntries(requests.at(-1)!.query)).toEqual({ ready: "true", limit: "1" });

      const blockedRepository = path.join(f.root, "blocked repository");
      await f.initializeRepository(blockedRepository);
      await mkdir(path.join(blockedRepository, ".gitignore"));
      const mutationCount = requests.filter(({ method }) => method === "POST").length;
      const failed = await f.invoke(["create", "--title", "Must not be submitted"], { ...options, cwd: blockedRepository });
      expect(failed.code).toBe(1); expect(failed.stdout).toBe("");
      expect(failed.stderr).toContain(".gitignore");
      expect(requests.filter(({ method }) => method === "POST")).toHaveLength(mutationCount);
      await expect(readFile(path.join(blockedRepository, ".daynight/project.yml"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.close(); }
  }, 60_000);

  it.skipIf(process.platform === "win32")("handles actual SIGINT during a dispatched mutation without publishing success", async () => {
    const f = await fixture();
    try {
      let received: () => void = () => {};
      const ready = new Promise<void>((resolve) => { received = resolve; });
      const { requests } = await f.serve((_request, response) => { response.writeHead(201, { "Content-Type": "application/json" }); response.write('{"id":'); received(); });
      const running = f.start(["create", "--title", "Cancelled", ...explicit]);
      await Promise.race([ready, running.result.then((result) => { throw new Error(`Task exited before the mutation reached the server: ${result.code}: ${result.stderr}`); })]);
      expect(running.child.kill("SIGINT")).toBe(true);
      const cancelled = await running.result;
      expect(cancelled.code).toBe(1); expect(cancelled.stdout).toBe("");
      for (const value of ["task.create", projectId, "cancelled", "SIGINT", "unconfirmed"]) expect(cancelled.stderr).toContain(value);
      expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    } finally { await f.close(); }
  }, 30_000);
});
