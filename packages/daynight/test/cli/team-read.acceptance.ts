import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

const userId = "aaaaaaaa-1111-4111-8111-111111111111";
const personalId = "bbbbbbbb-2222-4222-8222-222222222222";
const ordinaryId = "cccccccc-3333-4333-8333-333333333333";
const staleId = "dddddddd-4444-4444-8444-444444444444";
const time = "2026-11-04T10:00:00Z";
const token = "team-acceptance-token";
const personal = { id: personalId, kind: "personal", name: null };
const user = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: personal };
const team = (id: string, kind: "personal" | "ordinary") => ({ id, kind, name: kind === "personal" ? null : " Team 中文 ", version: 1, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: "admin", version: 2, createdAt: time, updatedAt: time } });
const project = (id: string) => ({ id, name: "Project", repoUrl: "https://example.test/project.git", settings: { version: 1, executionWarningMinutes: 60 }, ownership: { teamId: ordinaryId, version: 1 }, createdAt: time, updatedAt: time });
type Result = { code: number | null; stdout: string; stderr: string };

const capture = async (child: ChildProcess, input?: string): Promise<Result> => {
  let stdout = "", stderr = "", launchFailure: unknown;
  child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  child.once("error", (error) => { launchFailure = error; });
  if (input !== undefined) child.stdin!.end(input);
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
    if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed Team command timed out."); }
    if (launchFailure !== undefined) throw launchFailure;
    return { code, stdout, stderr };
  } finally { if (timer !== undefined) clearTimeout(timer); }
};

it("reads Team context through the packed launcher without changing configuration or sending writes", async () => {
  const installed = await createAcceptanceCli();
  const home = path.join(installed.receipt.root, "team home 中文");
  const config = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(config), { recursive: true });
  const calls: { method: string; path: string; authorization: string | undefined }[] = [];
  let mode: "normal" | "second-page-failure" | "wrong-principal" = "normal";
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    calls.push({ method: request.method!, path: request.url!, authorization: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Daynight-User-ID", mode === "wrong-principal" && url.pathname !== "/api/v1/me" ? staleId : userId);
    const send = (value: unknown, status = 200): void => { response.writeHead(status); response.end(JSON.stringify(value)); };
    if (request.method !== "GET" || request.headers.authorization !== `Bearer ${token}`) { send({ error: { code: "internal_error", message: "Unexpected request", requestId: "team-fixture" } }, 500); return; }
    if (url.pathname === "/api/v1/me") { send(user); return; }
    if (url.pathname === `/api/v1/teams/${staleId}` || url.pathname === "/api/v1/projects" && url.searchParams.get("teamId") === staleId) { send({ error: { code: "not_found", message: "Team unavailable", requestId: "team-missing" } }, 404); return; }
    if (url.pathname === `/api/v1/teams/${personalId}`) { send(team(personalId, "personal")); return; }
    if (url.pathname === `/api/v1/teams/${ordinaryId}`) { send(team(ordinaryId, "ordinary")); return; }
    const cursor = url.searchParams.get("cursor");
    if (url.pathname === "/api/v1/teams" || url.pathname === "/api/v1/projects" && url.searchParams.get("teamId") === ordinaryId) {
      if (mode === "second-page-failure" && cursor !== null) { send({ error: { code: "internal_error", message: "Page failed", requestId: "page-failed" } }, 500); return; }
      if (url.pathname === "/api/v1/teams") send(cursor === null ? { items: [team(personalId, "personal")], nextCursor: "page 2+/=" } : { items: [team(ordinaryId, "ordinary")], nextCursor: null });
      else send(cursor === null ? { items: [project("eeeeeeee-5555-4555-8555-555555555555")], nextCursor: "page 2+/=" } : { items: [project("ffffffff-6666-4666-8666-666666666666")], nextCursor: null });
      return;
    }
    send({ error: { code: "internal_error", message: "Unexpected route", requestId: "team-route" } }, 500);
  });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|CODEX_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, NO_COLOR: "1" });
  const pipe = (args: string[]) => capture(crossSpawn(installed.receipt.launcherPath, args, { cwd: home, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing Team fixture listener.");
    const origin = `http://127.0.0.1:${address.port}`;
    const connection = `serverUrl: ${origin}\nserverToken: ${token}\n`;
    const source = `${connection}# Preserve unrelated and account-scoped settings\nteamDefaults:\n  ${origin}:\n    ${userId}: ${staleId}\n    eeeeeeee-5555-4555-8555-555555555555: ${ordinaryId}\n  https://elsewhere.example:\n    ${userId}: ${ordinaryId}\n`;
    await writeFile(config, source, { mode: 0o600 });
    const help = await pipe(["team", "--help"]);
    expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain("projects"); expect(help.stdout).toContain("default");
    const completion = await pipe(["completion", "bash"]);
    expect(completion.code, completion.stderr).toBe(0); expect(completion.stdout).toContain("team");
    const list = await pipe(["team", "list", "--json"]);
    expect(list.code, list.stderr).toBe(0); expect(JSON.parse(list.stdout).map((value: { id: string }) => value.id)).toEqual([personalId, ordinaryId]);
    const stale = await pipe(["team", "default", "show", "--json"]);
    expect(stale.code).not.toBe(0); expect(stale.stdout).toBe(""); expect(stale.stderr).toContain("not_found");
    const explicit = await pipe(["team", "show", "--team", ordinaryId, "--json"]);
    expect(explicit.code, explicit.stderr).toBe(0); expect(JSON.parse(explicit.stdout).id).toBe(ordinaryId);
    const projects = await pipe(["team", "projects", "--team", ordinaryId, "--json"]);
    expect(projects.code, projects.stderr).toBe(0); expect(JSON.parse(projects.stdout)).toHaveLength(2);
    mode = "second-page-failure";
    const partial = await pipe(["team", "list", "--json"]);
    expect(partial.code).not.toBe(0); expect(partial.stdout).toBe(""); expect(partial.stderr).toContain("internal_error");
    mode = "wrong-principal";
    const mismatch = await pipe(["team", "show", "--team", ordinaryId, "--json"]);
    expect(mismatch.code).not.toBe(0); expect(mismatch.stdout).toBe("");
    mode = "normal";
    expect(await readFile(config, "utf8")).toBe(source);
    await writeFile(config, connection);
    const fallback = await pipe(["team", "default", "show", "--json"]);
    expect(fallback.code, fallback.stderr).toBe(0); expect(JSON.parse(fallback.stdout)).toMatchObject({ configured: null, team: { id: personalId } });
    if (process.platform !== "win32") {
      const harness = await capture(spawn("python3", ["-u", path.join(import.meta.dirname, "review-configuration-pty.py")], { cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"] }), JSON.stringify({ command: [installed.receipt.launcherPath, "team", "show", "--team", "personal"], cwd: home, environment, actions: [] }));
      expect(harness.code, harness.stderr).toBe(0);
      const terminal = JSON.parse(harness.stdout) as Result;
      expect(terminal.code, terminal.stderr).toBe(0); expect(terminal.stdout).toContain(personalId); expect(terminal.stdout).toContain("Personal");
    }
    expect(await readFile(config, "utf8")).toBe(connection);
    expect(await readdir(path.dirname(config))).toEqual(["config.yml"]);
    expect(calls.every(({ method, authorization }) => method === "GET" && authorization === `Bearer ${token}`)).toBe(true);
    expect(calls.some(({ path: value }) => new URL(value, origin).searchParams.get("cursor") === "page 2+/=")).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); });
    await installed.cleanup();
  }
});
