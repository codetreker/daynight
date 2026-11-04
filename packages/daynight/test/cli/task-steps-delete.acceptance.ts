import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import type { StepsResource, TaskStep, TaskStepStatus } from "../../src/api/types.js";
import { createInstalledCli, terminateInstalledProcess } from "../fixtures/installed-cli.js";

const workspace = path.resolve(import.meta.dirname, "../../../..");
const projectId = "aaaaaaaa-1111-4111-8111-111111111111", taskId = "bbbbbbbb-2222-4222-8222-222222222222", userId = "cccccccc-3333-4333-8333-333333333333";
const version = 9_007_199_254_740_993n;
const target: TaskStep = { id: "00abcdef", title: "private deleted title", description: "[Retained artifact](result.md)", status: "todo", createdAt: "2026-01-01T01:02:03Z", updatedAt: "2026-01-02T03:04:05.654321Z" };
const first: TaskStep = { ...target, id: "00000000", title: "  <packed&> 中文😀  ", description: "# Retained\n\n[Plan](plan.md) <&> 😀", status: "done" };
const last: TaskStep = { ...target, id: "fedcba98", title: "retained last", status: "skipped" };
type Result = { readonly stdout: string; readonly stderr: string };
type RequestRecord = { readonly method: string; readonly path: string; readonly requestId: string | undefined; readonly body: unknown; readonly contentType: string | undefined };
type Mode = "normal" | "lost" | "bad-success" | "pre-read-failed" | "deleted-parent" | "exhausted" | "unauthenticated";

it("runs both packed launchers through JSON Delete, complete receipts, refusals and factual unknown observations", async () => {
  const installed = await createInstalledCli(); const { receipt } = installed;
  const fixture = path.join(receipt.root, ".tmp", "Step Delete launcher 中文");
  const home = path.join(fixture, "home"), state = path.join(fixture, "configuration"), temporary = path.join(fixture, "temporary");
  const config = path.join(state, "config.yml");
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, DN_CONFIG_DIR: state, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"), XDG_CONFIG_HOME: path.join(fixture, "config"), XDG_CACHE_HOME: path.join(fixture, "cache"), TMPDIR: temporary, TMP: temporary, TEMP: temporary, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(fixture, "git-global"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const outside = path.parse(receipt.root).root;
  const children = new Map<ChildProcess, Promise<unknown>>();
  const requests: RequestRecord[] = [], scenarios: string[] = [];
  const collectionPath = `/api/v1/projects/${projectId}/tasks/${taskId}/steps`, itemPath = `${collectionPath}/${target.id}`;
  let current: StepsResource = { projectId, taskId, version, steps: [first, target, last] };
  let mode: Mode = "normal", lostRequestId: string | undefined;
  const send = (response: ServerResponse, value: unknown, status = 200, requestId?: string): void => {
    response.writeHead(status, { "Content-Type": "application/json", "Daynight-User-ID": userId, ...(requestId === undefined ? {} : { "X-Request-ID": requestId }) }); response.end(`${stringifyApiJson(value)}\n`);
  };
  const reject = (response: ServerResponse, code: string, status: number, message = "Delete was refused."): void => send(response, { error: { code, message, requestId: `fixture-${code}` } }, status);
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", (value: Buffer) => { chunks.push(value); });
    request.on("end", () => {
      let body: unknown;
      try { body = chunks.length === 0 ? null : parseApiJson(Buffer.concat(chunks).toString("utf8")); }
      catch { reject(response, "invalid_input", 400); return; }
      const requestId = typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : undefined;
      requests.push({ method: request.method!, path: request.url!, requestId, body, contentType: request.headers["content-type"] });
      if (request.headers.authorization !== "Bearer fixture-token" || !(request.method === "GET" && request.url === collectionPath || request.method === "DELETE" && request.url === itemPath)) {
        reject(response, "internal_error", 500, "Unexpected Delete fixture request."); return;
      }
      if (request.method === "GET") {
        if (mode === "pre-read-failed") { reject(response, "not_found", 404); return; }
        if ((mode === "lost" || mode === "bad-success") && requestId !== `${lostRequestId}.r1`) { reject(response, "invalid_input", 400, "Uncorrelated observation."); return; }
        send(response, current, 200, requestId); return;
      }
      if (mode === "unauthenticated") { reject(response, "unauthenticated", 401); return; }
      if (mode === "deleted-parent") { reject(response, "task_deleted", 410); return; }
      if (typeof body !== "object" || body === null || Object.keys(body).join(",") !== "version" || !("version" in body) || typeof body.version !== "bigint" || request.headers["content-type"] !== "application/json") {
        reject(response, "invalid_input", 400, "Delete requires JSON containing only an exact version."); return;
      }
      if (body.version !== current.version) { reject(response, "version_conflict", 409); return; }
      if (!current.steps.some(({ id }) => id === target.id)) { reject(response, "not_found", 404); return; }
      if (mode === "exhausted") { reject(response, "version_exhausted", 409); return; }
      if (mode === "bad-success") { lostRequestId = requestId; send(response, current, 200, requestId); return; }
      current = { ...current, version: current.version + 1n, steps: current.steps.filter(({ id }) => id !== target.id) };
      if (mode === "lost") { lostRequestId = requestId; response.socket!.destroy(); return; }
      send(response, current, 200, requestId);
    });
  });
  const invoke = async (launcher: string, args: readonly string[], expected = 0): Promise<Result> => {
    const child = crossSpawn(launcher, [...args], { cwd: outside, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", launchFailure: unknown;
    child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; }); child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.once("error", (cause) => { launchFailure = cause; });
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => { children.delete(child); resolve(code); })); children.set(child, closed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([closed, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
      if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Packed Step Delete exceeded twenty seconds."); }
      if (launchFailure !== undefined) throw launchFailure;
      expect(code, stderr).toBe(expected); if (expected !== 0) expect(stdout).toBe(""); else expect(stderr).toBe("");
      return { stdout, stderr };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const onlyDelete = (at: number, submittedVersion = version): RequestRecord => {
    const command = requests.slice(at); expect(command.map(({ method, path: pathname }) => ({ method, path: pathname }))).toEqual([{ method: "DELETE", path: itemPath }]);
    expect(command[0]!.requestId).toMatch(uuid); expect(command[0]!.body).toEqual({ version: submittedVersion }); expect(command[0]!.contentType).toBe("application/json"); return command[0]!;
  };
  let failure: unknown;
  try {
    await mkdir(home, { recursive: true }); await mkdir(state, { recursive: true }); await mkdir(temporary, { recursive: true });
    const alias = path.join(path.dirname(receipt.launcherPath), process.platform === "win32" ? "dn.cmd" : "dn"); await readFile(alias);
    const launchers = [receipt.launcherPath, alias];
    await writeFile(config, "serverUrl: [\n");
    for (const launcher of launchers) {
      const help = (await invoke(launcher, ["task", "step", "delete", "--help"])).stdout;
      for (const option of ["--project", "--if-version", "--json"]) expect(help).toContain(option);
      await invoke(launcher, ["task", "step", "delete", taskId], 2);
      await invoke(launcher, ["task", "step", "delete", taskId, "prefix"], 2);
      await invoke(launcher, ["task", "step", "delete", taskId, target.id, "--if-version=0"], 2);
      await invoke(launcher, ["task", "step", "delete", taskId, target.id, "--title=unsupported"], 2);
    }
    expect(requests).toEqual([]); expect(await readFile(config, "utf8")).toBe("serverUrl: [\n");
    await new Promise<void>((resolve, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => { server.off("error", fail); resolve(); }); });
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing packed Delete listener.");
    await writeFile(config, `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    const explicit = ["--project", projectId.toUpperCase(), "--if-version", version.toString()];
    for (const launcher of launchers) {
      mode = "normal";
      for (const status of ["todo", "in_progress", "done", "skipped"] satisfies TaskStepStatus[]) {
        current = { projectId, taskId, version, steps: [first, { ...target, status }, last] };
        const at = requests.length;
        const full = await invoke(launcher, ["task", "step", "delete", taskId.toUpperCase(), target.id.toUpperCase(), "--json", ...explicit]);
        onlyDelete(at); expect(current).toEqual({ projectId, taskId, version: version + 1n, steps: [first, last] });
        expect(parseApiJson(full.stdout)).toEqual(current); expect(full.stdout).toContain('"version":9007199254740994'); expect(full.stdout.startsWith("{")).toBe(true);
      }
      current = { projectId, taskId, version, steps: [first, target, last] }; let at = requests.length;
      const readable = await invoke(launcher, ["task", "step", "delete", taskId, target.id, "--project", projectId]);
      expect(requests.slice(at).map(({ method }) => method)).toEqual(["GET", "DELETE"]);
      expect(requests[at]!.path).toBe(collectionPath); expect(requests[at + 1]!.body).toEqual({ version }); expect(requests[at + 1]!.path).toBe(itemPath);
      expect(readable.stdout).toContain("Step deleted."); expect(readable.stdout).toContain(first.id); expect(readable.stdout).toContain(last.id); expect(readable.stdout).not.toContain(target.title);
      current = { projectId, taskId, version, steps: [target] }; at = requests.length;
      const empty = await invoke(launcher, ["task", "step", "delete", taskId, target.id, "--json", ...explicit]);
      onlyDelete(at); expect(parseApiJson(empty.stdout)).toEqual({ projectId, taskId, version: version + 1n, steps: [] });
      at = requests.length;
      const repeated = await invoke(launcher, ["task", "step", "delete", taskId, target.id, "--json", "--project", projectId, "--if-version", current.version.toString()], 1);
      onlyDelete(at, version + 1n); expect(repeated.stderr).toContain("not_found"); expect(repeated.stderr).not.toContain("unknown");
      current = { projectId, taskId, version, steps: [first, target, last] }; mode = "pre-read-failed"; at = requests.length;
      const preRead = await invoke(launcher, ["task", "step", "delete", taskId, target.id, "--project", projectId, "--json"], 1);
      expect(requests.slice(at).map(({ method }) => method)).toEqual(["GET"]); expect(preRead.stderr).toContain("not_found"); expect(current.version).toBe(version);
      for (const [refusal, code] of [["deleted-parent", "task_deleted"], ["exhausted", "version_exhausted"], ["unauthenticated", "unauthenticated"]] as const) {
        mode = refusal; const refusedVersion = refusal === "exhausted" ? 9_223_372_036_854_775_807n : version;
        current = { projectId, taskId, version: refusedVersion, steps: [first, target, last] }; const unchanged = stringifyApiJson(current); at = requests.length;
        const refused = await invoke(launcher, ["task", "step", "delete", taskId, target.id, "--project", projectId, "--if-version", refusedVersion.toString(), "--json"], 1);
        onlyDelete(at, refusedVersion); expect(stringifyApiJson(current)).toBe(unchanged); expect(refused.stderr).toContain(code); expect(refused.stderr).not.toContain("unknown");
        if (refusal === "unauthenticated") expect(refused.stderr).toContain("daynight login");
      }
      for (const unknownMode of ["lost", "bad-success"] as const) {
        current = { projectId, taskId, version, steps: [first, target, last] }; mode = unknownMode; lostRequestId = undefined; at = requests.length;
        const unknown = await invoke(launcher, ["task", "step", "delete", taskId, target.id.toUpperCase(), "--json", ...explicit], 1);
        const observed = requests.slice(at); expect(observed.map(({ method }) => method)).toEqual(["DELETE", "GET"]); expect(observed.map(({ path: pathname }) => pathname)).toEqual([itemPath, collectionPath]);
        expect(observed[0]!.body).toEqual({ version }); expect(observed[0]!.requestId).toMatch(uuid); expect(observed[1]!.requestId).toBe(`${observed[0]!.requestId}.r1`);
        expect(unknown.stderr).toContain("The Step Delete outcome is unknown."); expect(unknown.stderr).toContain(`projectId=${projectId}`); expect(unknown.stderr).toContain(`taskId=${taskId}`); expect(unknown.stderr).toContain(`stepId=${target.id}`); expect(unknown.stderr).toContain(`requestId=${observed[0]!.requestId}`); expect(unknown.stderr).toContain(`recoveryRequestId=${observed[0]!.requestId}.r1`);
        expect(unknown.stderr).toContain(`Current facts only: version=${unknownMode === "lost" ? version + 1n : version} target=${unknownMode === "lost" ? "absent" : "found"}. The Delete outcome remains unknown.`); expect(unknown.stderr).not.toContain("Step deleted.");
        for (const secret of [target.title, target.description, "fixture-token", `http://127.0.0.1:${address.port}`]) expect(unknown.stderr).not.toContain(secret);
      }
    }
    scenarios.push("both-aliases-help-usage-before-config", "explicit-one-json-delete-exact-int64-all-four-states", "default-get-then-delete-readable-complete-resource", "empty-complete-resource-and-repeat404", "failed-pre-read-no-delete", "parent410-max-version409-login401-no-retry", "lost-and-invalid200-correlated-current-facts-only-read-no-replay");
    expect(createHash("sha256").update(await readFile(receipt.entryPath)).digest("hex")).toBe(receipt.entrySha256);
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) { try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); } }
  try { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, fail) => server.close((cause) => cause === undefined ? resolve() : fail(cause))); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  let removed = false; try { await lstat(receipt.root); } catch (cause) { if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") removed = true; else cleanup.push(cause); }
  await writeFile(path.join(workspace, ".tmp/t10-packed-delete-evidence.json"), `${JSON.stringify({ schemaVersion: 1, success: failure === undefined && cleanup.length === 0 && removed, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256, source: receipt.source }, transport: "literal daynight and sibling dn launchers via crossSpawn", fixture: "small controlled Node HTTP package-consumer fixture; real Go/PostgreSQL interop is separate", scenarios, requests: requests.map(({ method, path: pathname, requestId }) => ({ method, path: pathname, requestId })), cleanup: { installationRemoved: removed, childrenExited: children.size === 0, serverClosed: !server.listening, errors: cleanup.length } }, null, 2)}\n`, { mode: 0o600 });
  if (cleanup.length !== 0) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Packed Step Delete acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
  expect(removed).toBe(true);
}, 180_000);
