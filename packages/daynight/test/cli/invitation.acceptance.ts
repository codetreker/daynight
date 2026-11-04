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
const time = "2026-11-04T10:00:00Z";
const credential = "invitation-acceptance-credential";
const secret = `dnteam_${Buffer.alloc(32, 7).toString("base64url")}`;
type Result = { code: number | null; stdout: string; stderr: string };

async function capture(child: ChildProcess, input: string): Promise<Result> {
  let stdout = "", stderr = "", launchFailure: unknown;
  child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  child.once("error", (error) => { launchFailure = error; });
  child.stdin!.on("error", () => {});
  child.stdin!.end(input);
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
    if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed invitation command timed out."); }
    if (launchFailure !== undefined) throw launchFailure;
    return { code, stdout, stderr };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

it("uses bounded and hidden invitation input and never replays an unknown acceptance", async () => {
  const installed = await createAcceptanceCli();
  const home = path.join(installed.receipt.root, "invitation home");
  const config = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(config), { recursive: true });
  const calls: { method: string; path: string; body: string }[] = [];
  let unknown = false;
  const team = { id: teamId, kind: "ordinary", name: "Fixture Team" };
  const membership = { teamId, userId, role: "member", version: 1, createdAt: time, updatedAt: time };
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      calls.push({ method: request.method!, path: request.url!, body });
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Daynight-User-ID", userId);
      const send = (value: unknown, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== `Bearer ${credential}`) { send({ error: { code: "unauthorized", message: "Unauthorized" } }, 401); return; }
      if (request.method === "GET" && request.url === "/api/v1/me") { send({ id: userId, email: "fixture@example.test", emailVerified: true, name: "Fixture User", avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } }); return; }
      if (request.method === "POST" && request.url === "/api/v1/team-invitations/inspect") { send({ team, membership: null }); return; }
      if (request.method === "POST" && request.url === "/api/v1/team-invitations/accept") {
        if (unknown) { response.socket!.destroy(); return; }
        send({ team, membership, joined: true, consumed: true }); return;
      }
      send({ error: { code: "internal_error", message: "Unexpected request", requestId: "fixture" } }, 500);
    });
  });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|CODEX_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, NO_COLOR: "1" });
  const pipe = (args: string[], input = "") => capture(crossSpawn(installed.receipt.launcherPath, args, { cwd: home, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] }), input);
  const tty = (args: string[], actions: { waitFor: string; input: string }[]) => capture(spawn("python3", ["-u", path.join(import.meta.dirname, "review-configuration-pty.py")], { cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"] }), JSON.stringify({ command: [installed.receipt.launcherPath, ...args], cwd: home, environment, actions }));
  const accepts = () => calls.filter(({ path: target }) => target === "/api/v1/team-invitations/accept");
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture listener.");
    const origin = `http://127.0.0.1:${address.port}`;
    const link = `${origin}/team-invitations#${secret}`;
    const source = `serverUrl: ${origin}\nserverToken: ${credential}\n`;
    await writeFile(config, source, { mode: 0o600 });

    const badArg = await pipe(["invitation", "inspect", link]);
    expect(badArg.code).toBe(2); expect(badArg.stderr).not.toContain(secret); expect(calls).toEqual([]);
    const badFlag = await pipe(["invitation", "inspect", "--token", secret]);
    expect(badFlag.code).toBe(2); expect(badFlag.stderr).not.toContain(secret); expect(calls).toEqual([]);
    const invalidLink = await pipe(["invitation", "inspect", "--stdin"], `${origin}/wrong#${secret}\n`);
    expect(invalidLink.code).not.toBe(0); expect(invalidLink.stderr).not.toContain(secret); expect(calls).toEqual([]);
    const tooLong = await pipe(["invitation", "inspect", "--stdin"], "x".repeat(4097));
    expect(tooLong.code).not.toBe(0); expect(tooLong.stderr).toContain("4096"); expect(calls).toEqual([]);
    const atLimit = await pipe(["invitation", "inspect", "--stdin"], "x".repeat(4096));
    expect(atLimit.code).not.toBe(0); expect(atLimit.stderr).not.toContain("exceeds 4096"); expect(calls).toEqual([]);
    const noConfirm = await pipe(["invitation", "accept", "--stdin"], `${link}\n`);
    expect(noConfirm.code).not.toBe(0); expect(calls).toEqual([]);
    const preview = await pipe(["invitation", "inspect", "--stdin", "--json"], `${link}\r\n`);
    expect(preview.code, preview.stderr).toBe(0); expect(JSON.parse(preview.stdout)).toEqual({ team, membership: null });
    expect(accepts()).toHaveLength(0);
    expect(JSON.parse(calls.find(({ path: target }) => target.endsWith("/inspect"))!.body)).toEqual({ token: secret });
    expect(preview.stdout + preview.stderr).not.toContain(secret);

    if (process.platform !== "win32") {
      const harness = await tty(["invitation", "accept", "--json"], [{ waitFor: "Invitation link (hidden):", input: `${link}\n` }, { waitFor: "[y/N]", input: "y\n" }]);
      expect(harness.code, harness.stderr).toBe(0);
      const result = JSON.parse(harness.stdout) as Result;
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("Fixture User"); expect(result.stderr).toContain("Fixture Team");
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(JSON.parse(result.stdout)).toEqual({ team, membership, joined: true, consumed: true });
      expect(accepts()).toHaveLength(1);
      expect(JSON.parse(accepts()[0]!.body)).toEqual({ token: secret, expectedUserId: userId });
    }
    const count = accepts().length;
    unknown = true;
    const lost = await pipe(["invitation", "accept", "--stdin", "--confirm"], `${link}\n`);
    expect(lost.code).not.toBe(0); expect(lost.stdout).toBe(""); expect(lost.stderr).toContain("unknown");
    expect(lost.stderr).not.toContain(secret); expect(accepts()).toHaveLength(count + 1);
    expect(await readFile(config, "utf8")).toBe(source);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); });
    await installed.cleanup();
  }
});
