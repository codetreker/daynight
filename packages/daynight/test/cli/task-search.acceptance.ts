import { type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

const fixtureRoot = new URL("../../../daynight-server/testdata/task-search/", import.meta.url);
const fixture = async (name: string): Promise<any> => JSON.parse(await readFile(new URL(`${name}.json`, fixtureRoot), "utf8"));
const userId = "459052e2-186f-4a52-8a58-55425ce43631";
const projectId = "79ccb68f-2bb1-4f41-a364-8befabb50945";
const credential = "search-acceptance-credential";

type Result = { code: number | null; stdout: string; stderr: string };
async function capture(child: ChildProcess): Promise<Result> {
  let stdout = "", stderr = "", failure: unknown;
  child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  child.once("error", (error) => { failure = error; });
  child.stdin!.end();
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
    if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed search command timed out."); }
    if (failure !== undefined) throw failure;
    return { code, stdout, stderr };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

it("searches through the installed package with complete, ordered and safe output", async () => {
  const installed = await createAcceptanceCli();
  const home = path.join(installed.receipt.root, "search home");
  const config = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(config), { recursive: true });
  const first = await fixture("first-page"), next = await fixture("next-page"), empty = await fixture("empty-page");
  const syntax = await fixture("invalid-expression"), changed = await fixture("search-changed");
  const calls: { method: string; path: string; body: any }[] = [];
  let mode = "filtered";
  let secondRequest: (() => void) | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      let input: any;
      try { input = JSON.parse(body); } catch { input = body; }
      calls.push({ method: request.method!, path: request.url!, body: input });
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Daynight-User-ID", userId);
      const send = (value: unknown, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== `Bearer ${credential}` || request.method !== "POST" || request.url !== `/api/v1/projects/${projectId}/tasks/search`) {
        send({ error: { code: "internal_error", message: "Unexpected request", requestId: "fixture" } }, 500); return;
      }
      const second = input.cursor !== undefined && input.cursor !== null;
      if (mode === "hold" && second) { secondRequest?.(); return; }
      if (mode === "changed" && second) { send(changed, 409); return; }
      if (mode === "disconnect" && second) { request.socket.destroy(); return; }
      if (mode === "broken" && second) { send({ ...next, total: "2" }); return; }
      if (mode === "duplicate-id" && second) { send({ ...next, items: [first.items[0]] }); return; }
      if (mode === "duplicate-cursor" && !second) { send({ ...first, total: 3 }); return; }
      if (mode === "duplicate-cursor" && second) { send({ ...next, total: 3, nextCursor: first.nextCursor }); return; }
      if (mode === "principal" && second) { response.setHeader("Daynight-User-ID", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); send(next); return; }
      if (mode === "project" && second) { send({ ...next, projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }); return; }
      if (mode === "bad-context") { send({ ...empty, total: 1, items: [{ ...first.items[0], context: { taskId: "invalid", title: "Goal" } }] }); return; }
      if (mode === "bad-match") { send({ ...empty, total: 1, items: [{ ...first.items[0], match: { fields: ["description"], descriptionSnippet: null } }] }); return; }
      if (mode === "bad-page") { send({ ...first, items: {} }); return; }
      if (mode === "syntax") { send(syntax, 400); return; }
      if (mode === "bad-syntax") { send({ error: { ...syntax.error, details: { reason: "unclosed_group" } } }, 400); return; }
      if (mode === "empty") { send(empty); return; }
      if (mode === "text") {
        const title = `${"完整标题".repeat(80)}\u001b[31m\n尾`;
        send({ projectId, total: 2, nextCursor: null, items: [
          { ...first.items[0], title, status: "done", context: { ...first.items[0].context, title: "Goal\t标题", future: "context-secret" }, match: { ...first.items[0].match, future: "match-secret" }, future: "wire-secret" },
          { ...next.items[0], match: { fields: [], descriptionSnippet: null } },
        ] }); return;
      }
      const page = second ? next : first;
      send(mode === "filtered" ? { ...page, items: page.items.map((item: any) => ({ ...item, status: "done", assignedTo: userId })) } : page);
    });
  });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|CODEX_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, NO_COLOR: "1" });
  const start = (args: string[]) => crossSpawn(installed.receipt.launcherPath, args, { cwd: home, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const run = (args: string[]) => capture(start(args));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture listener.");
    await writeFile(config, `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${credential}\n`, { mode: 0o600 });

    const query = '  title:"缓存 😀 \\"x\\"" OR description:"a\\\\b"  ';
    const filtered = await run(["task", "search", query, "--project", projectId, "--status", "done", "--assigned-to", "me", "--ready", "--allow-agents", "false", "--compatible-platform", "linux", "--json"]);
    expect(filtered.code, filtered.stderr).toBe(0);
    expect(filtered.stdout.endsWith("\n")).toBe(true);
    const output = JSON.parse(filtered.stdout);
    expect(output.map((item: any) => item.id)).toEqual([first.items[0].id, next.items[0].id]);
    expect(Object.keys(output[0])).toEqual(["id", "projectId", "title", "status", "context", "match"]);
    expect(filtered.stdout).not.toMatch(/assignedTo|updatedAt/);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual({ query, status: "done", assignedTo: "me", ready: true, allowAgents: false, compatiblePlatform: "linux", limit: 100 });
    expect(calls[1]!.body).toEqual({ ...calls[0]!.body, cursor: first.nextCursor });
    expect(calls.every(({ method, path: target }) => method === "POST" && target === `/api/v1/projects/${projectId}/tasks/search`)).toBe(true);

    mode = "pages";
    const unfiltered = await run(["task", "search", "cache", "--project", projectId, "--json"]);
    expect(unfiltered.code, unfiltered.stderr).toBe(0);
    expect(JSON.parse(unfiltered.stdout).map((item: any) => item.id)).toEqual([first.items[0].id, next.items[0].id]);

    mode = "text";
    const text = await run(["task", "search", "--project", projectId, "--", "-literal"]);
    expect(text.code, text.stderr).toBe(0);
    expect(calls.at(-1)!.body.query).toBe("-literal");
    expect(calls.at(-1)!.body).not.toHaveProperty("status");
    expect(text.stdout).toContain(`${"完整标题".repeat(80)}\\u001b[31m\\n尾`);
    expect(text.stdout).toContain("Goal\\t标题");
    expect(text.stdout).toContain("Match: negative condition");
    expect(text.stdout).not.toMatch(/Assigned to|Updated|wire-secret|context-secret|match-secret|\u001b/);
    const projected = await run(["task", "search", "x", "--project", projectId, "--json"]);
    expect(projected.code, projected.stderr).toBe(0);
    expect(projected.stdout).not.toMatch(/assignedTo|updatedAt|wire-secret|context-secret|match-secret/);
    expect(JSON.parse(projected.stdout)[0].title).toBe(`${"完整标题".repeat(80)}\u001b[31m\n尾`);
    mode = "empty";
    expect(await run(["task", "search", "x", "--project", projectId, "--json"])).toEqual({ code: 0, stdout: "[]\n", stderr: "" });
    const noMatches = await run(["task", "search", "x", "--project", projectId]);
    expect(noMatches.code).toBe(0); expect(noMatches.stdout).toBe(`Project: ${projectId}\nNo matching tasks.\n`);
    const priorCalls = calls.length;
    const blank = await run(["task", "search", " \t ", "--project", projectId]);
    expect(blank.code).toBe(2); expect(blank.stdout).toBe(""); expect(calls).toHaveLength(priorCalls);
    mode = "syntax";
    const invalid = await run(["task", "search", "缓存 AND (Worker", "--project", projectId, "--json"]);
    expect(invalid.code).toBe(2); expect(invalid.stdout).toBe(""); expect(invalid.stderr).toContain("unclosed_group"); expect(invalid.stderr).toContain("8");
    mode = "bad-syntax";
    const badSyntax = await run(["task", "search", "x", "--project", projectId, "--json"]);
    expect(badSyntax.code).toBe(1); expect(badSyntax.stdout).toBe("");
    for (mode of ["changed", "disconnect", "broken", "duplicate-id", "duplicate-cursor", "principal", "project", "bad-context", "bad-match", "bad-page"]) {
      const failed = await run(["task", "search", "x", "--project", projectId, "--json"]);
      expect(failed.code, failed.stderr).toBe(1); expect(failed.stdout).toBe("");
      if (mode === "changed") expect(failed.stderr).toContain("search_changed");
    }
    if (process.platform !== "win32") {
      mode = "hold";
      let requestTimeout: ReturnType<typeof setTimeout> | undefined;
      const requested = new Promise<void>((resolve) => { secondRequest = resolve; });
      const child = start(["task", "search", "x", "--project", projectId, "--json"]);
      const outcome = capture(child);
      try {
        await Promise.race([requested, new Promise<never>((_resolve, reject) => { requestTimeout = setTimeout(() => reject(new Error("Second search page did not start.")), 10_000); })]);
        child.kill("SIGINT");
        const cancelled = await outcome;
        expect(cancelled.code).toBe(1); expect(cancelled.stdout).toBe("");
      } finally {
        if (requestTimeout !== undefined) clearTimeout(requestTimeout);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); });
    await installed.cleanup();
  }
});
