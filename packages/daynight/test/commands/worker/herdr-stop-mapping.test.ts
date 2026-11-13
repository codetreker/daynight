import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation, type Operation } from "../../../src/api/operation.js";
import { createWorkerHerdr, type HerdrExecutionOwner } from "../../../src/commands/worker/herdr.js";
import { herdrExecutionLabel } from "../../../src/commands/worker/herdr/agents.js";
import * as commands from "../../../src/commands/worker/herdr/command.js";
import * as proofs from "../../../src/commands/worker/herdr/tool-launch-process-proof.js";
import * as metadata from "../../../src/commands/worker/herdr/windows-process-metadata.js";
import { createToolLaunchMapping, mappingFiles } from "../../../src/commands/worker/herdr/tool-launch.js";
import type { HerdrRpcClient } from "../../../src/commands/worker/herdr/rpc.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore, type WorkerStore } from "../../../src/commands/worker/store.js";
import type { ExecutionConfiguration } from "../../../src/commands/worker/types.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../../src/commands/worker/herdr/instance.js", async original => ({
  ...await original<object>(),
  createHerdrInstance: () => ({ rpc: transport, paths: {}, assertIntegrationEnvironment: () => {}, toolMappingRuntime: () => ({}) }),
}));
vi.mock("../../../src/commands/worker/herdr/preflight.js", () => ({ createHerdrPreflight: () => ({ verifyStart: async () => {}, close: async () => {} }) }));

const directories: string[] = [], stores: WorkerStore[] = [], operations: Operation[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const hostPlatform = process.platform;
const operation = () => { const result = createOperation({ limits: { totalMs: 3000 } }); operations.push(result); return result; };
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
const owner: HerdrExecutionOwner = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4) };
const shellPid = 2_147_483_647;

afterEach(async () => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  operations.splice(0).forEach(value => value.dispose());
  stores.splice(0).forEach(store => store.close());
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const fixture = async (platform: "darwin" | "win32", recipe: "frozen" | "legacy" | "missing" = "frozen", hasMapping = true) => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-tools/stop-mapping-tests");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "owner-")); directories.push(directory);
  const paths = resolveWorkerPaths(directory), environment = { ...process.env, SystemRoot: "C:\\Windows" };
  const launch = await resolveToolLaunch({ tool: "codex", context: "herdr", choice: { kind: "path", path: process.execPath }, environment, cwd: directory }, operation());
  await mkdir(path.dirname(paths.databaseFile), { recursive: true, mode: 0o700 });
  const initialStore = openWorkerStore(paths.databaseFile, { onMigration: () => {} });
  try {
    initialStore.registerProject({ projectId: owner.projectId, repoUrl: "https://github.com/owner/repo.git", localPath: directory });
    initialStore.registerPending({ ...owner, agent: "codex" });
    if (recipe !== "missing") initialStore.freezeNativeConfiguration(owner, { agent: "codex", model: null, args: [], ...(recipe === "frozen" ? { toolLaunch: launch } : {}) });
  } finally { initialStore.close(); }
  const store = openWorkerStore(paths.databaseFile, { onMigration: () => {} }); stores.push(store);
  const readConfiguration = vi.fn((identity: HerdrExecutionOwner): ExecutionConfiguration | null => {
    const frozen = store.getNativeConfiguration(identity);
    return frozen === null ? null : { ...frozen, agentControlMode: "herdr", recoveryLimit: 3 };
  });
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  const proof: proofs.MappingProcessProof = { pid: shellPid, parentPid: 1, processGroupId: null, startedAt: "2026-11-12T00:00:00.1234000Z", commandHash: "a".repeat(64) };
  vi.spyOn(proofs, "captureMappingProcessProof").mockResolvedValue(proof);
  const inspect = vi.spyOn(proofs, "inspectMappingProcessForCleanup").mockResolvedValue("stopped");
  vi.spyOn(metadata, "captureWindowsProcessInventory").mockResolvedValue([]);
  vi.spyOn(commands, "runHerdrCommand").mockImplementation(async command => {
    if (command.file !== "/bin/ps") throw new Error(`Unexpected process command: ${command.file}`);
    return { stdout: "", stderr: "" };
  });
  await mkdir(paths.herdrDirectory, { recursive: true, mode: 0o700 });
  const mappingInput = { directory: paths.herdrDirectory, owner, launch, nativeEnvironment: environment };
  const mapping = hasMapping ? (await createToolLaunchMapping(mappingInput, operation()))! : null;
  if (mapping !== null) {
    await mapping.captureProcesses([shellPid], operation());
    if (platform === "win32") await writeFile(mappingFiles(mapping.manifestPath).layout, JSON.stringify({ nonce: mapping.nonce, initial: { paneId: "previous-generation-pane" } }), { mode: 0o600 });
  }
  const binding = { session: "w", workspaceId: "owned", paneId: "empty-pane", terminalId: "original-terminal" };
  const calls: string[] = [];
  let closed = false;
  transport.request.mockReset().mockImplementation((async method => {
    calls.push(method);
    if (method === "session.snapshot") return { type: "session_snapshot", snapshot: { workspaces: closed ? [] : [{ workspace_id: binding.workspaceId, label: herdrExecutionLabel(owner, "Task") }], panes: closed ? [] : [{ workspace_id: binding.workspaceId, pane_id: binding.paneId, terminal_id: binding.terminalId }], agents: [], tabs: [] } };
    if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: binding.paneId, shell_pid: shellPid, foreground_processes: [] } };
    if (method === "workspace.close") { closed = true; return { type: "ok" }; }
    throw new Error(`Unexpected stop RPC: ${method}`);
  }) satisfies HerdrRpcClient["request"]);
  const build = (includeReader = true) => createWorkerHerdr({ paths, homeDirectory: directory, environment, ...(includeReader ? { readExecutionConfiguration: readConfiguration } : {}) });
  return { directory, paths, mappingInput, mapping, binding, context: { ...owner, cwd: directory }, readConfiguration, build, inspect, calls };
};

describe.each(["darwin", "win32"] as const)("owner-only frozen stop assembly (%s)", platform => {
  const platformIt = it.skipIf(hostPlatform === "win32" && platform === "darwin");
  platformIt("uses the default Herdr mode for a frozen owner-only stop", async () => {
    const f = await fixture(platform), readOriginal = f.readConfiguration.getMockImplementation()!;
    f.readConfiguration.mockImplementation(identity => {
      const { agentControlMode: _mode, ...configuration } = readOriginal(identity)!;
      return configuration;
    });
    await f.build().tasks.stopAndClose(f.context, f.binding, operation());
    expect(JSON.parse(await readFile(path.join(path.dirname(f.mapping!.manifestPath), "retired.json"), "utf8"))).toEqual({ nonce: f.mapping!.nonce, selectionKey: f.mapping!.selectionKey, owner });
    expect(f.readConfiguration.mock.calls.map(([identity]) => identity)).toEqual([owner]);
    expect(f.calls.filter(method => method === "workspace.close")).toHaveLength(1);
  });

  platformIt("retires a pre-launch mapping after store reopen and rotates shell and layout evidence", async () => {
    const f = await fixture(platform), mapping = f.mapping!, journal = path.join(path.dirname(mapping.manifestPath), "processes.json");
    const originalJournal = await readFile(journal, "utf8");
    const adapter = f.build();
    await adapter.tasks.stopAndClose(f.context, f.binding, operation());
    expect(JSON.parse(await readFile(path.join(path.dirname(mapping.manifestPath), "retired.json"), "utf8"))).toEqual({ nonce: mapping.nonce, selectionKey: mapping.selectionKey, owner });
    expect(f.readConfiguration.mock.calls.map(([identity]) => identity)).toEqual([owner]);
    expect(f.calls.filter(method => method === "workspace.close")).toHaveLength(1);
    expect(adapter.tasks.pendingStops()).toEqual([]);
    const next = (await createToolLaunchMapping(f.mappingInput, operation()))!;
    expect(next.nonce).not.toBe(mapping.nonce);
    expect(next.selectionKey).toBe(mapping.selectionKey);
    expect(next.manifestPath).not.toBe(mapping.manifestPath);
    await expect(readFile(path.join(path.dirname(next.manifestPath), "processes.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(mappingFiles(next.manifestPath).layout)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(journal, "utf8")).toBe(originalJournal);
  });

  platformIt("refuses an owner-only cold stop before close when the frozen mapping index is missing", async () => {
    const f = await fixture(platform), mapping = f.mapping!, manifest = await readFile(mapping.manifestPath, "utf8");
    const index = path.join(path.dirname(path.dirname(mapping.manifestPath)), "index.json");
    await rm(index);
    const adapter = f.build();
    await expect(adapter.tasks.stopAndClose(f.context, f.binding, operation())).rejects.toThrow("generation index is missing");
    expect(f.calls).not.toContain("workspace.close");
    expect(adapter.tasks.pendingStops()).toEqual([{ context: f.context, binding: f.binding }]);
    expect(await readFile(mapping.manifestPath, "utf8")).toBe(manifest);
    await expect(readFile(index)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(path.dirname(mapping.manifestPath), "retired.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  platformIt("retains the original stop responsibility when frozen process ownership remains unknown", async () => {
    const f = await fixture(platform), failure = new Error("Original shell birth is unknown"), adapter = f.build();
    f.inspect.mockRejectedValue(failure);
    await expect(adapter.tasks.stopAndClose(f.context, f.binding, operation())).rejects.toBe(failure);
    expect(f.calls).not.toContain("workspace.close");
    expect(adapter.tasks.pendingStops()).toEqual([{ context: f.context, binding: f.binding }]);
    await expect(adapter.tasks.prepareWorkspace({ ...f.context, agent: "codex" }, "Task", operation())).rejects.toThrow("stop remains unconfirmed");
    await expect(readFile(path.join(path.dirname(f.mapping!.manifestPath), "retired.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  platformIt.each(["legacy", "missing"] as const)("refuses to downgrade an existing mapping when the original recipe is %s", async recipe => {
    const f = await fixture(platform, recipe);
    await expect(f.build().tasks.stopAndClose(f.context, f.binding, operation())).rejects.toThrow("frozen");
    expect(f.calls).not.toContain("workspace.close");
    await expect(readFile(path.join(path.dirname(f.mapping!.manifestPath), "retired.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  platformIt.each(["legacy", "missing"] as const)("keeps a true %s execution without mapping on its original stop path", async recipe => {
    const f = await fixture(platform, recipe, false), adapter = f.build();
    await adapter.tasks.stopAndClose(f.context, f.binding, operation());
    expect(f.calls.filter(method => method === "workspace.close")).toHaveLength(1);
    expect(adapter.tasks.pendingStops()).toEqual([]);
    await expect(readFile(path.join(f.paths.herdrDirectory, "tool-launch"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  platformIt("retains a known mapping when its configuration reader is unavailable", async () => {
    const f = await fixture(platform), adapter = f.build(false);
    await expect(adapter.tasks.stopAndClose(f.context, f.binding, operation())).rejects.toThrow("no frozen execution recipe");
    expect(f.calls).not.toContain("workspace.close");
    await expect(readFile(path.join(path.dirname(f.mapping!.manifestPath), "retired.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  platformIt("refuses an explicit provider that differs from the original owner configuration", async () => {
    const f = await fixture(platform), context = { ...f.context, agent: "copilot" as const };
    await expect(f.build().tasks.stopAndClose(context, f.binding, operation())).rejects.toThrow("another provider or mode");
    expect(f.calls).not.toContain("workspace.close");
    expect(f.readConfiguration.mock.calls.map(([identity]) => identity)).toEqual([owner]);
  });

  platformIt.each(["mode", "provider", "recipe-context"] as const)("refuses a conflicting persisted %s before closing the original pane", async conflict => {
    const f = await fixture(platform), readOriginal = f.readConfiguration.getMockImplementation()!;
    f.readConfiguration.mockImplementationOnce(identity => {
      const original = readOriginal(identity)!;
      if (conflict === "mode") return { ...original, agentControlMode: "web" };
      if (conflict === "provider") return { ...original, agent: "copilot" };
      return { ...original, toolLaunch: { ...original.toolLaunch!, context: "web" } };
    });
    await expect(f.build().tasks.stopAndClose(f.context, f.binding, operation())).rejects.toThrow(/provider or mode|recipe differs/);
    expect(f.calls).not.toContain("workspace.close");
    await expect(readFile(path.join(path.dirname(f.mapping!.manifestPath), "retired.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.skipIf(hostPlatform === "win32")("uses the default Herdr mode when preparing an original mapped workspace", async () => {
  const f = await fixture("darwin"), readOriginal = f.readConfiguration.getMockImplementation()!;
  f.readConfiguration.mockImplementation(identity => {
    const { agentControlMode: _mode, ...configuration } = readOriginal(identity)!;
    return configuration;
  });
  const adapter = f.build();
  await expect(adapter.tasks.prepareWorkspace({ ...f.context, agent: "codex" }, "Task", operation())).resolves.toEqual(f.binding);
  expect(f.readConfiguration.mock.calls.map(([identity]) => identity)).toEqual([owner]);
  expect(f.calls).not.toContain("workspace.close");
});
