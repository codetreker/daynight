import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation, type Operation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { inspectControllerJob } from "../../../src/commands/controller/windows-job.js";
import { createToolLaunchMapping, posixToolMappingRc } from "../../../src/commands/worker/herdr/tool-launch.js";
import * as launchInventory from "../../../src/commands/worker/herdr/tool-launch-inventory.js";
import { advanceToolStartRequest, deferToolStartRequest, reserveToolStartRequest } from "../../../src/commands/worker/herdr/tool-launch-start.js";
import { captureMappingProcessProof, parseLinuxProcessBirth } from "../../../src/commands/worker/herdr/tool-launch-process-proof.js";
import * as herdrCommands from "../../../src/commands/worker/herdr/command.js";
import * as metadata from "../../../src/commands/worker/herdr/windows-process-metadata.js";
import * as processProofs from "../../../src/commands/worker/herdr/tool-launch-process-proof.js";
import { readToolManifest } from "../../../src/commands/worker/herdr/tool-launch-protocol.js";
import { retainHerdrJobObserver } from "../../../src/commands/worker/herdr/tool-launch-windows-job.js";
import { createHerdrAgentManager, herdrExecutionLabel } from "../../../src/commands/worker/herdr/agents.js";
import type { HerdrRpcClient } from "../../../src/commands/worker/herdr/rpc.js";
import { loadWindowsJobKernel, type WindowsNamedJobKernel, type WindowsJobProcess } from "../../../src/platform/windows-job.js";
import * as windowsJobs from "../../../src/commands/controller/windows-job.js";
import * as windowsProcessProofs from "../../../src/commands/controller/windows-process-proof.js";

const roots: string[] = [], operations: Operation[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const operation = (): Operation => { const value = createOperation({ limits: { totalMs: 10_000 } }); operations.push(value); return value; };
const owner = { projectId: "00000000-0000-4000-8000-000000000001", taskId: "00000000-0000-4000-8000-000000000002", claimId: "00000000-0000-4000-8000-000000000003", worktreeId: "00000000-0000-4000-8000-000000000004" };
const childEntry = path.resolve(import.meta.dirname, "../../../dist/commands/worker/herdr/tool-launch-child.js");
const fixture = async (platform?: NodeJS.Platform, loaderSource?: string) => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-tools/mapping-tests");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "owner ' $; 中文-")); roots.push(directory);
  const entry = loaderSource === undefined ? process.execPath : path.join(directory, "codex.js");
  if (loaderSource !== undefined) await writeFile(entry, loaderSource);
  const launch = await resolveToolLaunch({ tool: "codex", context: "herdr", choice: { kind: "path", path: entry }, environment: process.env, cwd: directory }, operation());
  const input = { directory, owner, launch, nativeEnvironment: { ...process.env, ...(platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}), PATH: "/native/path", CODEX_HOME: "/native/home" }, childEntry, ...(platform === undefined ? {} : { platform }) };
  const mapping = await createToolLaunchMapping(input, operation());
  if (mapping === null) throw new Error("A new mapping was not created.");
  return { directory, launch, input, mapping };
};
const execute = async (file: string, args: string[], environment = process.env) => {
  const child = spawn(file, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
  try { const [code, signal] = await once(child, "close"); return { code, signal, stdout, stderr, pid: child.pid }; }
  finally { clearTimeout(timer); }
};
afterEach(async () => { Object.defineProperty(process, "platform", platformDescriptor); vi.restoreAllMocks(); operations.splice(0).forEach(value => value.dispose()); await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const windowsProof = (pid: number, parentPid: number, startedAt: string): processProofs.MappingProcessProof => ({ pid, parentPid, processGroupId: null, startedAt, commandHash: "a".repeat(64) });
const windowsTree = async (proofs: processProofs.MappingProcessProof[], rows = proofs) => {
  const f = await fixture("win32");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  const capture = vi.spyOn(processProofs, "captureMappingProcessProof").mockImplementation(async id => {
    const proof = proofs.find(value => value.pid === id);
    if (proof === undefined) throw new Error("An unexpected process proof was requested.");
    return { ...proof };
  });
  vi.spyOn(processProofs, "inspectMappingProcessForCleanup").mockResolvedValue("running");
  const query = vi.spyOn(metadata, "captureWindowsProcessInventory").mockResolvedValue(rows.map(row => ({ pid: row.pid, parentPid: row.parentPid, group: null })));
  return { ...f, capture, query, journal: path.join(path.dirname(f.mapping.manifestPath), "processes.json") };
};
const posixProof = (pid: number, parentPid: number, group = pid): processProofs.MappingProcessProof => ({ pid, parentPid, processGroupId: group, startedAt: `original-${pid}`, commandHash: "a".repeat(64) });
const posixTree = async (proofs: processProofs.MappingProcessProof[], rows = proofs) => {
  const f = await fixture();
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  const capture = vi.spyOn(processProofs, "captureMappingProcessProof").mockImplementation(async id => {
    const proof = proofs.find(value => value.pid === id);
    if (proof === undefined) throw new Error("An unexpected process proof was requested.");
    return { ...proof };
  });
  const inspect = vi.spyOn(processProofs, "inspectMappingProcessForCleanup").mockResolvedValue("running");
  const query = vi.spyOn(herdrCommands, "runHerdrCommand").mockImplementation(async command => {
    expect(command.file).toBe("/bin/ps");
    return { stdout: rows.map(row => `${row.pid} ${row.parentPid} ${row.processGroupId} S`).join("\n"), stderr: "" };
  });
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  return { ...f, capture, inspect, query, signal, journal: path.join(path.dirname(f.mapping.manifestPath), "processes.json") };
};
const controlledReceipt = (f: Awaited<ReturnType<typeof fixture>>, helperPid: number, childPid: number) => ({ schemaVersion: 1 as const, owner, nonce: f.mapping.nonce, selectionKey: f.mapping.selectionKey, logicalArgvDigest: "b".repeat(64), file: f.launch.command.file, prefixArgs: [...f.launch.command.prefixArgs], helperPid, childPid });

describe("owned Herdr launch mapping", () => {
  it.skipIf(platformDescriptor.value === "win32")("retains unknown POSIX foreground responsibility across failed cleanup and PID reuse", async () => {
    const f = await fixture(), root = { ...windowsProof(501, 1, "original-root"), processGroupId: 501 }, child = { ...windowsProof(502, 501, "original-child"), processGroupId: 502 };
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    const journal = path.join(path.dirname(f.mapping.manifestPath), "processes.json");
    await writeFile(journal, JSON.stringify({ nonce: f.mapping.nonce, proofs: [root] }), { mode: 0o600 });
    let reused = false;
    const replacement = { ...child, parentPid: 999, processGroupId: 999, startedAt: "replacement" };
    const capture = vi.spyOn(processProofs, "captureMappingProcessProof").mockImplementation(async pid => {
      if (pid === root.pid) return root;
      if (pid !== child.pid) throw new Error("Unexpected process proof");
      if (!reused) throw new Error("The original child exited before capture");
      return replacement;
    });
    vi.spyOn(processProofs, "inspectMappingProcessForCleanup").mockResolvedValue("running");
    vi.spyOn(herdrCommands, "runHerdrCommand").mockImplementation(async command => {
      expect(command.file).toBe("/bin/ps");
      const current = reused ? replacement : child;
      return { stdout: `${root.pid} ${root.parentPid} ${root.processGroupId} S\n${current.pid} ${current.parentPid} ${current.processGroupId} S\n`, stderr: "" };
    });
    const signal = vi.spyOn(process, "kill").mockReturnValue(true);
    const context = { ...owner, cwd: f.directory, agent: "codex" as const }, binding = { session: "w", workspaceId: "owned", paneId: "pane", terminalId: "terminal" };
    const close = vi.fn(() => { throw new Error("Unsafe workspace closure"); });
    const rpc: HerdrRpcClient = { request: async method => {
      if (method === "session.snapshot") return { type: "session_snapshot", snapshot: { workspaces: [{ workspace_id: binding.workspaceId, label: herdrExecutionLabel(context, "Task") }], panes: [{ workspace_id: binding.workspaceId, pane_id: binding.paneId, terminal_id: binding.terminalId, agent: "codex" }], agents: [], tabs: [] } };
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: binding.paneId, shell_pid: root.pid, foreground_processes: reused ? [] : [{ pid: child.pid }] } };
      if (method === "workspace.close") return close();
      throw new Error(`Unexpected cleanup RPC: ${method}`);
    } };
    const manager = createHerdrAgentManager({ rpc, session: "w", preflight: { verifyStart: async () => {} }, workspaceEnvironment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, toolMapping: async () => f.mapping });
    await expect(manager.stopAndClose(context, binding, operation())).rejects.toThrow("original child exited before capture");
    expect(JSON.parse(await readFile(journal, "utf8")).proofs).toEqual([root]);
    reused = true; capture.mockClear(); signal.mockClear();
    // The second pane observation omits the PID; only the retained stop responsibility carries it forward.
    await expect(manager.stopAndClose(context, binding, operation())).rejects.toThrow(/foreground.*original/);
    expect(capture.mock.calls.some(([pid]) => pid === child.pid)).toBe(false);
    expect(signal.mock.calls.some(([pid]) => pid === child.pid)).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(journal, "utf8")).proofs).toEqual([root]);
    await expect(readFile(path.join(path.dirname(journal), "retired.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(platformDescriptor.value === "win32")("does not invent a POSIX cleanup root from foreground PIDs without a prepared journal", async () => {
    const root = posixProof(501, 1), f = await posixTree([root]);
    await expect(f.mapping.captureProcesses([root.pid], operation(), true)).rejects.toThrow(/root.*journal/);
    expect(f.capture).not.toHaveBeenCalled(); expect(f.signal).not.toHaveBeenCalled();
    await expect(readFile(f.journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(platformDescriptor.value === "win32").each(["parent", "group"] as const)("does not enroll POSIX descendants using a stopped original %s anchor", async relation => {
    const root = posixProof(501, 1), child = posixProof(502, relation === "parent" ? root.pid : 999, relation === "group" ? root.processGroupId! : 502), f = await posixTree([root, child], [child]);
    await writeFile(f.journal, JSON.stringify({ nonce: f.mapping.nonce, proofs: [root] }), { mode: 0o600 });
    f.inspect.mockResolvedValue("stopped");
    await expect(f.mapping.captureProcesses([root.pid, child.pid], operation(), true)).rejects.toThrow(/foreground.*original/);
    expect(f.capture).not.toHaveBeenCalled(); expect(f.signal).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it.skipIf(platformDescriptor.value === "win32")("rejects a registered POSIX root replaced after the initial cleanup check", async () => {
    const root = posixProof(501, 1), f = await posixTree([root]);
    await writeFile(f.journal, JSON.stringify({ nonce: f.mapping.nonce, proofs: [root] }), { mode: 0o600 });
    f.inspect.mockImplementation(async () => f.query.mock.calls.length === 0 ? "running" : "replaced");
    await expect(f.mapping.captureProcesses([root.pid], operation())).rejects.toThrow(/identity changed/);
    expect(f.capture).not.toHaveBeenCalled(); expect(f.signal).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it.skipIf(platformDescriptor.value === "win32").each(["parent", "group"].flatMap(relation => ["before-stopped", "after-stopped", "before-replaced", "after-replaced"].map(transition => ({ relation, transition }))))("rechecks the original POSIX $relation anchor when it is $transition during capture", async ({ relation, transition }) => {
    const root = posixProof(501, 1), child = posixProof(502, relation === "parent" ? root.pid : 999, relation === "group" ? root.processGroupId! : 502), f = await posixTree([root, child]);
    await writeFile(f.journal, JSON.stringify({ nonce: f.mapping.nonce, proofs: [root] }), { mode: 0o600 });
    let observations = 0;
    f.inspect.mockImplementation(async proof => {
      if (proof.pid !== root.pid || f.query.mock.calls.length === 0) return "running";
      return ++observations >= (transition.startsWith("before") ? 2 : 3) ? (transition.endsWith("stopped") ? "stopped" : "replaced") : "running";
    });
    await expect(f.mapping.captureProcesses([root.pid, child.pid], operation())).rejects.toThrow(/identity changed/);
    expect(f.capture.mock.calls.some(([pid]) => pid === child.pid)).toBe(transition.startsWith("after"));
    expect(f.signal).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it.skipIf(platformDescriptor.value === "win32").each(["parent", "group"] as const)("registers POSIX descendants through a live original %s anchor with reversed inventory", async relation => {
    const root = posixProof(501, 1), child = posixProof(502, relation === "parent" ? root.pid : 999, relation === "group" ? root.processGroupId! : 502), grandchild = posixProof(503, child.pid), f = await posixTree([root, child, grandchild], [grandchild, child, root]);
    expect(await f.mapping.captureProcesses([root.pid, grandchild.pid, child.pid], operation())).toEqual([root.pid, child.pid, grandchild.pid]);
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root, child, grandchild]);
  });

  it.each(["exact", "ticks", "executable"] as const)("compares Windows readiness against native metadata without rounding (%s)", async kind => {
    const f = await fixture("win32"), shell = 501, executable = f.mapping.windowsCommand![0]!, startToken = "639300096001234567";
    await writeFile(path.join(path.dirname(f.mapping.manifestPath), "shell-ready.json"), JSON.stringify({ nonce: f.mapping.nonce, pid: shell, executable, startToken }), { mode: 0o600 });
    const query = vi.spyOn(metadata, "readWindowsProcessMetadata").mockResolvedValue({ executable: kind === "executable" ? `${executable}.changed` : executable, startToken: kind === "ticks" ? "639300096001234568" : startToken });
    if (kind === "exact") await f.mapping.verifyReady(shell, operation());
    else await expect(f.mapping.verifyReady(shell, operation())).rejects.toThrow("identity changed");
    expect(query).toHaveBeenCalledOnce(); expect(query.mock.calls[0]![0]).toBe(shell);
  });

  it.each(["recovery", "external", "reused", "release-process", "release-job"] as const)("keeps the manager cleanup bound to original Job handles after helper exit (%s)", async scenario => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), helper = windowsProof(502, 501, "2026-11-12T00:00:00.1235000Z"), native = windowsProof(503, 502, "2026-11-12T00:00:00.1236000Z"), detached = windowsProof(504, 503, "2026-11-12T00:00:00.1237000Z");
    const f = await windowsTree([root, helper, native, detached]);
    const manifest = await readToolManifest(f.mapping.manifestPath), directory = path.dirname(f.mapping.manifestPath), receipt = controlledReceipt(f, helper.pid, native.pid), { childPid: _child, ...intent } = receipt;
    await writeFile(f.journal, JSON.stringify({ nonce: f.mapping.nonce, proofs: [root, helper, native] }), { mode: 0o600 });
    await writeFile(path.join(directory, "launch-intent.json"), JSON.stringify(intent), { mode: 0o600 });
    await writeFile(path.join(directory, "launch-receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
    const raw = (proof: processProofs.MappingProcessProof): WindowsJobProcess => ({ pid: proof.pid, parentPid: proof.parentPid, birth: BigInt(Date.parse(`${proof.startedAt.slice(0, 19)}Z`)) * 10000n + BigInt(proof.startedAt.slice(20, 27)) + 116444736000000000n });
    const originals = new Map([helper, native, detached].map(proof => [proof.pid, raw(proof)])), live = new Map([root, helper, native].map(proof => [proof.pid, raw(proof)]));
    await writeFile(path.join(directory, "windows-job.json"), JSON.stringify({ schemaVersion: 1, nonce: manifest.nonce, owner, selectionKey: manifest.launch.selectionKey, helperPid: helper.pid, helperParentPid: helper.parentPid, helperBirth: raw(helper).birth.toString(), policy: "kill-on-close" }), { mode: 0o600 });
    const job = {}, terminate = vi.fn(() => { for (const [pid, identity] of originals) if (live.get(pid)?.birth === identity.birth) live.delete(pid); });
    const api: WindowsNamedJobKernel = {
      create: () => job, killOnClose: () => {}, assign: () => {}, assignHandle: () => {}, openNamed: () => job,
      open: pid => live.get(pid) ?? null, identity: handle => handle as WindowsJobProcess,
      contains: (_job, handle) => originals.get((handle as WindowsJobProcess).pid)?.birth === (handle as WindowsJobProcess).birth,
      signaled: handle => live.get((handle as WindowsJobProcess).pid)?.birth !== (handle as WindowsJobProcess).birth,
      active: () => [...originals].filter(([pid, identity]) => live.get(pid)?.birth === identity.birth).length,
      inspect: () => [...originals].filter(([pid, identity]) => live.get(pid)?.birth === identity.birth).map(([pid]) => pid),
      terminate, close: () => {}, closeProcess: () => {},
    };
    f.query.mockImplementation(async () => [...live.values()].map(row => ({ pid: row.pid, parentPid: row.parentPid, group: null })));
    vi.mocked(processProofs.inspectMappingProcessForCleanup).mockImplementation(async proof => live.has(proof.pid) ? "running" : "stopped");
    f.capture.mockImplementation(async pid => {
      if (!live.has(pid)) throw new Error("The original parent process is no longer available.");
      const original = [root, helper, native, detached].find(proof => proof.pid === pid);
      if (original === undefined) throw new Error("An unexpected process proof was requested.");
      return { ...original };
    });
    vi.useFakeTimers();
    const observer = await retainHerdrJobObserver(f.mapping.manifestPath, manifest, receipt, operation(), helper, api);
    try {
      terminate.mockImplementationOnce(() => { throw new Error("controlled monitor termination failure"); });
      live.set(detached.pid, raw(detached)); live.delete(helper.pid);
      await vi.advanceTimersByTimeAsync(100);
      expect(() => observer.check()).toThrow("ownership remains unknown");
      vi.useRealTimers();
      if (scenario === "external") live.set(505, { pid: 505, parentPid: 1, birth: raw(detached).birth + 10n });
      if (scenario === "reused") live.set(detached.pid, { ...raw(detached), birth: raw(helper).birth - 10n });
      let closed = false;
      const context = { ...owner, cwd: f.directory, agent: "codex" as const }, binding = { session: "w", workspaceId: "owned", paneId: "pane", terminalId: "terminal" };
      const rpc: HerdrRpcClient = { request: async method => {
        if (method === "session.snapshot") return { type: "session_snapshot", snapshot: { workspaces: closed ? [] : [{ workspace_id: binding.workspaceId, label: herdrExecutionLabel(context, "Task") }], panes: closed ? [] : [{ workspace_id: binding.workspaceId, pane_id: binding.paneId, terminal_id: binding.terminalId, agent: "codex" }], agents: [], tabs: [] } };
        if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: binding.paneId, shell_pid: root.pid, foreground_processes: [detached.pid, ...(scenario === "external" ? [505] : [])].map(pid => ({ pid })) } };
        if (method === "workspace.close") { closed = true; live.delete(root.pid); return { type: "ok" }; }
        throw new Error(`Unexpected cleanup RPC: ${method}`);
      } };
      const manager = createHerdrAgentManager({ rpc, session: "w", preflight: { verifyStart: async () => {} }, workspaceEnvironment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, toolMapping: async () => f.mapping });
      if (scenario === "recovery" || scenario.startsWith("release-")) {
        if (scenario.startsWith("release-")) {
          const closeFailure = new Error("controlled original handle release failure"), closedProcesses: number[] = [];
          const closeProcess = vi.fn((handle: unknown) => { closedProcesses.push((handle as WindowsJobProcess).pid); });
          api.closeProcess = closeProcess;
          if (scenario === "release-process") closeProcess.mockImplementationOnce(handle => { closedProcesses.push((handle as WindowsJobProcess).pid); }).mockImplementationOnce(() => { throw closeFailure; });
          else api.close = vi.fn().mockImplementationOnce(() => { throw closeFailure; });
          await expect(manager.stopAndClose(context, binding, operation())).rejects.toBe(closeFailure);
          expect(JSON.parse(await readFile(path.join(directory, "retired.json"), "utf8"))).toMatchObject({ nonce: manifest.nonce });
          expect(await launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).toBe(true);
          expect(new Set(closedProcesses).size).toBe(closedProcesses.length);
          const open = vi.spyOn(api, "open"), openJob = vi.spyOn(api, "openNamed");
          await manager.stopAndClose(context, binding, operation());
          await f.mapping.stopProcesses(operation()); expect(await f.mapping.confirmStopped(operation())).toBe(true); await f.mapping.retire(operation());
          expect(open).not.toHaveBeenCalled(); expect(openJob).not.toHaveBeenCalled();
        } else await manager.stopAndClose(context, binding, operation());
        expect(closed).toBe(true); expect(live.size).toBe(0);
        expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root, helper, native]);
        expect(JSON.parse(await readFile(path.join(directory, "retired.json"), "utf8"))).toMatchObject({ nonce: manifest.nonce });
      } else {
        await expect(manager.stopAndClose(context, binding, operation())).rejects.toThrow(/parent|foreground|unexpected process/i);
        expect(closed).toBe(false); expect(live.has(scenario === "external" ? 505 : detached.pid)).toBe(true);
        await expect(readFile(path.join(directory, "retired.json"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { vi.useRealTimers(); live.clear(); if (scenario === "external" || scenario === "reused") { await observer.stop(operation()); observer.release(); } }
  });

  it.each(["2026-11-12T00:00:00.1233000Z", "2026-11-12T00:00:00.1234000Z", "unproved-birth"])("does not register a Windows descendant without strictly later birth (%s)", async startedAt => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, root.pid, startedAt), f = await windowsTree([root, child]);
    await expect(f.mapping.captureProcesses([root.pid], operation())).rejects.toThrow(/birth|parent/);
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it.each(["prepare", "cleanup"] as const)("does not register an unrelated foreground PID using its stale Windows PPID during %s", async phase => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, root.pid, "2026-11-12T00:00:00.1233000Z"), f = await windowsTree([root, child]);
    if (phase === "cleanup") await writeFile(f.journal, JSON.stringify({ nonce: f.mapping.nonce, proofs: [root] }), { mode: 0o600 });
    await expect(f.mapping.captureProcesses(phase === "cleanup" ? [child.pid] : [root.pid, child.pid], operation(), phase === "cleanup")).rejects.toThrow(/birth|parent/);
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it("rejects an additional Windows foreground process whose parent is outside the original tree", async () => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, 999, "2026-11-12T00:00:00.1235000Z"), f = await windowsTree([root, child]);
    await expect(f.mapping.captureProcesses([root.pid, child.pid], operation())).rejects.toThrow(/parent/);
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it("does not invent a Windows cleanup root from foreground PIDs when the original journal is missing", async () => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), f = await windowsTree([root]);
    await expect(f.mapping.captureProcesses([root.pid], operation(), true)).rejects.toThrow(/root|journal/);
    expect(f.capture).not.toHaveBeenCalled();
    await expect(readFile(f.journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["before-replaced", "after-replaced", "before-stopped", "after-stopped", "after-command-changed"])("keeps a Windows candidate unknown when its original parent is %s", async transition => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, root.pid, "2026-11-12T00:00:00.1235000Z"), f = await windowsTree([root, child]);
    let parents = 0;
    f.capture.mockImplementation(async id => {
      if (id === child.pid) return child;
      const changed = ++parents >= (transition.startsWith("before") ? 2 : 3);
      if (changed && transition.endsWith("stopped")) throw new Error("The controlled parent stopped.");
      if (changed && transition.endsWith("command-changed")) return { ...root, commandHash: "c".repeat(64) };
      return changed ? { ...root, startedAt: "2026-11-12T00:00:00.1236000Z" } : root;
    });
    await expect(f.mapping.captureProcesses([root.pid], operation())).rejects.toThrow(/parent|identity/);
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it("registers a Windows multilevel tree in parent order despite reversed inventory and foreground rows", async () => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, root.pid, "2026-11-12T00:00:00.1235000Z"), grandchild = windowsProof(503, child.pid, "2026-11-12T00:00:00.1236000Z"), f = await windowsTree([root, child, grandchild], [grandchild, child, root]);
    expect(await f.mapping.captureProcesses([root.pid, grandchild.pid, child.pid], operation())).toEqual(expect.arrayContaining([root.pid, child.pid, grandchild.pid]));
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root, child, grandchild]);
  });

  it("rejects a Windows helper receipt whose process predates the original shell", async () => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), helper = windowsProof(502, root.pid, "2026-11-12T00:00:00.1233000Z"), child = windowsProof(503, helper.pid, "2026-11-12T00:00:00.1235000Z"), f = await windowsTree([root, helper, child]);
    await writeFile(f.journal, JSON.stringify({ nonce: f.mapping.nonce, proofs: [root] }), { mode: 0o600 });
    await expect(f.mapping.verifyProcesses({ shellPid: root.pid, receipt: controlledReceipt(f, helper.pid, child.pid) }, operation())).rejects.toThrow(/birth|parent/);
    expect(JSON.parse(await readFile(f.journal, "utf8")).proofs).toEqual([root]);
  });

  it.each(["older-parent-instance", "equal-birth", "missing-parent"] as const)("preserves an invalid historical Windows responsibility journal without terminating its Job or PIDs (%s)", async invalid => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), helper = windowsProof(502, invalid === "missing-parent" ? 999 : root.pid, invalid === "equal-birth" ? root.startedAt : "2026-11-12T00:00:00.1233000Z"), child = windowsProof(503, helper.pid, "2026-11-12T00:00:00.1235000Z"), f = await windowsTree([root, helper, child]);
    const journal = JSON.stringify({ nonce: f.mapping.nonce, proofs: [root, helper, child] });
    await writeFile(f.journal, journal, { mode: 0o600 });
    const receipt = controlledReceipt(f, helper.pid, child.pid), { childPid: _child, ...intent } = receipt, directory = path.dirname(f.mapping.manifestPath);
    await writeFile(path.join(directory, "launch-intent.json"), JSON.stringify(intent), { mode: 0o600 });
    await writeFile(path.join(directory, "launch-receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
    const alive = new Set([root.pid, helper.pid, child.pid]), job = vi.spyOn(windowsJobs, "inspectControllerJob").mockResolvedValue([]), kill = vi.spyOn(process, "kill").mockImplementation(id => { alive.delete(id); return true; });
    const stop = vi.spyOn(windowsProcessProofs, "stopWindowsBootstrapProcess").mockRejectedValue(new Error("An invalid journal must not reach process termination."));
    f.query.mockImplementation(async () => [...[root, helper, child].filter(row => alive.has(row.pid)).map(row => ({ pid: row.pid, parentPid: row.parentPid, group: null })), { pid: 999, parentPid: 1, group: null }]);
    await expect(f.mapping.stopProcesses(operation())).rejects.toThrow(/birth|parent/);
    expect(job).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
    expect(await readFile(f.journal, "utf8")).toBe(journal);
  });

  it("retains a valid Windows descendant as cleanup responsibility after its original parent exits", async () => {
    const root = windowsProof(501, 1, "2026-11-12T00:00:00.1234000Z"), child = windowsProof(502, root.pid, "2026-11-12T00:00:00.1235000Z"), f = await windowsTree([root, child]);
    const journal = JSON.stringify({ nonce: f.mapping.nonce, proofs: [root, child] });
    await writeFile(f.journal, journal, { mode: 0o600 });
    let running = true;
    vi.mocked(processProofs.inspectMappingProcessForCleanup).mockImplementation(async proof => {
      expect(proof).toEqual(proof.pid === root.pid ? root : child);
      return proof.pid === root.pid || !running ? "stopped" : "running";
    });
    const kill = vi.spyOn(process, "kill");
    const stop = vi.spyOn(windowsProcessProofs, "stopWindowsBootstrapProcess").mockImplementation(async (proof, deadline) => {
      expect(proof).toEqual(child);
      expect(deadline).toBeGreaterThan(Date.now()); expect(deadline).toBeLessThanOrEqual(Date.now() + 10_000);
      running = false;
    });
    f.query.mockImplementation(async () => running ? [{ pid: child.pid, parentPid: root.pid, group: null }] : [{ pid: 999, parentPid: 1, group: null }]);
    await f.mapping.stopProcesses(operation());
    expect(stop).toHaveBeenCalledExactlyOnceWith(child, expect.any(Number));
    expect(kill).not.toHaveBeenCalled();
    expect(await f.mapping.confirmStopped(operation())).toBe(true);
    expect(await readFile(f.journal, "utf8")).toBe(journal);
  });
  it.skipIf(process.platform !== "win32")("reads native Windows process inventory independently of shell module paths", async () => {
    const f = await fixture(), native = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(native, "close"), timer = setTimeout(() => native.kill("SIGKILL"), 8_000);
    try {
      await once(native.stdout!, "data");
      const environment = { ...f.input.nativeEnvironment, PSModulePath: path.join(f.directory, "incompatible-modules"), pSmOdUlEpAtH: path.join(f.directory, "other-incompatible-modules") };
      const mapping = (await createToolLaunchMapping({ ...f.input, nativeEnvironment: environment, existingOnly: true }, operation()))!;
      expect(await mapping.captureProcesses([native.pid!], operation())).toContain(native.pid);
      native.kill("SIGKILL"); await closed;
      expect(await mapping.confirmStopped(operation())).toBe(true);
      expect(environment.PSModulePath).toBe(path.join(f.directory, "incompatible-modules"));
      expect(environment.PATH).toBe("/native/path");
    } finally { clearTimeout(timer); native.kill("SIGKILL"); await closed; }
  }, 60_000);

  it("distinguishes Linux process births within one wall-clock second and rejects malformed proc identities", () => {
    const boot = "12345678-1234-4234-8234-123456789abc";
    const stat = (start: string) => `23 (native name (child)) S 17 23 23 0 -1 4194304 12 0 0 0 0 0 0 0 20 0 1 0 ${start} 123456 42`;
    expect(parseLinuxProcessBirth(23, stat("567890"), `${boot}\n`)).toEqual({ token: `${boot}:567890`, parentPid: 17, processGroupId: 23 });
    expect(parseLinuxProcessBirth(23, stat("567891"), boot).token).not.toBe(`${boot}:567890`);
    expect(() => parseLinuxProcessBirth(24, stat("567890"), boot)).toThrow();
    expect(() => parseLinuxProcessBirth(23, stat("not-a-token"), boot)).toThrow();
    expect(() => parseLinuxProcessBirth(23, stat("567890"), "unknown-boot")).toThrow();
  });

  it.skipIf(process.platform === "win32")("admits only a native child continuously owned by the original shell and helper", async () => {
    const f = await fixture(), args = ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"];
    const script = "const {spawn}=require('node:child_process');process.stdin.once('data',()=>{const child=spawn(process.execPath,JSON.parse(process.argv[1]),{stdio:['ignore','inherit','inherit']});child.on('close',code=>process.exit(code??1));});";
    const shell = spawn(process.execPath, ["-e", script, JSON.stringify([childEntry, f.mapping.manifestPath, "codex", "--", ...args])], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let errors = ""; shell.stderr!.on("data", chunk => { errors += chunk; });
    const closed = once(shell, "close");
    const kill = () => { try { if (shell.pid !== undefined) process.kill(-shell.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
    const timer = setTimeout(kill, 4_000);
    try {
      await f.mapping.captureProcesses([shell.pid!], operation());
      const ready = Promise.race([once(shell.stdout!, "data"), closed.then(() => { throw new Error(`The mapped native process exited before readiness: ${errors}`); })]); shell.stdin!.write("go"); await ready;
      const receipt = await f.mapping.verifyReceipt(args, operation());
      await f.mapping.verifyProcesses({ shellPid: shell.pid!, receipt, foregroundPids: [receipt.helperPid, receipt.childPid] }, operation());
      const recovered = (await createToolLaunchMapping({ ...f.input, existingOnly: true }, operation()))!;
      await recovered.verifyProcesses({ shellPid: shell.pid!, receipt }, operation());
      await expect(recovered.verifyProcesses({ shellPid: process.pid, receipt }, operation())).rejects.toThrow("original shell");
      await expect(recovered.verifyProcesses({ shellPid: receipt.helperPid }, operation())).rejects.toThrow("original shell");
      await expect(recovered.verifyProcesses({ shellPid: shell.pid!, receipt, foregroundPids: [process.pid] }, operation())).rejects.toThrow("foreground");
      await expect(recovered.verifyProcesses({ shellPid: shell.pid!, receipt: { ...receipt, helperPid: process.pid } }, operation())).rejects.toThrow("helper");
    } finally { clearTimeout(timer); if (shell.exitCode === null && shell.signalCode === null) kill(); await closed; }
  });

  it.skipIf(process.platform === "win32")("retains a JavaScript loader and its native descendant in the original mapping across recovery and cleanup", async () => {
    const loaderSource = `Promise.all([import("node:child_process"), import("node:readline")]).then(([{ spawn }, { createInterface }]) => {
  const child = spawn(process.execPath, ["-e", process.argv[2], process.argv[3]], { stdio: ["ignore", "pipe", "inherit"] });
  createInterface({ input: child.stdout }).once("line", marker => {
    process.stdout.write(JSON.stringify({ loaderPid: process.pid, descendantPid: child.pid, marker }) + "\\n");
  });
  child.on("close", code => process.exit(code ?? 1));
});`;
    const f = await fixture(undefined, loaderSource), marker = `mapped-descendant-${f.mapping.nonce}`;
    const args = ["process.stdout.write(process.argv[1]+'\\n');setInterval(()=>{},1000);", marker];
    expect(f.launch.command).toEqual({ file: await realpath(process.execPath), prefixArgs: [await realpath(path.join(f.directory, "codex.js"))] });
    expect(f.launch.interpreterPath).not.toBeNull();
    expect(f.launch.artifacts.map(artifact => artifact.role).sort()).toEqual(["entry", "interpreter"]);
    const script = "const {spawn}=require('node:child_process');process.stdin.once('data',()=>{spawn(process.execPath,JSON.parse(process.argv[1]),{stdio:['ignore','inherit','inherit']});});setInterval(()=>{},1000);";
    const shell = spawn(process.execPath, ["-e", script, JSON.stringify([childEntry, f.mapping.manifestPath, "codex", "--", ...args])], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let errors = "", cleanupFailure: unknown;
    let cleanupProofs: processProofs.MappingProcessProof[] = [];
    let watchdogCleanup: Promise<void> | undefined;
    shell.stderr!.on("data", chunk => { errors += chunk; });
    const closed = once(shell, "close"), lines = createInterface({ input: shell.stdout! });
    const kill = async () => {
      if (cleanupProofs.length === 0) {
        // No launch was released before the shell's birth was registered.
        if (shell.exitCode === null && shell.signalCode === null) shell.kill("SIGKILL");
        return;
      }
      for (const proof of cleanupProofs) {
        if (proof.processGroupId !== shell.pid || await processProofs.inspectMappingProcessForCleanup(proof) !== "running") continue;
        try { process.kill(-proof.processGroupId, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        return;
      }
    };
    const waitForClose = async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("The owned loader process group did not close after cleanup.")), 2_000); })]); }
      finally { clearTimeout(timeout); }
    };
    const timer = setTimeout(() => { watchdogCleanup = kill(); void watchdogCleanup.catch(cause => { cleanupFailure = cause; }); }, 8_000);
    try {
      cleanupProofs = [await captureMappingProcessProof(shell.pid!)];
      await f.mapping.captureProcesses([shell.pid!], operation());
      const ready = Promise.race([once(lines, "line", { signal: AbortSignal.timeout(8_000) }), closed.then(() => { throw new Error(`The mapped JavaScript loader exited before readiness: ${errors}`); })]);
      shell.stdin!.write("go");
      const [data] = await ready, started = JSON.parse(String(data)) as { loaderPid: number; descendantPid: number; marker: string };
      cleanupProofs.push(await captureMappingProcessProof(started.loaderPid), await captureMappingProcessProof(started.descendantPid));
      expect(started.marker).toBe(marker);
      const receipt = await f.mapping.verifyReceipt(args, operation());
      expect(receipt).toMatchObject({ file: f.launch.interpreterPath, prefixArgs: [f.launch.canonicalEntryPath], childPid: started.loaderPid });
      expect(started.descendantPid).not.toBe(receipt.childPid);
      const command = await execute("/bin/ps", ["-p", String(started.descendantPid), "-o", "command="]);
      expect(command.code).toBe(0); expect(command.stdout).toContain(marker);
      const foregroundPids = [receipt.helperPid, receipt.childPid, started.descendantPid];
      await f.mapping.verifyProcesses({ shellPid: shell.pid!, receipt, foregroundPids }, operation());
      const journal = path.join(path.dirname(f.mapping.manifestPath), "processes.json"), original = await readFile(journal, "utf8");
      const { proofs } = JSON.parse(original) as { proofs: processProofs.MappingProcessProof[] };
      cleanupProofs = proofs;
      expect(proofs.map(proof => proof.pid)).toEqual([shell.pid, receipt.helperPid, receipt.childPid, started.descendantPid]);
      for (let index = 0; index < proofs.length; index++) {
        const proof = proofs[index]!;
        expect(proof).toEqual(await captureMappingProcessProof(proof.pid));
        expect(proof.startedAt).not.toBe("");
        expect(proof.commandHash).toMatch(/^[a-f0-9]{64}$/);
        expect(proof.processGroupId).toBe(shell.pid);
        if (index > 0) expect(proof.parentPid).toBe(proofs[index - 1]!.pid);
      }
      const recovered = (await createToolLaunchMapping({ ...f.input, existingOnly: true }, operation()))!;
      expect(recovered.manifestPath).toBe(f.mapping.manifestPath);
      expect(await recovered.verifyReceipt(args, operation())).toEqual(receipt);
      await recovered.verifyProcesses({ shellPid: shell.pid!, receipt, foregroundPids }, operation());
      expect(await readFile(journal, "utf8")).toBe(original);
      expect(await recovered.captureProcesses([shell.pid!], operation(), true)).toEqual(proofs.map(proof => proof.pid));
      await recovered.stopProcesses(operation());
      await waitForClose();
      expect(await recovered.confirmStopped(operation())).toBe(true);
      const stopped = await execute("/bin/ps", ["-p", proofs.map(proof => proof.pid).join(","), "-o", "stat="]);
      expect([0, 1]).toContain(stopped.code); expect(stopped.stderr).toBe("");
      expect(stopped.stdout.trim().split(/\s+/).filter(Boolean).every(state => state.startsWith("Z"))).toBe(true);
      await recovered.retire(operation());
    } finally {
      clearTimeout(timer);
      try { await watchdogCleanup?.catch(() => {}); await kill(); await waitForClose(); if (cleanupFailure !== undefined) throw cleanupFailure; }
      finally { lines.close(); }
    }
  }, 20_000);

  it.skipIf(process.platform === "win32").each(["intent", "receipt", "helper-only", "native-orphan"] as const)("keeps an orphan launch unknown when its declared roles lack durable birth proofs (%s)", async evidence => {
    const f = await fixture(), args = ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"];
    const script = "const {spawn}=require('node:child_process');process.stdin.once('data',()=>{spawn(process.execPath,JSON.parse(process.argv[1]),{detached:true,stdio:['ignore','inherit','inherit']});});setInterval(()=>{},1000);";
    const shell = spawn(process.execPath, ["-e", script, JSON.stringify([childEntry, f.mapping.manifestPath, "codex", "--", ...args])], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(shell, "exit"), closed = once(shell, "close"); let helper: number | undefined;
    const timer = setTimeout(() => { shell.kill("SIGKILL"); if (helper !== undefined) process.kill(-helper, "SIGKILL"); }, 8_000);
    try {
      await f.mapping.captureProcesses([shell.pid!], operation());
      const journal = path.join(path.dirname(f.mapping.manifestPath), "processes.json"); let original = await readFile(journal, "utf8");
      const ready = once(shell.stdout!, "data"); shell.stdin!.write("go"); await ready;
      const receipt = await f.mapping.verifyReceipt(args, operation()); helper = receipt.helperPid;
      if (evidence === "intent") await rm(path.join(path.dirname(f.mapping.manifestPath), "launch-receipt.json"));
      if (evidence === "helper-only") {
        const partial = JSON.parse(original) as { nonce: string; proofs: unknown[] };
        partial.proofs.push(await captureMappingProcessProof(receipt.helperPid));
        original = JSON.stringify(partial); await writeFile(journal, original, { mode: 0o600 });
      }
      shell.kill("SIGKILL"); await exited;
      if (evidence === "native-orphan") process.kill(receipt.helperPid, "SIGKILL");
      else expect(() => process.kill(receipt.helperPid, 0)).not.toThrow();
      expect(() => process.kill(receipt.childPid, 0)).not.toThrow();
      const recovered = (await createToolLaunchMapping({ ...f.input, existingOnly: true }, operation()))!;
      await expect(recovered.confirmStopped(operation())).rejects.toThrow(/receipt|durable birth proof/);
      await expect(launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).rejects.toThrow(/receipt|durable birth proof/);
      await expect(recovered.retire(operation())).rejects.toThrow(/receipt|durable birth proof/);
      await expect(recovered.stopProcesses(operation())).rejects.toThrow(/receipt|durable birth proof/);
      await expect(recovered.captureProcesses([receipt.helperPid, receipt.childPid], operation(), true)).rejects.toThrow(/receipt|durable birth proof/);
      expect(await readFile(journal, "utf8")).toBe(original);
      if (evidence !== "native-orphan") expect(() => process.kill(receipt.helperPid, 0)).not.toThrow();
      expect(() => process.kill(receipt.childPid, 0)).not.toThrow();
    } finally {
      clearTimeout(timer); shell.kill("SIGKILL");
      if (helper !== undefined) { try { process.kill(-helper, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      await closed;
    }
  });

  it.skipIf(process.platform === "win32")("stops a registered detached descendant after its original parent exits and the mapping reconnects", async () => {
    const f = await fixture();
    const script = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',\"process.stdout.write('ready');setInterval(()=>{},1000);\"],{detached:true,stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>process.stdout.write(String(child.pid)));setInterval(()=>{},1000);";
    const shell = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(shell, "close"); let descendant: number | undefined;
    const timer = setTimeout(() => { shell.kill("SIGKILL"); if (descendant !== undefined) process.kill(descendant, "SIGKILL"); }, 8_000);
    try {
      const [data] = await once(shell.stdout!, "data"); descendant = Number(String(data));
      await f.mapping.captureProcesses([shell.pid!], operation());
      const ids = await f.mapping.captureProcesses([shell.pid!], operation(), true);
      expect(ids).toContain(descendant);
      shell.kill("SIGKILL"); await closed;
      expect(await f.mapping.confirmStopped(operation())).toBe(false);
      const recovered = (await createToolLaunchMapping({ ...f.input, existingOnly: true }, operation()))!;
      await recovered.stopProcesses(operation());
      expect(await recovered.confirmStopped(operation())).toBe(true);
      await recovered.retire(operation());
    } finally {
      clearTimeout(timer);
      shell.kill("SIGKILL");
      if (descendant !== undefined) { try { process.kill(descendant, "SIGCONT"); process.kill(descendant, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      await closed;
    }
  });

  it.skipIf(process.platform === "win32")("releases a frozen original detached descendant after its parent is reaped", async () => {
    const f = await fixture();
    const script = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',\"process.stdout.write('ready');setInterval(()=>{},1000);\"],{detached:true,stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>process.stdout.write(String(child.pid)));setInterval(()=>{},1000);";
    const shell = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(shell, "close"); let descendant: number | undefined;
    const timer = setTimeout(() => { shell.kill("SIGKILL"); if (descendant !== undefined) process.kill(descendant, "SIGKILL"); }, 8_000);
    try {
      const [data] = await once(shell.stdout!, "data"); descendant = Number(String(data));
      await f.mapping.captureProcesses([shell.pid!], operation());
      await f.mapping.captureProcesses([shell.pid!], operation(), true);
      shell.kill("SIGKILL"); await closed;
      await f.mapping.releaseFrozen();
      const state = await execute("/bin/ps", ["-p", String(descendant), "-o", "stat="]);
      expect(state.code).toBe(0); expect(state.stdout).not.toContain("T");
    } finally {
      clearTimeout(timer); shell.kill("SIGKILL");
      if (descendant !== undefined) { try { process.kill(descendant, "SIGCONT"); process.kill(descendant, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      await closed;
    }
  });

  it.skipIf(process.platform !== "win32")("terminates the original Windows Job including descendants absent from the process journal", async () => {
    const f = await fixture();
    const args = ["-e", "const {spawn}=require('node:child_process');process.stdout.write('ready');process.stdin.once('data',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000);'],{detached:true,stdio:'ignore'});process.stdout.write(String(child.pid));});setInterval(()=>{},1000);"];
    const helper = spawn(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(helper, "close"), job = `Local\\Daynight-${f.mapping.nonce}`;
    const timer = setTimeout(() => { helper.kill("SIGKILL"); }, 8_000);
    let failure: unknown, failed = false, retired = false;
    const cleanupFailures: unknown[] = [];
    try {
      await once(helper.stdout!, "data");
      const receipt = await f.mapping.verifyReceipt(args, operation());
      const registered = await f.mapping.captureProcesses([helper.pid!, receipt.childPid], operation());
      const spawned = once(helper.stdout!, "data"); helper.stdin!.write("go");
      const [data] = await spawned, detached = Number(String(data));
      expect(registered).not.toContain(detached);
      expect(await inspectControllerJob(job)).toEqual(expect.arrayContaining([helper.pid!, receipt.childPid, detached]));
      await f.mapping.stopProcesses(operation());
      await closed;
      expect(await inspectControllerJob(job)).toEqual([]);
      expect(await f.mapping.confirmStopped(operation())).toBe(true);
      await f.mapping.retire(operation()); retired = true;
    } catch (error) { failed = true; failure = error; }
    finally {
      try { if (!retired) { await f.mapping.stopProcesses(operation()); await f.mapping.retire(operation()); } }
      catch (error) { cleanupFailures.push(error); }
      // Retirement releases the original Job lease. A reused or missing name
      // cannot authorize another termination or replace that closure proof.
      try { helper.kill("SIGKILL"); await closed; }
      catch (error) { cleanupFailures.push(error); }
      clearTimeout(timer);
    }
    if (cleanupFailures.length) throw new AggregateError(failed ? [failure, ...cleanupFailures] : cleanupFailures, "The original Windows Job fixture cleanup failed.", failed ? { cause: failure } : undefined);
    if (failed) throw failure;
  });

  it.skipIf(process.platform !== "win32").each([0, 37, "killed"] as const)("keeps the original Windows Job observable through helper exit (%s) and stops unregistered descendants", async outcome => {
    const f = await fixture(), code = outcome === "killed" ? 0 : outcome;
    const script = `const {spawn}=require('node:child_process');let started=false;process.stdout.write('ready\\n');process.stdin.on('data',()=>{if(started){process.exit(${code});return;}started=true;const child=spawn(process.execPath,['-e','setInterval(()=>{},1000);'],{detached:true,stdio:'ignore'});process.stdout.write(String(child.pid)+'\\n');});setInterval(()=>{},1000);`;
    const args = ["-e", script], helper = spawn(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(helper, "close"), job = `Local\\Daynight-${f.mapping.nonce}`, timer = setTimeout(() => helper.kill("SIGKILL"), 30_000);
    let failure: unknown, failed = false, retired = false;
    const cleanupFailures: unknown[] = [];
    try {
      expect(String((await once(helper.stdout!, "data"))[0])).toBe("ready\n");
      const receipt = await f.mapping.verifyReceipt(args, operation());
      const registered = await f.mapping.captureProcesses([helper.pid!, receipt.childPid], operation());
      const spawned = once(helper.stdout!, "data"); helper.stdin!.write("spawn\n");
      const detached = Number(String((await spawned)[0]).trim());
      expect(Number.isSafeInteger(detached) && detached > 0).toBe(true); expect(registered).not.toContain(detached);
      const originalNative = await captureMappingProcessProof(receipt.childPid), originalDetached = await captureMappingProcessProof(detached);
      expect(await inspectControllerJob(job)).toEqual(expect.arrayContaining([helper.pid!, receipt.childPid, detached]));
      if (outcome === "killed") helper.kill("SIGKILL"); else helper.stdin!.write("exit\n");
      const [exitCode] = await closed;
      if (outcome !== "killed") expect(exitCode).toBe(outcome);
      await vi.waitFor(async () => {
        expect(await f.mapping.confirmStopped(operation())).toBe(true);
        expect(await processProofs.inspectMappingProcessForCleanup(originalNative)).toBe("stopped");
        expect(await processProofs.inspectMappingProcessForCleanup(originalDetached)).toBe("stopped");
      }, { timeout: 10_000, interval: 25 });
      await f.mapping.retire(operation()); retired = true;
    } catch (error) { failed = true; failure = error; }
    finally {
      try { if (!retired) { await f.mapping.stopProcesses(operation()); await f.mapping.retire(operation()); } }
      catch (error) { cleanupFailures.push(error); }
      try { helper.kill("SIGKILL"); await closed; }
      catch (error) { cleanupFailures.push(error); }
      clearTimeout(timer);
    }
    if (cleanupFailures.length) throw new AggregateError(failed ? [failure, ...cleanupFailures] : cleanupFailures, "The original Windows helper exit fixture cleanup failed.", failed ? { cause: failure } : undefined);
    if (failed) throw failure;
  }, 45_000);

  it.skipIf(process.platform !== "win32")("preserves exit code 37 and closes detached descendants with only the helper Job lease", async () => {
    const f = await fixture(), api = await loadWindowsJobKernel();
    const koffi = await import("koffi"), library = koffi.load("kernel32.dll"), terminate = library.func("int __stdcall TerminateProcess(void *process, uint32_t code)");
    const script = "const {spawn}=require('node:child_process');let started=false;process.stdout.write('ready\\n');process.stdin.on('data',()=>{if(started){process.exit(37);return;}started=true;const child=spawn(process.execPath,['-e','setInterval(()=>{},1000);'],{detached:true,stdio:'ignore'});process.stdout.write(String(child.pid)+'\\n');});setInterval(()=>{},1000);";
    const helper = spawn(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", "-e", script], { stdio: ["pipe", "pipe", "pipe"] }), closed = once(helper, "close");
    const handles: Array<{ handle: unknown }> = [];
    const hold = (pid: number) => {
      const handle = api.open(pid);
      if (handle === null) throw new Error("The original Windows lease fixture process cannot be held.");
      handles.push({ handle });
      const identity = api.identity(handle);
      if (identity.pid !== pid || api.signaled(handle)) throw new Error("The original Windows lease fixture process identity changed.");
      return identity;
    };
    let failure: unknown, failed = false;
    const failures: unknown[] = [];
    const timer = setTimeout(() => {
      for (const { handle } of handles) try { if (!api.signaled(handle)) terminate(handle, 1); } catch (error) { failures.push(error); }
      helper.kill("SIGKILL");
    }, 30_000);
    try {
      const helperIdentity = hold(helper.pid!);
      expect(String((await once(helper.stdout!, "data"))[0])).toBe("ready\n");
      // Read immutable receipt bytes without opening an observer Job handle.
      let receipt = await f.mapping.readReceipt(operation());
      await vi.waitFor(async () => { receipt = await f.mapping.readReceipt(operation()); expect(receipt).not.toBeNull(); });
      const nativeIdentity = hold(receipt!.childPid);
      expect(nativeIdentity.parentPid).toBe(helperIdentity.pid); expect(nativeIdentity.birth).toBeGreaterThan(helperIdentity.birth);
      const spawned = once(helper.stdout!, "data"); helper.stdin!.write("spawn\n");
      const detachedIdentity = hold(Number(String((await spawned)[0]).trim()));
      expect(detachedIdentity.parentPid).toBe(nativeIdentity.pid); expect(detachedIdentity.birth).toBeGreaterThan(nativeIdentity.birth);
      helper.stdin!.write("exit\n");
      const [code] = await closed; expect(code).toBe(37);
      await vi.waitFor(() => { for (const { handle } of handles) expect(api.signaled(handle)).toBe(true); }, { timeout: 10_000, interval: 25 });
    } catch (error) { failed = true; failure = error; }
    finally {
      clearTimeout(timer);
      helper.kill("SIGKILL");
      for (const { handle } of handles) try { if (!api.signaled(handle) && terminate(handle, 1) === 0) throw new Error("Original Windows lease fixture termination failed."); } catch (error) { failures.push(error); }
      try { await closed; await vi.waitFor(() => { for (const { handle } of handles) expect(api.signaled(handle)).toBe(true); }, { timeout: 10_000, interval: 25 }); } catch (error) { failures.push(error); }
      for (const { handle } of handles) try { api.closeProcess(handle); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failed ? [failure, ...failures] : failures, "The original Windows lease fixture cleanup failed.", failed ? { cause: failure } : undefined);
    if (failed) throw failure;
  }, 45_000);

  it.skipIf(process.platform !== "win32")("does not spawn native input when the original Windows Job boundary cannot be published", async () => {
    const f = await fixture(), forbidden = path.join(f.directory, "forbidden-native-start");
    const boundary = path.join(path.dirname(f.mapping.manifestPath), "windows-job.json");
    await writeFile(boundary, "{}", { mode: 0o600 });
    const result = await execute(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", "-e", "require('node:fs').writeFileSync(process.argv[1],'started')", forbidden]);
    expect(result.code).toBe(1);
    expect(await readFile(boundary, "utf8")).toBe("{}");
    await expect(readFile(forbidden)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(path.dirname(f.mapping.manifestPath), "launch-intent.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a validated retired generation as terminal even when its historical PID is running again", async () => {
    const f = await fixture(), native = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(native, "close"), timer = setTimeout(() => native.kill("SIGKILL"), 8_000);
    try {
      await once(native.stdout!, "data");
      await f.mapping.captureProcesses([native.pid!], operation());
      expect(await launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).toBe(false);
      const retired = path.join(path.dirname(f.mapping.manifestPath), "retired.json");
      await writeFile(retired, JSON.stringify({ nonce: f.mapping.nonce, selectionKey: f.mapping.selectionKey, owner }), { mode: 0o600 });
      expect(launchInventory.readToolLaunchMappingInventory(f.directory)).toMatchObject([{ retired: true }]);
      expect(await launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).toBe(true);
      await writeFile(retired, JSON.stringify({ nonce: owner.taskId, selectionKey: f.mapping.selectionKey, owner }), { mode: 0o600 });
      await expect(launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).rejects.toThrow("retirement");
    } finally { clearTimeout(timer); native.kill("SIGKILL"); await closed; }
  });

  it.each(["rejected", "not_submitted"] as const)("retains a reserved start without helper intent until its %s outcome is durably settled", async state => {
    const f = await fixture(), shell = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(shell, "close"), timer = setTimeout(() => shell.kill("SIGKILL"), 4_000);
    try {
      await once(shell.stdout!, "data");
      await f.mapping.captureProcesses([shell.pid!], operation());
      const request = await reserveToolStartRequest(f.mapping.manifestPath, { nonce: f.mapping.nonce, selectionKey: f.mapping.selectionKey, owner }, { session: "original-session", workspaceId: "original-workspace", paneId: "original-pane", terminalId: "original-terminal" }, "codex", ["original-argument"]);
      expect(launchInventory.readToolLaunchMappingInventory(f.directory)).toMatchObject([{ started: true, retired: false }]);
      shell.kill("SIGKILL"); await closed;
      await expect(f.mapping.confirmStopped(operation())).rejects.toThrow("launch RPC");
      await expect(launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).rejects.toThrow("launch RPC");
      await expect(f.mapping.stopProcesses(operation())).rejects.toThrow("launch RPC");
      await expect(f.mapping.retire(operation())).rejects.toThrow("launch RPC");
      await expect(reserveToolStartRequest(f.mapping.manifestPath, request, request.binding, "codex", ["original-argument"])).rejects.toThrow("changed before");
      if (state === "rejected") await advanceToolStartRequest(f.mapping.manifestPath, request, "agent_pane_busy");
      else await deferToolStartRequest(f.mapping.manifestPath, request);
      expect(launchInventory.readToolLaunchMappingInventory(f.directory)).toMatchObject([{ started: false, retired: false }]);
      expect(await launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).toBe(true);
      await f.mapping.retire(operation());
      expect(launchInventory.readToolLaunchMappingInventory(f.directory)).toMatchObject([{ retired: true }]);
    } finally { clearTimeout(timer); shell.kill("SIGKILL"); await closed; }
  });

  it.each(["rejected", "not_submitted"] as const)("readmits only matching %s requests and retains conflicts", async state => {
    const f = await fixture(), binding = { session: "original-session", workspaceId: "original-workspace", paneId: "original-pane", terminalId: "original-terminal" };
    const identity = { nonce: f.mapping.nonce, selectionKey: f.mapping.selectionKey, owner };
    const reserved = await reserveToolStartRequest(f.mapping.manifestPath, identity, binding, "codex", ["original-argument"]);
    const settled = state === "rejected" ? await advanceToolStartRequest(f.mapping.manifestPath, reserved, "agent_pane_busy") : await deferToolStartRequest(f.mapping.manifestPath, reserved);
    expect(launchInventory.readToolLaunchMappingInventory(f.directory)).toMatchObject([{ started: false, retired: false }]);
    await expect(f.mapping.confirmStopped(operation())).rejects.toThrow("no stopped identity proof");
    for (const [changedIdentity, changedBinding, args] of [
      [{ ...identity, owner: { ...owner, claimId: "00000000-0000-4000-8000-000000000009" } }, binding, ["original-argument"]],
      [identity, { ...binding, paneId: "another-pane" }, ["original-argument"]],
      [identity, binding, ["changed-argument"]],
    ] as const) await expect(reserveToolStartRequest(f.mapping.manifestPath, changedIdentity, changedBinding, "codex", args)).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(path.dirname(f.mapping.manifestPath), "native-start.json"), "utf8"))).toEqual(settled);
    const resumed = await reserveToolStartRequest(f.mapping.manifestPath, identity, binding, "codex", ["original-argument"]);
    expect(resumed).toEqual({ ...reserved, attempt: 1 });
    await expect(reserveToolStartRequest(f.mapping.manifestPath, identity, binding, "codex", ["original-argument"])).rejects.toThrow("changed before");
    await expect(deferToolStartRequest(f.mapping.manifestPath, reserved)).rejects.toThrow("changed before");
    await expect(f.mapping.confirmStopped(operation())).rejects.toThrow("no stopped identity proof");
  });

  it("admits only one caller for the same definitely rejected native request", async () => {
    const f = await fixture(), binding = { session: "original-session", workspaceId: "original-workspace", paneId: "original-pane", terminalId: "original-terminal" };
    const identity = { nonce: f.mapping.nonce, selectionKey: f.mapping.selectionKey, owner };
    const request = await reserveToolStartRequest(f.mapping.manifestPath, identity, binding, "codex", []);
    await advanceToolStartRequest(f.mapping.manifestPath, request, "agent_pane_busy");
    const outcomes = await Promise.allSettled(Array.from({ length: 2 }, () => reserveToolStartRequest(f.mapping.manifestPath, identity, binding, "codex", [])));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    const expected = { ...request, attempt: 1 };
    expect(JSON.parse(await readFile(path.join(path.dirname(f.mapping.manifestPath), "native-start.json"), "utf8"))).toEqual(expected);
    expect(JSON.parse(await readFile(path.join(path.dirname(f.mapping.manifestPath), `native-start-${request.requestId}-1.json`), "utf8"))).toEqual(expected);
  });

  it("retains an interrupted readmission without replaying its immutable attempt", async () => {
    const f = await fixture(), binding = { session: "original-session", workspaceId: "original-workspace", paneId: "original-pane", terminalId: "original-terminal" };
    const identity = { nonce: f.mapping.nonce, selectionKey: f.mapping.selectionKey, owner };
    const request = await reserveToolStartRequest(f.mapping.manifestPath, identity, binding, "codex", []);
    const settled = await deferToolStartRequest(f.mapping.manifestPath, request);
    await writeFile(path.join(path.dirname(f.mapping.manifestPath), `native-start-${request.requestId}-1.json`), JSON.stringify({ ...request, attempt: 1 }), { mode: 0o600 });
    await expect(reserveToolStartRequest(f.mapping.manifestPath, identity, binding, "codex", [])).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(path.join(path.dirname(f.mapping.manifestPath), "native-start.json"), "utf8"))).toEqual(settled);
  });

  it("keeps incomplete orphan generations as cleanup responsibilities", async () => {
    const f = await fixture();
    expect(launchInventory.readToolLaunchMappingInventory(f.directory)).toMatchObject([{ owner, launch: f.launch, nonce: f.mapping.nonce, started: false, retired: false }]);
    expect(await launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).toBe(true);
    const orphan = path.join(path.dirname(path.dirname(f.mapping.manifestPath)), "00000000-0000-4000-8000-000000000005");
    await mkdir(orphan, { mode: 0o700 });
    expect(() => launchInventory.readToolLaunchMappingInventory(f.directory)).toThrow();
    await expect(launchInventory.confirmToolLaunchMappingsStopped(f.directory, process.env, operation())).rejects.toThrow();
  });

  it("freezes one immutable manifest and preserves its nonce across reconnect", async () => {
    const f = await fixture(), before = await readFile(f.mapping.manifestPath, "utf8");
    const recovered = await createToolLaunchMapping({ ...f.input, nativeEnvironment: { ...f.input.nativeEnvironment, PATH: "/changed/current/path" }, existingOnly: true }, operation());
    expect(recovered?.nonce).toBe(f.mapping.nonce);
    expect(await readFile(f.mapping.manifestPath, "utf8")).toBe(before);
    expect(before).not.toContain("CODEX_HOME");
  });

  it.each(["absent", "deleted"] as const)("refuses to recover a frozen launch when its mapping index is %s without recreating evidence", async state => {
    const f = await fixture(), original = await readFile(f.mapping.manifestPath, "utf8");
    const directory = state === "absent" ? path.join(f.directory, "absent") : f.directory;
    const index = path.join(path.dirname(path.dirname(f.mapping.manifestPath)), "index.json");
    if (state === "deleted") await rm(index);
    await expect(createToolLaunchMapping({ ...f.input, directory, existingOnly: true }, operation())).rejects.toThrow("generation index is missing");
    expect(await readFile(f.mapping.manifestPath, "utf8")).toBe(original);
    await expect(readFile(state === "absent" ? path.join(directory, "tool-launch") : index)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([true, false])("retains the original Windows helper runtime in an existing generation (existingOnly=%s)", async existingOnly => {
    const f = await fixture("win32"), original = await readFile(f.mapping.manifestPath, "utf8");
    const recovered = await createToolLaunchMapping({ ...f.input, nodeExecutable: path.join(f.directory, "replacement-node"), childEntry: path.join(f.directory, "replacement-helper.js"), existingOnly }, operation());
    expect(recovered?.manifestPath).toBe(f.mapping.manifestPath);
    expect(await readToolManifest(recovered!.manifestPath)).toMatchObject({ nodeExecutable: process.execPath, childEntry });
    expect(await readFile(f.mapping.manifestPath, "utf8")).toBe(original);
  });

  it("uses the current Windows helper runtime only after the original generation is retired", async () => {
    const f = await fixture("win32"), original = await readToolManifest(f.mapping.manifestPath), before = await readFile(f.mapping.manifestPath, "utf8");
    await writeFile(path.join(path.dirname(f.mapping.manifestPath), "retired.json"), JSON.stringify({ nonce: original.nonce, selectionKey: original.launch.selectionKey, owner: original.owner }), { mode: 0o600 });
    const runtime = { nodeExecutable: path.join(f.directory, "replacement-node"), childEntry: path.join(f.directory, "replacement-helper.js") };
    const next = (await createToolLaunchMapping({ ...f.input, ...runtime }, operation()))!;
    expect(next.manifestPath).not.toBe(f.mapping.manifestPath);
    expect(next.nonce).not.toBe(original.nonce);
    expect(await readToolManifest(next.manifestPath)).toMatchObject(runtime);
    expect(await readFile(f.mapping.manifestPath, "utf8")).toBe(before);
  });

  it.each(["darwin", "linux"] as const)("requires the original controlled shell runtime on %s", async platform => {
    const f = await fixture(platform), original = await readFile(f.mapping.manifestPath, "utf8");
    await expect(createToolLaunchMapping({ ...f.input, nodeExecutable: path.join(f.directory, "replacement-node"), childEntry: path.join(f.directory, "replacement-helper.js"), existingOnly: true }, operation())).rejects.toThrow("frozen execution selection");
    expect(await readFile(f.mapping.manifestPath, "utf8")).toBe(original);
  });

  it.each(["owner", "recipe", "platform", "runtime", "script"] as const)("rejects a changed Windows mapping %s before retaining its historical runtime", async changed => {
    const f = await fixture("win32"), manifest = await readToolManifest(f.mapping.manifestPath);
    if (changed === "owner") manifest.owner = { ...manifest.owner, claimId: "00000000-0000-4000-8000-000000000005" };
    if (changed === "recipe") manifest.launch = { ...manifest.launch, selectionKey: "b".repeat(64) };
    if (changed === "platform") manifest.platform = "darwin";
    if (changed === "runtime") manifest.childEntry = "relative-helper.js";
    const original = JSON.stringify(manifest);
    await writeFile(f.mapping.manifestPath, original, { mode: 0o600 });
    if (changed === "script") await writeFile(path.join(path.dirname(f.mapping.manifestPath), "codex.ps1"), "changed script", { mode: 0o600 });
    await expect(createToolLaunchMapping({ ...f.input, nodeExecutable: path.join(f.directory, "replacement-node"), childEntry: path.join(f.directory, "replacement-helper.js"), existingOnly: true }, operation())).rejects.toThrow();
    expect(await readFile(f.mapping.manifestPath, "utf8")).toBe(original);
  });

  it("starts exactly the frozen command, records original argv, and removes mapping environment from the child", async () => {
    const f = await fixture();
    const args = ["-e", "process.stdout.write(JSON.stringify({args:process.argv.slice(1),path:process.env.PATH,home:process.env.CODEX_HOME,mapping:process.env.DAYNIGHT_HERDR_TOOL_MANIFEST}));", "--", "", "a b", "'\"\\", "$HOME;echo nope", "中文"];
    const result = await execute(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", ...args], { ...process.env, ...f.mapping.environment, PATH: "/mapping:/native/path", CODEX_HOME: "/native/home" });
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ args: args.slice(3), path: "/native/path", home: "/native/home" });
    const receipt = await f.mapping.readReceipt(operation());
    expect(receipt).not.toBeNull();
    expect(receipt).toMatchObject({ helperPid: result.pid, selectionKey: f.launch.selectionKey, file: f.launch.command.file, prefixArgs: f.launch.command.prefixArgs });
    expect(receipt!.childPid).not.toBe(result.pid);
    await expect(f.mapping.verifyReceipt([...args, "changed"], operation())).rejects.toThrow("receipt");
    const replay = await execute(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", ...args]);
    expect(replay.code).not.toBe(0);
    expect(replay.stdout).toBe("");
  });

  it("refuses redirected or changed manifests without spawning a native command", async () => {
    const f = await fixture(), contents = await readFile(f.mapping.manifestPath, "utf8");
    const redirected = path.join(f.directory, "redirected.json"); await writeFile(redirected, contents, { mode: 0o600 });
    await rm(f.mapping.manifestPath); await symlink(redirected, f.mapping.manifestPath);
    const result = await execute(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", "-e", "process.stdout.write('wrong')"]);
    expect(result.code).not.toBe(0); expect(result.stdout).toBe("");
    await expect(createToolLaunchMapping({ ...f.input, existingOnly: true }, operation())).rejects.toThrow();
  });

  it("decodes the PowerShell transport as data and preserves empty native arguments", async () => {
    const f = await fixture(), args = ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)));", "--", "", "a b", "'\"\\", "$HOME;echo nope", "中文"];
    const encode = (value: string) => Buffer.from(value).toString("base64");
    const result = await execute(process.execPath, [childEntry, "--encoded-manifest", encode(f.mapping.manifestPath), "codex", "--encoded-args", encode(JSON.stringify(args))]);
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(args.slice(3));
    expect(await f.mapping.readReceipt(operation())).toMatchObject({ helperPid: result.pid });
  });

  it("waits for the asynchronous receipt publication without starting another native process", async () => {
    const f = await fixture(), args = ["-e", "process.stdout.write('once');process.stdin.once('data',()=>process.exit(0));setInterval(()=>{},1000);"];
    const verification = f.mapping.verifyReceipt(args, operation());
    const helper = spawn(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", ...args], { detached: true, stdio: ["pipe", "pipe", "pipe"] }), closed = once(helper, "close");
    let stdout = "", stderr = "";
    helper.stdout!.on("data", chunk => { stdout += chunk; }); helper.stderr!.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => helper.kill("SIGKILL"), 8_000);
    let registered = false, retired = false, failure: unknown, failed = false;
    let receipt: Awaited<typeof verification> | undefined, observer: Awaited<ReturnType<typeof retainHerdrJobObserver>> | undefined;
    const cleanupFailures: unknown[] = [];
    try {
      receipt = await verification;
      expect(receipt.helperPid).toBe(helper.pid);
      if (process.platform === "win32") observer = await retainHerdrJobObserver(f.mapping.manifestPath, await readToolManifest(f.mapping.manifestPath), receipt, operation());
      await f.mapping.captureProcesses([receipt.helperPid, receipt.childPid], operation()); registered = true;
      await vi.waitFor(() => expect(stdout).toBe("once"));
      helper.stdin!.write("exit\n");
      expect(await closed).toEqual([0, null]); expect(stderr).toBe("");
      await vi.waitFor(async () => expect(await f.mapping.confirmStopped(operation())).toBe(true));
      await f.mapping.retire(operation()); retired = true;
    } catch (error) { failed = true; failure = error; }
    finally {
      clearTimeout(timer);
      if (!retired) {
        if (process.platform === "win32") {
          try {
            receipt ??= await f.mapping.readReceipt(operation()) ?? undefined;
            if (receipt !== undefined) observer ??= await retainHerdrJobObserver(f.mapping.manifestPath, await readToolManifest(f.mapping.manifestPath), receipt, operation());
            if (observer !== undefined) { await observer.stop(operation()); observer.release(); }
          } catch (error) { cleanupFailures.push(error); }
        } else {
          try {
            if (registered) { await f.mapping.stopProcesses(operation()); await f.mapping.retire(operation()); }
            else {
              // The original helper forwards SIGTERM through its held native
              // ChildProcess; a receipt PID cannot create a cleanup birth proof.
              if (!helper.kill("SIGTERM")) throw new Error("The asynchronous receipt fixture lost its original helper before cleanup; native closure remains unknown.");
              await vi.waitFor(() => expect(helper.exitCode !== null || helper.signalCode !== null).toBe(true), { timeout: 1000, interval: 10 });
            }
          } catch (error) { cleanupFailures.push(error); }
        }
      }
      try { helper.kill("SIGKILL"); } catch (error) { cleanupFailures.push(error); }
      try { await closed; } catch (error) { cleanupFailures.push(error); }
    }
    if (cleanupFailures.length) throw new AggregateError(failed ? [failure, ...cleanupFailures] : cleanupFailures, "The asynchronous receipt fixture cleanup failed.", failed ? { cause: failure } : undefined);
    if (failed) throw failure;
  });

  it.skipIf(process.platform === "win32")("rotates a same-owner generation only after every recorded process has stopped", async () => {
    const f = await fixture(), native = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(native, "close");
    const timer = setTimeout(() => { if (native.pid !== undefined) process.kill(-native.pid, "SIGKILL"); }, 8_000);
    try {
      await once(native.stdout!, "data");
      await f.mapping.captureProcesses([native.pid!], operation());
      await expect(f.mapping.retire(operation())).rejects.toThrow("stopped");
      expect((await createToolLaunchMapping(f.input, operation()))!.nonce).toBe(f.mapping.nonce);
      native.kill("SIGTERM"); await closed;
      await f.mapping.retire(operation());
      expect((await createToolLaunchMapping({ ...f.input, existingOnly: true }, operation()))!.nonce).toBe(f.mapping.nonce);
      const next = await createToolLaunchMapping(f.input, operation());
      expect(next!.nonce).not.toBe(f.mapping.nonce);
      expect(next!.manifestPath).not.toBe(f.mapping.manifestPath);
      expect(JSON.parse(await readFile(f.mapping.manifestPath, "utf8")).nonce).toBe(f.mapping.nonce);
    } finally { clearTimeout(timer); if (native.exitCode === null && native.signalCode === null && native.pid !== undefined) { process.kill(-native.pid, "SIGKILL"); await closed; } }
  });

  it.skipIf(process.platform === "win32")("waits for the original native child after a signal and returns its exit status", async () => {
    const f = await fixture(), args = ["-e", "process.on('SIGTERM',()=>process.exit(17));process.stdout.write('ready');setInterval(()=>{},1000);"];
    const helper = spawn(process.execPath, [childEntry, f.mapping.manifestPath, "codex", "--", ...args], { env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(helper, "close");
    const timer = setTimeout(() => { if (helper.pid !== undefined) process.kill(-helper.pid, "SIGKILL"); }, 8_000);
    try {
      await once(helper.stdout!, "data");
      const receipt = await f.mapping.verifyReceipt(args, operation());
      expect(helper.kill("SIGTERM")).toBe(true);
      expect(await closed).toEqual([17, null]);
      expect(() => process.kill(receipt.childPid, 0)).toThrow();
    } finally { clearTimeout(timer); if (helper.exitCode === null && helper.signalCode === null && helper.pid !== undefined) { process.kill(-helper.pid, "SIGKILL"); await closed; } }
  });

  it.skipIf(process.platform === "win32")("refuses a replaced selected entry before writing a launch intent", async () => {
    const f = await fixture(), entry = path.join(f.directory, "selected-native");
    await symlink(process.execPath, entry);
    const launch = await resolveToolLaunch({ tool: "codex", context: "herdr", choice: { kind: "path", path: entry }, environment: process.env, cwd: f.directory }, operation());
    const mapping = await createToolLaunchMapping({ ...f.input, launch }, operation());
    if (mapping === null) throw new Error("Missing selected-entry mapping.");
    await rm(entry); await symlink("/bin/echo", entry);
    const result = await execute(process.execPath, [childEntry, mapping.manifestPath, "codex", "--", "-e", "process.stdout.write('wrong')"]);
    expect(result.code).not.toBe(0); expect(result.stdout).toBe("");
    expect(await mapping.readReceipt(operation())).toBeNull();
    await expect(readFile(path.join(path.dirname(mapping.manifestPath), "launch-intent.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("uses unexported Bash functions without replacing the original pane shell", async () => {
    const f = await fixture(), rc = path.join(f.directory, "shell.rc");
    await writeFile(rc, posixToolMappingRc({ nodeExecutable: process.execPath, childEntry }));
    const args = ["-e", "process.stdout.write(JSON.stringify({args:process.argv.slice(1),path:process.env.PATH,mapping:process.env.DAYNIGHT_HERDR_TOOL_MANIFEST,functions:process.env['BASH_FUNC_codex%%']}));", "--", "", "a b", "$HOME;echo nope"];
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const result = await execute("/bin/bash", ["--noprofile", "--rcfile", rc, "-p", "-i", "-c", `printf 'shell:%s\\n' "$$"; codex ${args.map(quote).join(" ")}; printf '\\nshell:%s\\n' "$$"`], { ...process.env, ...f.mapping.environment });
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe(`shell:${result.pid}`); expect(lines[2]).toBe(`shell:${result.pid}`);
    expect(JSON.parse(lines[1]!)).toEqual({ args: args.slice(3), path: "/native/path" });
  });
});
