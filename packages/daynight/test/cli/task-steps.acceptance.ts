import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import type { Project, StepsResource, TaskStep } from "../../src/api/types.js";
import { createInstalledCli, terminateInstalledProcess } from "../fixtures/installed-cli.js";

const workspace = path.resolve(import.meta.dirname, "../../../..");
const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333";
const otherId = "dddddddd-4444-4444-8444-444444444444";
const step: TaskStep = { id: "00abcdef", title: "  <完整&> 中文😀\u001b[31m\u202e  ", description: "# Complete Markdown\nFirst line.\n\t[Plan](plan.md) \u2028😀", status: "done", createdAt: "2026-11-03T10:11:12.123456Z", updatedAt: "2026-11-03T10:12:13Z" };
const resource: StepsResource = { projectId, taskId, version: 9_007_199_254_740_993n, steps: [step, { ...step, id: "00000000", status: "in_progress", description: "Another complete description." }] };
type Result = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

it("runs both packed launchers through Steps reads, help and safe read failures", async () => {
  const installed = await createInstalledCli();
  const { receipt } = installed;
  const fixture = path.join(receipt.root, ".tmp", "Steps launcher fixture 中文");
  const home = path.join(fixture, "home");
  const state = path.join(fixture, "configuration");
  const config = path.join(state, "config.yml");
  const outside = path.parse(receipt.root).root;
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, {
    HOME: home, USERPROFILE: home, DN_CONFIG_DIR: state,
    APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(fixture, "config"), XDG_CACHE_HOME: path.join(fixture, "cache"),
    TMPDIR: path.join(fixture, "temporary"), TMP: path.join(fixture, "temporary"), TEMP: path.join(fixture, "temporary"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(fixture, "git-global"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1",
  });
  const children = new Map<ChildProcess, Promise<unknown>>();
  const requests: { method: string; path: string }[] = [];
  const scenarios: string[] = [];
  let mode: "resource" | "empty" | "scope" | "malformed" | "unauthenticated" | "unsupported" | "discovery-missing" | "discovery-ambiguous" = "resource";
  const projectsPath = "/api/v1/projects";
  const discoveryRepoUrl = "https://git.example/private-project-URL/Steps.git";
  const lastMatchingId = "ffffffff-6666-4666-8666-666666666666";
  const project = (id: string, name: string, repoUrl = discoveryRepoUrl): Project => ({
    id, name, repoUrl, settings: { version: 1n, executionWarningMinutes: 60 },
    createdAt: "2026-11-03T10:11:12.123456Z", updatedAt: "2026-11-03T10:11:12.123456Z",
  });
  const matchingProjects = [project(projectId, "private-name-one\u001b[31m\u202e"), project(otherId, "private-name-two"), project(lastMatchingId, "private-name-three")];
  const unrelatedProject = project("eeeeeeee-5555-4555-8555-555555555555", "private-unrelated-name", "https://other.example/unrelated-private-repo.git");
  const collectionPath = `/api/v1/projects/${projectId}/tasks/${taskId}/steps`;
  const itemPath = `${collectionPath}/${step.id}`;
  const server = createServer((request, response) => {
    requests.push({ method: request.method!, path: request.url! });
    response.setHeader("Content-Type", "application/json");
    if (mode === "discovery-missing" || mode === "discovery-ambiguous") {
      const url = new URL(request.url!, "http://localhost");
      const cursor = url.searchParams.get("cursor");
      if (request.method !== "GET" || url.pathname !== projectsPath || url.searchParams.get("limit") !== "100" || cursor !== null && cursor !== "steps-page-two" || request.headers.authorization !== "Bearer fixture-token") {
        response.writeHead(500); response.end(stringifyApiJson({ error: { code: "internal_error", message: "Unexpected discovery request.", requestId: "steps-discovery-unexpected" } })); return;
      }
      response.setHeader("Daynight-User-ID", userId);
      if (mode === "discovery-missing") response.end(stringifyApiJson({ items: [unrelatedProject], nextCursor: null }));
      else response.end(stringifyApiJson(cursor === null ? { items: [matchingProjects[0], unrelatedProject], nextCursor: "steps-page-two" } : { items: matchingProjects.slice(1), nextCursor: null }));
      return;
    }
    if (request.method !== "GET" || ![collectionPath, itemPath].includes(request.url!)) {
      response.writeHead(500); response.end(stringifyApiJson({ error: { code: "internal_error", message: "Unexpected launcher request.", requestId: "steps-unexpected" } })); return;
    }
    if (request.headers.authorization !== "Bearer fixture-token" || mode === "unauthenticated") {
      response.writeHead(401); response.end(stringifyApiJson({ error: { code: "unauthenticated", message: "Read is not authorized.\nUse your account.", requestId: "steps-launcher-401" } })); return;
    }
    if (mode === "unsupported") {
      response.writeHead(501); response.end(stringifyApiJson({ error: { code: "not_implemented", message: "Steps reads are unavailable.", requestId: "steps-launcher-501" } })); return;
    }
    response.setHeader("Daynight-User-ID", userId);
    const value = request.url === collectionPath ? { ...resource, ...(mode === "empty" ? { steps: [] } : {}) } : { projectId, taskId, version: resource.version, step };
    response.end(stringifyApiJson(mode === "scope" ? { ...value, projectId: otherId } : mode === "malformed" ? { ...value, version: "1" } : value));
  });
  let failure: unknown;
  const invoke = async (launcher: string, args: readonly string[], expected = 0, cwd = outside): Promise<Result> => {
    const child = crossSpawn(launcher, [...args], { cwd, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", launchFailure: unknown;
    child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.once("error", (cause) => { launchFailure = cause; });
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => { children.delete(child); resolve(code); }));
    children.set(child, closed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
      if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Packed Steps launcher exceeded twenty seconds."); }
      if (launchFailure !== undefined) throw launchFailure;
      expect(code, stderr).toBe(expected);
      if (expected !== 0) expect(stdout).toBe("");
      else expect(stderr).toBe("");
      return { code, stdout, stderr };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  try {
    await mkdir(home, { recursive: true }); await mkdir(state, { recursive: true }); await mkdir(environment.TMPDIR!, { recursive: true });
    const alias = path.join(path.dirname(receipt.launcherPath), process.platform === "win32" ? "dn.cmd" : "dn");
    const launchers = [receipt.launcherPath, alias];
    await readFile(alias);
    await writeFile(config, "serverUrl: [\n");
    for (const launcher of launchers) {
      for (const args of [["task", "step"], ["task", "step", "--help"], ["task", "step", "list", "--help"], ["task", "step", "show", "--help"]]) {
        const result = await invoke(launcher, args);
        expect(result.stdout).toContain("Usage: daynight task step");
        expect(result.stdout).not.toContain("--if-version");
        expect(result.stdout).not.toMatch(/\n\s+(?:update|set-status|move)\s/);
        if (args.length <= 3) expect(result.stdout).toMatch(/\n\s+delete\s/);
      }
      await invoke(launcher, ["task", "step", "add", taskId], 2);
      await invoke(launcher, ["task", "step", "show", taskId, "prefix"], 2);
    }
    expect(await readFile(config, "utf8")).toBe("serverUrl: [\n");
    expect(requests).toEqual([]);
    scenarios.push("daynight-and-dn-help-before-config-and-unsupported-write-usage");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing packed Steps test listener.");
    await writeFile(config, `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    const explicit = ["--project", projectId.toUpperCase()];
    for (const launcher of launchers) {
      const at = requests.length;
      const listed = await invoke(launcher, ["task", "step", "list", taskId.toUpperCase(), "--json", ...explicit]);
      expect(parseApiJson(listed.stdout)).toEqual(resource);
      expect(listed.stdout).toContain('"version":9007199254740993');
      expect(requests.slice(at)).toEqual([{ method: "GET", path: collectionPath }]);
      const shown = await invoke(launcher, ["task", "step", "show", taskId, "00ABCDEF", "--json", ...explicit]);
      expect(parseApiJson(shown.stdout)).toEqual({ projectId, taskId, version: resource.version, step });
      expect(requests.at(-1)).toEqual({ method: "GET", path: itemPath });
      const text = await invoke(launcher, ["task", "step", "list", taskId, ...explicit]);
      expect(text.stdout).toContain("Version: 9007199254740993\nSteps: 2\n1. 00abcdef  done");
      expect(text.stdout.indexOf("1. 00abcdef")).toBeLessThan(text.stdout.indexOf("2. 00000000"));
      expect(text.stdout).not.toContain("\u001b"); expect(text.stdout).not.toContain("\u202e");
      expect(text.stdout).toContain("\\u001b[31m\\u202e");
      const description = await invoke(launcher, ["task", "step", "show", taskId, step.id, ...explicit]);
      expect(description.stdout).toContain("Description: # Complete Markdown\\nFirst line.\\n\\t[Plan](plan.md) \\u2028😀");
      expect(description.stdout).toContain(`Created: ${step.createdAt}`); expect(description.stdout).toContain(`Updated: ${step.updatedAt}`);
      mode = "empty";
      expect(parseApiJson((await invoke(launcher, ["task", "step", "list", taskId, "--json", ...explicit])).stdout)).toEqual({ ...resource, steps: [] });
      expect((await invoke(launcher, ["task", "step", "list", taskId, ...explicit])).stdout).toContain("Steps: 0\n");
      for (const broken of ["scope", "malformed"] as const) {
        mode = broken;
        expect((await invoke(launcher, ["task", "step", "list", taskId, "--json", ...explicit], 1)).stderr).toContain("phase=protocol");
      }
      mode = "unauthenticated";
      const unauthenticated = await invoke(launcher, ["task", "step", "show", taskId, step.id, ...explicit], 1);
      expect(unauthenticated.stderr).toContain("unauthenticated: Read is not authorized.\\nUse your account.");
      expect(unauthenticated.stderr).toContain("requestId=steps-launcher-401"); expect(unauthenticated.stderr).toContain("daynight login");
      mode = "unsupported";
      const unsupported = await invoke(launcher, ["task", "step", "list", taskId, "--json", ...explicit], 1);
      expect(unsupported.stderr).toContain("not_implemented: Steps reads are unavailable."); expect(unsupported.stderr).toContain("requestId=steps-launcher-501");
      mode = "resource";
    }
    expect(requests.every(({ method, path: pathname }) => method === "GET" && [collectionPath, itemPath].includes(pathname))).toBe(true);
    expect(createHash("sha256").update(await readFile(receipt.entryPath)).digest("hex")).toBe(receipt.entrySha256);
    scenarios.push("both-literal-launchers-outside-git-one-get-lossless-json-order-show-empty-and-safe-read-errors");
    const repository = path.join(fixture, "discovery repository 中文");
    await mkdir(repository);
    const git = (args: readonly string[]): void => { execFileSync("git", ["-C", repository, ...args], { env: environment, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }); };
    git(["init", "--initial-branch=main"]);
    git(["remote", "add", "origin", "git@git.example:private-project-URL/Steps.git"]);
    const privateFacts = ["private-name-one", "private-name-two", "private-name-three", "private-unrelated-name", "private-project-URL", "unrelated-private-repo", "fixture-token", "\u001b", "\u202e"];
    const failureRequests = (at: number) => requests.slice(at).map(({ method, path: pathname }) => {
      const url = new URL(pathname, "http://localhost");
      return { method, path: url.pathname, query: Object.fromEntries(url.searchParams) };
    });
    const noDiscoveryMetadata = async (): Promise<void> => {
      await expect(lstat(path.join(repository, ".daynight"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(repository, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
    };
    for (const launcher of launchers) {
      for (const operation of ["list", "show"] as const) {
        const args = ["task", "step", operation, taskId, ...(operation === "show" ? [step.id] : [])];
        mode = "discovery-missing";
        let at = requests.length;
        const missing = await invoke(launcher, args, 1, repository);
        expect(missing.stderr).toContain("Project does not exist.");
        expect(missing.stderr).not.toMatch(/login|configuration|authentication/);
        expect(missing.stderr).toContain(`operation=task.step.${operation} phase=prepare`);
        expect(failureRequests(at)).toEqual([{ method: "GET", path: projectsPath, query: { limit: "100" } }]);
        for (const value of privateFacts) expect(missing.stderr).not.toContain(value);
        await noDiscoveryMetadata();
        mode = "discovery-ambiguous";
        at = requests.length;
        const ambiguous = await invoke(launcher, args, 1, repository);
        expect(ambiguous.stderr).toContain("Multiple projects match this repository");
        expect(ambiguous.stderr).toContain("--project <id>");
        expect(ambiguous.stderr).not.toMatch(/login|configuration|authentication/);
        expect(ambiguous.stderr).not.toContain("projectId=");
        for (const { id } of matchingProjects) expect(ambiguous.stderr).toContain(id);
        expect(ambiguous.stderr.indexOf(projectId)).toBeLessThan(ambiguous.stderr.indexOf(otherId));
        expect(ambiguous.stderr.indexOf(otherId)).toBeLessThan(ambiguous.stderr.indexOf(lastMatchingId));
        expect(failureRequests(at)).toEqual([
          { method: "GET", path: projectsPath, query: { limit: "100" } },
          { method: "GET", path: projectsPath, query: { limit: "100", cursor: "steps-page-two" } },
        ]);
        for (const value of privateFacts) expect(ambiguous.stderr).not.toContain(value);
        await noDiscoveryMetadata();
      }
    }
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    scenarios.push("both-launchers-list-and-show-native-git-zero-and-cross-page-ambiguous-project-recovery-without-binding-writes");

  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) { try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); } }
  try { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause))); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  let removed = false;
  try { await lstat(receipt.root); } catch (cause) { if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") removed = true; else cleanup.push(cause); }
  await writeFile(path.join(workspace, ".tmp/t06-packed-launchers-evidence.json"), `${JSON.stringify({ schemaVersion: 1, success: failure === undefined && cleanup.length === 0 && removed, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256, source: receipt.source }, transport: "literal daynight and sibling dn launchers via crossSpawn", fixture: "small Node HTTP package-consumer fixture; real server interoperability is verified by Go acceptance", scenarios, requests, cleanup: { installationRemoved: removed, childrenExited: children.size === 0, serverClosed: !server.listening, errors: cleanup.length } }, null, 2)}\n`, { mode: 0o600 });
  if (cleanup.length !== 0) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Packed Steps launcher acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
  expect(removed).toBe(true);
}, 180_000);
