import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

const executable = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const preload = fileURLToPath(new URL("../fixtures/cli-argv-file.mjs", import.meta.url));
const temporary = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const userId = "cccccccc-3333-4333-8333-333333333333";
const firstId = "00000001", secondId = "00000002";
const collection = `/api/v1/projects/${projectId}/tasks/${taskId}/steps`;
const title = "é".repeat(512), longTitle = `${title}x`;
const description = "\u0001".repeat(65_536), longDescription = `${description}x`;
const firstCreated = "2026-01-01T00:00:00Z", firstShort = "2026-01-01T00:00:01Z", firstRestored = "2026-01-01T00:00:02Z";
const secondCreated = "2026-01-01T00:00:03Z", secondShort = "2026-01-01T00:00:04Z", secondRestored = "2026-01-01T00:00:05Z";
const first = { id: firstId, title, description: "", status: "todo", createdAt: firstCreated, updatedAt: firstCreated };
const firstAt3 = { id: firstId, title: "short", description: "", status: "todo", createdAt: firstCreated, updatedAt: firstShort };
const firstAt4 = { id: firstId, title, description: "", status: "todo", createdAt: firstCreated, updatedAt: firstRestored };
const second = { id: secondId, title: "x", description, status: "todo", createdAt: secondCreated, updatedAt: secondCreated };
const secondAt6 = { id: secondId, title: "x", description: "short", status: "todo", createdAt: secondCreated, updatedAt: secondShort };
const secondAt7 = { id: secondId, title: "x", description, status: "todo", createdAt: secondCreated, updatedAt: secondRestored };
const refusal = { error: { code: "invalid_input", message: "field exceeds maximum UTF-8 bytes", requestId: "field-refusal" } };
const resource = (version: number, steps: readonly unknown[]) => ({ projectId, taskId, version, steps });

// Responses are supplied facts, not an implementation of the server's Step state machine.
const plans = [
  { args: ["add", taskId, "--id", firstId, "--title", longTitle], version: 1, method: "POST", path: collection, body: { version: 1, id: firstId, title: longTitle }, status: 400, response: refusal },
  { args: ["add", taskId, "--id", firstId, "--title", title], version: 1, method: "POST", path: collection, body: { version: 1, id: firstId, title }, status: 201, response: resource(2, [first]), location: `${collection}/${firstId}` },
  { args: ["update", taskId, firstId, "--title", longTitle], version: 2, method: "PATCH", path: `${collection}/${firstId}`, body: { version: 2, title: longTitle }, status: 400, response: refusal },
  { args: ["update", taskId, firstId, "--title", "short"], version: 2, method: "PATCH", path: `${collection}/${firstId}`, body: { version: 2, title: "short" }, status: 200, response: resource(3, [firstAt3]) },
  { args: ["update", taskId, firstId, "--title", title], version: 3, method: "PATCH", path: `${collection}/${firstId}`, body: { version: 3, title }, status: 200, response: resource(4, [firstAt4]) },
  { args: ["add", taskId, "--id", secondId, "--title", "x", "--description", longDescription], version: 4, method: "POST", path: collection, body: { version: 4, id: secondId, title: "x", description: longDescription }, status: 400, response: refusal },
  { args: ["add", taskId, "--id", secondId, "--title", "x", "--description", description], version: 4, method: "POST", path: collection, body: { version: 4, id: secondId, title: "x", description }, status: 201, response: resource(5, [firstAt4, second]), location: `${collection}/${secondId}` },
  { args: ["update", taskId, secondId, "--description", longDescription], version: 5, method: "PATCH", path: `${collection}/${secondId}`, body: { version: 5, description: longDescription }, status: 400, response: refusal },
  { args: ["update", taskId, secondId, "--description", "short"], version: 5, method: "PATCH", path: `${collection}/${secondId}`, body: { version: 5, description: "short" }, status: 200, response: resource(6, [firstAt4, secondAt6]) },
  { args: ["update", taskId, secondId, "--description", description], version: 6, method: "PATCH", path: `${collection}/${secondId}`, body: { version: 6, description }, status: 200, response: resource(7, [firstAt4, secondAt7]) },
] as const;

type Request = { method: string | undefined; path: string | undefined; authorization: string | undefined; contentType: string | undefined; body: unknown };
type Exit = { code: number | null; signal: NodeJS.Signals | null };

it("preserves exact Step field text through the built CLI process and HTTP transport", async () => {
  expect(Buffer.byteLength(title)).toBe(1024);
  expect(Buffer.byteLength(description)).toBe(65_536);
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "step-cli-text-"));
  const home = path.join(root, "home"), config = path.join(root, "config"), caller = path.join(root, "caller"), temp = path.join(root, "temp");
  const requests: Request[] = [];
  const children = new Map<ChildProcess, Promise<Exit>>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    request.on("end", () => {
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { body = undefined; }
      requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, contentType: request.headers["content-type"], body });
      const plan = plans[requests.length - 1];
      if (plan === undefined) { response.writeHead(500); response.end(); return; }
      response.writeHead(plan.status, { "Content-Type": "application/json", "Daynight-User-ID": userId, ...("location" in plan ? { Location: plan.location } : {}) });
      response.end(`${JSON.stringify(plan.response)}\n`);
    });
  });
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, {
    HOME: home, USERPROFILE: home, DN_CONFIG_DIR: config,
    APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_CACHE_HOME: path.join(root, "cache"),
    TMPDIR: temp, TMP: temp, TEMP: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "git-global"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1",
  });
  const invoke = async (args: readonly string[], index: number): Promise<Exit & { stdout: string; stderr: string }> => {
    const argumentFile = path.join(root, `args-${index}.json`);
    await writeFile(argumentFile, JSON.stringify(args), { mode: 0o600 });
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, executable, argumentFile], { cwd: caller, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let stdout = "", stderr = "", launchFailure: unknown;
    child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.once("error", (cause) => { launchFailure = cause; });
    const closed = new Promise<Exit>((resolve) => child.once("close", (code, signal) => { children.delete(child); resolve({ code, signal }); }));
    children.set(child, closed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 15_000); })]);
      if (result === "timeout") {
        const cause = new Error(`CLI stage ${index + 1} exceeded fifteen seconds.`);
        try { await terminateInstalledProcess(child, closed); } catch (cleanup) { throw new AggregateError([cause, cleanup], "CLI timeout and cleanup failed."); }
        throw cause;
      }
      if (launchFailure !== undefined) throw launchFailure;
      return { ...result, stdout, stderr };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  let failure: unknown;
  try {
    await Promise.all([home, config, caller, temp].map((directory) => mkdir(directory, { recursive: true })));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing Step fixture listener.");
    await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`, { mode: 0o600 });
    for (const [index, plan] of plans.entries()) {
      const result = await invoke(["task", "step", ...plan.args, "--project", projectId, "--if-version", String(plan.version), "--json"], index);
      expect(requests.length, `stage ${index + 1} request count`).toBe(index + 1);
      expect(requests[index]).toEqual({ method: plan.method, path: plan.path, authorization: "Bearer fixture-token", contentType: "application/json", body: plan.body });
      expect(result.signal).toBeNull();
      if (plan.status === 400) {
        expect(typeof result.code, result.stderr).toBe("number");
        expect(result.code, result.stderr).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("code=invalid_input");
        expect(result.stderr).toContain("outcome=refused");
      } else {
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual(plan.response);
      }
    }
    expect(requests).toHaveLength(plans.length);
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) { try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); } }
  try { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause))); } catch (cause) { cleanup.push(cause); }
  try { await rm(root, { recursive: true, force: true }); } catch (cause) { cleanup.push(cause); }
  try { await lstat(root); cleanup.push(new Error("Step CLI fixture root was retained after cleanup.")); }
  catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) cleanup.push(cause); }
  if (cleanup.length !== 0) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Step CLI test or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 180_000);
