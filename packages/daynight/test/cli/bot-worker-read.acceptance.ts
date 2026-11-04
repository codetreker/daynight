import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

const userId = "aaaaaaaa-1111-4111-8111-111111111111";
const workerId = "bbbbbbbb-2222-4222-8222-222222222222";
const secondWorkerId = "cccccccc-3333-4333-8333-333333333333";
const knownBotId = "dddddddd-4444-4444-8444-444444444444";
const deletionId = "eeeeeeee-5555-4555-8555-555555555555";
const observedAt = "2026-11-04T10:00:00Z";
const largeVersion = "9007199254740993";
const token = "bot-worker-acceptance-token";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bot = (id: string, name: string) => ({
  id, ownerUserId: userId, workerId, name, version: largeVersion, creationOrder: largeVersion,
  requestedOverrides: {}, resolvedConfiguration: { workerId, cwd: "/ordinary/directory", provider: "claude", model: null, args: [] },
  roleConfiguration: null, sessionId: null, testExecutionId: null,
  startupResult: { state: "pending", code: null }, deletion: null, createdAt: observedAt, updatedAt: observedAt,
});
const summary = {
  workerId, machine: { id: workerId, name: "Worker 中文" }, platform: "macos",
  lastReportedAt: "2026-11-04T09:59:30Z", taskObservationState: "unavailable", taskObservedAt: null, activeTaskCount: null,
};
const secondSummary = {
  ...summary, workerId: secondWorkerId, lastReportedAt: "2026-11-04T09:58:00Z",
  taskObservationState: "stale", taskObservedAt: "2026-11-04T09:57:30Z", activeTaskCount: 0,
};
const unavailableProbe = { state: "error", checkedAt: observedAt, code: "unavailable" };
const detail = { observedAt, worker: {
  ...summary, inventoryObservedAt: null, tasks: [], telemetry: {
    machine: summary.machine, platform: "macos", workingDirectory: "/ordinary/directory", sampledAt: observedAt,
    os: unavailableProbe, cpu: unavailableProbe, memory: unavailableProbe, disk: unavailableProbe,
    versions: { daynight: "0.41.0", herdr: { state: "not_running", checkedAt: observedAt }, codex: { state: "not_installed", checkedAt: observedAt }, copilot: unavailableProbe },
  },
} };
type Result = { code: number | null; stdout: string; stderr: string };
type Call = { method: string; url: string; authorization: string | undefined; body?: Record<string, unknown> };

const capture = async (child: ChildProcess): Promise<Result> => {
  let stdout = "", stderr = "", launchFailure: unknown;
  child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  child.once("error", (error) => { launchFailure = error; });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
    if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed Bot/Worker command timed out."); }
    if (launchFailure !== undefined) throw launchFailure;
    return { code, stdout, stderr };
  } finally { if (timer !== undefined) clearTimeout(timer); }
};

it("exercises installed Bot and remote Worker commands outside Git against controlled HTTP resources", async () => {
  // The fixture supplies resource contracts; it does not start a Provider or perform history cleanup.
  const installed = await createAcceptanceCli();
  const home = path.join(installed.receipt.root, "Bot Worker home 中文");
  const config = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(config), { recursive: true });
  const bots = new Map<string, Record<string, unknown>>([[knownBotId, bot(knownBotId, "Existing assistant")]]);
  const calls: Call[] = [];
  let loseCreateResponse = false, failSecondPage = false, cleanupCompleted = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const call: Call = { method: request.method!, url: request.url!, authorization: request.headers.authorization };
    calls.push(call);
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Daynight-User-ID", userId);
    const send = (value: unknown, status = 200): void => { response.writeHead(status); response.end(JSON.stringify(value)); };
    const failure = (status: number, code: string): void => send({ error: { code, message: `Private fixture message ${token}`, requestId: "bot-worker-fixture" } }, status);
    if (request.headers.authorization !== `Bearer ${token}`) { failure(401, "unauthenticated"); return; }
    if (request.method === "POST" || request.method === "DELETE") {
      let source = "";
      request.setEncoding("utf8").on("data", (chunk: string) => { source += chunk; });
      request.once("end", () => {
        try { call.body = JSON.parse(source) as Record<string, unknown>; }
        catch { failure(400, "invalid_input"); return; }
        if (request.method === "POST" && url.pathname === "/api/v1/me/bots") {
          if (typeof call.body.id !== "string" || typeof call.body.name !== "string") { failure(400, "invalid_input"); return; }
          if (call.body.id === knownBotId) {
            if (call.body.name !== "Existing assistant" || call.body.overrides !== undefined) { failure(409, "resource_conflict"); return; }
            send(bots.get(knownBotId));
            return;
          }
          const created = bot(call.body.id, call.body.name);
          bots.set(created.id, created);
          if (loseCreateResponse) response.destroy();
          else send(created);
          return;
        }
        if (request.method === "DELETE" && url.pathname === `/api/v1/me/bots/${knownBotId}`) {
          if (call.body.ifVersion !== largeVersion || call.body.deletionId !== deletionId) { failure(409, "version_conflict"); return; }
          const state = cleanupCompleted ? "completed" : "pending";
          const deleted = { id: knownBotId, workerId, version: "9007199254740994", deletion: {
            deletionId, requestedVersion: largeVersion,
            workerCleanup: { state, code: null }, serverCleanup: { state, code: null },
          } };
          bots.set(knownBotId, deleted);
          send(deleted);
          return;
        }
        failure(404, "not_found");
      });
      return;
    }
    if (request.method !== "GET") { failure(405, "method_not_allowed"); return; }
    if (url.pathname === "/api/v1/me") {
      send({ id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: secondWorkerId, kind: "personal", name: null } });
      return;
    }
    const cursor = url.searchParams.get("cursor");
    if (url.pathname === "/api/v1/me/bots") {
      if (failSecondPage && cursor !== null) { failure(500, "internal_error"); return; }
      const active = [...bots.values()].filter((item) => item.deletion === null);
      send(cursor === null ? { items: active.slice(0, 1), nextCursor: "bots page 2+/=" } : { items: active.slice(1), nextCursor: null });
      return;
    }
    if (url.pathname.startsWith("/api/v1/me/bots/")) {
      const current = bots.get(url.pathname.slice("/api/v1/me/bots/".length));
      if (current === undefined) failure(404, "not_found");
      else send(current);
      return;
    }
    if (url.pathname === "/api/v1/me/workers") {
      send(cursor === null ? { observedAt, items: [summary], nextCursor: "workers page 2+/=" } : { observedAt, items: [secondSummary], nextCursor: null });
      return;
    }
    if (url.pathname === `/api/v1/me/workers/${workerId}`) { send(detail); return; }
    failure(404, "not_found");
  });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|CODEX_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, NO_COLOR: "1", GIT_CEILING_DIRECTORIES: installed.receipt.root });
  const pipe = (args: string[]) => capture(crossSpawn(installed.receipt.launcherPath, args, { cwd: home, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
  const output: Result[] = [];
  const run = async (args: string[]): Promise<Result> => { const result = await pipe(args); output.push(result); return result; };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing Bot/Worker fixture listener.");
    const origin = `http://127.0.0.1:${address.port}`;
    const source = `serverUrl: ${origin}\nserverToken: ${token}\n`;
    await writeFile(config, source, { mode: 0o600 });
    const repository = await capture(crossSpawn("git", ["rev-parse", "--is-inside-work-tree"], { cwd: home, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }));
    expect(repository.code).not.toBe(0);
    expect(repository.stdout).toBe("");

    const created = await run(["bot", "create", "--name", "Assistant 中文", "--json"]);
    expect(created.code, created.stderr).toBe(0);
    const createdBot = JSON.parse(created.stdout) as ReturnType<typeof bot>;
    expect(createdBot.id).toMatch(uuid);
    expect(createdBot).toEqual(bot(createdBot.id, "Assistant 中文"));
    const createCalls = calls.filter((call) => call.method === "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.body).toEqual({ id: createdBot.id, name: "Assistant 中文" });

    const listed = await run(["bot", "list", "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([bot(knownBotId, "Existing assistant"), createdBot]);
    const shown = await run(["bot", "show", knownBotId, "--json"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout).version).toBe(largeVersion);
    failSecondPage = true;
    const partial = await run(["bot", "list", "--json"]);
    expect(partial.code).toBe(1); expect(partial.stdout).toBe("");
    expect(JSON.parse(partial.stderr).error).toMatchObject({ operation: "bot.list", status: 500, code: "internal_error" });
    failSecondPage = false;

    loseCreateResponse = true;
    const unknown = await run(["bot", "create", "--name", "Unknown response", "--json"]);
    expect(unknown.code).toBe(1); expect(unknown.stdout).toBe("");
    const unknownError = JSON.parse(unknown.stderr).error as { botId: string; requestId: string; outcomeUnconfirmed: boolean; reconcile: string };
    expect(unknownError.botId).toMatch(uuid);
    expect(unknownError).toMatchObject({ requestId: unknownError.botId, outcomeUnconfirmed: true, reconcile: `daynight bot show ${unknownError.botId} --json` });
    expect(calls.filter((call) => call.method === "POST" && call.body?.id === unknownError.botId)).toHaveLength(1);
    loseCreateResponse = false;
    const reconciled = await run(["bot", "show", unknownError.botId, "--json"]);
    expect(reconciled.code, reconciled.stderr).toBe(0);
    expect(JSON.parse(reconciled.stdout)).toEqual(bot(unknownError.botId, "Unknown response"));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);

    const deleteArgs = ["bot", "delete", knownBotId, "--if-version", largeVersion, "--request-id", deletionId, "--json"];
    const pending = await run(deleteArgs);
    expect(pending.code, pending.stderr).toBe(0);
    expect(JSON.parse(pending.stdout)).toEqual({ id: knownBotId, workerId, version: "9007199254740994", deletion: {
      deletionId, requestedVersion: largeVersion, workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null },
    } });
    const replayArgs = ["bot", "create", "--name", "Existing assistant", "--request-id", knownBotId, "--json"];
    const replayPending = await run(replayArgs);
    expect(replayPending.code, replayPending.stderr).toBe(0);
    expect(replayPending.stderr).toBe("");
    expect(JSON.parse(replayPending.stdout)).toEqual(JSON.parse(pending.stdout));
    cleanupCompleted = true;
    const completed = await run(deleteArgs);
    expect(completed.code, completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout).deletion).toEqual({ deletionId, requestedVersion: largeVersion, workerCleanup: { state: "completed", code: null }, serverCleanup: { state: "completed", code: null } });
    const replayCompleted = await run(replayArgs);
    expect(replayCompleted.code, replayCompleted.stderr).toBe(0);
    expect(replayCompleted.stderr).toBe("");
    expect(JSON.parse(replayCompleted.stdout)).toEqual(JSON.parse(completed.stdout));
    expect(calls.filter((call) => call.method === "POST" && call.body?.id === knownBotId)).toHaveLength(2);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.body)).toEqual([
      { ifVersion: largeVersion, deletionId }, { ifVersion: largeVersion, deletionId },
    ]);
    const deletionText = await run(["bot", "show", knownBotId]);
    expect(deletionText.code, deletionText.stderr).toBe(0); expect(deletionText.stdout).toContain("Deletion: completed");

    const workers = await run(["worker", "list", "--json"]);
    expect(workers.code, workers.stderr).toBe(0);
    expect(JSON.parse(workers.stdout)).toEqual({ observedAt, items: [summary, secondSummary] });
    const worker = await run(["worker", "show", workerId, "--json"]);
    expect(worker.code, worker.stderr).toBe(0); expect(JSON.parse(worker.stdout)).toEqual(detail);
    const workerText = await run(["worker", "show", workerId]);
    expect(workerText.code, workerText.stderr).toBe(0);
    expect(workerText.stdout).toContain("Connection: online (at observation)");
    expect(workerText.stdout).toContain("Active tasks: unknown");
    expect(workerText.stdout).toContain("Assistant hosting: unsupported (not reported)");
    const missing = await run(["worker", "show", knownBotId, "--json"]);
    expect(missing.code).toBe(1); expect(missing.stdout).toBe("");
    expect(JSON.parse(missing.stderr).error).toMatchObject({ operation: "worker.show", workerId: knownBotId, status: 404, code: "not_found" });

    expect(output.every((result) => !`${result.stdout}${result.stderr}`.includes(token))).toBe(true);
    expect(calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
    expect(calls.some((call) => call.url.includes("projects"))).toBe(false);
    for (const cursor of ["bots page 2+/=", "workers page 2+/="]) expect(calls.some((call) => new URL(call.url, origin).searchParams.get("cursor") === cursor)).toBe(true);
    expect(await readFile(config, "utf8")).toBe(source);
    expect(await readdir(path.dirname(config))).toEqual(["config.yml"]);
  } finally {
    try { await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); }); }
    finally { await installed.cleanup(); }
  }
});
