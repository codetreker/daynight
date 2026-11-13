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
import { actorId as observationActorId, observedFixtureResponse, withTaskObservation, withGraphObservations, workPage } from "../fixtures/task-observation.js";

const executable = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const projectId = "a1b2c3d4-1111-4222-8333-123456789abc";
const taskId = "b1b2c3d4-1111-4222-8333-123456789abc";
const secondId = "b1b2c3d4-1111-4222-8333-123456789abd";
const thirdId = "b1b2c3d4-1111-4222-8333-123456789abe";
const accountId = "a1b2c3d4-1111-4222-8333-123456789abe";
const time = "2026-10-20T00:00:00.123456789Z";
const project: Project = { id: projectId, name: "Project 中文", repoUrl: "git@git.example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: time, updatedAt: time };
const task = (partial: Partial<Task> = {}): Task => ({ type: "task", parentId: null, id: taskId, projectId, title: "Task 中文", description: "", tags: [], properties: { pullRequests: [] }, status: "todo", allowAgents: false, assignedTo: null, requiredPlatform: null, version: 1n, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, ...partial });
const taskListItem = (value: Task) => withTaskObservation({
  type: value.type, parentId: value.parentId, id: value.id, projectId: value.projectId, title: value.title, tags: value.tags, properties: value.properties,
  status: value.status, allowAgents: value.allowAgents, assignedTo: value.assignedTo, requiredPlatform: value.requiredPlatform, version: value.version, startedAt: value.startedAt, completedAt: value.completedAt, cancelledAt: value.cancelledAt, createdAt: value.createdAt, updatedAt: value.updatedAt,
  dependsOn: value.dependsOn, externalDependsOn: value.externalDependsOn, blockedBy: value.blockedBy, ready: value.ready,
});
const graph = (): TaskGraph => ({
  observedAt: time,
  project,
  summary: { total: 1, proposed: 0, todo: 1, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 0 },
  tasks: [{ type: "task", parentId: null, id: taskId, titlePreview: "Task 中文", titleTruncated: false, allowAgents: false, assignedTo: null, requiredPlatform: null, status: "todo", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time }],
});
const taskPath = `/api/v1/projects/${projectId}/tasks`;
const projectPath = `/api/v1/projects/${projectId}`;
const blockedReview = ["/commands/review/runtime.js", "/commands/review/store.js", "/commands/review/adapters/", "better-sqlite3"];
const blockedExplicit = ["/repository/", ...blockedReview];
const respond = (response: ServerResponse, value: unknown, status = 200): void => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(stringifyApiJson(status === 200 ? observedFixtureResponse(value, response.req.url!) : value)); };
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
  return { root, home, caller, invoke, start, serve, git, initializeRepository, close };
};

const explicit = ["--project", projectId];

describe("compiled Task Session observation commands", () => {
  it("preserves old-service Task JSON and returns partial exit 3 from the real command runtime", async () => {
    const f = await fixture();
    try {
      const { requests } = await f.serve((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(stringifyApiJson(task()));
      });
      const result = await f.invoke(["show", taskId, "--json", ...explicit]);
      expect(result.code, result.stderr).toBe(3);
      expect(parseApiJson(result.stdout)).toMatchObject({ id: taskId, session: { observation: "unsupported", observedAt: null, send: { allowed: null } } });
      expect(result.stderr).toContain("Upgrade the Daynight service");
      expect(requests.filter(request => request.pathname === `${taskPath}/${taskId}`)).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("prints one grouped JSON page and forwards its cursor through the compiled CLI", async () => {
    const f = await fixture();
    try {
      const { requests } = await f.serve((_request, response) => {
        response.setHeader("Daynight-User-ID", observationActorId);
        respond(response, workPage);
      });
      const result = await f.invoke(["list", "--status", "in_progress", "--group-by", "chain", "--cursor", "group+/=", "--json", ...explicit]);
      expect(result.code, result.stderr).toBe(0);
      expect(parseApiJson(result.stdout)).toEqual(workPage);
      expect(result.stderr).toBe("");
      expect(requests.filter(request => request.pathname.endsWith("/task-work")).map(request => Object.fromEntries(request.query))).toEqual([{ assignedTo: "me", cursor: "group+/=" }]);
    } finally { await f.close(); }
  });
});

describe("compiled Task Thread commands", () => {
  const accountId = "aabbccdd-1111-4111-8111-111111111111";
  const messageId = "dddddddd-1111-4111-8111-111111111111";
  const threadPath = `${taskPath}/${taskId}/thread/messages`;
  const threadMessage = { id: messageId, author: { userId: accountId, displayName: null, Agent: false }, createdAt: "2026-11-03T10:20:30.000Z", body: "  中文\n\tId: forged\nHas more messages after...\n" };

  it("performs one real HTTP request per explicit read/post and ships help/manual discovery", async () => {
    const f = await fixture();
    try {
      const { requests } = await f.serve((request, response) => {
        response.setHeader("Daynight-User-ID", accountId);
        if (request.pathname !== threadPath) { refuse(response, "not_found", "unexpected", 404); return; }
        if (request.method === "GET") respond(response, { items: [threadMessage], hasMoreBefore: true, hasMoreAfter: true });
        else respond(response, { ...threadMessage, body: (request.body as { body: string }).body }, 201);
      });
      const help = await f.invoke(["thread", "read", "--help"]);
      expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain("default: 20");
      const invalid = await f.invoke(["thread", "read", taskId, "--json", ...explicit]);
      expect(invalid.code).toBe(2); expect(invalid.stdout).toBe(""); expect(requests).toHaveLength(0);
      const read = await f.invoke(["thread", "read", taskId, ...explicit]);
      expect(read.code, read.stderr).toBe(0); expect(read.stderr).toBe("");
      expect(read.stdout).toContain(`Author: Account (${accountId})`);
      expect(read.stdout).toContain("Message:\n    中文\n  \tId: forged\n  Has more messages after...\n  ");
      expect(read.stdout.startsWith("... Has more messages before\n")).toBe(true);
      expect(read.stdout.endsWith("Has more messages after...\n")).toBe(true);
      expect(requests).toHaveLength(1); expect(requests[0]!.query.get("count")).toBe("20");
      const posted = await f.invoke(["thread", "post", taskId, `--body=${threadMessage.body}`, ...explicit]);
      expect(posted.code, posted.stderr).toBe(0); expect(posted.stderr).toBe("");
      expect(posted.stdout).toBe(`Message posted.\nId: ${messageId}\n`);
      expect(requests).toHaveLength(2); expect(requests.map(({ method }) => method)).toEqual(["GET", "POST"]);
      expect(requests[1]!.body).toEqual({ body: threadMessage.body });
      expect(requests.every(({ pathname }) => pathname === threadPath)).toBe(true);
    } finally { await f.close(); }
  });

  it("keeps unknown and definite POST failures distinct without leaking server text or replaying", async () => {
    const f = await fixture();
    try {
      let mode: "clock" | "unknown" | "invalid" = "clock";
      const { requests } = await f.serve((_request, response) => {
        if (mode === "invalid") {
          response.writeHead(201, { "Content-Type": "application/json", "Daynight-User-ID": accountId });
          response.end(JSON.stringify(threadMessage).replace('"body":', '"body":"secret Markdown","body":'));
        } else respond(response, { error: { code: mode === "clock" ? "clock_not_advanced" : "message_outcome_unknown", requestId: "thread-failure", message: "secret Markdown and credentials" } }, 503);
      });
      const args = ["thread", "post", taskId, `--body=${threadMessage.body}`, ...explicit];
      const definite = await f.invoke(args);
      expect(definite.code).toBe(1); expect(definite.stdout).toBe("");
      expect(definite.stderr).toContain("code=clock_not_advanced"); expect(definite.stderr).not.toContain("outcome is unknown");
      for (const next of ["unknown", "invalid"] as const) {
        mode = next;
        const unknown = await f.invoke(args);
        expect(unknown.code).toBe(1); expect(unknown.stdout).toBe("");
        expect(unknown.stderr).toContain("The posting outcome is unknown.");
        expect(unknown.stderr).not.toContain("secret"); expect(unknown.stderr).not.toContain("Id: forged");
      }
      expect(requests).toHaveLength(3);
    } finally { await f.close(); }
  });
});

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
        expect(Object.fromEntries(requests.at(-1)!.query)).toEqual({ ready: "true", allowAgents: String(allowAgents), limit: "100", include: "session" });
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
          expect(result.stdout).toContain("--json remains an array, omits description");
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
        ["show", "invalid"], ["list", "--project", "invalid"], ["list", "--ready", "false"], ["list", "--all", "--status", "todo"], ["list", "--status", "done", "--all"],
        ["graph"], ["graph", "invalid"], ["graph", "--depends-only"], ["graph", taskId, "--unknown"],
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
        summary: { total: 3, proposed: 0, todo: 1, inProgress: 0, done: 2, cancelled: 0, ready: 1, blocked: 0 },
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
        const args = (command === "show" || command === "graph") ? [command, taskId] : [command];
        const human = await f.invoke([...args, ...explicit]);
        expect(human.code, human.stderr).toBe(0);
        expect(human.stdout).toContain("Automatic execution: true");
        expect(human.stdout).toContain(`Depends on: ${secondId}, ${thirdId}`);
        expect(human.stdout).toContain(`External dependencies (1): ${thirdId}`);
        const json = await f.invoke([...args, "--json", ...explicit]);
        expect(json.code, json.stderr).toBe(0);
        const resource = parseApiJson(json.stdout);
        expect(resource).toEqual(command === "list" ? [taskListItem(current)] : command === "ready" ? [current] : command === "graph" ? withGraphObservations(graphValue, taskId) : withTaskObservation(current));
        if (command === "list") expect(resource).not.toHaveProperty("0.description");
        if (command !== "graph") expect(json.stdout).toContain('"version":9223372036854775807');
      }
    } finally { await f.close(); }
  }, 60_000);

  it("audits complete dependency IDs through the compiled CLI while keeping external prerequisites at one layer", async () => {
    const f = await fixture();
    try {
      const value: TaskGraph = {
        ...graph(), summary: { total: 2, proposed: 0, todo: 2, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 2 },
        tasks: [
          { ...graph().tasks[0]!, dependsOn: [secondId], externalDependsOn: [secondId], blockedBy: [secondId], ready: false },
          { ...graph().tasks[0]!, id: secondId, dependsOn: [thirdId], blockedBy: [thirdId], ready: false },
        ],
      };
      const { requests } = await f.serve((request, response) => {
        expect(Object.fromEntries(request.query)).toEqual({ taskId });
        respond(response, value);
      });
      const human = await f.invoke(["graph", taskId.toUpperCase(), "--depends-only", ...explicit]);
      expect(human.code, human.stderr).toBe(0);
      expect(human.stdout).toBe(`ID: ${taskId}\nDepends on: ${secondId}\nExternal dependencies: ${secondId}\n\nID: ${secondId}\nDepends on: ${thirdId}\nExternal dependencies: none\n`);
      const json = await f.invoke(["graph", taskId, "--depends-only", "--json", ...explicit]);
      expect(json.code, json.stderr).toBe(0);
      expect(parseApiJson(json.stdout)).toEqual([
        { id: taskId, dependsOn: [secondId], externalDependsOn: [secondId] },
        { id: secondId, dependsOn: [thirdId], externalDependsOn: [] },
      ]);
      expect(requests.filter(({ pathname }) => pathname.endsWith("/task-graph"))).toHaveLength(2);
    } finally { await f.close(); }
  });

  it("soft-deletes through the compiled entrypoint with observed and explicit exact versions", async () => {
    const f = await fixture();
    try {
      const current = task({ version: 9_007_199_254_740_993n });
      const { requests } = await f.serve((request, response) => {
        if (request.method === "DELETE") { response.writeHead(204); response.end(); }
        else respond(response, current);
      });
      for (const { version, removeDepends } of [false, true].flatMap((removeDepends) => [undefined, "9223372036854775807"].map((version) => ({ version, removeDepends })))) {
        const before = requests.length;
        const result = await f.invoke(["delete", taskId.toUpperCase(), ...(removeDepends ? ["--remove-depends"] : []), ...(version === undefined ? [] : ["--if-version", version]), ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(`Task deleted. Stored data and attachments are retained.\nID: ${taskId}\nProject: ${projectId}\n`);
        expect(requests.slice(before).map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
          `GET ${projectPath}`, `GET ${taskPath}/${taskId}`, `DELETE ${taskPath}/${taskId}`,
        ]);
        expect(requests.at(-1)!.bodyText).toBe(`{"version":${version === undefined ? current.version : version}${removeDepends ? ",\"removeDepends\":true" : ""}}`);
      }
    } finally { await f.close(); }
  }, 60_000);

  it("sets all task statuses with precise observed or supplied versions and same-status no-ops", async () => {
    const f = await fixture();
    try {
      let current = task({ requiredPlatform: "windows", description: "Status details", version: 9_007_199_254_740_993n });
      const { requests } = await f.serve((request, response) => {
        if (request.method === "POST") current = { ...current, assignedTo: (request.body as { assignedTo: string }).assignedTo };
        if (request.method === "PUT") {
          const { status } = request.body as { status: Task["status"] };
          if (current.status !== status) current = { ...current, status, ready: status === "todo", version: current.version + 1n };
        }
        respond(response, current, request.pathname === taskPath ? 201 : 200);
      });
      const created = await f.invoke(["create", "--title", "Status", "--status", "todo", ...explicit]);
      expect(created.code, created.stderr).toBe(0);
      expect(created.stdout).toContain("Status: todo");
      for (const status of ["todo", "proposed", "in_progress", "done", "todo"] as const) {
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
        expect(requests.slice(before).map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `GET ${taskPath}/${taskId}`, `PUT ${taskPath}/${taskId}/status`]);
        expect(requests.at(-1)!.body).toEqual({ version, status });
        expect(requests.at(-1)!.bodyText).toBe(`{"version":${version},"status":"${status}"}`);
      }
    } finally { await f.close(); }
  }, 60_000);

  it("round-trips Markdown bytes through creation, replacement and status changes", async () => {
    const f = await fixture();
    const original = "# 需求 中文😀\r\n\r\n- [ ] one\r\n\r\n```ts\r\nconst a = '<&>';\r\n```\r\n[链接](docs/plan.md)\r\n";
    const replacement = "# Revised\n\n> 引用 😀\n\n| A | B |\n| - | - |\n| 1 | 2 |\n";
    try {
      let current = task({ version: 9_007_199_254_740_993n });
      const { requests } = await f.serve((request, response) => {
        const body = request.body as { description?: string; title?: string; status?: Task["status"]; version?: bigint } | null;
        if (request.method === "POST") current = { ...current, title: body!.title!, description: body!.description!, assignedTo: accountId };
        if (request.method === "PATCH") current = { ...current, description: body!.description!, version: current.version + 1n };
        if (request.method === "PUT") current = { ...current, status: body!.status!, ready: body!.status === "todo", version: current.version + 1n };
        respond(response, current, request.method === "POST" ? 201 : 200);
      });
      const created = await f.invoke(["create", "--title", "Markdown", "--status", "todo", "--description", original, ...explicit]);
      expect(created.code, created.stderr).toBe(0);
      expect(requests.at(-1)!.body).toEqual({ title: "Markdown", status: "todo", description: original, assignedTo: accountId });
      const readOriginal = await f.invoke(["show", taskId, "--json", ...explicit]);
      expect(readOriginal.code, readOriginal.stderr).toBe(0);
      expect(Buffer.from((parseApiJson(readOriginal.stdout) as Task).description)).toEqual(Buffer.from(original));
      const changed = await f.invoke(["update", taskId, "--description", replacement, ...explicit]);
      expect(changed.code, changed.stderr).toBe(0);
      expect(requests.at(-1)!.body).toEqual({ version: 9_007_199_254_740_993n, description: replacement });
      for (const status of ["in_progress", "done"] as const) {
        const before = current.version;
        const result = await f.invoke(["set-status", taskId, status, ...explicit]);
        expect(result.code, result.stderr).toBe(0); expect(requests.at(-1)!.body).toEqual({ version: before, status });
        const read = await f.invoke(["show", taskId, "--json", ...explicit]);
        expect(read.code, read.stderr).toBe(0);
        expect(Buffer.from((parseApiJson(read.stdout) as Task).description)).toEqual(Buffer.from(replacement));
      }
    } finally { await f.close(); }
  }, 30_000);

  it("lists unfinished tasks in stable global priority order and includes both terminal statuses with --all", async () => {
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
      const cancelledFirst = identifiedTask("09", "Cancelled first", { status: "cancelled", cancelledAt: time, ready: false });
      const cancelledSecond = identifiedTask("10", "Cancelled second", { status: "cancelled", cancelledAt: time, ready: false });
      const proposedFirst = identifiedTask("11", "Proposed first", { status: "proposed", ready: false, allowAgents: true });
      const proposedSecond = identifiedTask("12", "Proposed second", { status: "proposed", ready: false });
      const cursor = "next priority page+/=?";
      const { requests } = await f.serve((request, response) => respond(response, request.query.has("cursor")
        ? { items: [proposedSecond, readySecond, progressSecond, blockedSecond, doneSecond, cancelledSecond], nextCursor: null }
        : { items: [blockedFirst, doneFirst, proposedFirst, readyFirst, progressFirst, cancelledFirst], nextCursor: cursor }));
      const unfinished = [progressFirst, progressSecond, readyFirst, readySecond, blockedFirst, blockedSecond, proposedFirst, proposedSecond];
      for (const includeAll of [false, true]) {
        const args = ["list", ...(includeAll ? ["--all"] : []), ...explicit];
        const expected = includeAll ? [...unfinished, doneFirst, cancelledFirst, doneSecond, cancelledSecond] : unfinished;
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
        { limit: "100", include: "session" }, { limit: "100", include: "session", cursor },
      ]).flat());
    } finally { await f.close(); }
  }, 60_000);

  it("preserves Task timestamps in JSON and shows Session observation times in text", async () => {
    const f = await fixture();
    try {
      const completed = task({ status: "done", ready: false, startedAt: "2026-10-19T23:00:00Z", completedAt: time, cancelledAt: null });
      const value: TaskGraph = {
        observedAt: time, project,
        summary: { total: 1, proposed: 0, todo: 0, inProgress: 0, done: 1, cancelled: 0, ready: 0, blocked: 0 },
        tasks: [{ ...graph().tasks[0]!, status: "done", ready: false, startedAt: completed.startedAt, completedAt: completed.completedAt, cancelledAt: null }],
      };
      await f.serve((request, response) => respond(response, request.pathname.endsWith("/task-graph") ? value
        : request.pathname === taskPath ? { items: [completed], nextCursor: null } : completed));
      const shown = await f.invoke(["show", taskId, "--json", ...explicit]);
      expect(shown.code, shown.stderr).toBe(0);
      expect(parseApiJson(shown.stdout)).toEqual(withTaskObservation(completed));
      const listed = await f.invoke(["list", "--all", "--json", ...explicit]);
      expect(listed.code, listed.stderr).toBe(0);
      expect(parseApiJson(listed.stdout)).toEqual([taskListItem(completed)]);
      const graphed = await f.invoke(["graph", taskId, "--json", ...explicit]);
      expect(graphed.code, graphed.stderr).toBe(0);
      expect(parseApiJson(graphed.stdout)).toEqual(withGraphObservations(value, taskId));
      const text = await f.invoke(["list", "--all", ...explicit]);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).not.toMatch(/Started:|Completed:/);
    } finally { await f.close(); }
  }, 60_000);

  it("rejects unknown status resources and filters", async () => {
    const f = await fixture();
    try {
      const { requests } = await f.serve((_request, response) => respond(response, { ...task(), status: "unknown", ready: false }));
      const shown = await f.invoke(["show", taskId, ...explicit]);
      expect(shown.code).toBe(1);
      expect(shown.stdout).toBe("");
      const before = requests.length;
      for (const args of [["list", "--status", "unknown"], ["set-status", taskId, "unknown"], ...["approve", "unapprove", "claim", "complete"].map((action) => [action, taskId])]) {
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
      const cancelledTask = task({ id: "dddddddd-4444-4444-8444-444444444444", status: "cancelled", cancelledAt: time, ready: false });
      const items = [doneTask, readyTask, progressTask, cancelledTask];
      const { requests } = await f.serve((request, response) => respond(response, {
        items: items.filter((item) => (!request.query.has("status") || item.status === request.query.get("status")) && (!request.query.has("ready") || item.ready)),
        nextCursor: null,
      }));
      const cases: readonly { args: readonly string[]; expected: readonly Task[]; query: Record<string, string> }[] = [
        { args: ["--status", "done"], expected: [doneTask], query: { status: "done", limit: "100" } },
        { args: ["--status", "cancelled"], expected: [cancelledTask], query: { status: "cancelled", limit: "100" } },
        { args: ["--ready"], expected: [readyTask], query: { ready: "true", limit: "100" } },
        { args: ["--all", "--ready"], expected: [readyTask], query: { ready: "true", limit: "100" } },
        { args: ["--status", "todo", "--ready"], expected: [readyTask], query: { status: "todo", ready: "true", limit: "100" } },
        { args: ["--status", "in_progress", "--ready"], expected: [], query: { status: "in_progress", ready: "true", limit: "100" } },
        { args: ["--status", "done", "--ready"], expected: [], query: { status: "done", ready: "true", limit: "100" } },
        { args: ["--status", "cancelled", "--ready"], expected: [], query: { status: "cancelled", ready: "true", limit: "100" } },
      ];
      for (const { args, expected, query } of cases) {
        const result = await f.invoke(["list", ...args, "--json", ...explicit]);
        expect(result.code, result.stderr).toBe(0);
        const listed = parseApiJson(result.stdout) as Record<string, unknown>[];
        expect(listed).toEqual(expected.map(taskListItem));
        for (const item of listed) expect(item).not.toHaveProperty("description");
        expect(Object.fromEntries(requests.at(-1)!.query)).toEqual({ ...query, include: "session" });
      }
    } finally { await f.close(); }
  }, 60_000);

  it("prints empty text and JSON when only terminal tasks remain", async () => {
    const f = await fixture();
    try {
      await f.serve((_request, response) => respond(response, { items: [task({ status: "done", ready: false }), task({ id: secondId, status: "cancelled", cancelledAt: time, ready: false })], nextCursor: null }));
      const text = await f.invoke(["list", ...explicit]);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toBe("No tasks.\n");
      const json = await f.invoke(["list", "--json", ...explicit]);
      expect(json.code, json.stderr).toBe(0);
      expect(parseApiJson(json.stdout)).toEqual([]);
      expect(json.stdout).toBe("[]\n");
    } finally { await f.close(); }
  }, 60_000);

  it("preserves raw property values through setting, current-value reads, task reads and removal", async () => {
    const f = await fixture();
    try {
      const supplied = [{ url: "", title: "" }, { url: "-arbitrary=a,b", title: " 标题\n\u001b[2J " }, { url: "-arbitrary=a,b", title: " 标题\n\u001b[2J " }, { url: "\0not a URL", title: "\0" }];
      const valueText = JSON.stringify(supplied);
      let current = task({ title: "Task 中文\n\u001b[2J", description: "Full description\n\u001b[2J", properties: { future: { version: 7 } }, version: 9_007_199_254_740_993n });
      let conflict = false;
      const resource = () => ({ projectId, taskId, version: current.version, properties: current.properties });
      const { requests } = await f.serve((request, response) => {
        if (request.pathname === `${taskPath}/${taskId}/properties`) respond(response, resource());
        else if (request.pathname === `${taskPath}/${taskId}/properties/pullRequests`) {
          if (conflict) { refuse(response, "version_conflict", "property-conflict", 409); return; }
          const input = request.body as { version: bigint; valueText?: string };
          const properties = Object.fromEntries(Object.entries(current.properties).filter(([name]) => name !== "pullRequests"));
          current = { ...current, version: input.version + 1n, properties: request.method === "DELETE" ? properties : { ...properties, pullRequests: JSON.parse(input.valueText!) } };
          respond(response, resource());
        } else if (request.pathname === taskPath) respond(response, { items: [current], nextCursor: null });
        else respond(response, current);
      });
      const set = await f.invoke(["set-property", taskId, "pullRequests", valueText, ...explicit]);
      expect(set.code, set.stderr).toBe(0);
      expect(requests.map(({ method, pathname }) => [method, pathname])).toEqual([
        ["GET", `${taskPath}/${taskId}/properties`], ["PUT", `${taskPath}/${taskId}/properties/pullRequests`],
      ]);
      expect(requests.at(-1)!.body).toEqual({ version: 9_007_199_254_740_993n, valueText });
      expect(set.stdout).toContain("Task property set.");
      expect(set.stdout).toContain('"url":"\\u0000not a URL","title":"\\u0000"');
      expect(set.stdout).not.toContain("Description:");
      const values = await f.invoke(["properties", taskId, "--json", ...explicit]);
      expect(values.code, values.stderr).toBe(0); expect(parseApiJson(values.stdout)).toEqual(resource());
      for (const command of [["show", taskId], ["list"]]) {
        const json = await f.invoke([...command, "--json", ...explicit]);
        expect(json.code, json.stderr).toBe(0);
        const parsed = parseApiJson(json.stdout);
        expect(parsed).toEqual(command[0] === "list" ? [taskListItem(current)] : withTaskObservation(current));
        if (command[0] === "list") expect((parsed as Record<string, unknown>[])[0]).not.toHaveProperty("description");
        else expect(parsed).toHaveProperty("description", current.description);
        expect(json.stdout).toContain(`"version":${current.version}`);
        const text = await f.invoke([...command, ...explicit]);
        expect(text.code, text.stderr).toBe(0);
        expect(text.stdout).toContain(" 标题\\n\\u001b[2J "); expect(text.stdout).toContain("\\u0000not a URL");
        expect(text.stdout).toContain('future: {"version":7}'); expect(text.stdout).not.toContain("\u001b");
      }
      const clearAt = requests.length;
      const clearVersion = current.version;
      const cleared = await f.invoke(["set-property", taskId, "pullRequests", "[]", "--if-version", String(clearVersion), ...explicit]);
      expect(cleared.code, cleared.stderr).toBe(0); expect(cleared.stdout).toContain("pullRequests: []");
      expect(requests.slice(clearAt).map(({ method }) => method)).toEqual(["PUT"]);
      expect(requests.at(-1)!.body).toEqual({ version: clearVersion, valueText: "[]" });
      const removeAt = requests.length;
      const removed = await f.invoke(["remove-property", taskId, "pullRequests", "--if-version", String(current.version), ...explicit]);
      expect(removed.code, removed.stderr).toBe(0); expect(removed.stdout).toContain("Task property removed.");
      expect(removed.stdout).not.toContain("pullRequests:"); expect(requests.slice(removeAt).map(({ method }) => method)).toEqual(["DELETE"]);
      expect(current.properties).toEqual({ future: { version: 7 } });
      conflict = true;
      const conflictAt = requests.length;
      const refused = await f.invoke(["set-property", taskId, "pullRequests", valueText, ...explicit]);
      expect(refused.code).toBe(1); expect(refused.stdout).toBe(""); expect(refused.stderr).toContain("property-conflict");
      expect(requests.slice(conflictAt).map(({ method }) => method)).toEqual(["GET", "PUT"]);
    } finally { await f.close(); }
  }, 60_000);

  it("reads the server schema outside Git without loading repository modules", async () => {
    const f = await fixture();
    try {
      const schema = { properties: { future: { description: "Future definition", readOnly: false, schema: { type: "string", custom: { version: 7 } } } } };
      const { requests } = await f.serve((_request, response) => respond(response, schema));
      const result = await f.invoke(["properties", "--schema", "--json"]);
      expect(result.code, result.stderr).toBe(0); expect(parseApiJson(result.stdout)).toEqual(schema);
      expect(requests.map(({ method, pathname }) => [method, pathname])).toEqual([["GET", "/api/v1/task-properties/schema"]]);
    } finally { await f.close(); }
  });

  it("requests a single bounded ready page and preserves full task JSON and empty output", async () => {
    const f = await fixture();
    try {
      let items = [task({ description: "Ready details", properties: { pullRequests: [{ url: "\0 arbitrary URL", title: "Ready\nPR" }] }, version: 9_223_372_036_854_775_807n })];
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
      expect(text.stdout).toContain('"url":"\\u0000 arbitrary URL","title":"Ready\\nPR"');
      for (const field of ["Description: Ready details", "Version: 9223372036854775807", `Created: ${time}`, `Updated: ${time}`]) expect(text.stdout).toContain(field);
      items = []; cursor = null;
      const empty = await f.invoke(["ready", ...explicit]);
      expect(empty.code, empty.stderr).toBe(0); expect(empty.stdout).toBe("No ready tasks.\n");
      expect(Object.fromEntries(requests.at(-1)!.query)).toEqual({ ready: "true", limit: "10" });
      expect(await readdir(f.caller)).toEqual([]);
    } finally { await f.close(); }
  }, 60_000);

  it("defaults creation to the signed-in account and skips identity lookup for an explicit assignee", async () => {
    const f = await fixture();
    try {
      const { requests } = await f.serve((request, response) => respond(response, task({ assignedTo: (request.body as { assignedTo: string }).assignedTo, status: "proposed", ready: false }), 201));
      const created = await f.invoke(["create", "--title", "My task", ...explicit]);
      expect(created.code, created.stderr).toBe(0);
      expect(created.stdout).toContain(`Assigned to: ${accountId}\n`);
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, "GET /api/v1/me", `POST ${taskPath}`]);
      expect(requests.at(-1)!.body).toEqual({ title: "My task", assignedTo: accountId });
      requests.length = 0;
      const assigned = await f.invoke(["create", "--title", "Colleague task", "--assigned-to", secondId.toUpperCase(), ...explicit]);
      expect(assigned.code, assigned.stderr).toBe(0);
      expect(assigned.stdout).toContain(`Assigned to: ${secondId}\n`);
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `POST ${taskPath}`]);
      expect(requests.at(-1)!.body).toEqual({ title: "Colleague task", assignedTo: secondId });
    } finally { await f.close(); }
  });

  it("creates, shows, lists and graphs explicit projects without Git or repository imports", async () => {
    const f = await fixture();
    try {
      const title = "Task 中文\n\u001b[31m";
      const createdTask = task({ title, status: "proposed", assignedTo: accountId, dependsOn: [secondId], blockedBy: [secondId], ready: false });
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
      expect(requests.find(({ method }) => method === "POST")!.body).toEqual({ title, description: "", assignedTo: accountId, dependsOn: [secondId], externalDependsOn: [] });

      const shown = await f.invoke(["show", taskId.toUpperCase(), "--project", projectId.toUpperCase(), "--json"]);
      expect(shown.code, shown.stderr).toBe(0);
      expect(parseApiJson(shown.stdout)).toEqual(withTaskObservation(createdTask));

      const listed = await f.invoke(["list", "--status", "todo", "--ready", "--json", ...explicit]);
      expect(listed.code, listed.stderr).toBe(0);
      expect(parseApiJson(listed.stdout)).toEqual([task(), second].map(taskListItem));
      const pages = requests.filter(({ pathname }) => pathname === taskPath).filter(({ method }) => method === "GET");
      expect(pages.map(({ query }) => Object.fromEntries(query))).toEqual([
        { status: "todo", ready: "true", limit: "100", include: "session" }, { status: "todo", ready: "true", limit: "100", include: "session", cursor },
      ]);
      const graphed = await f.invoke(["graph", taskId, "--json", ...explicit]);
      expect(graphed.code, graphed.stderr).toBe(0);
      expect(parseApiJson(graphed.stdout)).toEqual(withGraphObservations(graph(), taskId));
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
      const { requests } = await f.serve((request, response) => respond(response, request.method === "GET" ? current : { ...current, ...(request.method === "POST" ? { status: "proposed", ready: false } : {}), ...(request.body as object), version: current.version + 1n }, request.method === "POST" ? 201 : 200));
      const cases = [
        { args: ["create", "--title", "Mixed", "--depends-on", thirdId.toUpperCase(), "--external-depends-on", secondId], body: { title: "Mixed", assignedTo: accountId, dependsOn: [secondId, thirdId], externalDependsOn: [secondId] } },
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
        expect(requests.map(({ method }) => method)).toEqual(["GET", ...(update ? [] : ["GET"]), update ? "PATCH" : "POST"]);
        expect(requests.at(-1)!.body).toEqual({ ...(update ? { version: 9_223_372_036_854_775_807n } : {}), ...body });
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
      expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`GET ${projectPath}`, `GET ${taskPath}/${taskId}`, `PUT ${taskPath}/${taskId}/status`]);
      expect(requests[2]!.bodyText).toContain('"version":9223372036854775807');
      expect(requests[2]!.body).toEqual({ version: 9_223_372_036_854_775_807n, status: "done" });

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
        else if (mode === "graph") refuse(response, "internal_error", "task-graph-read", 500);
        else if (request.query.has("cursor")) refuse(response, "internal_error", "task-later-page", 500);
        else respond(response, { items: [task()], nextCursor: "later page" });
      });
      const failedPage = await f.invoke(["list", "--json", ...explicit]);
      expect(failedPage.code).toBe(1); expect(failedPage.stdout).toBe("");
      expect(failedPage.stderr).toContain("internal_error"); expect(failedPage.stderr).toContain("task-later-page");
      expect(requests.filter(({ pathname }) => pathname === taskPath)).toHaveLength(2);
      mode = "graph";
      const failedGraph = await f.invoke(["graph", taskId, "--json", ...explicit]);
      expect(failedGraph.code).toBe(1); expect(failedGraph.stdout).toBe("");
      for (const value of ["internal_error", "task-graph-read"]) expect(failedGraph.stderr).toContain(value);
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
          respond(response, task({ assignedTo: (request.body as { assignedTo: string }).assignedTo, status: "proposed", ready: false }), 201);
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
