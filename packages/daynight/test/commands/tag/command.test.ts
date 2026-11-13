import { describe, expect, it, vi } from "vitest";
import { commandTree } from "../../../src/cli/commands.js";
import { renderBashCompletion } from "../../../src/commands/completion/bash.js";
import { renderZshCompletion } from "../../../src/commands/completion/zsh.js";
import { createApiClient, createOperation, stringifyApiJson } from "../../../src/api/index.js";
import { UsageError } from "../../../src/cli/context.js";
import { runTagCommand } from "../../../src/commands/tag/command.js";
import type { TagCommandDependencies } from "../../../src/commands/tag/command.js";

const projectId = "abcdefab-1234-5678-90ab-abcdefabcdef";
const tagId = "11111111-2222-4333-8444-555555555555";
const epoch = "88888888-2222-4333-8444-555555555555";
const teamId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const timestamp = "2026-10-20T01:02:03Z";
const project = { id: projectId, name: "Project", repoUrl: "https://example.test/a/b", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId, version: 1n }, createdAt: timestamp, updatedAt: timestamp };
const tag = { id: tagId, projectId, name: "Example", version: 9007199254740993n, createdAt: timestamp, updatedAt: timestamp, usage: { tasks: 4, goals: 2 } };
const response = (value: unknown, status = 200) => new Response(stringifyApiJson(value), { status, headers: { "content-type": "application/json" } });

const fixture = (handler: (url: URL, init: RequestInit) => Response | Promise<Response>) => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => handler(new URL(String(input)), init ?? {}));
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: () => "unused", workingDirectory: () => "unused",
    stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async () => {}),
  };
  const runServerCommand: TagCommandDependencies["runServerCommand"] = async (current, command) => {
    const operation = createOperation();
    try {
      const serverUrl = "https://server.example";
      const api = createApiClient({ serverUrl, serverToken: "fixture-token", operation, fetch: fetcher });
      const output = await command({ api, operation, serverUrl, serverConfiguration: { serverUrl } });
      if (typeof output === "string") current.stdout(output);
      else if (output?.kind === "confirmed-mutation") current.stdout(output.output);
    } finally { operation.dispose(); }
  };
  const dependencies: TagCommandDependencies = { runServerCommand, resolveProject: vi.fn().mockResolvedValue(project) };
  return { context, dependencies, fetcher };
};

const path = `/api/v1/projects/${projectId}/tags`;
const mockProject = (url: URL): Response | undefined => url.pathname === `/api/v1/projects/${projectId}` ? response(project) : undefined;

describe("tag command", () => {
  it("renders help without opening a server session and rejects invalid arguments", async () => {
    const f = fixture(() => { throw new Error("unexpected HTTP request"); });
    await runTagCommand(["delete", "--help"], f.context, f.dependencies);
    expect(f.context.stdout.mock.calls[0]![0]).toContain("all associations");
    await expect(runTagCommand(["list", "--limit", "101"], f.context, f.dependencies)).rejects.toBeInstanceOf(UsageError);
    await expect(runTagCommand(["show", "invalid"], f.context, f.dependencies)).rejects.toBeInstanceOf(UsageError);
    await expect(runTagCommand(["rename", tagId, "Name", "--if-version", "9223372036854775808"], f.context, f.dependencies)).rejects.toBeInstanceOf(UsageError);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("reads every page with unchanged query and limit before emitting lossless JSON", async () => {
    const f = fixture((url) => mockProject(url) ?? response(url.searchParams.has("cursor")
      ? { items: [{ ...tag, id: "22222222-2222-4333-8444-555555555555" }], catalogEpoch: epoch, nextCursor: null }
      : { items: [tag], catalogEpoch: epoch, nextCursor: "second" }));
    await runTagCommand(["list", "--project", projectId, "--query", "Exam", "--limit", "1", "--json"], f.context, f.dependencies);
    const calls = f.fetcher.mock.calls.map(([url]) => new URL(String(url)));
    expect(calls.slice(1).map(url => [url.pathname, url.searchParams.get("query"), url.searchParams.get("limit"), url.searchParams.get("cursor")])).toEqual([[path, "Exam", "1", null], [path, "Exam", "1", "second"]]);
    expect(f.context.stdout).toHaveBeenCalledOnce();
    expect(f.context.stdout.mock.calls[0]![0]).toContain('"version":9007199254740993');
  });

  it("does not emit partial results after a later page fails", async () => {
    const f = fixture((url) => mockProject(url) ?? (url.searchParams.has("cursor")
      ? response({ error: { code: "catalog_changed", message: "Catalog changed", requestId: "request" } }, 409)
      : response({ items: [tag], catalogEpoch: epoch, nextCursor: "second" })));
    await expect(runTagCommand(["list", "--project", projectId, "--json"], f.context, f.dependencies)).rejects.toMatchObject({ status: 409, code: "catalog_changed" });
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it("distinguishes empty catalogs and absent query matches", async () => {
    for (const [args, expected] of [[[], "No Tags."], [["--query", "missing"], "No matching Tags."]] as const) {
      const f = fixture((url) => mockProject(url) ?? response({ items: [], catalogEpoch: epoch, nextCursor: null }));
      await runTagCommand(["list", "--project", projectId, ...args], f.context, f.dependencies);
      expect(f.context.stdout.mock.calls[0]![0]).toContain(expected);
    }
  });

  it("reports an empty cursor suffix without asserting that the catalog is empty", async () => {
    for (const query of [[], ["--query", "Example"]]) {
      const f = fixture((url) => mockProject(url) ?? response({ items: [], catalogEpoch: epoch, nextCursor: null }));
      await runTagCommand(["list", "--project", projectId, "--cursor", "last", ...query], f.context, f.dependencies);
      expect(f.context.stdout.mock.calls[0]![0]).toContain("No more Tags after the cursor.");
      expect(f.context.stdout.mock.calls[0]![0]).not.toContain("No matching Tags.");
      expect(f.context.stdout.mock.calls[0]![0]).not.toContain("No Tags.");
    }
  });

  it("previews deletion and retains an explicit exact version even when the preview differs", async () => {
    let body = "";
    const f = fixture((url, init) => {
      const p = mockProject(url); if (p) return p;
      if (init.method === "DELETE") { body = String(init.body); return response({ projectId, tagId, deleted: true }); }
      return response(tag);
    });
    await runTagCommand(["delete", tagId, "--project", projectId, "--if-version", "9007199254740995", "--confirm", "--json"], f.context, f.dependencies);
    expect(body).toBe('{"version":9007199254740995,"confirm":true}');
    expect(f.context.stderr.mock.calls[0]![0]).toContain("4 Tasks, 2 Goals");
    expect(f.context.stderr.mock.calls[0]![0]).toContain("All associations");
    expect(f.context.stdout.mock.calls[0]![0]).toContain('"deleted":true');
  });

  it("refuses unconfirmed non-interactive deletion and cancellation never sends DELETE", async () => {
    const f = fixture((url) => mockProject(url) ?? response(tag));
    await expect(runTagCommand(["delete", tagId, "--project", projectId], f.context, f.dependencies)).rejects.toThrow("confirmation");
    expect(f.fetcher).not.toHaveBeenCalled();
    const prompt = { isInteractive: true, ask: vi.fn().mockResolvedValue('"wrong"'), close: vi.fn(), select: vi.fn(), selectMany: vi.fn() };
    await expect(runTagCommand(["delete", tagId, "--project", projectId, "--confirm"], { ...f.context, prompt }, f.dependencies)).rejects.toThrow("cancelled");
    expect(prompt.ask).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("creates a Tag and reports explicit refusals without replay", async () => {
    let writes = 0;
    const f = fixture((url, init) => {
      const p = mockProject(url); if (p) return p;
      expect(url.pathname).toBe(path);
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-token");
      expect(String(init.body)).toBe('{"name":"Example"}');
      writes++;
      if (writes === 1) return new Response(stringifyApiJson({ ...tag, version: 1n }), { status: 201, headers: { "content-type": "application/json", location: `${path}/${tagId}` } });
      return response({ error: { code: "tag_name_conflict", message: "Name already exists", requestId: "request" } }, 409);
    });
    await runTagCommand(["create", "Example", "--project", projectId, "--json"], f.context, f.dependencies);
    expect(f.context.stdout.mock.calls[0]![0]).toContain(`"id":"${tagId}"`);
    f.context.stdout.mockClear();
    await expect(runTagCommand(["create", "Example", "--project", projectId], f.context, f.dependencies)).rejects.toMatchObject({ status: 409, code: "tag_name_conflict" });
    expect(writes).toBe(2);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });

  it.each(["create", "rename"])("does not replay an unknown %s outcome", async (action) => {
    let writes = 0;
    const f = fixture((url, init) => {
      const p = mockProject(url); if (p) return p;
      if (init.method === "POST" || init.method === "PATCH") { writes++; throw new Error("connection lost"); }
      return response(tag);
    });
    const args = action === "create" ? ["create", "Example"] : ["rename", tagId, "New", "--if-version", "9007199254740995"];
    await expect(runTagCommand([...args, "--project", projectId], f.context, f.dependencies)).rejects.toMatchObject({ outcomeUnconfirmed: true });
    expect(writes).toBe(1);
    expect(f.context.stdout).not.toHaveBeenCalled();
    if (action === "rename") expect(f.fetcher.mock.calls).toHaveLength(2);
  });

  it("confirms the exact preview name interactively before using the observed version", async () => {
    let body = "";
    const f = fixture((url, init) => {
      const p = mockProject(url); if (p) return p;
      if (init.method === "DELETE") { body = String(init.body); return response({ projectId, tagId, deleted: true }); }
      return response(tag);
    });
    const prompt = { isInteractive: true, ask: vi.fn().mockResolvedValue('"Example"'), close: vi.fn(), select: vi.fn(), selectMany: vi.fn() };
    await runTagCommand(["delete", tagId, "--project", projectId], { ...f.context, prompt }, f.dependencies);
    expect(prompt.ask.mock.calls[0]![0]).toContain('"Example"');
    expect(body).toBe('{"version":9007199254740993,"confirm":true}');
  });

  it("exposes Tag operations and options in generated shell completion", () => {
    const tagCommand = commandTree.commands!.find(({ name }) => name === "tag")!;
    expect(renderBashCompletion(commandTree)).toContain("'tag'");
    expect(renderBashCompletion(tagCommand)).toContain("dn_children=('list' 'show' 'create' 'rename' 'delete')");
    const deletion = tagCommand.commands!.find(({ name }) => name === "delete")!;
    const bash = renderBashCompletion(deletion);
    expect(bash).toContain("dn_options=('--project' '--if-version' '--confirm' '--json' '-h' '--help')");
    expect(bash).toContain("dn_argument_count=1");
    const zsh = renderZshCompletion(tagCommand);
    expect(zsh).toContain("delete:Delete a Tag and all its associations");
    for (const option of ["--confirm", "--if-version=", "--project=", "--json"]) expect(renderZshCompletion(deletion)).toContain(option);
  });

  it("uses the observed version for rename and propagates conflicts without retry", async () => {
    let patch = 0;
    const f = fixture((url, init) => {
      const p = mockProject(url); if (p) return p;
      if (init.method === "PATCH") { patch++; expect(String(init.body)).toContain('"version":9007199254740993'); return response({ error: { code: "version_conflict", message: "Version conflict", requestId: "request" } }, 409); }
      return response(tag);
    });
    await expect(runTagCommand(["rename", tagId, "New", "--project", projectId], f.context, f.dependencies)).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    expect(patch).toBe(1);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });
});
