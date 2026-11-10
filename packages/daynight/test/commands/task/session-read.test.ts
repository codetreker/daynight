import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../../src/api/index.js";
import type { Operation } from "../../../src/api/index.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runCli } from "../../../src/cli/application.js";
import { runTaskCommand } from "../../../src/commands/task/command.js";
import type { TaskCommandDependencies } from "../../../src/commands/task/command.js";
import { taskDefinition } from "../../../src/commands/task/definition.js";
import { actorId, inspection, project, projectId, sessionId, taskId } from "../../fixtures/task-observation.js";

const operations: Operation[] = [];
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); });
const fixture = (body: unknown, status = 200) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(stringifyApiJson(body), {
    status, headers: { "content-type": "application/json", "Daynight-User-ID": actorId },
  }));
  const operation = createOperation(); operations.push(operation);
  const api = createApiClient({ serverUrl: "http://localhost:8787", operation, fetch });
  const stdout: string[] = [], stderr: string[] = [];
  const context: CliContext = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: () => "unused", workingDirectory: () => "unused",
    stdout: value => { stdout.push(value); }, stderr: value => { stderr.push(value); },
    stdoutBytes: async bytes => { stdout.push(Buffer.from(bytes).toString("utf8")); },
  };
  const resolveProject = vi.fn<TaskCommandDependencies["resolveProject"]>(async () => project);
  const dependencies: TaskCommandDependencies = {
    resolveProject,
    runServerCommand: async (current, command) => {
      const output = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
      if (typeof output === "string") current.stdout(output);
    },
  };
  const run = (args: readonly string[]) => runCli(["task", "session", ...args], context, [{ ...taskDefinition, load: async () => ({ run: (values, current) => runTaskCommand(values, current, dependencies) }) }]);
  return { run, fetch, stdout, stderr, resolveProject, context };
};

describe("Task Session read commands", () => {
  it("discovers implemented read commands without making a request", async () => {
    const f = fixture(null);
    expect(await f.run(["--help"])).toBe(0);
    for (const name of ["current", "list", "show", "read", "entry"]) expect(f.stdout.join("")).toMatch(new RegExp(`\\b${name}\\b`));
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("inspects only the explicit Session and retains historical identity in JSON", async () => {
    const expected = { ...inspection, currentBinding: false, source: "archive", session: { ...inspection.session, send: { allowed: false, mode: null, reason: "historical_session" } } };
    const f = fixture(expected);
    expect(await f.run(["show", taskId, sessionId, "--project", projectId, "--json"])).toBe(0);
    expect(parseApiJson(f.stdout.join(""))).toEqual(expected);
    expect(new URL(String(f.fetch.mock.calls[0]![0])).pathname).toBe(`/api/v1/projects/${projectId}/tasks/${taskId}/sessions/${sessionId}/inspection`);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.resolveProject).not.toHaveBeenCalled();
    expect(f.stderr).toEqual([]);
  });

  it("renders the observed identity and readable source with terminal controls escaped", async () => {
    const f = fixture({ ...inspection, session: { ...inspection.session, reason: "idle\u001b[31m", nativeSessionId: "native\u0007identity" } });
    expect(await f.run(["show", taskId, sessionId])).toBe(0);
    const text = f.stdout.join("");
    expect(text).toContain(`Session: ${sessionId}`);
    expect(text).toContain("Source: live");
    expect(text).toContain("Current binding: true");
    expect(text).toContain("\\u001b[31m");
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    expect(f.resolveProject).toHaveBeenCalledOnce();
  });

  it.each([
    ["show", taskId, "native-id"], ["show", "not-a-task", sessionId],
    ["read", taskId, sessionId, "--limit", "0"], ["read", taskId, sessionId, "--limit", "201"],
    ["read", taskId, sessionId, "--limit", "1.5"], ["entry", taskId, sessionId],
    ["entry", taskId, sessionId, "--cursor", ""], ["current", taskId, "--project", "wrong-project"],
  ].map(args => ({ args }))) ("rejects invalid input without network activity $args", async ({ args }) => {
    const f = fixture(null);
    expect(await f.run(args)).toBe(2);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.resolveProject).not.toHaveBeenCalled();
    expect(f.stdout).toEqual([]);
  });

  it("preserves a definite permission refusal without looking up another Session", async () => {
    const f = fixture({ error: { code: "forbidden", message: "Session read is forbidden.\u001b[31m", requestId: "denied" } }, 403);
    expect(await f.run(["show", taskId, sessionId, "--project", projectId])).toBe(1);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.stdout).toEqual([]);
    expect(f.stderr.join("")).toContain("forbidden");
    expect(f.stderr.join("")).not.toContain("\u001b");
  });

  it("reports no current Session without asking for the directory", async () => {
    const f = fixture({ status: "not_applicable", claimId: null, agentControlMode: null, session: null });
    expect(await f.run(["current", taskId, "--project", projectId, "--json"])).toBe(0);
    expect(parseApiJson(f.stdout.join(""))).toEqual({ status: "not_applicable", claimId: null, agentControlMode: null, session: null });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("prints directory continuation without following it", async () => {
    const f = fixture({ items: [], nextCursor: "older-sessions" });
    expect(await f.run(["list", taskId, "--project", projectId, "--limit", "7", "--cursor", "current-page"])).toBe(0);
    expect(f.stdout.join("")).toContain(`daynight task session list ${taskId} --project ${projectId} --limit 7 --cursor 'older-sessions'`);
    expect(new URL(String(f.fetch.mock.calls[0]![0])).searchParams.get("cursor")).toBe("current-page");
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  const entryId = "55555555-5555-4555-8555-555555555555";
  const body = { entryId, entrySeq: "9", revision: "1", kind: "assistant_message", content: [{ type: "text", text: "first line\n第二行\u001b[31m\tend" }] };
  const message = { entryId, entrySeq: "9", revision: "1", kind: "assistant_message", role: "assistant", timestamp: null, body, truncated: false, contentRef: null, resources: [], resourcesTruncated: false };
  const page = { sessionId, historyEpoch: "epoch-1", source: "live", items: [message], beforeCursor: "older-page", hasMoreBefore: true, coverage: { state: "complete", reason: null }, observedAt: "2026-11-10T01:02:03Z" };

  it("renders real body lines safely and preserves the exact before query", async () => {
    const f = fixture(page);
    expect(await f.run(["read", taskId, sessionId, "--project", projectId, "--before", "requested-page", "--limit", "7"])).toBe(0);
    expect(f.stdout.join("")).toContain("first line\n第二行\\u001b[31m\\tend");
    expect(f.stdout.join("")).not.toContain("\u001b");
    expect(f.stdout.join("")).toContain(`--limit 7 --before 'older-page'`);
    expect(new URL(String(f.fetch.mock.calls[0]![0])).searchParams.get("before")).toBe("requested-page");
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("retains JSON message text without applying terminal escaping", async () => {
    const f = fixture(page);
    expect(await f.run(["read", taskId, sessionId, "--project", projectId, "--json"])).toBe(0);
    expect(parseApiJson(f.stdout.join(""))).toEqual(page);
    expect(f.stderr).toEqual([]);
  });

  it("renders Markdown, image references and unavailable images without downloading originals", async () => {
    const resourceId = "66666666-6666-4666-8666-666666666666", imageId = "77777777-7777-4777-8777-777777777777";
    const content = [
      { type: "markdown", text: "Markdown\n原文\u001b[31m", partId: "88888888-8888-4888-8888-888888888888", revision: "1", textSha256: "a".repeat(64), complete: true, truncated: false, bindings: [], retainedImages: [] },
      { type: "image", imageId, resourceId, label: "Original image" },
      { type: "image_unavailable", imageId: "99999999-9999-4999-8999-999999999999", label: "Missing image", error: { code: "source_unavailable", message: "Original unavailable." } },
      { type: "resource", resourceId, label: "Legacy\u0007resource" },
    ];
    const f = fixture({ ...page, items: [{ ...message, body: { ...body, imageProjectionError: null, content } }] });
    expect(await f.run(["read", taskId, sessionId, "--project", projectId])).toBe(0);
    const output = f.stdout.join("");
    expect(output).toContain("Markdown\n原文\\u001b[31m");
    expect(output).toContain(`Image reference: ${resourceId}; Original image`);
    expect(output).toContain("Image unavailable: Missing image; source_unavailable; Original unavailable.");
    expect(output).toContain("Legacy\\u0007resource");
    expect(output).not.toContain("undefined");
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("keeps empty conversation pages and their unfiltered continuation", async () => {
    const f = fixture({ ...page, items: [] });
    expect(await f.run(["read", taskId, sessionId, "--project", projectId, "--conversation"])).toBe(0);
    expect(f.stdout.join("")).toContain("No matching entries in this page.");
    expect(f.stdout.join("")).toContain("--conversation --before 'older-page'");
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("does not offer an earlier page when only the final boundary cursor remains", async () => {
    const f = fixture({ ...page, hasMoreBefore: false });
    expect(await f.run(["read", taskId, sessionId, "--project", projectId])).toBe(0);
    expect(f.stdout.join("")).toContain("No earlier page.");
    expect(f.stdout.join("")).not.toContain("Earlier:");
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("prints large-entry references and a one-block continuation command", async () => {
    const large = { ...message, body: null, truncated: true, contentRef: { cursor: "entry-start", sha256: "a".repeat(64), byteLength: "500000" } };
    const f = fixture({ ...page, items: [large] });
    expect(await f.run(["read", taskId, sessionId, "--project", projectId])).toBe(0);
    expect(f.stdout.join("")).toContain("500000");
    expect(f.stdout.join("")).toContain(`daynight task session entry ${taskId} ${sessionId} --project ${projectId} --cursor 'entry-start'`);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("returns one entry block with verification metadata and the next cursor", async () => {
    const chunk = { sessionId, historyEpoch: "epoch-1", source: "live", entryId, revision: "1", sha256: "a".repeat(64), byteLength: "4", offset: "0", fragment: "中", nextCursor: "entry-next", eof: false, observedAt: page.observedAt };
    const f = fixture(chunk);
    expect(await f.run(["entry", taskId, sessionId, "--project", projectId, "--cursor", "entry-start", "--json"])).toBe(0);
    expect(parseApiJson(f.stdout.join(""))).toEqual(chunk);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("prints partial archive evidence before exit 3", async () => {
    const partial = { ...page, source: "archive", coverage: { state: "partial", reason: "missing_entries" } };
    const f = fixture(partial);
    expect(await f.run(["read", taskId, sessionId, "--project", projectId, "--json"])).toBe(3);
    expect(parseApiJson(f.stdout.join(""))).toEqual(partial);
    expect(f.stderr.join("")).toMatch(/partial/i);
  });

  it.each(["entry_truncated", "resource_unavailable"])("keeps live %s evidence for references and empty conversation pages", async reason => {
    for (const conversation of [false, true]) {
      const partial = { ...page, items: conversation ? [] : [{ ...message, body: null, truncated: true, contentRef: { cursor: "entry-start", sha256: "a".repeat(64), byteLength: "500000" } }], coverage: { state: "partial", reason } };
      const f = fixture(partial);
      expect(await f.run(["read", taskId, sessionId, "--project", projectId, "--json", ...(conversation ? ["--conversation"] : [])])).toBe(3);
      expect(parseApiJson(f.stdout.join(""))).toEqual(partial);
      expect(f.stderr.join("")).toMatch(/partial/i);
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(new URL(String(f.fetch.mock.calls[0]![0])).searchParams.get("conversation")).toBe(conversation ? "true" : null);
    }
  });

  it.each(["reset_required", "content_changed", "upgrade_required", "unsupported_mode"]) ("explains %s without performing recovery", async code => {
    const f = fixture({ error: { code, message: "Read refused.", requestId: "read-refused" } }, 409);
    expect(await f.run(["read", taskId, sessionId, "--project", projectId])).toBe(1);
    expect(f.stderr.join("")).toContain(code);
    expect(f.stderr.join("")).toContain(code === "upgrade_required" ? "Upgrade" : code === "unsupported_mode" ? "Herdr" : "daynight task session read");
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
