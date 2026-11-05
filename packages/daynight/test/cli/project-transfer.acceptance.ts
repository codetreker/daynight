import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

const userId = "aaaaaaaa-1111-4111-8111-111111111111";
const sourceId = "bbbbbbbb-2222-4222-8222-222222222222";
const targetId = "cccccccc-3333-4333-8333-333333333333";
const projectId = "dddddddd-4444-4444-8444-444444444444";
const token = "transfer-fixture";
const source = { id: sourceId, kind: "personal", name: null };
const target = { id: targetId, kind: "ordinary", name: "Destination" };
const time = "2026-11-04T10:00:00Z";
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
    if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed transfer command timed out."); }
    if (launchFailure !== undefined) throw launchFailure;
    return { code, stdout, stderr };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

it("runs Project transfer through the installed launcher and preserves unknown outcomes", async () => {
  const installed = await createAcceptanceCli();
  const home = path.join(installed.receipt.root, "transfer home");
  const config = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(config), { recursive: true });
  const calls: { method: string; path: string; body: string }[] = [];
  let mode: "normal" | "conflict" | "unknown" | "wrong-principal" = "normal";
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      calls.push({ method: request.method!, path: request.url!, body });
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Daynight-User-ID", mode === "wrong-principal" && request.url!.endsWith("/transfer") ? targetId : userId);
      const send = (value: unknown, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== `Bearer ${token}`) { send({ error: { code: "unauthorized", message: "Unauthorized" } }, 401); return; }
      if (request.url === "/api/v1/me") { send({ id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: source }); return; }
      if (request.url === `/api/v1/projects/${projectId}`) { send({ id: projectId, name: "Project", repoUrl: "https://example.test/repo", settings: { version: 1, executionWarningMinutes: 60 }, ownership: { teamId: sourceId, version: 1 }, createdAt: time, updatedAt: time }); return; }
      if (request.url === `/api/v1/projects/${projectId}/transfer-preview`) {
        response.end(`{"sourceTeam":${JSON.stringify(source)},"targetTeam":{${JSON.stringify(target).slice(1,-1)},"version":9007199254740993},"ownership":{"teamId":"${sourceId}","version":9007199254740994},"actorRole":null}`); return;
      }
      if (request.url === `/api/v1/projects/${projectId}/transfer`) {
        if (mode === "unknown") { response.socket!.destroy(); return; }
        if (mode === "conflict") { send({ error: { code: "version_conflict", message: "Conflict", requestId: "fixture" } }, 409); return; }
        response.end(`{"projectId":"${projectId}","changed":true,"sourceTeam":${JSON.stringify(source)},"ownerTeam":${JSON.stringify(target)},"ownership":{"teamId":"${targetId}","version":9007199254740995},"actorAccess":null}`); return;
      }
      send({ error: { code: "not_found", message: "Not found", requestId: "fixture" } }, 404);
    });
  });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|CODEX_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, NO_COLOR: "1" });
  const args = ["project", "transfer", "--project", projectId, "--to-team", targetId];
  const pipe = (extra: string[]) => capture(crossSpawn(installed.receipt.launcherPath, extra, { cwd: home, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
  const tty = (input: string) => capture(spawn("python3", ["-u", path.join(import.meta.dirname, "review-configuration-pty.py")], { cwd: home, detached: true, stdio: ["pipe", "pipe", "pipe"] }), JSON.stringify({ command: [installed.receipt.launcherPath, ...args], cwd: home, environment, actions: [{ waitFor: "[y/N]", input }] }));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture listener.");
    const configSource = `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${token}\n`;
    await writeFile(config, configSource, { mode: 0o600 });
    const help = await pipe(["project", "transfer", "--help"]);
    expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain("--to-team"); expect(help.stdout).toContain("--confirm");
    const completion = await pipe(["completion", "bash"]);
    expect(completion.code, completion.stderr).toBe(0); expect(completion.stdout).toContain("transfer");
    for (const invalid of [[...args, "--confirm=false"], [...args, "--confirm", "--confirm"]]) expect((await pipe(invalid)).code).toBe(2);
    const noTty = await pipe(args); expect(noTty.code).not.toBe(0); expect(calls).toHaveLength(0);
    if (process.platform !== "win32") {
      const harness = await tty("n\n"); expect(harness.code, harness.stderr).toBe(0);
      const result = JSON.parse(harness.stdout) as Result;
      expect(result.code).not.toBe(0); expect(result.stderr).toContain("Destination"); expect(result.stderr).toContain("none");
      expect(calls.filter(({ path: value }) => value.endsWith("/transfer"))).toHaveLength(0);
    }
    const success = await pipe([...args, "--confirm", "--json"]);
    expect(success.code, success.stderr).toBe(0); expect(success.stdout).toContain('"actorAccess":null'); expect(success.stdout).toContain("9007199254740995");
    const writes = calls.filter(({ path: value }) => value.endsWith("/transfer"));
    expect(writes).toHaveLength(1); expect(writes[0]!.body).toContain('"version":9007199254740994'); expect(writes[0]!.body).toContain('"version":9007199254740993'); expect(writes[0]!.body).toContain(userId);
    mode = "conflict";
    const conflict = await pipe([...args, "--confirm"]); expect(conflict.code).not.toBe(0); expect(conflict.stderr).toContain("version_conflict");
    mode = "wrong-principal";
    const wrong = await pipe([...args, "--confirm"]); expect(wrong.code).not.toBe(0); expect(wrong.stdout).toBe("");
    mode = "unknown";
    const start = calls.length;
    const unknown = await pipe([...args, "--confirm"]); expect(unknown.code).not.toBe(0); expect(unknown.stdout).toBe(""); expect(unknown.stderr).toContain("unknown"); expect(unknown.stderr).toContain("404");
    expect(calls.slice(start).filter(({ path: value }) => value.endsWith("/transfer"))).toHaveLength(1);
    expect(calls.at(-1)!.path.endsWith("/transfer")).toBe(true);
    expect(await readFile(config, "utf8")).toBe(configSource);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); });
    await installed.cleanup();
  }
});
