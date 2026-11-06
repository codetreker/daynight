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
import type { UpdateTaskStepInput, SetTaskStepStatusInput, StepsResource, TaskStep } from "../../src/api/types.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

const workspace = path.resolve(import.meta.dirname, "../../../..");
const projectId = "aaaaaaaa-1111-4111-8111-111111111111", taskId = "bbbbbbbb-2222-4222-8222-222222222222", userId = "cccccccc-3333-4333-8333-333333333333";
const version = 9_007_199_254_740_993n;
const stamp = "2026-11-04T10:11:12.123456Z";
const old: TaskStep = { id: "00000000", title: "same", description: "Old retained Markdown", status: "done", createdAt: "2026-01-01T01:02:03Z", updatedAt: "2026-01-02T03:04:05.654321Z" };
const target: TaskStep = { ...old, id: "00abcdef", status: "todo" };
type Result = { readonly code: number | null; readonly stdout: string; readonly stderr: string };
type RequestRecord = { readonly method: string; readonly path: string; readonly requestId: string | undefined; readonly body: unknown };

it("runs the packed Step update and status matrix and verifies both native launchers", async () => {
  const installed = await createAcceptanceCli(); const { receipt } = installed;
  const fixture = path.join(receipt.root, ".tmp", "Step Update launcher 中文");
  const home = path.join(fixture, "home"), state = path.join(fixture, "configuration"), temporary = path.join(fixture, "temporary");
  const config = path.join(state, "config.yml");
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete environment[key];
  Object.assign(environment, { HOME: home, USERPROFILE: home, DN_CONFIG_DIR: state, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"), XDG_CONFIG_HOME: path.join(fixture, "config"), XDG_CACHE_HOME: path.join(fixture, "cache"), TMPDIR: temporary, TMP: temporary, TEMP: temporary, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(fixture, "git-global"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const outside = path.parse(receipt.root).root;
  const children = new Map<ChildProcess, Promise<unknown>>();
  const requests: RequestRecord[] = [], scenarios: string[] = [];
  const collectionPath = `/api/v1/projects/${projectId}/tasks/${taskId}/steps`;
  let current: StepsResource = { projectId, taskId, version, steps: [old, target] };
  const itemPath = `${collectionPath}/${target.id}`;
  const statusPath = `${itemPath}/status`;
  let mode: "normal" | "capacity" | "lost" = "normal";
  let lostRequestId: string | undefined;
  const send = (response: ServerResponse, value: unknown, status = 200, requestId?: string): void => {
    response.writeHead(status, { "Content-Type": "application/json", "Daynight-User-ID": userId, ...(requestId === undefined ? {} : { "X-Request-ID": requestId }) }); response.end(`${stringifyApiJson(value)}\n`);
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", (value: Buffer) => { chunks.push(value); });
    request.on("end", () => {
      let body: unknown;
      try { body = chunks.length === 0 ? null : parseApiJson(Buffer.concat(chunks).toString("utf8")); }
      catch { send(response, { error: { code: "invalid_input", message: "Malformed request.", requestId: "fixture-malformed" } }, 400); return; }
      const outgoingId = typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : undefined;
      requests.push({ method: request.method!, path: request.url!, requestId: outgoingId, body });
      const read = request.method === "GET" && request.url === collectionPath;
      const update = request.method === "PATCH" && request.url === itemPath;
      const status = request.method === "PUT" && request.url === statusPath;
      if ((!read && !update && !status) || request.headers.authorization !== "Bearer fixture-token") {
        send(response, { error: { code: "internal_error", message: "Unexpected update fixture request.", requestId: "fixture-unexpected" } }, 500); return;
      }
      if (read) {
        if (mode === "lost" && outgoingId !== `${lostRequestId}.r1`) { send(response, { error: { code: "invalid_input", message: "Uncorrelated observation.", requestId: "fixture-uncorrelated" } }, 400); return; }
        send(response, current, 200, outgoingId); return;
      }
      if (mode === "capacity") {
        send(response, { error: { code: "steps_limit_exceeded", message: "Capacity exceeded.", requestId: "capacity-server-id", details: { encodedBytes: 67_108_865, maxEncodedBytes: 67_108_864 } } }, 409, "capacity-observed"); return;
      }
      const input = body as UpdateTaskStepInput | SetTaskStepStatusInput;
      if (typeof input?.version !== "bigint" || input.version !== current.version) {
        send(response, { error: { code: "version_conflict", message: "Stale version.", requestId: "fixture-refusal" } }, 409); return;
      }
      const oldTarget = current.steps[1]!;
      const fields = "status" in input ? { status: input.status } : { ...(input.title === undefined ? {} : { title: input.title }), ...(input.description === undefined ? {} : { description: input.description }) };
      const next = { ...oldTarget, ...fields };
      const changed = next.title !== oldTarget.title || next.description !== oldTarget.description || next.status !== oldTarget.status;
      current = { ...current, version: current.version + (changed ? 1n : 0n), steps: [current.steps[0]!, { ...next, updatedAt: changed ? stamp : oldTarget.updatedAt }] };
      if (mode === "lost") { lostRequestId = outgoingId; response.socket!.destroy(); return; }
      send(response, current, 200, outgoingId);
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
      if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Packed Step update exceeded twenty seconds."); }
      if (launchFailure !== undefined) throw launchFailure;
      expect(code, stderr).toBe(expected); if (expected !== 0) expect(stdout).toBe(""); else expect(stderr).toBe("");
      return { code, stdout, stderr };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const onlyWrite = (at: number, status: boolean): RequestRecord => {
    const command = requests.slice(at); expect(command.map(({ method, path: pathname }) => ({ method, path: pathname }))).toEqual([{ method: status ? "PUT" : "PATCH", path: status ? statusPath : itemPath }]);
    expect(command[0]!.requestId).toMatch(uuid); return command[0]!;
  };
  let failure: unknown;
  try {
    await mkdir(home, { recursive: true }); await mkdir(state, { recursive: true }); await mkdir(temporary, { recursive: true });
    const alias = path.join(path.dirname(receipt.launcherPath), process.platform === "win32" ? "dn.cmd" : "dn"); await readFile(alias);
    const launchers = [receipt.launcherPath, alias];
    await writeFile(config, "serverUrl: [\n");
    for (const launcher of launchers) {
      for (const name of ["update", "set-status"]) expect((await invoke(launcher, ["task", "step", name, "--help"])).stdout).toContain("--if-version");
      await invoke(launcher, ["task", "step", "update", taskId, target.id], 2);
      if (launcher === alias) continue;
      await invoke(launcher, ["task", "step", "update", taskId, "prefix", "--title=valid"], 2);
      await invoke(launcher, ["task", "step", "set-status", taskId, target.id, "invalid"], 2);
      await invoke(launcher, ["task", "step", "update", taskId, target.id, "--title=valid", "--status=done"], 2);
    }
    expect(requests).toEqual([]); expect(await readFile(config, "utf8")).toBe("serverUrl: [\n");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing packed update listener.");
    await writeFile(config, `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    const explicit = ["--project", projectId.toUpperCase(), "--if-version", version.toString()];
    for (const launcher of launchers) {
      current = { projectId, taskId, version, steps: [old, target] }; mode = "normal";
      const title = "  <packed&> 中文😀  ", description = "# Packed [Plan](plan.md) <&> 😀";
      let at = requests.length;
      const full = await invoke(launcher, ["task", "step", "update", taskId.toUpperCase(), target.id.toUpperCase(), `--title=${title}`, `--description=${description}`, "--json", ...explicit]);
      expect(onlyWrite(at, false).body).toEqual({ version, title, description });
      expect(parseApiJson(full.stdout)).toEqual(current); expect(full.stdout).toContain('"version":9007199254740994'); expect(full.stdout.startsWith("{")).toBe(true); expect(current.steps[0]).toEqual(old);
      if (launcher === alias) {
        current = { projectId, taskId, version, steps: [old, target] }; at = requests.length;
        const changed = await invoke(launcher, ["task", "step", "set-status", taskId, target.id.toUpperCase(), "done", "--json", ...explicit]);
        expect(onlyWrite(at, true).body).toEqual({ version, status: "done" }); expect(parseApiJson(changed.stdout)).toEqual(current);
        expect(current.steps[1]).toEqual({ ...target, status: "done", updatedAt: stamp }); expect(current.version).toBe(version + 1n);
        continue;
      }
      current = { projectId, taskId, version, steps: [old, target] }; at = requests.length;
      const cleared = await invoke(launcher, ["task", "step", "update", taskId, target.id, "--description=", "--json", "--project", projectId]);
      expect(requests.slice(at).map(({ method }) => method)).toEqual(["GET", "PATCH"]); expect(requests[at]!.path).toBe(collectionPath); expect(requests[at + 1]!.body).toEqual({ version, description: "" });
      expect(parseApiJson(cleared.stdout)).toEqual(current); expect(current.steps[1]).toEqual({ ...target, description: "", updatedAt: stamp });
      for (const status of ["todo", "in_progress", "done", "skipped"] as const) {
        current = { projectId, taskId, version, steps: [old, target] }; at = requests.length;
        const changed = await invoke(launcher, ["task", "step", "set-status", taskId, target.id.toUpperCase(), status, "--json", ...explicit]);
        expect(onlyWrite(at, true).body).toEqual({ version, status }); expect(parseApiJson(changed.stdout)).toEqual(current);
        expect(current.steps[1]).toEqual({ ...target, status, updatedAt: status === target.status ? target.updatedAt : stamp }); expect(current.version).toBe(version + (status === target.status ? 0n : 1n));
      }
      current = { projectId, taskId, version, steps: [old, target] }; at = requests.length;
      const defaultStatus = await invoke(launcher, ["task", "step", "set-status", taskId, target.id, "done", "--project", projectId]);
      expect(requests.slice(at).map(({ method }) => method)).toEqual(["GET", "PUT"]); expect(defaultStatus.stdout).toContain("Step status set. ID: 00abcdef"); expect(defaultStatus.stdout).toContain("Version: 9007199254740994");
      current = { projectId, taskId, version, steps: [old, target] }; at = requests.length;
      const unchanged = await invoke(launcher, ["task", "step", "update", taskId, target.id, `--title=${target.title}`, ...explicit]);
      onlyWrite(at, false); expect(current).toEqual({ projectId, taskId, version, steps: [old, target] }); expect(unchanged.stdout).toContain("Step updated. ID: 00abcdef"); expect(unchanged.stdout).toContain("Version: 9007199254740993");
      mode = "capacity"; at = requests.length;
      const refused = await invoke(launcher, ["task", "step", "update", taskId, target.id, "--title=capacity-private-title", "--json", ...explicit], 1);
      const refusedWrite = onlyWrite(at, false); expect(refused.stderr).toContain("steps_limit_exceeded"); expect(refused.stderr).toContain('"encodedBytes":67108865'); expect(refused.stderr).toContain('"maxEncodedBytes":67108864'); expect(refused.stderr).toContain(`requestId=${refusedWrite.requestId}`); expect(refused.stderr).not.toContain("unknown"); expect(refused.stderr).not.toContain("capacity-private");
      for (const name of ["update", "set-status"] as const) {
        current = { projectId, taskId, version, steps: [old, target] }; mode = "lost"; lostRequestId = undefined; at = requests.length;
        const unknown = await invoke(launcher, ["task", "step", name, taskId, target.id, ...(name === "update" ? ["--title=private-unknown-title"] : ["done"]), "--json", ...explicit], 1);
        const observed = requests.slice(at); expect(observed.map(({ method }) => method)).toEqual([name === "update" ? "PATCH" : "PUT", "GET"]); expect(observed[0]!.path).toBe(name === "update" ? itemPath : statusPath); expect(observed[1]!.path).toBe(collectionPath);
        expect(observed[0]!.requestId).toMatch(uuid); expect(observed[1]!.requestId).toBe(`${observed[0]!.requestId}.r1`); expect(current.version).toBe(version + 1n);
        expect(unknown.stderr).toContain(`The Step ${name === "update" ? "Update" : "Set-status"} outcome is unknown.`); expect(unknown.stderr).toContain("stepId=00abcdef"); expect(unknown.stderr).toContain(`requestId=${observed[0]!.requestId}`); expect(unknown.stderr).toContain(`recoveryRequestId=${observed[0]!.requestId}.r1`); expect(unknown.stderr).toContain("Current facts only: version=9007199254740994 target=found."); expect(unknown.stderr).toContain("remains unknown.");
        for (const secret of ["private-unknown", "fixture-token", `http://127.0.0.1:${address.port}`]) expect(unknown.stderr).not.toContain(secret);
      }
    }
    scenarios.push("both-launchers-help-and-invalid-update-before-config", "both-launchers-explicit-patch-and-put-exact-int64", "raw-fields-and-explicit-description-clear", "default-get-then-write-and-omitted-fields-retained", "four-statuses-and-no-op-times", "readable-and-json-complete-resource", "capacity-details-no-retry", "unknown-original-identity-correlated-read-without-replay");
    expect(createHash("sha256").update(await readFile(receipt.entryPath)).digest("hex")).toBe(receipt.entrySha256);
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) { try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); } }
  try { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause))); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  let removed = false; try { await lstat(receipt.root); } catch (cause) { if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") removed = true; else cleanup.push(cause); }
  await writeFile(path.join(workspace, ".tmp/t08-packed-update-evidence.json"), `${JSON.stringify({ schemaVersion: 1, success: failure === undefined && cleanup.length === 0 && removed, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256, source: receipt.source }, transport: "literal daynight and sibling dn launchers via crossSpawn", fixture: "small controlled Node HTTP package-consumer fixture; real Go/PostgreSQL interop is separate", scenarios, requests: requests.map(({ method, path: pathname, requestId, body }) => ({ method, path: pathname, requestId, ...(body !== null && typeof body === "object" && "id" in body ? { stepId: body.id } : {}) })), cleanup: { runtimeRemoved: removed, childrenExited: children.size === 0, serverClosed: !server.listening, errors: cleanup.length } }, null, 2)}\n`, { mode: 0o600 });
  if (cleanup.length !== 0) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Packed Step update acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
  expect(removed).toBe(true);
}, 180_000);
