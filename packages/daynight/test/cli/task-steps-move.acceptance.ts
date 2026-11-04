import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import type { MoveTaskStepInput, StepsResource, TaskStep } from "../../src/api/types.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

const workspace = path.resolve(import.meta.dirname, "../../../..");
const projectId = "aaaaaaaa-1111-4111-8111-111111111111", taskId = "bbbbbbbb-2222-4222-8222-222222222222", userId = "cccccccc-3333-4333-8333-333333333333";
const version = 9_007_199_254_740_993n;
const original: readonly TaskStep[] = ["00000000", "abcdef01", "12345678", "fedcba98"].map<TaskStep>((id, index) => ({
  id, title: index === 0 ? "  Same\u001b[31m\nFull title  " : "same", description: `# Original ${index}\n\"\\\u2028\u2029`,
  status: index === 0 ? "done" : "todo", createdAt: "2026-01-01T01:02:03Z", updatedAt: "2026-01-02T03:04:05.654321Z",
}));
type Result = { readonly code: number | null; readonly stdout: string; readonly stderr: string };
type RequestRecord = { readonly method: string; readonly path: string; readonly requestId: string | undefined; readonly body: unknown };

it("runs both packed launchers through Move positions, exact budgets, no-ops and one factual unknown observation", async () => {
  const deadline = Date.now() + 170_000;
  const installed = await createAcceptanceCli({ signal: AbortSignal.timeout(170_000) }); const { receipt } = installed;
  const fixture = path.join(receipt.root, ".tmp", "Step Move launcher 中文");
  const home = path.join(fixture, "home"), state = path.join(fixture, "configuration"), temporary = path.join(fixture, "temporary");
  const config = path.join(state, "config.yml");
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, DN_CONFIG_DIR: state, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"), XDG_CONFIG_HOME: path.join(fixture, "config"), XDG_CACHE_HOME: path.join(fixture, "cache"), TMPDIR: temporary, TMP: temporary, TEMP: temporary, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(fixture, "git-global"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const outside = path.parse(receipt.root).root;
  const children = new Map<ChildProcess, Promise<unknown>>();
  const requests: RequestRecord[] = [], scenarios: string[] = [];
  const collectionPath = `/api/v1/projects/${projectId}/tasks/${taskId}/steps`;
  const positionPath = (stepId: string): string => `${collectionPath}/${stepId}/position`;
  let current: StepsResource = { projectId, taskId, version, steps: original };
  let lost = false, lostRequestId: string | undefined;
  const send = (response: ServerResponse, value: unknown, status = 200, requestId?: string): void => {
    response.writeHead(status, { "Content-Type": "application/json", "Daynight-User-ID": userId, ...(requestId === undefined ? {} : { "X-Request-ID": requestId }) }); response.end(`${stringifyApiJson(value)}\n`);
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", (value: Buffer) => { chunks.push(value); });
    request.on("end", () => {
      let body: unknown;
      try { body = chunks.length === 0 ? null : parseApiJson(Buffer.concat(chunks).toString("utf8")); }
      catch { send(response, { error: { code: "invalid_input", message: "Malformed test request.", requestId: "fixture-malformed" } }, 400); return; }
      const requestId = typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : undefined;
      requests.push({ method: request.method!, path: request.url!, requestId, body });
      if (request.headers.authorization !== "Bearer fixture-token") { send(response, { error: { code: "unauthorized", message: "Unauthorized fixture request.", requestId: "fixture-auth" } }, 401); return; }
      if (request.method === "GET" && request.url === collectionPath) {
        if (lost && requestId !== `${lostRequestId}.r1`) { send(response, { error: { code: "invalid_input", message: "Uncorrelated observation.", requestId: "fixture-uncorrelated" } }, 400); return; }
        send(response, current, 200, requestId); return;
      }
      const target = current.steps.find((step) => request.url === positionPath(step.id));
      const input = body as MoveTaskStepInput;
      if (request.method !== "PUT" || target === undefined || typeof input?.version !== "bigint" || input.version !== current.version) {
        send(response, { error: { code: "version_conflict", message: "Move identity or version refused.", requestId: "fixture-refusal" } }, 409); return;
      }
      const remaining = current.steps.filter(({ id }) => id !== target.id);
      const anchorId = input.before === undefined ? input.after : input.before;
      const anchorIndex = anchorId === undefined ? -1 : remaining.findIndex(({ id }) => id === anchorId);
      if (anchorId !== undefined && anchorIndex < 0) { send(response, { error: { code: "not_found", message: "Anchor unavailable.", requestId: "fixture-anchor" } }, 404); return; }
      const index = input.position === "first" ? 0 : input.position === "last" ? remaining.length : input.before !== undefined ? anchorIndex : anchorIndex + 1;
      remaining.splice(index, 0, target);
      const changed = remaining.some((step, position) => step.id !== current.steps[position]!.id);
      current = { ...current, version: current.version + (changed ? 1n : 0n), steps: remaining };
      if (lost) { lostRequestId = requestId; response.socket!.destroy(); return; }
      send(response, current, 200, requestId);
    });
  });
  const invoke = async (launcher: string, args: readonly string[], expected = 0): Promise<Result> => {
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("Packed Step Move exceeded its execution deadline.");
    const child = crossSpawn(launcher, [...args], { cwd: outside, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", launchFailure: unknown;
    child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; }); child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.once("error", (cause) => { launchFailure = cause; });
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => { children.delete(child); resolve(code); })); children.set(child, closed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), Math.min(20_000, remaining)); })]);
      if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Packed Step Move exceeded its invocation deadline."); }
      if (launchFailure !== undefined) throw launchFailure;
      expect(code, stderr).toBe(expected); if (expected !== 0) expect(stdout).toBe(""); else expect(stderr).toBe("");
      return { code, stdout, stderr };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const budget = (at: number, stepId: string, explicit: boolean): RequestRecord => {
    const actual = requests.slice(at);
    expect(actual.map(({ method, path: pathname }) => ({ method, path: pathname }))).toEqual([
      ...(explicit ? [] : [{ method: "GET", path: collectionPath }]), { method: "PUT", path: positionPath(stepId) },
    ]);
    const write = actual[actual.length - 1]!;
    expect(write.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    return write;
  };
  let failure: unknown;
  try {
    await mkdir(home, { recursive: true }); await mkdir(state, { recursive: true }); await mkdir(temporary, { recursive: true });
    const alias = path.join(path.dirname(receipt.launcherPath), process.platform === "win32" ? "dn.cmd" : "dn"); await readFile(alias);
    const launchers = [receipt.launcherPath, alias];
    await writeFile(config, "serverUrl: [\n");
    const checks: (() => Promise<void>)[] = [];
    for (const launcher of launchers) {
      checks.push(async () => {
        const help = (await invoke(launcher, ["task", "step", "move", "--help"])).stdout;
        for (const option of ["--before", "--after", "--first", "--last", "--if-version", "--project", "--json"]) expect(help).toContain(option);
      });
      for (const extra of [[], ["--first", "--last"], ["--before=abcdef01", "--after=12345678"], ["--before=00000000"], ["--after=00000000"], ["--before=prefix"]]) {
        checks.push(async () => { await invoke(launcher, ["task", "step", "move", taskId, "00000000", ...extra], 2); });
      }
      checks.push(async () => { await invoke(launcher, ["task", "step", "move", taskId, "prefix", "--first"], 2); });
      for (const shell of ["bash", "zsh"]) checks.push(async () => {
        const completion = (await invoke(launcher, ["completion", shell])).stdout;
        for (const token of ["move", "--before", "--after", "--first", "--last"]) expect(completion).toContain(token);
      });
      checks.push(async () => {
        const usage = (await invoke(launcher, ["--skill"])).stdout;
        expect(usage).toContain("daynight task step move <task-id> <step-id>");
        for (const option of ["--before", "--after", "--first", "--last"]) expect(usage).toContain(option);
      });
    }
    for (let at = 0; at < checks.length; at += 4) {
      const results = await Promise.allSettled(checks.slice(at, at + 4).map((check) => check()));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
      if (failures.length !== 0) throw new AggregateError(failures, "Packed Move pre-configuration checks failed.");
    }
    expect(requests).toEqual([]); expect(await readFile(config, "utf8")).toBe("serverUrl: [\n");
    scenarios.push("both-aliases-help-usage-invalid-placement-and-self-anchor-before-config", "installed-bash-zsh-completion-and-skill-usage");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing packed Move listener.");
    await writeFile(config, `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    for (const launcher of launchers) {
      lost = false;
      for (const tc of [
        { id: "FEDCBA98", args: ["--first"], input: { position: "first" }, order: ["fedcba98", "00000000", "abcdef01", "12345678"], explicit: true },
        { id: "00000000", args: ["--last"], input: { position: "last" }, order: ["abcdef01", "12345678", "fedcba98", "00000000"], explicit: false },
        { id: "12345678", args: ["--before=ABCDEF01"], input: { before: "abcdef01" }, order: ["00000000", "12345678", "abcdef01", "fedcba98"], explicit: true },
        { id: "00000000", args: ["--after=12345678"], input: { after: "12345678" }, order: ["abcdef01", "12345678", "00000000", "fedcba98"], explicit: false },
      ]) {
        current = { projectId, taskId, version, steps: original };
        for (const noop of [false, true]) {
          const explicit = noop ? !tc.explicit : tc.explicit, previousVersion = current.version;
          const at = requests.length;
          const output = await invoke(launcher, ["task", "step", "move", taskId.toUpperCase(), tc.id, ...tc.args, "--project", projectId.toUpperCase(), "--json", ...(explicit ? ["--if-version", previousVersion.toString()] : [])]);
          expect(budget(at, tc.id.toLowerCase(), explicit).body).toEqual({ version: previousVersion, ...tc.input });
          expect(parseApiJson(output.stdout)).toEqual(current); expect(output.stdout.startsWith("{")).toBe(true);
          expect(current.version).toBe(version + 1n); expect(output.stdout).toContain('"version":9007199254740994');
          expect(current.steps.map(({ id }) => id)).toEqual(tc.order);
          for (const step of current.steps) expect(step).toEqual(original.find(({ id }) => id === step.id));
        }
      }
      current = { projectId, taskId, version, steps: original };
      const readable = (await invoke(launcher, ["task", "step", "move", taskId, "00000000", "--first", "--if-version", version.toString(), "--project", projectId])).stdout;
      expect(current.version).toBe(version);
      for (const part of ["Step moved. ID: 00000000", "9007199254740993", "Steps: 4", "1. 00000000", String.raw`Same\u001b[31m\nFull title`]) expect(readable).toContain(part);
      expect(readable).not.toMatch(/[\u001b\r\u2028\u2029]/);
      lost = true; lostRequestId = undefined; const at = requests.length;
      const unknown = await invoke(launcher, ["task", "step", "move", taskId, "00000000", "--last", "--if-version", version.toString(), "--project", projectId, "--json"], 1);
      const observed = requests.slice(at);
      expect(observed.map(({ method, path: pathname }) => ({ method, path: pathname }))).toEqual([{ method: "PUT", path: positionPath("00000000") }, { method: "GET", path: collectionPath }]);
      expect(observed[0]!.body).toEqual({ version, position: "last" }); expect(observed[1]!.requestId).toBe(`${observed[0]!.requestId}.r1`);
      expect(current.version).toBe(version + 1n); expect(current.steps.map(({ id }) => id)).toEqual(["abcdef01", "12345678", "fedcba98", "00000000"]);
      for (const fact of ["The Step Move outcome is unknown.", "stepId=00000000", `requestId=${observed[0]!.requestId}`, `recoveryRequestId=${observed[0]!.requestId}.r1`, "Current facts only: version=9007199254740994 target=found. The Move outcome remains unknown."]) expect(unknown.stderr).toContain(fact);
      expect(unknown.stderr).not.toContain("Step moved.");
      for (const secret of [original[0]!.title, original[0]!.description, "fixture-token", `http://127.0.0.1:${address.port}`]) expect(unknown.stderr).not.toContain(secret);
    }
    scenarios.push("four-positions-canonical-identities-explicit-one-put-default-get-put", "exact-bigint-noop-and-unchanged-content-times", "complete-json-and-readable-terminal-escaping", "one-unknown-put-correlated-current-facts-only-read-no-replay");
    expect(createHash("sha256").update(await readFile(receipt.entryPath)).digest("hex")).toBe(receipt.entrySha256);
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) { try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); } }
  try { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause))); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  let removed = false; try { await lstat(receipt.root); } catch (cause) { if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") removed = true; else cleanup.push(cause); }
  await writeFile(path.join(workspace, ".tmp/t09-packed-move-evidence.json"), `${JSON.stringify({ schemaVersion: 1, success: failure === undefined && cleanup.length === 0 && removed, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256, source: receipt.source }, transport: "literal daynight and sibling dn launchers via crossSpawn", fixture: "small controlled Node HTTP package-consumer fixture; real Go/PostgreSQL interop is separate", scenarios, requests: requests.map(({ method, path: pathname, requestId }) => ({ method, path: pathname, requestId })), cleanup: { runtimeRemoved: removed, childrenExited: children.size === 0, serverClosed: !server.listening, errors: cleanup.length } }, null, 2)}\n`, { mode: 0o600 });
  if (cleanup.length !== 0) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Packed Step Move acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
  expect(removed).toBe(true);
}, 180_000);
