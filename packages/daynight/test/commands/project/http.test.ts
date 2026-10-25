import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringifyApiJson } from "../../../src/api/index.js";
import type { Project } from "../../../src/api/index.js";
import { runProjectCommand } from "../../../src/commands/project/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const id = "abcdefab-1234-5678-90ab-abcdefabcdef";
const project: Project = { id, name: "Project 名称", repoUrl: "git@Git.Example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: "2026-10-20T01:02:03.123456789Z", updatedAt: "2026-10-20T02:03:04.987654321Z" };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
const server = async (handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> => {
  const created = createServer(handler);
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    created.close((error) => error === undefined ? resolve() : reject(error));
    created.closeAllConnections();
  }));
  const address = created.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
};
const fixture = async (serverUrl: string, operationLimits?: { readonly totalMs: number }) => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/project-command-tests");
  await mkdir(temporary, { recursive: true });
  const home = await mkdtemp(path.join(temporary, "home 用户 "));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".daynight"));
  await writeFile(path.join(home, ".daynight/config.yml"), `serverUrl: ${serverUrl}\nserverToken: fixture-token\n`);
  const signals = new EventEmitter();
  const context = {
    version: "0.0.0", packageDirectory: "unused", homeDirectory: () => home,
    workingDirectory: vi.fn<() => string>(() => { throw new Error("Project commands must not query the working directory"); }),
    stdoutBytes: vi.fn(async () => {}), stdout: vi.fn<(value: string) => void>(), stderr: vi.fn<(value: string) => void>(),
  };
  const dependencies = { runServerCommand: (current: Parameters<typeof runServerCommand>[0], command: Parameters<typeof runServerCommand>[1]) => runServerCommand(current, command, { signalEmitter: signals, ...(operationLimits === undefined ? {} : { operationLimits }) }) };
  return { context, dependencies, signals };
};
const respond = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(stringifyApiJson(value));
};

describe("project command over HTTP", () => {
  it("prints one complete JSON array after the final project page succeeds", async () => {
    const next = { ...project, id: "22222222-2222-2222-2222-222222222222", name: "Second\nProject" };
    const requests: string[] = [];
    let context: Awaited<ReturnType<typeof fixture>>["context"];
    const url = await server((request, response) => {
      requests.push(request.url!);
      expect(context.stdout).not.toHaveBeenCalled();
      const query = new URL(request.url!, "http://localhost").searchParams;
      respond(response, query.has("cursor") ? { items: [next], nextCursor: null } : { items: [project], nextCursor: "second page" });
    });
    const current = await fixture(url); context = current.context;
    await runProjectCommand(["list", "--json"], context, current.dependencies);
    expect(context.stdout).toHaveBeenCalledExactlyOnceWith(`${stringifyApiJson([project, next])}\n`);
    expect(requests).toEqual(["/api/v1/projects?limit=100", "/api/v1/projects?limit=100&cursor=second+page"]);
    expect(context.workingDirectory).not.toHaveBeenCalled();
    expect(current.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("preserves a later-page refusal and leaves stdout empty", async () => {
    let requests = 0;
    const url = await server((_request, response) => {
      requests++;
      respond(response, requests === 1 ? { items: [project], nextCursor: "second" } : { error: { code: "internal", message: "Second page unavailable", requestId: "failed-page" } }, requests === 1 ? 200 : 500);
    });
    const { context, dependencies, signals } = await fixture(url);
    await expect(runProjectCommand(["list", "--json"], context, dependencies)).rejects.toMatchObject({ operation: "project.list", status: 500, code: "internal", requestId: "failed-page" });
    expect(context.stdout).not.toHaveBeenCalled();
    expect(context.workingDirectory).not.toHaveBeenCalled();
    expect(requests).toBe(2);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("submits original create values once and prints only the server-confirmed resource", async () => {
    const name = "  Original 名称  ";
    const repoUrl = "ssh://git@Git.Example:22/Org/Repo.git";
    let requests = 0;
    const bodies: unknown[] = [];
    const url = await server((request, response) => {
      requests++;
      if (request.method === "GET") { respond(response, { items: [], nextCursor: null }); return; }
      expect(request.method).toBe("POST"); expect(request.url).toBe("/api/v1/projects");
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => { bodies.push(JSON.parse(body)); respond(response, { ...project, name, repoUrl }, 201); });
    });
    const { context, dependencies } = await fixture(url);
    await runProjectCommand(["create", name, "--repo", repoUrl], context, dependencies);
    expect(bodies).toEqual([{ name, repoUrl }]);
    expect(requests).toBe(2);
    expect(context.stdout).toHaveBeenCalledOnce();
    expect(context.stdout.mock.calls[0]![0]).toContain(`ID: ${project.id}\nName: ${name}\nRepository: ${repoUrl}\n`);
    expect(context.workingDirectory).not.toHaveBeenCalled();
  });

  it("reads every project page before returning a canonical match on a later page", async () => {
    const requests: string[] = [];
    const unrelated = { ...project, id: "22222222-2222-2222-2222-222222222222", repoUrl: "https://git.example/Other/Repo" };
    const url = await server((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      const later = new URL(request.url!, "http://localhost").searchParams.has("cursor");
      respond(response, { items: later ? [project] : [unrelated], nextCursor: later ? null : "later" });
    });
    const { context, dependencies } = await fixture(url);
    await runProjectCommand(["create", "Another name", "--repo", "https://git.example/Org/Repo"], context, dependencies);
    expect(requests).toEqual(["GET /api/v1/projects?limit=100", "GET /api/v1/projects?limit=100&cursor=later"]);
    expect(context.stdout.mock.calls[0]![0]).toContain(`Project already exists.\nID: ${id}\nName: ${project.name}\n`);
    expect(context.workingDirectory).not.toHaveBeenCalled();
  });

  it("rejects canonical matches split across pages with every matching ID", async () => {
    const second = { ...project, id: "22222222-2222-2222-2222-222222222222", repoUrl: "https://git.example/Org/Repo" };
    const methods: string[] = [];
    const url = await server((request, response) => {
      methods.push(request.method!);
      const later = new URL(request.url!, "http://localhost").searchParams.has("cursor");
      respond(response, { items: later ? [second] : [project], nextCursor: later ? null : "later" });
    });
    const { context, dependencies } = await fixture(url);
    await expect(runProjectCommand(["create", "Name", "--repo", project.repoUrl], context, dependencies)).rejects.toThrow(`Multiple projects match this repository (${id}, ${second.id})`);
    expect(methods).toEqual(["GET", "GET"]);
    expect(context.stdout).not.toHaveBeenCalled();
  });

  it.each(["refusal", "json", "invalid-repository", "repeated-cursor", "disconnect", "deadline"])("does not create after a later project page fails: %s", async (failure) => {
    const methods: string[] = [];
    const url = await server((request, response) => {
      methods.push(request.method!);
      const later = new URL(request.url!, "http://localhost").searchParams.has("cursor");
      if (!later) { respond(response, { items: [project], nextCursor: "later" }); return; }
      if (failure === "refusal") respond(response, { error: { code: "internal", message: "Later page failed", requestId: "create-page-failure" } }, 500);
      else if (failure === "json") { response.writeHead(200, { "Content-Type": "application/json" }); response.end("{"); }
      else if (failure === "invalid-repository") respond(response, { items: [{ ...project, id: "22222222-2222-2222-2222-222222222222", repoUrl: "invalid repository" }], nextCursor: null });
      else if (failure === "repeated-cursor") respond(response, { items: [], nextCursor: "later" });
      else if (failure === "disconnect") response.destroy();
    });
    const { context, dependencies, signals } = await fixture(url, failure === "deadline" ? { totalMs: 250 } : undefined);
    await expect(runProjectCommand(["create", "Name", "--repo", project.repoUrl], context, dependencies)).rejects.toBeInstanceOf(Error);
    expect(methods).toEqual(["GET", "GET"]);
    expect(context.stdout).not.toHaveBeenCalled();
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("queries an explicit canonical project ID and preserves timestamps and exact nested settings versions in JSON", async () => {
    const requests: string[] = [];
    const precise = { ...project, settings: { version: 9_007_199_254_740_993n, executionWarningMinutes: 90 } };
    const url = await server((request, response) => { requests.push(request.url!); respond(response, precise); });
    const { context, dependencies } = await fixture(url);
    await runProjectCommand(["show", id.toUpperCase(), "--json"], context, dependencies);
    expect(requests).toEqual([`/api/v1/projects/${id}`]);
    expect(context.stdout).toHaveBeenCalledExactlyOnceWith(`${stringifyApiJson(precise)}\n`);
    expect(context.stdout.mock.calls[0]![0]).toContain('"settings":{"version":9007199254740993,"executionWarningMinutes":90}');
    expect(context.workingDirectory).not.toHaveBeenCalled();
  });
});
