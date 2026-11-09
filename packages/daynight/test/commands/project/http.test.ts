import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringifyApiJson } from "../../../src/api/index.js";
import type { Project } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import { runProjectCommand } from "../../../src/commands/project/command.js";
import { runServerCommand } from "../../../src/commands/server/runtime.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const user = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "personal", name: null } };
const id = "abcdefab-1234-5678-90ab-abcdefabcdef";
const project: Project = { id, name: "Project 名称", repoUrl: "git@Git.Example:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: "2026-10-20T01:02:03.123456789Z", updatedAt: "2026-10-20T02:03:04.987654321Z" };
const personalTeam = { id: user.personalTeam.id, kind: "personal", name: null, version: 1n, createdAt: "2026-10-20T01:02:03Z", updatedAt: "2026-10-20T01:02:03Z", membership: { teamId: user.personalTeam.id, userId, role: "admin", version: 1n, createdAt: "2026-10-20T01:02:03Z", updatedAt: "2026-10-20T01:02:03Z" } };
const creationReceipt = <T extends { id: string; ownership: { teamId: string; version: bigint }; createdAt: string; updatedAt: string }>(value: T, userId: string) => ({ ...value, access: { projectId: value.id, ownerTeam: { id: value.ownership.teamId, kind: "personal", name: null }, ownership: value.ownership, effectiveRole: "admin", teamRole: "admin", canTransfer: true, directGrant: { projectId: value.id, userId, role: "admin", version: 1n, createdAt: value.createdAt, updatedAt: value.updatedAt } } });
const cleanups: (() => void | Promise<void>)[] = [];
let restoreGitEnvironment: (() => void) | undefined;
afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
  } finally { restoreGitEnvironment?.(); restoreGitEnvironment = undefined; vi.restoreAllMocks(); }
  if (failures.length > 0) throw new AggregateError(failures, "Project fixture cleanup failed.");
});
const gitEnvironment = () => Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith("GIT_"));
const clearGitEnvironment = () => {
  for (const [key] of gitEnvironment()) delete process.env[key];
};
const isolateGitEnvironment = (root: string) => {
  clearGitEnvironment();
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "isolated-gitconfig");
};
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
const fixture = async (serverUrl: string, operationLimits?: { readonly totalMs?: number; readonly responseBytes?: number; readonly totalBytes?: number }) => {
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
    stdoutBytes: vi.fn<(chunk: Uint8Array, signal: AbortSignal) => Promise<void>>(async () => {}), stdout: vi.fn<(value: string) => void>(), stderr: vi.fn<(value: string) => void>(),
  };
  const dependencies = { runServerCommand: (current: Parameters<typeof runServerCommand>[0], command: Parameters<typeof runServerCommand>[1]) => runServerCommand(current, command, { signalEmitter: signals, ...(operationLimits === undefined ? {} : { operationLimits }) }) };
  return { context, dependencies, signals };
};
const respond = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(stringifyApiJson(value));
};

describe("project command over HTTP", () => {
  it("isolates inherited Git configuration and creates from a subdirectory without repository binding metadata", async () => {
    const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/project-command-tests");
    await mkdir(temporary, { recursive: true });
    const root = await mkdtemp(path.join(temporary, "repo-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const savedGitEnvironment = gitEnvironment();
    restoreGitEnvironment = () => {
      clearGitEnvironment();
      for (const [key, value] of savedGitEnvironment) if (value !== undefined) process.env[key] = value;
    };
    isolateGitEnvironment(root);
    const unrelated = path.join(root, "unrelated");
    execFileSync("git", ["init", "--quiet", unrelated], { timeout: 10_000 });
    execFileSync("git", ["-C", unrelated, "remote", "add", "preserved", "https://example.test/unchanged.git"], { timeout: 10_000 });
    const unrelatedConfig = await readFile(path.join(unrelated, ".git", "config"));
    process.env.GIT_DIR = path.join(unrelated, ".git");
    process.env.GIT_WORK_TREE = unrelated;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "remote.origin.url";
    process.env.GIT_CONFIG_VALUE_0 = "https://example.test/injected.git";
    isolateGitEnvironment(root);
    expect(process.env.GIT_DIR).toBeUndefined();
    expect(process.env.GIT_WORK_TREE).toBeUndefined();
    expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
    const repository = path.join(root, "repository");
    execFileSync("git", ["init", "--quiet", repository], { timeout: 10_000 });
    execFileSync("git", ["-C", repository, "remote", "add", "origin", project.repoUrl], { timeout: 10_000 });
    const nested = path.join(repository, "source"); await mkdir(nested);
    let submitted: string | undefined;
    const url = await server((request, response) => {
      response.setHeader("Daynight-User-ID", userId);
      if (request.url === "/api/v1/me") respond(response, user);
      else if (request.url === `/api/v1/teams/${user.personalTeam.id}`) respond(response, personalTeam);
      else if (request.method === "GET") respond(response, { items: [], nextCursor: null });
      else {
        let body = ""; request.setEncoding("utf8"); request.on("data", (part: string) => { body += part; });
        request.on("end", () => { submitted = body; respond(response, creationReceipt({ ...project, name: "Project" }, userId), 201); });
      }
    });
    const { context, dependencies } = await fixture(url);
    context.workingDirectory.mockReturnValue(nested);
    await runProjectCommand(["create", "Project", "--confirm"], context, dependencies);
    expect(context.stdoutBytes).toHaveBeenCalledOnce();
    expect(JSON.parse(submitted!)).toMatchObject({ name: "Project", repoUrl: project.repoUrl });
    await expect(stat(path.join(repository, ".daynight"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(unrelated, ".git", "config"))).toEqual(unrelatedConfig);
    restoreGitEnvironment();
    expect(Object.fromEntries(gitEnvironment())).toEqual(Object.fromEntries(savedGitEnvironment));
  });

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

  it("preserves exact nested settings versions from a later project page in JSON", async () => {
    const precise = { ...project, id: "22222222-2222-2222-2222-222222222222", settings: { version: 9_007_199_254_740_993n, executionWarningMinutes: 90 } };
    const requests: string[] = [];
    const url = await server((request, response) => {
      requests.push(request.url!);
      respond(response, requests.length === 1 ? { items: [project], nextCursor: "second" } : { items: [precise], nextCursor: null });
    });
    const { context, dependencies } = await fixture(url);
    await runProjectCommand(["list", "--json"], context, dependencies);
    expect(context.stdout).toHaveBeenCalledExactlyOnceWith(`${stringifyApiJson([project, precise])}\n`);
    expect(context.stdout.mock.calls[0]![0]).toContain('"settings":{"version":9007199254740993,"executionWarningMinutes":90}');
    expect(requests).toEqual(["/api/v1/projects?limit=100", "/api/v1/projects?limit=100&cursor=second"]);
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

  it.each(["response", "total"])("does not print partial project JSON when the %s byte budget is exceeded", async (budget) => {
    const first = stringifyApiJson({ items: [project], nextCursor: "second" });
    const second = stringifyApiJson({ items: [{ ...project, id: "22222222-2222-2222-2222-222222222222", name: "Long second page ".repeat(32) }], nextCursor: null });
    const requests: string[] = [];
    const url = await server((request, response) => {
      requests.push(request.url!);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(requests.length === 1 ? first : second);
    });
    const limits = budget === "response"
      ? { responseBytes: Buffer.byteLength(second) - 1 }
      : { totalBytes: Buffer.byteLength(first) + Buffer.byteLength(second) - 1 };
    const { context, dependencies } = await fixture(url, limits);
    const exit = await runCli(["project", "list", "--json"], context, [{ name: "project", description: "Manage projects", load: async () => ({ run: (args, current) => runProjectCommand(args, current, dependencies) }) }]);
    expect(exit).toBe(1);
    expect(context.stderr.mock.calls.map(([text]) => text).join("")).toContain(budget === "response" ? "HTTP response byte limit exceeded." : "Operation response byte budget exceeded.");
    expect(context.stdout).not.toHaveBeenCalled();
    expect(context.stdoutBytes).not.toHaveBeenCalled();
    expect(requests).toEqual(["/api/v1/projects?limit=100", "/api/v1/projects?limit=100&cursor=second"]);
  });

  it("submits original create values once and prints only the server-confirmed resource", async () => {
    const name = "  Original 名称  ";
    const repoUrl = "ssh://git@Git.Example:22/Org/Repo.git";
    let requests = 0;
    const bodies: unknown[] = [];
    const url = await server((request, response) => {
      requests++;
      if (request.url === "/api/v1/me") { response.setHeader("Daynight-User-ID", userId); respond(response, user); return; }
      if (request.url === `/api/v1/teams/${user.personalTeam.id}`) { response.setHeader("Daynight-User-ID", userId); respond(response, personalTeam); return; }
      if (request.method === "GET") { respond(response, { items: [], nextCursor: null }); return; }
      expect(request.method).toBe("POST"); expect(request.url).toBe("/api/v1/projects");
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => { bodies.push(JSON.parse(body)); response.setHeader("Daynight-User-ID", userId); respond(response, creationReceipt({ ...project, name, repoUrl }, userId), 201); });
    });
    const { context, dependencies } = await fixture(url);
    await runProjectCommand(["create", name, "--repo", repoUrl, "--confirm"], context, dependencies);
    expect(bodies).toEqual([{ name, repoUrl, expectedUserId: userId, teamId: user.personalTeam.id }]);
    expect(requests).toBe(4);
    expect(context.stdoutBytes).toHaveBeenCalledOnce();
    expect(Buffer.from(context.stdoutBytes.mock.calls[0]![0]).toString("utf8")).toContain(`ID: ${project.id}\nName: ${name}\nRepository: ${repoUrl}\n`);
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

describe("project creation Team selection", () => {
  const ordinaryId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ordinaryTeam = { ...personalTeam, id: ordinaryId, kind: "ordinary", name: "Team \u001b[31m", membership: { ...personalTeam.membership, teamId: ordinaryId, role: "member" } };
  const selectedProject = { ...project, ownership: { teamId: ordinaryId, version: 1n } };
  const receipt = { ...creationReceipt(selectedProject, userId), access: { ...creationReceipt(selectedProject, userId).access, ownerTeam: { id: ordinaryId, kind: "ordinary", name: ordinaryTeam.name }, teamRole: "member", canTransfer: false } };

  it("uses the account default, preserves raw input and checks the creator's direct admin receipt", async () => {
    const calls: string[] = [];
    let body: unknown;
    const url = await server((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      if (request.url === "/api/v1/projects?limit=100") { respond(response, { items: [], nextCursor: null }); return; }
      response.setHeader("Daynight-User-ID", userId);
      if (request.url === "/api/v1/me") { respond(response, user); return; }
      if (request.url === `/api/v1/teams/${ordinaryId}`) { respond(response, ordinaryTeam); return; }
      let text = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { text += chunk; });
      request.on("end", () => { body = JSON.parse(text); respond(response, { ...receipt, name: "  名称\n", repoUrl: "git@git.example:Org/Raw.git" }, 201); });
    });
    const { context, dependencies } = await fixture(url);
    await writeFile(path.join(context.homeDirectory(), ".daynight/config.yml"), `serverUrl: ${url}\nserverToken: fixture-token\nteamDefaults:\n  ${url}:\n    ${userId}: ${ordinaryId}\n`);
    await runProjectCommand(["create", "  名称\n", "--repo", "git@git.example:Org/Raw.git", "--confirm"], context, dependencies);
    expect(body).toEqual({ name: "  名称\n", repoUrl: "git@git.example:Org/Raw.git", expectedUserId: userId, teamId: ordinaryId });
    expect(calls).toEqual(["GET /api/v1/projects?limit=100", "GET /api/v1/me", `GET /api/v1/teams/${ordinaryId}`, "POST /api/v1/projects"]);
  });

  it("ignores a malformed default for an existing match or explicit Personal selection", async () => {
    let existing = true;
    const calls: string[] = [];
    const url = await server((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      if (request.url === "/api/v1/projects?limit=100") { respond(response, { items: existing ? [project] : [], nextCursor: null }); return; }
      response.setHeader("Daynight-User-ID", userId);
      if (request.url === "/api/v1/me") { respond(response, user); return; }
      if (request.url === `/api/v1/teams/${user.personalTeam.id}`) { respond(response, personalTeam); return; }
      request.resume(); request.on("end", () => respond(response, creationReceipt({ ...project, name: "New" }, userId), 201));
    });
    const { context, dependencies } = await fixture(url);
    await writeFile(path.join(context.homeDirectory(), ".daynight/config.yml"), `serverUrl: ${url}\nserverToken: fixture-token\nteamDefaults:\n  ${url}:\n    ${userId}: invalid\n`);
    await runProjectCommand(["create", "Existing", "--repo", project.repoUrl], context, dependencies);
    expect(calls).toEqual(["GET /api/v1/projects?limit=100"]);
    existing = false;
    await expect(runProjectCommand(["create", "New", "--repo", project.repoUrl, "--confirm"], context, dependencies)).rejects.toThrow("canonical UUID");
    await runProjectCommand(["create", "New", "--repo", project.repoUrl, "--team", "personal", "--confirm"], context, dependencies);
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
  });

  it("reports an unknown create outcome with its request ID without replaying", async () => {
    const calls: string[] = [];
    let sentId: string | undefined;
    const url = await server((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      if (request.url === "/api/v1/projects?limit=100") { respond(response, { items: [], nextCursor: null }); return; }
      response.setHeader("Daynight-User-ID", userId);
      if (request.url === "/api/v1/me") { respond(response, user); return; }
      if (request.url === `/api/v1/teams/${user.personalTeam.id}`) { respond(response, personalTeam); return; }
      sentId = request.headers["x-request-id"] as string | undefined;
      request.resume(); request.on("end", () => { response.destroy(); });
    });
    const { context, dependencies } = await fixture(url);
    const failure: unknown = await runProjectCommand(["create", "Name", "--repo", project.repoUrl, "--team", "personal", "--confirm"], context, dependencies).catch((error: unknown) => error);
    expect(sentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(failure)).toContain(`outcome is unknown (requestId=${sentId})`);
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    expect(context.stdout).not.toHaveBeenCalled();
    expect(context.stdoutBytes).not.toHaveBeenCalled();
  });

  it("rejects a changed principal on Team qualification before creation", async () => {
    const calls: string[] = [];
    const url = await server((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      if (request.url === "/api/v1/projects?limit=100") { respond(response, { items: [], nextCursor: null }); return; }
      response.setHeader("Daynight-User-ID", request.url === "/api/v1/me" ? userId : "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
      respond(response, request.url === "/api/v1/me" ? user : personalTeam);
    });
    const { context, dependencies } = await fixture(url);
    await expect(runProjectCommand(["create", "Name", "--repo", project.repoUrl, "--team", "personal", "--confirm"], context, dependencies)).rejects.toThrow();
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(0);
  });

});
