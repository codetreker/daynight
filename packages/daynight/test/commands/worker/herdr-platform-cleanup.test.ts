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
test.each(["closed", "pid-present", "endpoint-present", "receipt-present", "capture-present", "partial-present", "observation-present", "closure-present", "readiness-present", "adapter-created", "stage-missing", "error-missing", "diagnostics-missing", "mock-open", "query-unconfirmed", "retained"])("classifies pre-adapter initialization failure without weakening cleanup: %s", async kind => {
  await windowsFixture(async directory => {
    const file = "acceptance-codex-fixture.json";
    const run: any = { schemaVersion: 1, platform: "win32", resourceStage: "initialization", error: "Git initialization failed", errorDetails: { code: 1, killed: false, signal: null, elapsedMs: 42 }, endpoints: null, receipt: null, initialInputAttempts: 0, requests: [], cleanup: { mockClosed: true, runtimeDirectoryRemoved: true, windowsQueries: [] } };
    if (kind === "pid-present") run.daemonPid = 101;
    if (kind === "endpoint-present") run.endpoints = {};
    if (kind === "receipt-present") run.receipt = { helperPid: 103, childPid: 104 };
    if (kind === "capture-present") run.cleanup.processCapture = { stage: "before-stop", roots: [101], processes: [] };
    if (kind === "partial-present") run.cleanup.partialWorkspace = { closeConfirmed: true };
    if (kind === "observation-present") run.cleanup.partialWorkspaceObservation = {};
    if (kind === "closure-present") run.cleanup.partialWorkspaceClosure = {};
    if (kind === "readiness-present") run.cleanup.readinessDiagnostics = {};
    if (kind === "adapter-created") run.resourceStage = "adapter-created";
    if (kind === "stage-missing") delete run.resourceStage;
    if (kind === "error-missing") delete run.error;
    if (kind === "diagnostics-missing") delete run.errorDetails;
    if (kind === "mock-open") run.cleanup.mockClosed = false;
    if (kind === "query-unconfirmed") run.cleanup.windowsQueries = [{ closed: false, cleanupConfirmed: false }];
    if (kind === "retained") run.cleanup.runtimeDirectoryRemoved = false;
    await writeFile(path.join(directory, file), JSON.stringify(run));
    const result = await cleanup.checkHerdrPlatformCleanup(directory, { platform: "win32", observeWindows: observing() });
    const formal = result.runs.find((entry: any) => entry.file === file);
    expect(formal.livePids).toEqual([]);
    if (kind === "closed") {
      expect(result.failures).toEqual([]);
      expect(formal).toMatchObject({ resourceState: "no-resource-initialization-failure", resourcesAbsent: true, processes: [], processEvidenceError: null });
      expect(formal.processStopped).toBeUndefined();
    } else expect(result.failures).toContain(file);
  });
});

const queryResult = (rows: unknown[]) => ({ pid: 900, code: 0, signal: null, closed: true, error: null, stdoutBytes: 100, stderrBytes: 0, stdout: JSON.stringify({ schemaVersion: 1, rows }) });
const observing = (change: (rows: any[], targets: any[]) => any = rows => rows) => (targets: any[]) => cleanup.observeWindowsCleanup(targets, { systemRoot: "C:\\Windows", execute: async () => queryResult(change(targets.map(target => ({ ...target, state: "missing", startToken: null, error: null })), targets)) });

test.each([
  "closed", "wrong-stage", "wrong-error", "missing-owner", "owner-mismatch", "missing-binding", "wrong-session", "shell-mismatch", "layout-unknown", "wrong-phase",
  "launch-unknown", "receipt-present", "input-present", "request-present", "close-unknown", "owner-present", "workspace-present", "pane-present", "terminal-present",
  "diagnostics-missing", "diagnostics-error", "ready-unknown", "ready-contradiction", "ready-unverified", "ready-valid", "ready-late-verified", "pane-invalid", "pane-mismatch",
  "observation-missing", "observation-owner-mismatch", "observation-binding-mismatch", "observation-shell-mismatch", "closure-missing", "closure-owner-mismatch", "closure-binding-mismatch", "closure-unknown",
  "tab-missing", "tab-duplicate", "observation-tab-mismatch", "closure-tab-mismatch", "tab-present", "independent-missing", "independent-owner-mismatch", "independent-binding-mismatch", "independent-tab-mismatch", "independent-tab-present", "independent-workspace-present",
  "initial-pane-missing", "initial-pane-duplicate", "initial-terminal-duplicate", "observation-initial-pane-mismatch", "closure-initial-terminal-mismatch", "independent-initial-pane-mismatch",
  "controlled", "controlled-marker-missing", "controlled-marker-invalid", "controlled-marker-shell", "controlled-marker-budget", "controlled-marker-kind", "controlled-no-deadline", "controlled-wrong-error-details", "controlled-ready-missing", "controlled-ready-unverified", "controlled-masquerade",
  "root-missing", "root-duplicate", "birth-missing", "after-missing", "after-changed", "capture-error", "workspace-error", "instance-open", "endpoint-missing", "mock-open", "runtime-retained",
  "live-original", "unknown-original",
])("independently checks partially prepared Windows workspace cleanup: %s", async kind => {
  await windowsFixture(async directory => {
    const owner = { projectId: "00000000-0000-4000-8000-000000000001", taskId: "00000000-0000-4000-8000-000000000002", claimId: "00000000-0000-4000-8000-000000000003", worktreeId: "00000000-0000-4000-8000-000000000004" };
    const originals = [101, 102, 105].map((pid, index) => ({ pid, parentPid: pid - 1, startToken: (BigInt(startToken) + BigInt(index * 10)).toString() }));
    const run: any = { schemaVersion: 1, platform: "win32", resourceStage: "preparing-workspace", owner, daemonPid: 101, shellPid: 102, receipt: null, initialInputAttempts: 0, requests: [], error: "The original PowerShell root readiness phase failed", endpoints: { api: "fixture-api", client: "fixture-client" }, cleanup: { workspaceClosed: true, instance: { ownedChildClosed: true, apiClosed: true, clientClosed: true }, apiClosed: true, clientClosed: true, mockClosed: true, readinessVerified: true, readinessDiagnostics: { readyFile: { state: "missing" }, pane: { state: "observed", shellPid: 102, screenBytes: 0, screenSignals: [] } }, runtimeDirectoryRemoved: true, processCapture: { stage: "before-stop", roots: [101, 102], processes: originals }, originalProcesses: originals.map(row => ({ ...row, stage: "after-stop", observation: "exited" })), partialWorkspace: { owner: { ...owner }, binding: { session: "w", workspaceId: "workspace", paneId: "pane", terminalId: "terminal" }, shellPid: 102, tabId: "tab", initialTabId: "initial-tab", failurePhase: "root-readiness", layoutVerified: true, noAgentLaunch: true, closeConfirmed: true, readyValidation: "missing", after: { ownerAbsent: true, workspaceAbsent: true, paneAbsent: true, terminalAbsent: true, tabAbsent: true } } } };
    const partial = run.cleanup.partialWorkspace;
    partial.initialPaneId = "initial-pane"; partial.initialTerminalId = "initial-terminal";
    run.cleanup.partialWorkspaceObservation = { owner: { ...owner }, binding: { ...partial.binding }, tabId: partial.tabId, initialTabId: partial.initialTabId, initialPaneId: partial.initialPaneId, initialTerminalId: partial.initialTerminalId, shellPid: 102, failurePhase: "root-readiness", layoutVerified: true };
    run.cleanup.partialWorkspaceClosure = structuredClone(partial);
    run.cleanup.partialWorkspaceIndependent = { owner: { ...owner }, binding: { ...partial.binding }, tabId: partial.tabId, initialTabId: partial.initialTabId, initialPaneId: partial.initialPaneId, initialTerminalId: partial.initialTerminalId, ...partial.after };
    if (kind === "wrong-stage") run.resourceStage = "adapter-created";
    if (kind === "wrong-error") run.error = "workspace.create failed";
    if (kind === "missing-owner") delete run.owner.claimId;
    if (kind === "owner-mismatch") partial.owner.claimId = "00000000-0000-4000-8000-000000000005";
    if (kind === "missing-binding") delete partial.binding.terminalId;
    if (kind === "wrong-session") partial.binding.session = "other";
    if (kind === "shell-mismatch") partial.shellPid = 103;
    if (kind === "layout-unknown") partial.layoutVerified = false;
    if (kind === "wrong-phase") partial.failurePhase = "workspace-create";
    if (kind === "launch-unknown") partial.noAgentLaunch = false;
    if (kind === "receipt-present") run.receipt = { helperPid: 103, childPid: 104 };
    if (kind === "input-present") run.initialInputAttempts = 1;
    if (kind === "request-present") run.requests.push({ method: "POST" });
    if (kind === "close-unknown") partial.closeConfirmed = false;
    if (kind === "owner-present") partial.after.ownerAbsent = false;
    if (kind === "workspace-present") partial.after.workspaceAbsent = false;
    if (kind === "pane-present") partial.after.paneAbsent = false;
    if (kind === "terminal-present") partial.after.terminalAbsent = false;
    if (kind === "diagnostics-missing") delete run.cleanup.readinessDiagnostics;
    if (kind === "diagnostics-error") run.cleanup.readinessDiagnosticError = "Error";
    if (kind === "ready-unknown") run.cleanup.readinessDiagnostics.readyFile = { state: "unknown", reason: "unavailable" };
    if (kind === "ready-contradiction") run.cleanup.readinessDiagnostics.readyFile = { state: "present", size: 40, nonceMatches: true, pidMatches: false, executableMatches: true, validStartToken: true };
    if (kind === "ready-unverified" || kind === "ready-valid") { run.cleanup.readinessDiagnostics.readyFile = { state: "present", size: 40, nonceMatches: true, pidMatches: true, executableMatches: true, validStartToken: true }; if (kind === "ready-valid") partial.readyValidation = "verified"; }
    if (kind === "ready-late-verified") partial.readyValidation = "verified";
    if (kind === "pane-invalid") run.cleanup.readinessDiagnostics.pane = { state: "unknown", reason: "invalid" };
    if (kind === "pane-mismatch") run.cleanup.readinessDiagnostics.pane.shellPid = 103;
    if (kind === "observation-missing") delete run.cleanup.partialWorkspaceObservation;
    if (kind === "observation-owner-mismatch") run.cleanup.partialWorkspaceObservation.owner.claimId = "00000000-0000-4000-8000-000000000005";
    if (kind === "observation-binding-mismatch") run.cleanup.partialWorkspaceObservation.binding.paneId = "other";
    if (kind === "observation-shell-mismatch") run.cleanup.partialWorkspaceObservation.shellPid = 103;
    if (kind === "closure-missing") delete run.cleanup.partialWorkspaceClosure;
    if (kind === "closure-owner-mismatch") run.cleanup.partialWorkspaceClosure.owner.claimId = "00000000-0000-4000-8000-000000000005";
    if (kind === "closure-binding-mismatch") run.cleanup.partialWorkspaceClosure.binding.paneId = "other";
    if (kind === "closure-unknown") run.cleanup.partialWorkspaceClosure.closeConfirmed = false;
    if (kind === "tab-missing") delete partial.tabId;
    if (kind === "tab-duplicate") partial.initialTabId = partial.tabId;
    if (kind === "observation-tab-mismatch") run.cleanup.partialWorkspaceObservation.tabId = "other";
    if (kind === "closure-tab-mismatch") run.cleanup.partialWorkspaceClosure.initialTabId = "other";
    if (kind === "tab-present") partial.after.tabAbsent = false;
    if (kind === "independent-missing") delete run.cleanup.partialWorkspaceIndependent;
    if (kind === "independent-owner-mismatch") run.cleanup.partialWorkspaceIndependent.owner.claimId = "00000000-0000-4000-8000-000000000005";
    if (kind === "independent-binding-mismatch") run.cleanup.partialWorkspaceIndependent.binding.paneId = "other";
    if (kind === "independent-tab-mismatch") run.cleanup.partialWorkspaceIndependent.tabId = "other";
    if (kind === "independent-tab-present") run.cleanup.partialWorkspaceIndependent.tabAbsent = false;
    if (kind === "independent-workspace-present") run.cleanup.partialWorkspaceIndependent.workspaceAbsent = false;
    if (kind === "initial-pane-missing") delete partial.initialPaneId;
    if (kind === "initial-pane-duplicate") partial.initialPaneId = partial.binding.paneId;
    if (kind === "initial-terminal-duplicate") partial.initialTerminalId = partial.binding.terminalId;
    if (kind === "observation-initial-pane-mismatch") run.cleanup.partialWorkspaceObservation.initialPaneId = "other";
    if (kind === "closure-initial-terminal-mismatch") run.cleanup.partialWorkspaceClosure.initialTerminalId = "other";
    if (kind === "independent-initial-pane-mismatch") run.cleanup.partialWorkspaceIndependent.initialPaneId = "other";
    if (kind === "root-missing") run.cleanup.processCapture.processes.shift();
    if (kind === "root-duplicate") run.cleanup.processCapture.roots = [101, 101, 102];
    if (kind === "birth-missing") run.cleanup.processCapture.processes[0].startToken = null;
    if (kind === "after-missing") run.cleanup.originalProcesses.pop();
    if (kind === "after-changed") run.cleanup.originalProcesses[0].startToken = "639301558314541840";
    if (kind === "capture-error") run.cleanup.captureError = "failed";
    if (kind === "workspace-error") run.cleanup.workspaceError = "unknown";
    if (kind === "instance-open") run.cleanup.instance.ownedChildClosed = false;
    if (kind === "endpoint-missing") delete run.endpoints.client;
    if (kind === "mock-open") run.cleanup.mockClosed = false;
    if (kind === "runtime-retained") run.cleanup.runtimeDirectoryRemoved = false;
    const controlled = kind.startsWith("controlled");
    if (controlled) {
      run.officialNativeIdentification = false; run.controlledArgumentRoundTrip = false;
      run.error += ": The operation was aborted: Operation deadline exceeded.";
      run.errorDetails = { name: "HerdrAgentActionError", message: "The original PowerShell root readiness phase failed" };
      run.controlledReadinessFailure = { kind: "after-real-readiness", realRootVerified: true, shellPid: 102, remainingMs: 12000, totalMs: 20000, failureKind: "deadline" };
      partial.readyValidation = "verified";
      run.cleanup.readinessDiagnostics.readyFile = { state: "present", size: 40, nonceMatches: true, pidMatches: true, executableMatches: true, validStartToken: true };
      if (kind === "controlled-marker-missing") delete run.controlledReadinessFailure;
      if (kind === "controlled-marker-invalid") run.controlledReadinessFailure.realRootVerified = false;
      if (kind === "controlled-marker-shell") run.controlledReadinessFailure.shellPid = 103;
      if (kind === "controlled-marker-budget") run.controlledReadinessFailure.remainingMs = 0;
      if (kind === "controlled-marker-kind") run.controlledReadinessFailure.failureKind = "cancelled";
      if (kind === "controlled-no-deadline") run.error = "The original PowerShell root readiness phase failed: Operation cancelled.";
      if (kind === "controlled-wrong-error-details") run.errorDetails.name = "TypeError";
      if (kind === "controlled-ready-missing") run.cleanup.readinessDiagnostics.readyFile = { state: "missing" };
      if (kind === "controlled-ready-unverified") partial.readyValidation = "missing";
    }
    const file = controlled && kind !== "controlled-masquerade" ? "acceptance-partial-codex-fixture.json" : "acceptance-codex-fixture.json";
    await writeFile(path.join(directory, file), JSON.stringify(run));
    const observeWindows = vi.fn(observing(rows => rows.map(row => row.pid !== 101 || !["live-original", "unknown-original"].includes(kind) ? row : kind === "live-original" ? { ...row, state: "present", startToken, error: null } : { ...row, state: "unknown", error: { name: "QueryError", code: 5 } })));
    const result = await cleanup.checkHerdrPlatformCleanup(directory, { platform: "win32", observeWindows, requirePartial: controlled && kind !== "controlled-masquerade" });
    const actual = result.runs.find((entry: any) => entry.file === file);
    if (["closed", "ready-valid", "ready-late-verified", "controlled"].includes(kind)) {
      expect(result.failures).toEqual([]);
      expect(actual.processStopped).toBe(true);
      expect(actual.processes.map((row: any) => row.observation)).toEqual(["missing", "missing", "missing"]);
      expect(observeWindows).toHaveBeenCalledWith(originals.map(({ pid }) => ({ pid, source })));
    } else {
      expect(result.failures).toContain(file);
      if (kind === "live-original") expect(actual.livePids).toEqual([101]);
      if (kind === "unknown-original") expect(actual.unknownPids).toEqual([101]);
      if (!["live-original", "unknown-original", "runtime-retained", "controlled-marker-missing", "controlled-marker-invalid", "controlled-marker-shell", "controlled-marker-budget", "controlled-marker-kind", "controlled-no-deadline", "controlled-wrong-error-details", "controlled-ready-missing", "controlled-masquerade"].includes(kind)) expect(actual.processEvidenceError.code).toBe("INVALID_ORIGINAL_STOP_EVIDENCE");
    }
  });
});

test("requires a separate controlled Windows partial receipt when selected", async () => {
  await windowsFixture(async directory => {
    const result = await cleanup.checkHerdrPlatformCleanup(directory, { platform: "win32", observeWindows: observing(), requirePartial: true });
    expect(result.failures).toContain("Missing or duplicate controlled Windows partial workspace evidence.");
  });
});

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

test.each(["root-missing", "descendant-missing", "after-token-changed", "capture-error", "workspace-unknown", "instance-unknown", "contradictory-partial", "contradictory-observation", "contradictory-closure", "contradictory-readiness"])("rejects incomplete original stop evidence before observing replacements: %s", async kind => {
  await windowsFixture(async (directory, run) => {
    if (kind === "root-missing") run.cleanup.processCapture.processes.shift();
    if (kind === "descendant-missing") run.cleanup.originalProcesses.pop();
    if (kind === "after-token-changed") run.cleanup.originalProcesses[0].startToken = "639301558314541840";
    if (kind === "capture-error") run.cleanup.captureError = "failed";
    if (kind === "workspace-unknown") run.cleanup.workspaceClosed = false;
    if (kind === "instance-unknown") run.cleanup.instance.ownedChildClosed = false;
    if (kind === "contradictory-partial") run.cleanup.partialWorkspace = { closeConfirmed: true };
    if (kind === "contradictory-observation") run.cleanup.partialWorkspaceObservation = {};
    if (kind === "contradictory-closure") run.cleanup.partialWorkspaceClosure = {};
    if (kind === "contradictory-readiness") run.cleanup.readinessDiagnostics = {};
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
