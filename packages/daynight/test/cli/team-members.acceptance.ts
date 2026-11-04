import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { parseApiJson } from "../../src/api/json.js";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

const userId = "aaaaaaaa-1111-4111-8111-111111111111";
const targetId = "dddddddd-4444-4444-8444-444444444444";
const personalId = "bbbbbbbb-2222-4222-8222-222222222222";
const teamId = "cccccccc-3333-4333-8333-333333333333";
const time = "2026-11-04T10:00:00Z";
const token = "team-members-fixture";
const version = 9007199254740993n;
type Result = { code: number | null; stdout: string; stderr: string };

async function capture(child: ChildProcess, input?: string): Promise<Result> {
  let stdout = "", stderr = "", launchFailure: unknown;
  child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  child.once("error", (error) => { launchFailure = error; });
  if (input !== undefined) child.stdin!.end(input);
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
    if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed Team member command timed out."); }
    if (launchFailure !== undefined) throw launchFailure;
    return { code, stdout, stderr };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

it("runs scoped membership reads and writes through the installed launcher", async () => {
  const installed = await createAcceptanceCli();
  const home = path.join(installed.receipt.root, "team members home 中文");
  const config = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(config), { recursive: true });
  const calls: { method: string; path: string; body: string }[] = [];
  let mode: "normal" | "unknown" | "wrong-principal" | "last-admin" | "personal" = "normal";
  const member = (id: string, role = "member") => ({ teamId, userId: id, role, version: "EXACT_VERSION", createdAt: time, updatedAt: time });
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      calls.push({ method: request.method!, path: request.url!, body });
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Daynight-User-ID", mode === "wrong-principal" && request.method !== "GET" ? targetId : userId);
      const send = (value: unknown, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value).replaceAll('"EXACT_VERSION"', version.toString()).replaceAll('"NEXT_VERSION"', (version + 1n).toString())); };
      if (request.headers.authorization !== `Bearer ${token}`) { send({ error: { code: "unauthorized", message: "Unauthorized" } }, 401); return; }
      if (request.method === "GET" && request.url === "/api/v1/me") { send({ id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } }); return; }
      if (request.method === "GET" && request.url === `/api/v1/teams/${teamId}`) { send({ id: teamId, kind: "ordinary", name: "Team", version: 7, createdAt: time, updatedAt: time, membership: member(userId, "admin") }); return; }
      if (request.method === "GET" && request.url === `/api/v1/teams/${teamId}/members`) { send({ items: [{ ...member(userId, "admin"), profile: { name: null, email: null, avatarUrl: null } }, { ...member(targetId), profile: { name: "Member", email: null, avatarUrl: null } }] }); return; }
      if ((request.method === "PATCH" || request.method === "DELETE") && request.url?.startsWith(`/api/v1/teams/${teamId}/members/`)) {
        if (mode === "unknown") { response.socket!.destroy(); return; }
        if (mode === "last-admin" || mode === "personal") { send({ error: { code: mode === "last-admin" ? "last_admin" : "personal_team_immutable", message: "Refused", requestId: "members-refused" } }, 409); return; }
        const id = request.url.slice(request.url.lastIndexOf("/") + 1);
        if (request.method === "PATCH") send({ membership: { ...member(id, "admin"), version: "NEXT_VERSION" }, actorRole: "admin" });
        else send({ teamId, userId: id, removed: true, actorRole: id === userId ? null : "admin" });
        return;
      }
      send({ error: { code: "internal_error", message: "Unexpected request", requestId: "members-fixture" } }, 500);
    });
  });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|CODEX_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, NO_COLOR: "1" });
  const pipe = (args: string[]) => capture(crossSpawn(installed.receipt.launcherPath, args, { cwd: home, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
  const tty = (args: string[], input: string) => capture(spawn("python3", ["-u", path.join(import.meta.dirname, "review-configuration-pty.py")], { cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"] }), JSON.stringify({ command: [installed.receipt.launcherPath, ...args], cwd: home, environment, actions: [{ waitFor: "[y/N]", input }] }));
  const writes = () => calls.filter(({ method }) => method === "PATCH" || method === "DELETE");
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing Team fixture listener.");
    const source = `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${token}\n`;
    await writeFile(config, source, { mode: 0o600 });
    for (const args of [["team", "member", "--help"], ["team", "member", "set-role", "--help"], ["team", "leave", "--help"]]) {
      const help = await pipe(args); expect(help.code, help.stderr).toBe(0);
      if (args.includes("set-role") || args.includes("leave")) { expect(help.stdout).toContain("--confirm"); expect(help.stdout).toContain("--if-version"); }
      else { expect(help.stdout).toContain("list"); expect(help.stdout).toContain("remove"); }
    }
    const completion = await pipe(["completion", "bash"]);
    expect(completion.code, completion.stderr).toBe(0); expect(completion.stdout).toContain("member");
    const list = await pipe(["team", "member", "list", "--team", teamId, "--json"]);
    expect(list.code, list.stderr).toBe(0);
    const members = parseApiJson(list.stdout) as { userId: string; version: bigint; profile: { name: string | null; email: string | null; avatarUrl: string | null } }[];
    expect(members).toHaveLength(2); expect(members[0]).toMatchObject({ userId, version, profile: { name: null, email: null, avatarUrl: null } });
    expect(members[1]).toMatchObject({ userId: targetId, version, profile: { name: "Member", email: null, avatarUrl: null } });
    const noTtyStart = calls.length;
    const noTty = await pipe(["team", "member", "remove", targetId, "--team", teamId]);
    expect(noTty.code).not.toBe(0); expect(calls.slice(noTtyStart)).toEqual([]);
    if (process.platform !== "win32") {
      const count = writes().length;
      const harness = await tty(["team", "member", "remove", targetId, "--team", teamId], "n\n");
      expect(harness.code, harness.stderr).toBe(0); expect((JSON.parse(harness.stdout) as Result).code).not.toBe(0); expect(writes()).toHaveLength(count);
      const confirmed = await tty(["team", "member", "remove", targetId, "--team", teamId, "--json"], "y\n");
      expect(confirmed.code, confirmed.stderr).toBe(0); const result = JSON.parse(confirmed.stdout) as Result;
      expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ teamId, userId: targetId, removed: true, actorRole: "admin" });
      expect(writes()).toHaveLength(count + 1);
      expect(parseApiJson(writes().at(-1)!.body)).toEqual({ version, expectedUserId: userId });
    }
    let start = calls.length;
    const role = await pipe(["team", "member", "set-role", targetId, "admin", "--team", teamId, "--if-version", version.toString(), "--confirm", "--json"]);
    expect(role.code, role.stderr).toBe(0);
    expect(parseApiJson(role.stdout)).toMatchObject({ membership: { teamId, userId: targetId, role: "admin", version: version + 1n }, actorRole: "admin" });
    expect(parseApiJson(writes().at(-1)!.body)).toEqual({ version, role: "admin", expectedUserId: userId });
    expect(calls.slice(start).at(-1)).toMatchObject({ method: "PATCH", path: `/api/v1/teams/${teamId}/members/${targetId}` });
    start = calls.length;
    const leave = await pipe(["team", "leave", "--team", teamId, "--confirm", "--json"]);
    expect(leave.code, leave.stderr).toBe(0); expect(JSON.parse(leave.stdout)).toEqual({ teamId, userId, removed: true, actorRole: null });
    expect(parseApiJson(writes().at(-1)!.body)).toEqual({ version, expectedUserId: userId });
    expect(calls.slice(start).at(-1)).toMatchObject({ method: "DELETE", path: `/api/v1/teams/${teamId}/members/${userId}` });
    const beforeStale = writes().length;
    const stale = await pipe(["team", "member", "remove", targetId, "--team", teamId, "--if-version", "9007199254740992", "--confirm"]);
    expect(stale.code).not.toBe(0); expect(writes()).toHaveLength(beforeStale);
    for (const refusal of ["last-admin", "personal"] as const) {
      mode = refusal;
      const refused = await pipe(["team", "leave", "--team", teamId, "--confirm"]);
      expect(refused.code).not.toBe(0); expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain(refusal === "last-admin" ? "last_admin" : "personal_team_immutable");
    }
    mode = "unknown"; const beforeUnknown = writes().length;
    const unknown = await pipe(["team", "member", "remove", targetId, "--team", teamId, "--confirm"]);
    expect(unknown.code).not.toBe(0); expect(unknown.stdout).toBe(""); expect(unknown.stderr).toContain("unknown"); expect(writes()).toHaveLength(beforeUnknown + 1);
    mode = "wrong-principal"; const beforePrincipal = writes().length;
    const mismatch = await pipe(["team", "member", "remove", targetId, "--team", teamId, "--confirm"]);
    expect(mismatch.code).not.toBe(0); expect(mismatch.stdout).toBe(""); expect(writes()).toHaveLength(beforePrincipal + 1);
    expect(await readFile(config, "utf8")).toBe(source);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); });
    await installed.cleanup();
  }
});
