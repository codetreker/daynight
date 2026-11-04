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
const token = "team-lifecycle-fixture";
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
    if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed Team lifecycle command timed out."); }
    if (launchFailure !== undefined) throw launchFailure;
    return { code, stdout, stderr };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

it("runs lifecycle writes and exact-name challenges through the installed launcher", async () => {
  const installed = await createAcceptanceCli();
  const home = path.join(installed.receipt.root, "team lifecycle home");
  const config = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(config), { recursive: true });
  const calls: { method: string; path: string; body: string }[] = [];
  let rawName = "  line\nreturn\r tab\t slash\\ end  ";
  let mode: "normal" | "unknown" | "wrong-principal" = "normal";
  const team = () => ({ id: teamId, kind: "ordinary", name: rawName, version: 7, createdAt: time, updatedAt: time, membership: { teamId, userId, role: "admin", version: 2, createdAt: time, updatedAt: time } });
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
      if (request.method === "GET" && request.url === `/api/v1/teams/${teamId}`) { send(team()); return; }
      if (request.method === "POST" && request.url === "/api/v1/teams") {
        rawName = JSON.parse(body).name;
        response.setHeader("Location", `/api/v1/teams/${teamId}`);
        if (mode === "unknown") { response.socket!.destroy(); return; }
        send(team(), 201); return;
      }
      if (request.method === "DELETE" && request.url === `/api/v1/teams/${teamId}`) { send({ teamId, deleted: true }); return; }
      send({ error: { code: "internal_error", message: "Unexpected request", requestId: "fixture" } }, 500);
    });
  });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|CODEX_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, NO_COLOR: "1" });
  const pipe = (args: string[]) => capture(crossSpawn(installed.receipt.launcherPath, args, { cwd: home, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
  const tty = (args: string[], input: string, waitFor = "JSON") => capture(spawn("python3", ["-u", path.join(import.meta.dirname, "review-configuration-pty.py")], { cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"] }), JSON.stringify({ command: [installed.receipt.launcherPath, ...args], cwd: home, environment, actions: [{ waitFor, input }] }));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture listener.");
    const source = `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${token}\n`;
    await writeFile(config, source, { mode: 0o600 });
    const help = await pipe(["team", "delete", "--help"]);
    expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain("--confirm"); expect(help.stdout).toContain("JSON");
    for (const args of [["team", "create", "name", "--confirm=false"], ["team", "create", "name", "--confirm", "--confirm"]]) {
      const invalid = await pipe(args); expect(invalid.code).toBe(2);
    }
    const before = calls.length;
    const noTty = await pipe(["team", "delete", "--team", teamId]);
    expect(noTty.code).not.toBe(0); expect(calls.slice(before)).toEqual([]);
    if (process.platform !== "win32") {
      const cancelledHarness = await tty(["team", "create", "cancelled"], "n\n", "[y/N]");
      expect(cancelledHarness.code, cancelledHarness.stderr).toBe(0);
      expect((JSON.parse(cancelledHarness.stdout) as Result).code).not.toBe(0);
      expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);
      const mismatchHarness = await tty(["team", "delete", "--team", teamId], '"wrong"\n');
      expect(mismatchHarness.code, mismatchHarness.stderr).toBe(0);
      const mismatch = JSON.parse(mismatchHarness.stdout) as Result;
      expect(mismatch.code).not.toBe(0); expect(calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
      const exactName = rawName;
      const harness = await tty(["team", "delete", "--team", teamId, "--json"], `${JSON.stringify(exactName)}\n`);
      expect(harness.code, harness.stderr).toBe(0);
      const result = JSON.parse(harness.stdout) as Result;
      expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ teamId, deleted: true });
      const deletion = calls.filter(({ method }) => method === "DELETE");
      expect(deletion).toHaveLength(1); expect(JSON.parse(deletion[0]!.body)).toEqual({ name: exactName, version: 7, expectedUserId: userId });
    }
    const created = await pipe(["team", "create", "  created  ", "--confirm", "--json"]);
    expect(created.code, created.stderr).toBe(0); expect(JSON.parse(created.stdout).name).toBe("  created  ");
    const creates = calls.filter(({ method }) => method === "POST");
    expect(creates).toHaveLength(1); expect(JSON.parse(creates[0]!.body)).toEqual({ name: "  created  ", expectedUserId: userId });
    mode = "unknown";
    const unknown = await pipe(["team", "create", "unknown", "--confirm"]);
    expect(unknown.code).not.toBe(0); expect(unknown.stdout).toBe(""); expect(rawName).toBe("unknown"); expect(calls.filter(({ method }) => method === "POST")).toHaveLength(2);
    mode = "wrong-principal";
    const mismatch = await pipe(["team", "create", "principal", "--confirm"]);
    expect(mismatch.code).not.toBe(0); expect(mismatch.stdout).toBe(""); expect(calls.filter(({ method }) => method === "POST")).toHaveLength(3);
    expect(await readFile(config, "utf8")).toBe(source);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); });
    await installed.cleanup();
  }
});
