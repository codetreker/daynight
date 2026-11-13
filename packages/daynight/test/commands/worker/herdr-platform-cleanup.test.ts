import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { describe, expect, test, vi } from "vitest";

const project = path.resolve(import.meta.dirname, "../../../../..");
const cleanup = await import(new URL("../../../scripts/herdr-platform-cleanup.mjs", import.meta.url).href);
const withCleanup = async (change: (evidence: Record<string, unknown>, directory: string) => Promise<void>, verify: (result: { failures: string[] }, status?: number | null) => void, platform: NodeJS.Platform) => {
  if (platform === "win32") return withControlledCleanup(change, verify);
  const scratch = path.join(project, ".tmp/herdr-tools/research-platform/cleanup-script-tests");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "checker-")), scripts = path.join(root, "packages/daynight/scripts"), directory = path.join(root, ".tmp/herdr-tools/research-platform");
  try {
    await mkdir(scripts, { recursive: true }); await mkdir(directory, { recursive: true });
    const script = path.join(scripts, "check-herdr-platform-cleanup.mjs");
    await copyFile(path.join(project, "packages/daynight/scripts/check-herdr-platform-cleanup.mjs"), script);
    await copyFile(path.join(project, "packages/daynight/scripts/herdr-platform-cleanup.mjs"), path.join(scripts, "herdr-platform-cleanup.mjs"));
    const children = Array.from({ length: 4 }, () => spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] }));
    const closed = children.map(child => new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); }));
    const originals = children.map(child => ({ pid: child.pid!, parentPid: process.pid, startToken: "639301558314541830" })), dotnetToken = "639301558314541837";
    children.forEach(child => child.stdin!.end()); await Promise.all(closed);
    const ids = originals.map(row => row.pid);
    const completed = JSON.stringify({ schemaVersion: 1, platform: process.platform, daemonPid: ids[0], shellPid: ids[1], receipt: { helperPid: ids[2], childPid: ids[3] }, cleanup: { workspaceClosed: true, instance: { ownedChildClosed: true, apiClosed: true, clientClosed: true }, runtimeDirectoryRemoved: true, processCapture: { stage: "before-stop", roots: ids, processes: originals }, originalProcesses: originals.map(row => ({ ...row, stage: "after-stop", observation: "exited" })) } });
    for (const name of ["codex", "copilot", "argv-codex"]) await writeFile(path.join(directory, `acceptance-${name}-fixture.json`), completed);
    const evidence = { schemaVersion: 1, source: "isolated-ps5-dotnet-oracle", platform: "win32", pid: ids[0], startToken: dotnetToken, directory: path.join(directory, "removed-oracle"), closed: true, runtimeDirectoryRemoved: true };
    await change(evidence, directory);
    const record = path.join(directory, "acceptance-windows-metadata-fixture.json");
    await writeFile(record, JSON.stringify(evidence));
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 45_000 });
    const diagnostic = JSON.stringify({ status: run.status, signal: run.signal, error: run.error, stderr: run.stderr });
    expect(run.error, diagnostic).toBeUndefined();
    try { verify(JSON.parse(await readFile(path.join(directory, "cleanup.json"), "utf8")), run.status); }
    catch (cause) { throw new Error(`Independent cleanup entry failed: ${diagnostic}`, { cause }); }
  } finally { await rm(root, { recursive: true, force: true }); }
};

describe.each(process.platform === "win32" ? ["win32"] : [process.platform, "win32"])("independent cleanup gates (%s)", platform => {
  test("accepts a closed original oracle process and a removed private directory", async () => {
    await withCleanup(async () => {}, (result, status) => { expect(result.failures).toEqual([]); if (status !== undefined) expect(status).toBe(0); }, platform as NodeJS.Platform);
  }, 60_000);

  test.each(["live", "close-unknown", "retained", "directory-present", "identity-missing", "birth-missing"])("fails for %s native metadata evidence", async kind => {
    await withCleanup(async evidence => {
      if (kind === "live") evidence.pid = process.pid;
      if (kind === "close-unknown") evidence.closed = false;
      if (kind === "retained") evidence.runtimeDirectoryRemoved = false;
      if (kind === "directory-present") await mkdir(evidence.directory as string);
      if (kind === "identity-missing") evidence.pid = null;
      if (kind === "birth-missing") evidence.startToken = null;
    }, (result, status) => { expect(result.failures).toContain("acceptance-windows-metadata-fixture.json"); if (status !== undefined) expect(status).not.toBe(0); }, platform as NodeJS.Platform);
  }, 60_000);

  test.each(["closed", "close-unknown", "cleanup-unknown"])("checks %s query cleanup alongside formal resources", async kind => {
    await withCleanup(async (_evidence, directory) => {
      const file = path.join(directory, "acceptance-codex-fixture.json"), run = JSON.parse(await readFile(file, "utf8"));
      run.cleanup.windowsQueries = [{ stage: "external-script", closed: kind !== "close-unknown", cleanupConfirmed: kind !== "cleanup-unknown" }];
      await writeFile(file, JSON.stringify(run));
    }, (result, status) => {
      if (kind === "closed") { expect(result.failures).toEqual([]); if (status !== undefined) expect(status).toBe(0); }
      else { expect(result.failures).toContain("acceptance-codex-fixture.json"); if (status !== undefined) expect(status).not.toBe(0); }
    }, platform as NodeJS.Platform);
  }, 60_000);
});

const source = "cim-creation-date-ticks", startToken = "639301558314541830";
const windowsFixture = async (action: (directory: string, run: any) => Promise<void>) => {
  const scratch = path.join(project, ".tmp/herdr-tools/research-platform/cleanup-script-tests");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "windows-"));
  const originals = [101, 102, 103, 104, 105].map((pid, index) => ({ pid, parentPid: pid - 1, startToken: (BigInt(startToken) + BigInt(index * 10)).toString() }));
  const run = { schemaVersion: 1, platform: "win32", daemonPid: 101, shellPid: 102, receipt: { helperPid: 103, childPid: 104 }, cleanup: { workspaceClosed: true, instance: { ownedChildClosed: true, apiClosed: true, clientClosed: true }, runtimeDirectoryRemoved: true, processCapture: { stage: "before-stop", roots: [101, 102, 103, 104], processes: originals }, originalProcesses: originals.map(row => ({ ...row, stage: "after-stop", observation: "exited" })) } };
  try {
    for (const name of ["codex", "copilot", "argv-codex"]) await writeFile(path.join(directory, `acceptance-${name}-fixture.json`), JSON.stringify(run));
    await writeFile(path.join(directory, "acceptance-windows-metadata-fixture.json"), JSON.stringify({ schemaVersion: 1, source: "isolated-ps5-dotnet-oracle", platform: "win32", pid: 106, startToken: "639301558314541837", closed: true, runtimeDirectoryRemoved: true, directory: path.join(directory, "removed-oracle") }));
    await action(directory, run);
  } finally { await rm(directory, { recursive: true, force: true }); }
};
const queryResult = (rows: unknown[]) => ({ pid: 900, code: 0, signal: null, closed: true, error: null, stdoutBytes: 100, stderrBytes: 0, stdout: JSON.stringify({ schemaVersion: 1, rows }) });
const observing = (change: (rows: any[], targets: any[]) => any = rows => rows) => (targets: any[]) => cleanup.observeWindowsCleanup(targets, { systemRoot: "C:\\Windows", execute: async () => queryResult(change(targets.map(target => ({ ...target, state: "missing", startToken: null, error: null })), targets)) });

// Policy and resource failures own real files and the checker, while native
// PS5/CIM acquisition belongs to the dedicated platform acceptance job.
const withControlledCleanup = async (change: (evidence: Record<string, unknown>, directory: string) => Promise<void>, verify: (result: { failures: string[] }) => void) => {
  await windowsFixture(async directory => {
    const file = path.join(directory, "acceptance-windows-metadata-fixture.json"), evidence = JSON.parse(await readFile(file, "utf8"));
    await change(evidence, directory); await writeFile(file, JSON.stringify(evidence));
    const observeWindows = observing(rows => rows.map(row => row.source === "dotnet-start-time-ticks" && row.pid === process.pid ? { ...row, state: "present", startToken: "639301558314541837" } : row));
    const result = await cleanup.checkHerdrPlatformCleanup(directory, { platform: "win32", observeWindows });
    expect(JSON.parse(await readFile(path.join(directory, "cleanup.json"), "utf8"))).toEqual(result);
    verify(result);
  });
};

test.each([{ failures: [] }, { failures: ["original-process-unconfirmed"] }])("the real wrapper exposes the checker outcome as its exit code: %j", async ({ failures }) => {
  const base = path.join(project, ".tmp/herdr-tools/research-platform/cleanup-script-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "entry-")), scripts = path.join(root, "packages/daynight/scripts"), directory = path.join(root, ".tmp/herdr-tools/research-platform");
  try {
    await mkdir(scripts, { recursive: true }); await mkdir(directory, { recursive: true });
    const entry = path.join(scripts, "check-herdr-platform-cleanup.mjs");
    await copyFile(path.join(project, "packages/daynight/scripts/check-herdr-platform-cleanup.mjs"), entry);
    await writeFile(path.join(directory, "controlled-result.json"), JSON.stringify({ failures }));
    await writeFile(path.join(scripts, "herdr-platform-cleanup.mjs"), `import { readFile } from "node:fs/promises"; import path from "node:path"; export const checkHerdrPlatformCleanup = async directory => JSON.parse(await readFile(path.join(directory, "controlled-result.json"), "utf8"));`);
    const result = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(failures.length ? 1 : 0);
    if (failures.length) expect(result.stderr).toContain("Real Herdr cleanup is unconfirmed: original-process-unconfirmed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["missing", "replaced", "same-original", "access-denied", "malformed", "timeout"])("independently classifies Windows original process evidence: %s", async kind => {
  await windowsFixture(async directory => {
    const execute = vi.fn(async (_file: string, args: string[]) => {
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
      const data = /FromBase64String\('([^']+)'\)/.exec(script)![1]!;
      const targets = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
      if (kind === "timeout") return { ...queryResult([]), code: null, signal: "SIGKILL", error: { name: "CleanupObservationError", code: "ETIMEDOUT" } };
      const rows = targets.map((target: any) => ({ ...target, state: "missing", startToken: null, error: null }));
      if (targets[0].source === source) rows[0] = { ...targets[0], state: "present", startToken: kind === "replaced" ? "639301558314541840" : startToken, error: null };
      if (kind === "missing") rows[0] = { ...targets[0], state: "missing", startToken: null, error: null };
      if (kind === "access-denied") rows[0] = { ...targets[0], state: "unknown", startToken: null, error: { name: "System.ComponentModel.Win32Exception", code: -2147467259, nativeCode: 5 } };
      return kind === "malformed" ? { ...queryResult(rows), stdout: "{incomplete" } : queryResult(rows);
    });
    const result = await cleanup.checkHerdrPlatformCleanup(directory, { platform: "win32", observeWindows: (targets: any[]) => cleanup.observeWindowsCleanup(targets, { systemRoot: "C:\\Windows", execute }) });
    const formal = result.runs.find((run: any) => run.file === "acceptance-codex-fixture.json");
    expect(formal.processes[0].observation).toBe(["missing", "replaced", "same-original"].includes(kind) ? kind : "unknown");
    expect(formal.processes[0].originalStartToken).toBe(startToken);
    expect(formal.processes).toHaveLength(5);
    if (kind === "missing" || kind === "replaced") expect(result.failures).toEqual([]);
    else expect(result.failures).toContain(formal.file);
    if (kind === "access-denied") expect(formal.processes[0].error.nativeCode).toBe(5);
    if (kind === "timeout") expect(formal.processes[0].error.code).toBe("ETIMEDOUT");
    if (kind === "replaced") expect(formal.processes[0].currentStartToken).toBe("639301558314541840");
    expect(execute).toHaveBeenCalledTimes(4);
  });
});

test.each(["639301558314541837", "639301558314541838"])("keeps exact .NET ticks separate from CIM precision: %s", async token => {
  await windowsFixture(async directory => {
    const result = await cleanup.checkHerdrPlatformCleanup(directory, { platform: "win32", observeWindows: observing(rows => rows.map(row => row.source === "dotnet-start-time-ticks" ? { ...row, state: "present", startToken: token } : row)) });
    const metadata = result.runs.find((run: any) => run.file.startsWith("acceptance-windows-metadata"));
    expect(metadata.processes[0]).toMatchObject({ source: "dotnet-start-time-ticks", originalStartToken: "639301558314541837", currentStartToken: token, observation: token.endsWith("7") ? "same-original" : "replaced" });
    expect(result.failures).toEqual(token.endsWith("7") ? [metadata.file] : []);
  });
});

test.each(["root-missing", "descendant-missing", "after-token-changed", "capture-error", "workspace-unknown", "instance-unknown"])("rejects incomplete original stop evidence before observing replacements: %s", async kind => {
  await windowsFixture(async (directory, run) => {
    if (kind === "root-missing") run.cleanup.processCapture.processes.shift();
    if (kind === "descendant-missing") run.cleanup.originalProcesses.pop();
    if (kind === "after-token-changed") run.cleanup.originalProcesses[0].startToken = "639301558314541840";
    if (kind === "capture-error") run.cleanup.captureError = "failed";
    if (kind === "workspace-unknown") run.cleanup.workspaceClosed = false;
    if (kind === "instance-unknown") run.cleanup.instance.ownedChildClosed = false;
    await writeFile(path.join(directory, "acceptance-codex-fixture.json"), JSON.stringify(run));
    const observeWindows = vi.fn(observing());
    const result = await cleanup.checkHerdrPlatformCleanup(directory, { platform: "win32", observeWindows });
    const formal = result.runs.find((row: any) => row.file === "acceptance-codex-fixture.json");
    expect(formal.processEvidenceError.code).toBe("INVALID_ORIGINAL_STOP_EVIDENCE");
    expect(result.failures).toContain(formal.file); expect(observeWindows).toHaveBeenCalledTimes(3);
  });
});

test.each(["query-unknown", "preparation-unknown", "short-link-present", "runtime-retained"])("preserves the independent resource cleanup gate: %s", async kind => {
  await windowsFixture(async (directory, run) => {
    if (kind === "query-unknown") run.cleanup.windowsQueries = [{ closed: true, cleanupConfirmed: false }];
    if (kind === "preparation-unknown") run.cleanup.preparationProbes = [{ closed: false }];
    if (kind === "short-link-present") run.shortLink = directory;
    if (kind === "runtime-retained") run.cleanup.runtimeDirectoryRemoved = false;
    await writeFile(path.join(directory, "acceptance-codex-fixture.json"), JSON.stringify(run));
    const result = await cleanup.checkHerdrPlatformCleanup(directory, { platform: "win32", observeWindows: observing() });
    expect(result.failures).toContain("acceptance-codex-fixture.json");
  });
});

test("joins a timed-out observer and its stdio before returning unknown", async () => {
  const result = await cleanup.runCleanupQuery(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100, cleanupMs: 2000 });
  expect(result).toMatchObject({ closed: true, error: { code: "ETIMEDOUT" } });
  expect(result.pid).toBeGreaterThan(0);
  expect(result.signal).toBe("SIGKILL");
});

test.skipIf(process.platform !== "win32")("reads one live original through the independent .NET process object", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let streamError: unknown;
  child.stdin!.on("error", error => { streamError = error; });
  const join = async (timeoutMs: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Original live-observer fixture ${child.pid} did not close.`)), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    // The policy matrix controls OS results; this single mechanism case keeps
    // GetProcessById, SafeHandle and exact StartTime acquisition on a live child.
    const observed = await cleanup.observeWindowsCleanup([{ pid: child.pid, source: "dotnet-start-time-ticks" }]);
    const diagnostic = JSON.stringify(observed);
    expect(observed.error, diagnostic).toBeNull();
    expect(observed.query, diagnostic).toMatchObject({ closed: true, code: 0, signal: null, error: null });
    expect(observed.rows, diagnostic).toEqual([{ pid: child.pid, source: "dotnet-start-time-ticks", state: "present", startToken: expect.stringMatching(/^[1-9][0-9]+$/), error: null }]);
    expect(streamError).toBeUndefined();
  } finally {
    child.stdin!.end();
    try { await join(2000); }
    catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await join(2000); throw error;
    }
  }
}, 20_000);

test("rejects a live endpoint even when the process observation is missing", async () => {
  await windowsFixture(async (directory, run) => {
    const endpoint = process.platform === "win32" ? `daynight-cleanup-${path.basename(directory)}` : path.relative(process.cwd(), path.join(directory, "endpoint"));
    const server = createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(process.platform === "win32" ? `\\\\.\\pipe\\${endpoint}` : endpoint, resolve); });
    try {
      run.endpoints = { api: endpoint, client: endpoint };
      await writeFile(path.join(directory, "acceptance-codex-fixture.json"), JSON.stringify(run));
      const result = await cleanup.checkHerdrPlatformCleanup(directory, { platform: process.platform, observeWindows: observing() });
      expect(result.runs.find((row: any) => row.file === "acceptance-codex-fixture.json").endpointsClosed).toEqual([false, false]);
      expect(result.failures).toContain("acceptance-codex-fixture.json");
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});

test.each(["duplicate", "wrong-source", "invalid-cim-precision", "unclosed", "nonzero"])("rejects incomplete or conflicting OS query results: %s", async kind => {
  const targets = [{ pid: 101, source }, { pid: 102, source }];
  const rows: any[] = targets.map(target => ({ ...target, state: "missing", startToken: null, error: null }));
  if (kind === "duplicate") rows[1] = rows[0]!;
  if (kind === "invalid-cim-precision") rows[0] = { ...targets[0], state: "present", startToken: "639301558314541837", error: null };
  if (kind === "wrong-source") rows[0]!.source = "dotnet-start-time-ticks";
  const result = await cleanup.observeWindowsCleanup(targets, { systemRoot: "C:\\Windows", execute: async () => ({ ...queryResult(rows), ...(kind === "unclosed" ? { closed: false } : {}), ...(kind === "nonzero" ? { code: 1 } : {}) }) });
  expect(result.rows).toEqual([]); expect(result.error).not.toBeNull();
});
