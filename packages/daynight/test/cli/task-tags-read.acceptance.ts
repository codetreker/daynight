import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";
import { actorId, project, projectId, task, taskId, time, withTaskObservation } from "../fixtures/task-observation.js";

it("reads Task tags through the installed command and suppresses incomplete results", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const fixture = path.join(receipt.root, ".tmp", "task tags");
  const state = path.join(fixture, "config"), home = path.join(fixture, "home"), temporary = path.join(fixture, "tmp");
  const goalId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const secondId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const tagId = "aaaaaaaa-1111-4111-8111-111111111111";
  const secondTagId = "bbbbbbbb-1111-4111-8111-111111111111";
  let name = "backend", brokenPage = false;
  const refs = () => [{ id: tagId, name }, { id: secondTagId, name: "中文 & 😀" }];
  const child = () => ({ ...task, parentId: goalId, status: "todo", ready: true, startedAt: null, tags: refs() });
  const empty = () => ({ ...child(), id: secondId, title: "Untagged", tags: [] });
  const goal = () => ({ ...child(), id: goalId, type: "goal", parentId: null, ready: false, allowAgents: false, tags: [{ id: tagId, name }], progress: { total: 2, done: 0, cancelled: 0, unfinished: 2 } });
  const searchItem = () => ({ id: taskId, type: "task", parentId: goalId, projectId, title: "Task", status: "todo", cancelledAt: null, assignedTo: actorId, updatedAt: time, context: { taskId: goalId, title: "Goal" }, match: { fields: ["title"], descriptionSnippet: null }, tags: refs() });
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("Content-Type", "application/json"); response.setHeader("Daynight-User-ID", actorId);
    const base = `/api/v1/projects/${projectId}`;
    if (url.pathname === base) response.end(stringifyApiJson(project));
    else if (url.pathname === `${base}/tasks/${taskId}/status` && request.method === "PUT") response.end(stringifyApiJson({ ...child(), status: "done", ready: false, completedAt: time, version: task.version + 1n }));
    else if (url.pathname === `${base}/tasks/${taskId}`) response.end(stringifyApiJson(withTaskObservation(child())));
    else if (url.pathname === `${base}/tasks/${goalId}`) response.end(stringifyApiJson(withTaskObservation(goal())));
    else if (url.pathname === `${base}/tasks/search`) response.end(stringifyApiJson({ projectId, total: 1, items: [searchItem()], nextCursor: null }));
    else if (url.pathname === `${base}/tasks`) {
      if (brokenPage && url.searchParams.has("cursor")) response.end(stringifyApiJson({ items: [{ ...child(), id: secondId, tags: null }], nextCursor: null, observedAt: time, partial: false }));
      else {
        const items = brokenPage ? [child()] : [child(), empty()];
        response.end(stringifyApiJson({ items: url.searchParams.has("include") ? items.map(withTaskObservation) : items, nextCursor: brokenPage ? "next-page" : null, ...(url.searchParams.has("include") ? { observedAt: time, partial: false } : {}) }));
      }
    } else { response.writeHead(404); response.end(stringifyApiJson({ error: { code: "not_found", message: "Unexpected route", requestId: "fixture" } })); }
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, DN_CONFIG_DIR: state, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"), XDG_CONFIG_HOME: path.join(fixture, "xdg"), XDG_CACHE_HOME: path.join(fixture, "cache"), TMPDIR: temporary, TMP: temporary, TEMP: temporary, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(fixture, "git-global"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const children = new Map<ChildProcess, Promise<unknown>>();
  const invoke = async (args: string[]) => {
    const process = crossSpawn(receipt.launcherPath, ["task", ...args, "--project", projectId], { cwd: fixture, env, windowsHide: true, detached: globalThis.process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: unknown;
    process.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    process.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    process.once("error", error => { failure = error; });
    const closed = new Promise<number | null>(resolve => process.once("close", code => { children.delete(process); resolve(code); }));
    children.set(process, closed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
      if (code === "timeout") { await terminateInstalledProcess(process, closed); throw new Error("Task tag read exceeded twenty seconds."); }
      if (failure !== undefined) throw failure;
      return { code, stdout, stderr };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  let failure: unknown;
  try {
    await mkdir(home, { recursive: true }); await mkdir(state, { recursive: true }); await mkdir(temporary, { recursive: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing HTTP listener.");
    await writeFile(path.join(state, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    for (const args of [["show", taskId], ["list"], ["ready"], ["search", "Task"]]) {
      const result = await invoke(args);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("backend"); expect(result.stdout).toContain("中文 & 😀");
      if (args[0] === "list" || args[0] === "ready") expect(result.stdout).toContain("Tags: none");
    }
    for (const args of [["show", taskId], ["list"], ["ready"], ["search", "Task"]]) {
      const result = await invoke([...args, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      const value = parseApiJson(result.stdout) as any;
      const item = Array.isArray(value) ? value[0] : value;
      expect(item.tags).toEqual(refs());
      if (args[0] === "search") { expect(item).not.toHaveProperty("assignedTo"); expect(item).not.toHaveProperty("updatedAt"); }
    }
    const receiptResult = await invoke(["set-status", taskId, "done", "--if-version", String(task.version)]);
    expect(receiptResult.code, receiptResult.stderr).toBe(0);
    expect(receiptResult.stdout).toContain("Status: done");
    expect(receiptResult.stdout).toContain("backend"); expect(receiptResult.stdout).toContain("中文 & 😀");
    const parent = await invoke(["show", goalId, "--json"]);
    expect(parent.code, parent.stderr).toBe(0); expect((parseApiJson(parent.stdout) as any).tags).toEqual([{ id: tagId, name }]);
    name = "platform";
    const renamed = await invoke(["show", taskId, "--json"]);
    expect(renamed.code, renamed.stderr).toBe(0); expect((parseApiJson(renamed.stdout) as any).tags).toEqual(refs());
    brokenPage = true;
    const invalid = await invoke(["list", "--json"]);
    expect(invalid.code).toBe(1); expect(invalid.stdout).toBe(""); expect(invalid.stderr).not.toBe("");
  } catch (error) { failure = error; }
  const cleanupErrors: unknown[] = [];
  for (const [childProcess, closed] of children) { try { await terminateInstalledProcess(childProcess, closed); } catch (error) { cleanupErrors.push(error); } }
  try { await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); } catch (error) { cleanupErrors.push(error); }
  try { await installed.cleanup(); } catch (error) { cleanupErrors.push(error); }
  if (failure !== undefined || cleanupErrors.length > 0) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupErrors], "Task tag acceptance or cleanup failed.");
}, 180_000);
