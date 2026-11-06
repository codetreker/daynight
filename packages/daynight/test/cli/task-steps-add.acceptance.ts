import type { ChildProcess } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

it("forwards separate arguments through both installed native launchers", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const fixture = path.join(receipt.root, ".tmp", "Step Add launcher 中文");
  const home = path.join(fixture, "home");
  const state = path.join(fixture, "configuration");
  const temporary = path.join(fixture, "temporary");
  const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
  const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
  const title = "  <packed&> 中文😀  ";
  const description = "# Packed [Plan](plan.md) <&> 😀";
  const collectionPath = `/api/v1/projects/${projectId}/tasks/${taskId}/steps`;
  const result = {
    projectId, taskId, version: 2,
    steps: [{ id: "00abcdef", title, description, status: "todo", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
  };
  const requests: { method: string | undefined; path: string | undefined; body: unknown }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (value: Buffer) => { chunks.push(value); });
    request.on("end", () => {
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { response.writeHead(400); response.end(); return; }
      requests.push({ method: request.method, path: request.url, body });
      response.writeHead(201, { "Content-Type": "application/json", "Daynight-User-ID": "cccccccc-3333-4333-8333-333333333333", Location: `${collectionPath}/00abcdef` });
      response.end(`${JSON.stringify(result)}\n`);
    });
  });
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, {
    HOME: home, USERPROFILE: home, DN_CONFIG_DIR: state,
    APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(fixture, "config"), XDG_CACHE_HOME: path.join(fixture, "cache"),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(fixture, "git-global"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1",
  });
  const children = new Map<ChildProcess, Promise<unknown>>();
  const invoke = async (launcher: string): Promise<string> => {
    const args = ["task", "step", "add", taskId, "--id", "00abcdef", "--title", title, "--description", description, "--json", "--project", projectId, "--if-version", "1"];
    const child = crossSpawn(launcher, args, { cwd: path.parse(receipt.root).root, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", launchFailure: unknown;
    child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.once("error", (cause) => { launchFailure = cause; });
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => { children.delete(child); resolve(code); }));
    children.set(child, closed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
      if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Packed launcher exceeded twenty seconds."); }
      if (launchFailure !== undefined) throw launchFailure;
      expect(code, stderr).toBe(0);
      expect(stderr).toBe("");
      return stdout;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  let failure: unknown;
  try {
    await mkdir(home, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(temporary, { recursive: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing packed launcher listener.");
    await writeFile(path.join(state, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    const alias = path.join(path.dirname(receipt.launcherPath), process.platform === "win32" ? "dn.cmd" : "dn");
    const first = await invoke(receipt.launcherPath);
    const second = await invoke(alias);
    const expected = { method: "POST", path: collectionPath, body: { version: 1, id: "00abcdef", title, description } };
    expect(requests).toEqual([expected, expected]);
    expect(JSON.parse(first)).toEqual(result);
    expect(second).toBe(first);
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) { try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); } }
  try { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause))); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  try { await lstat(receipt.root); cleanup.push(new Error("Installed launcher fixture was retained after cleanup.")); }
  catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) cleanup.push(cause); }
  if (cleanup.length !== 0) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Installed launcher acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 180_000);
