import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

const userId = "aaaaaaaa-1111-4111-8111-111111111111";
const personalId = "bbbbbbbb-2222-4222-8222-222222222222";
const teamId = "cccccccc-3333-4333-8333-333333333333";
const inviteId = "dddddddd-4444-4444-8444-444444444444";
const time = "2026-11-04T10:00:00Z";
const token = "fixture-credential";
const secret = `dnteam_${"a".repeat(42)}A`;
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
    if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed Team invitation command timed out."); }
    if (launchFailure !== undefined) throw launchFailure;
    return { code, stdout, stderr };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

it("manages Team invitations safely through the installed launcher", async () => {
  const installed = await createAcceptanceCli();
  const home = path.join(installed.receipt.root, "team invitation home");
  const config = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(config), { recursive: true });
  const calls: { method: string; path: string; body: string }[] = [];
  let origin = "", revoked = false;
  let mode: "normal" | "unknown" | "wrong-principal" | "malformed" | "malicious" = "normal";
  const metadata = { id: inviteId, teamId, createdBy: userId, createdAt: time, expiresAt: "2026-11-11T10:00:00Z", consumedBy: null, consumedAt: null, revokedAt: null };
  const team = { id: teamId, kind: "ordinary", name: "Team A", version: 7, createdAt: time, updatedAt: time, membership: { teamId, userId, role: "admin", version: 2, createdAt: time, updatedAt: time } };
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      calls.push({ method: request.method!, path: request.url!, body });
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Daynight-User-ID", mode === "wrong-principal" && request.method !== "GET" ? personalId : userId);
      const send = (value: unknown, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== `Bearer ${token}`) { send({ error: { code: "unauthorized", message: "Unauthorized" } }, 401); return; }
      if (request.method === "GET" && request.url === "/api/v1/me") { send({ id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } }); return; }
      if (request.method === "GET" && request.url === `/api/v1/teams/${personalId}`) { send({ ...team, id: personalId, kind: "personal", name: null, membership: { ...team.membership, teamId: personalId } }); return; }
      if (request.method === "GET" && request.url === `/api/v1/teams/${teamId}`) { send(team); return; }
      if (request.url === `/api/v1/teams/${teamId}/invitations`) {
        if (request.method === "GET") { send({ items: [metadata] }); return; }
        if (request.method === "POST") {
          response.setHeader("Location", `/api/v1/teams/${teamId}/invitations/${inviteId}`);
          if (mode === "unknown") { response.socket!.destroy(); return; }
          if (mode === "malformed") { response.writeHead(201); response.end(`{"link":"${origin}/team-invitations#${secret}",`); return; }
          send({ ...metadata, link: `${mode === "malicious" ? "https://evil.example" : origin}/team-invitations#${secret}` }, 201); return;
        }
      }
      if (request.method === "DELETE" && request.url === `/api/v1/teams/${teamId}/invitations/${inviteId}`) {
        const changed = !revoked; revoked = true; send({ teamId, invitationId: inviteId, changed }); return;
      }
      send({ error: { code: "internal_error", message: "Unexpected request", requestId: "fixture" } }, 500);
    });
  });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|CODEX_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, NO_COLOR: "1" });
  const pipe = (args: string[]) => capture(crossSpawn(installed.receipt.launcherPath, args, { cwd: home, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
  const tty = (args: string[], input: string) => capture(spawn("python3", ["-u", path.join(import.meta.dirname, "review-configuration-pty.py")], { cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"] }), JSON.stringify({ command: [installed.receipt.launcherPath, ...args], cwd: home, environment, actions: [{ waitFor: "[y/N]", input }] }));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture listener.");
    origin = `http://127.0.0.1:${address.port}`;
    const source = `serverUrl: ${origin}\nserverToken: ${token}\n`;
    await writeFile(config, source, { mode: 0o600 });
    const help = await pipe(["team", "invitation", "create", "--help"]);
    expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain("printed once");
    const noTty = await pipe(["team", "invitation", "create", "--team", teamId]);
    expect(noTty.code).not.toBe(0); expect(calls).toHaveLength(0);
    for (const suffix of [["--confirm=false"], ["--confirm", "--confirm"]]) {
      const invalid = await pipe(["team", "invitation", "create", "--team", teamId, ...suffix]);
      expect(invalid.code).toBe(2); expect(calls).toHaveLength(0);
    }
    const personal = await pipe(["team", "invitation", "create", "--team", "personal", "--confirm"]);
    expect(personal.code).not.toBe(0); expect(personal.stderr).toContain("Personal Team");
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);
    if (process.platform !== "win32") {
      const cancelledHarness = await tty(["team", "invitation", "create", "--team", teamId], "n\n");
      expect(cancelledHarness.code, cancelledHarness.stderr).toBe(0);
      expect((JSON.parse(cancelledHarness.stdout) as Result).code).not.toBe(0);
      expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);
    }
    const created = await pipe(["team", "invitation", "create", "--team", teamId, "--confirm"]);
    expect(created.code, created.stderr).toBe(0); expect(created.stdout).toBe(`${origin}/team-invitations#${secret}\n`); expect(created.stderr).not.toContain(secret);
    expect(JSON.parse(calls.find(({ method }) => method === "POST")!.body)).toEqual({ expectedUserId: userId });
    const createdJson = await pipe(["team", "invitation", "create", "--team", teamId, "--confirm", "--json"]);
    expect(createdJson.code, createdJson.stderr).toBe(0); expect(JSON.parse(createdJson.stdout)).toEqual({ ...metadata, link: `${origin}/team-invitations#${secret}` });
    const list = await pipe(["team", "invitation", "list", "--team", teamId, "--json"]);
    expect(list.code, list.stderr).toBe(0); expect(JSON.parse(list.stdout)).toEqual([metadata]); expect(list.stdout).not.toContain(secret);
    const revoke = () => pipe(["team", "invitation", "revoke", inviteId, "--team", teamId, "--confirm", "--json"]);
    if (process.platform !== "win32") {
      const cancelledHarness = await tty(["team", "invitation", "revoke", inviteId, "--team", teamId], "n\n");
      expect(cancelledHarness.code, cancelledHarness.stderr).toBe(0);
      expect((JSON.parse(cancelledHarness.stdout) as Result).code).not.toBe(0);
      expect(calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
      const confirmedHarness = await tty(["team", "invitation", "revoke", inviteId, "--team", teamId, "--json"], "y\n");
      expect(confirmedHarness.code, confirmedHarness.stderr).toBe(0);
      const first = JSON.parse(confirmedHarness.stdout) as Result;
      expect(first.code, first.stderr).toBe(0); expect(JSON.parse(first.stdout)).toEqual({ teamId, invitationId: inviteId, changed: true });
    } else {
      const first = await revoke(); expect(first.code, first.stderr).toBe(0); expect(JSON.parse(first.stdout).changed).toBe(true);
    }
    const second = await pipe(["team", "invitation", "revoke", inviteId, "--team", teamId, "--confirm"]);
    expect(second.code, second.stderr).toBe(0); expect(second.stdout).toContain("was not changed");
    expect(calls.filter(({ method }) => method === "DELETE").map(({ body }) => JSON.parse(body))).toEqual([{ expectedUserId: userId }, { expectedUserId: userId }]);
    for (mode of ["malformed", "malicious", "wrong-principal", "unknown"] as const) {
      const count = calls.filter(({ method }) => method === "POST").length;
      const failed = await pipe(["team", "invitation", "create", "--team", teamId, "--confirm"]);
      expect(failed.code).not.toBe(0); expect(failed.stdout).toBe(""); expect(failed.stderr).not.toContain(secret);
      expect(calls.filter(({ method }) => method === "POST")).toHaveLength(count + 1);
    }
    expect(await readFile(config, "utf8")).toBe(source);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); });
    await installed.cleanup();
  }
});
