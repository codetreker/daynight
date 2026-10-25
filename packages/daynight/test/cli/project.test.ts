import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";

const executable = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const projectId = "a1b2c3d4-1111-4222-8333-123456789abc";
const secondId = "a1b2c3d4-1111-4222-8333-123456789abd";
const project = (id = projectId, name = "Project 中文") => ({
  id, name, repoUrl: "git@git.example:Org/Repo.git",
  settings: { version: 1n, executionWarningMinutes: 60 },
  createdAt: "2026-10-20T00:00:00.123456789Z", updatedAt: "2026-10-20T00:00:00.123456789Z",
});

const fixture = async () => {
  const temporary = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "project CLI 中文-"));
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
  const invoke = (args: readonly string[], blocked: readonly string[], options: { readonly cwd?: string; readonly nativeGit?: boolean } = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(hook).href, executable, ...args], {
      cwd: options.cwd ?? caller, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home, USERPROFILE: home, ...(options.nativeGit ? {} : { PATH: emptyPath, Path: emptyPath }), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "git-global"), GIT_CEILING_DIRECTORIES: root, DAYNIGHT_TEST_BLOCK_IMPORTS: JSON.stringify(blocked) },
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { stdout += value; });
    child.stderr.on("data", (value: string) => { stderr += value; });
    child.once("error", (error) => { failure = error; });
    const timer = setTimeout(() => { failure = new Error("Compiled project command exceeded its test deadline."); child.kill("SIGKILL"); }, 10_000);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure !== undefined) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
  return { root, home, caller, invoke };
};

describe("compiled project commands", () => {
  it("infers effective origins from native Git and skips existing projects without writing bindings", async () => {
    const f = await fixture();
    let projects = [{ ...project(secondId, "Unrelated"), repoUrl: "https://git.example/Other/Repo" }];
    const requests: { method: string; cursor: string | null; body: unknown }[] = [];
    const remote = "ssh://git@Git.Example:22/Org/Repo.git";
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        const cursor = new URL(request.url!, "http://localhost").searchParams.get("cursor");
        const input = body === "" ? null : JSON.parse(body) as { name: string; repoUrl: string };
        requests.push({ method: request.method!, cursor, body: input });
        response.setHeader("Content-Type", "application/json");
        if (input !== null) {
          const created = { ...project(), ...input };
          projects.push(created);
          response.writeHead(201).end(stringifyApiJson(created));
        } else response.end(stringifyApiJson({ items: cursor === null ? projects.slice(0, 1) : projects.slice(1), nextCursor: cursor === null && projects.length > 1 ? "later page" : null }));
      });
    });
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    const git = (cwd: string, args: readonly string[], input?: string) => execFileSync("git", [...args], { cwd, encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"], env: { ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(f.root, "git-global") }, ...(input === undefined ? {} : { input }) }).trim();
    const initialize = async (name: string, origin?: string) => {
      const root = path.join(f.root, name);
      await mkdir(root); git(root, ["init", "--initial-branch=main"]);
      if (origin !== undefined) git(root, ["remote", "add", "origin", origin]);
      return root;
    };
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing native Git HTTP listener.");
      await mkdir(path.join(f.home, ".daynight"), { recursive: true });
      await writeFile(path.join(f.home, ".daynight/config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
      const root = await initialize("repository 中文", "fixture:Org/Repo.git");
      git(root, ["config", "url.ssh://git@Git.Example:22/.insteadOf", "fixture:"]);
      git(root, ["config", "remote.origin.pushurl", "https://push.example/Wrong/Repo"]);
      const nested = path.join(root, "nested 中文"); await mkdir(nested);
      const blocked = ["/repository/binding.js", "/commands/review/runtime.js", "better-sqlite3"];
      const created = await f.invoke(["project", "create", "Original 名称"], blocked, { cwd: nested, nativeGit: true });
      expect(created.code, created.stderr).toBe(0);
      expect(created.stdout).toContain("Project created.");
      expect(requests).toEqual([{ method: "GET", cursor: null, body: null }, { method: "POST", cursor: null, body: { name: "Original 名称", repoUrl: remote } }]);
      projects[1] = { ...projects[1]!, repoUrl: "https://git.example/Org/Repo" };
      const beforeRepeat = requests.length;
      const repeated = await f.invoke(["project", "create", "Different name"], blocked, { cwd: nested, nativeGit: true });
      expect(repeated.code, repeated.stderr).toBe(0);
      expect(repeated.stdout).toContain("Project already exists.");
      expect(repeated.stdout).toContain("Name: Original 名称");
      expect(requests.slice(beforeRepeat).map(({ method, cursor }) => ({ method, cursor }))).toEqual([{ method: "GET", cursor: null }, { method: "GET", cursor: "later page" }]);
      expect((await readdir(root)).sort()).toEqual([".git", "nested 中文"]);
      expect(await readdir(nested)).toEqual([]);

      const tree = git(root, ["hash-object", "-t", "tree", "-w", "--stdin"], "");
      const commit = git(root, ["hash-object", "-t", "commit", "-w", "--stdin"], `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nFixture\n`);
      git(root, ["update-ref", "refs/heads/main", commit]);
      const linked = path.join(f.root, "linked worktree"); git(root, ["worktree", "add", "--detach", linked, "HEAD"]);
      const worktree = await f.invoke(["project", "create", "Linked"], blocked, { cwd: linked, nativeGit: true });
      expect(worktree.code, worktree.stderr).toBe(0);
      expect(worktree.stdout).toContain("Project already exists.");
      expect(await readdir(linked)).toEqual([".git"]);

      git(root, ["remote", "set-url", "origin", "invalid-origin"]);
      const explicit = await f.invoke(["project", "create", "Explicit", "--repo", "https://git.example/Explicit/Repo"], ["/repository/git.js", "/repository/binding.js", "node:child_process"], { cwd: root });
      expect(explicit.code, explicit.stderr).toBe(0);
      expect(requests.at(-1)!.body).toEqual({ name: "Explicit", repoUrl: "https://git.example/Explicit/Repo" });
      for (const [cwd, diagnostic] of [[path.parse(f.root).root, "Cannot locate a Git repository"], [await initialize("no origin"), "origin fetch address"], [root, "Invalid repository address"]] as const) {
        const before = requests.length;
        const result = await f.invoke(["project", "create", "Cannot create"], blocked, { cwd, nativeGit: true });
        expect(result.code, result.stderr).toBe(1);
        expect(result.stderr).toContain(diagnostic);
        expect(result.stdout).toBe("");
        expect(requests).toHaveLength(before);
      }
      expect(await readdir(path.join(f.home, ".daynight"))).toEqual(["config.yml"]);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(f.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps help and malformed arguments independent of configuration and business imports", async () => {
    const f = await fixture();
    const blocked = ["/api/", "/config/", "/repository/", "/commands/server/", "/commands/project/rendering.js", "better-sqlite3"];
    try {
      for (const args of [[], ["--help"], ["create", "--help"], ["list", "--help"], ["show", "--help"]]) {
        const result = await f.invoke(["project", ...args], blocked);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain("Usage: daynight project");
        expect(result.stderr).toBe("");
      }
      for (const args of [["create"], ["create", "--name", "Example", "--repo", "remote"], ["create", "Name", "extra", "--repo", "remote"], ["create", "--repo", "remote"], ["create", "--repo", "remote", "-leading"], ["create", "\u0085", "--repo", "git@git.example:Org/Repo"], ["list", "--unknown"]]) {
        const result = await f.invoke(["project", ...args], blocked);
        expect(result.code, result.stderr).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("Unexpected module import");
      }
      const invalidId = await f.invoke(["project", "show", "not-a-uuid"], ["/api/client.js", "/api/json.js", "/api/operation.js", "/config/", "/commands/server/", "/repository/", "better-sqlite3"]);
      expect(invalidId.code, invalidId.stderr).toBe(2);
      expect(invalidId.stderr).toContain("hyphenated UUID");
      await expect(readdir(f.home)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(f.caller)).toEqual([]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }, 30_000);

  it("uses the configured server outside Git and publishes only complete API results", async () => {
    const f = await fixture();
    const requests: { method: string; pathname: string; cursor: string | null; body: unknown }[] = [];
    let failSecondPage = false;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      request.on("end", () => {
        const url = new URL(request.url!, "http://localhost");
        const body = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        requests.push({ method: request.method!, pathname: url.pathname, cursor: url.searchParams.get("cursor"), body });
        response.setHeader("Content-Type", "application/json");
        if (request.method === "POST") {
          const input = body as { name: string; repoUrl: string };
          response.writeHead(201).end(stringifyApiJson({ ...project(), ...input }));
        } else if (url.pathname === `/api/v1/projects/${projectId}`) {
          response.end(stringifyApiJson(project()));
        } else if (url.searchParams.has("cursor")) {
          if (failSecondPage) response.writeHead(500).end(JSON.stringify({ error: { code: "internal_error", message: "Controlled page failure", requestId: "project-page-failure" } }));
          else response.end(stringifyApiJson({ items: [project(secondId, "\uFEFF")], nextCursor: null }));
        } else {
          response.end(stringifyApiJson({ items: [project()], nextCursor: "next page+/=?" }));
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing controlled HTTP listener.");
    await mkdir(path.join(f.home, ".daynight"), { recursive: true });
    await writeFile(path.join(f.home, ".daynight/config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    const blocked = ["/repository/", "/commands/review/runtime.js", "/commands/review/store.js", "better-sqlite3"];
      const list = await f.invoke(["project", "list", "--json"], blocked);
      expect(list.code, list.stderr).toBe(0);
      expect(list.stderr).toBe("");
      expect(parseApiJson(list.stdout)).toEqual([project(), project(secondId, "\uFEFF")]);
      expect(requests[1]!.cursor).toBe("next page+/=?");

      const show = await f.invoke(["project", "show", projectId.toUpperCase(), "--json"], blocked);
      expect(show.code, show.stderr).toBe(0);
      expect(parseApiJson(show.stdout)).toEqual(project());
      expect(requests[2]!.pathname).toBe(`/api/v1/projects/${projectId}`);

      const name = "名字\n\u001b[31m";
      const remote = "ssh://git@Git.Example/Org/New.git";
      const createBlocked = ["/repository/git.js", "/repository/binding.js", "/repository/context.js", "/commands/review/runtime.js", "/commands/review/store.js", "better-sqlite3", "node:child_process"];
      const ambiguous = await f.invoke(["project", "create", "Ambiguous", "--repo", project().repoUrl], createBlocked);
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stdout).toBe("");
      expect(ambiguous.stderr).toContain("Multiple projects match this repository");
      expect(ambiguous.stderr).toContain(projectId);
      expect(ambiguous.stderr).toContain(secondId);
      expect(requests.filter(({ method }) => method === "POST")).toEqual([]);
      const created = await f.invoke(["project", "create", name, "--repo", remote], createBlocked);
      expect(created.code, created.stderr).toBe(0);
      expect(created.stdout).toContain("Project created.");
      expect(created.stdout).toContain("名字\\n\\u001b[31m");
      expect(requests.filter(({ method }) => method === "POST")).toEqual([{ method: "POST", pathname: "/api/v1/projects", cursor: null, body: { name, repoUrl: remote } }]);

      for (const name of [" Name 中文 ", "\ufeff", "-leading"]) {
        const created = await f.invoke(["project", "create", "--repo", remote, "--", name], createBlocked);
        expect(created.code, created.stderr).toBe(0);
        expect(requests.at(-1)!.body).toEqual({ name, repoUrl: remote });
      }

      failSecondPage = true;
      const postCount = requests.filter(({ method }) => method === "POST").length;
      const failedCreate = await f.invoke(["project", "create", "Unconfirmed", "--repo", remote], createBlocked);
      expect(failedCreate.code).toBe(1);
      expect(failedCreate.stdout).toBe("");
      expect(failedCreate.stderr).toContain("project-page-failure");
      expect(requests.filter(({ method }) => method === "POST")).toHaveLength(postCount);
      const failed = await f.invoke(["project", "list", "--json"], blocked);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toContain("internal_error");
      expect(failed.stderr).toContain("project-page-failure");
      expect(await readdir(f.caller)).toEqual([]);
      expect(await readdir(path.join(f.home, ".daynight"))).toEqual(["config.yml"]);
      expect(await readFile(path.join(f.home, ".daynight/config.yml"), "utf8")).toBe(`serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
      await rm(f.root, { recursive: true, force: true });
    }
  }, 30_000);
});
