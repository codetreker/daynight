import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import type { Task, TaskAttachment } from "../../src/api/types.js";
import type { Result } from "../fixtures/compiled-task.js";
import { withTaskObservation, withGraphObservations } from "../fixtures/task-observation.js";
import { projectId, taskId, secondId, thirdId, accountId, time, project, task, taskListItem, graph, taskPath, projectPath, blockedReview, respond, refuse, fixture, explicit } from "../fixtures/compiled-task.js";

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
  it("keeps all operation help and malformed arguments independent of configuration and business imports", async () => {
    const f = await fixture();
    try {
      const helpBlocked = ["/api/", "/config/", "/repository/", "/commands/server/", "/commands/task/rendering.js", "better-sqlite3"];
      const checkHelp = (args: readonly string[], result: Pick<Result, "code" | "stdout" | "stderr">) => {
        expect(result.code, `${JSON.stringify(args)}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("Usage: daynight task");
        expect(result.stderr).toBe("");
        if (args[0] === "list") {
          expect(result.stdout).toContain("Print task fields except description as JSON");
          expect(result.stdout).toContain("--json remains an array, omits description");
        } else if (["ready", "show", "graph"].includes(args[0]!)) {
          expect(result.stdout).toContain("Print the complete API resource data as JSON");
        }
      };
      for (const args of [[], ["attachment", "put", "--help"]]) checkHelp(args, await f.invoke(args, { blocked: helpBlocked }));
      const helpArgs = [["--help"], ...["create", "list", "ready", "show", "update", "set-status", "delete", "graph"].map((name) => [name, "--help"]), ["attachment"], ["attachment", "--help"], ...["list", "read", "remove"].map((name) => ["attachment", name, "--help"])];
      (await f.invokeBatch(helpArgs, helpBlocked)).forEach((result, index) => checkHelp(helpArgs[index]!, result));

      const validationBlocked = ["/api/client.js", "/api/operation.js", "/config/", "/repository/", "/commands/server/", "/commands/task/rendering.js", "better-sqlite3"];
      const checkInvalid = (args: readonly string[], result: Pick<Result, "code" | "stdout" | "stderr">) => {
        expect(result.code, `${JSON.stringify(args)}: ${result.stderr}`).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("Unexpected module import");
        expect(result.stderr).not.toContain("configuration file");
      };
      for (const args of [["create"], ["attachment", "put", taskId, "missing.txt", "--path", "../escape"]]) checkInvalid(args, await f.invoke(args, { blocked: validationBlocked }));
      const invalidArgs = [
        ["create", "--title", "\u0085"], ["update", taskId],
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
        ["attachment", "read", taskId, "/absolute"], ["attachment", "remove", taskId, "a//b"],
      ];
      (await f.invokeBatch(invalidArgs, validationBlocked)).forEach((result, index) => checkInvalid(invalidArgs[index]!, result));
      await expect(readdir(f.home)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(f.caller)).toEqual([]);
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
      expect(requests.filter(({ pathname }) => pathname === projectPath)).toHaveLength(1);
      expect(await readdir(f.caller)).toEqual([]);
      expect(await readdir(path.join(f.home, ".daynight"))).toEqual(["config.yml"]);
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
