import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { HerdrRpcClient } from "../../../src/commands/worker/herdr/rpc.js";
import { inspectWindowsRootReadiness } from "./herdr-platform-readiness-diagnostics.fixtures.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-readiness-diagnostics");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "readiness-")); roots.push(directory);
  const binding = { session: "w", workspaceId: "workspace", paneId: "pane", terminalId: "terminal" };
  const mapping = { manifestPath: path.join(directory, "manifest.json"), nonce: "12345678-1234-4234-8234-123456789012", windowsCommand: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"] };
  const operation = createOperation({ limits: { totalMs: 4000, requestMs: 2000, responseBytes: 65536, totalBytes: 131072 } });
  const screen = { pane_id: binding.paneId, workspace_id: binding.workspaceId, tab_id: "tab", source: "visible", format: "text", truncated: false, text: "PS C:\\temporary>\nprivate-secret\nCommandNotFoundException" };
  const request = vi.fn(async (method: string) => method === "pane.process_info" ? { type: "pane_process_info", process_info: { pane_id: binding.paneId, shell_pid: 123 } } : { type: "pane_read", read: screen });
  return { directory, binding, mapping, operation, screen, request, input: { rpc: { request } as Pick<HerdrRpcClient, "request">, operation, binding, tabId: "tab", shellPid: 123, mapping } };
};

it("reports bounded ready-file and pane signals without persisting pane text or mutating mapping files", async () => {
  const f = await setup();
  const temporary = "shell-ready.12345678-1234-4234-8234-123456789012.tmp";
  await writeFile(path.join(f.directory, temporary), "pending");
  const before = await readdir(f.directory);
  try {
    const result = await inspectWindowsRootReadiness(f.input);
    expect(result.readyFile).toEqual({ state: "missing" });
    expect(result.temporaryFiles).toEqual({ state: "observed", count: 1 });
    expect(result.pane).toMatchObject({ state: "observed", shellPid: 123, screenSignals: ["command-not-found", "powershell-prompt"] });
    expect(JSON.stringify(result)).not.toContain("private-secret");
    expect(JSON.stringify(result)).not.toContain("C:\\\\temporary");
    expect(await readdir(f.directory)).toEqual(before);
    expect(await readFile(path.join(f.directory, temporary), "utf8")).toBe("pending");
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(["pane.process_info", "pane.read", "pane.process_info"]);
  } finally { f.operation.dispose(); }
});

it("reports readiness identity matches without treating mismatches as proof", async () => {
  const f = await setup();
  const ready = JSON.stringify({ nonce: f.mapping.nonce, pid: 123, executable: f.mapping.windowsCommand[0]!.toUpperCase(), startToken: "639301878574428200" });
  await writeFile(path.join(f.directory, "shell-ready.json"), ready);
  try {
    expect((await inspectWindowsRootReadiness(f.input)).readyFile).toEqual({ state: "present", size: Buffer.byteLength(ready), nonceMatches: true, pidMatches: true, executableMatches: true, validStartToken: true });
    await writeFile(path.join(f.directory, "shell-ready.json"), JSON.stringify({ nonce: "other", pid: 456, executable: "other", startToken: "invalid" }));
    expect((await inspectWindowsRootReadiness(f.input)).readyFile).toMatchObject({ state: "present", nonceMatches: false, pidMatches: false, executableMatches: false, validStartToken: false });
  } finally { f.operation.dispose(); }
});

it.each(["wrong-workspace", "truncated", "oversized", "changed-shell"])("keeps pane evidence unknown for %s", async failure => {
  const f = await setup();
  if (failure === "wrong-workspace") f.screen.workspace_id = "other";
  if (failure === "truncated") f.screen.truncated = true;
  if (failure === "oversized") f.screen.text = "x".repeat(4097);
  if (failure === "changed-shell") {
    let calls = 0;
    f.request.mockImplementation(async method => method === "pane.process_info" ? { type: "pane_process_info", process_info: { pane_id: "pane", shell_pid: ++calls === 1 ? 123 : 456 } } : { type: "pane_read", read: f.screen });
  }
  try { expect((await inspectWindowsRootReadiness(f.input)).pane).toEqual({ state: "unknown", reason: "invalid" }); }
  finally { f.operation.dispose(); }
});

it("keeps unreadable files and RPC failures unknown without exposing errors", async () => {
  const f = await setup();
  await mkdir(path.join(f.directory, "shell-ready.json"));
  f.request.mockRejectedValue(new Error("private-secret"));
  try {
    const result = await inspectWindowsRootReadiness(f.input);
    expect(result.readyFile).toEqual({ state: "unknown", reason: "invalid" });
    expect(result.pane).toEqual({ state: "unknown", reason: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("private-secret");
  } finally { f.operation.dispose(); }
});

it("marks malformed readiness JSON invalid without exposing its contents", async () => {
  const f = await setup();
  await writeFile(path.join(f.directory, "shell-ready.json"), "private-secret{");
  try {
    const result = await inspectWindowsRootReadiness(f.input);
    expect(result.readyFile).toEqual({ state: "unknown", reason: "invalid" });
    expect(JSON.stringify(result)).not.toContain("private-secret");
  } finally { f.operation.dispose(); }
});

it("does not claim observations after cancellation or allow unbounded budgets", async () => {
  const f = await setup(), controller = new AbortController();
  const cancelled = createOperation({ signal: controller.signal, limits: { totalMs: 4000, requestMs: 2000, responseBytes: 65536, totalBytes: 131072 } });
  const unbounded = createOperation();
  controller.abort();
  try {
    expect(await inspectWindowsRootReadiness({ ...f.input, operation: cancelled })).toEqual({ readyFile: { state: "unknown", reason: "cancelled" }, temporaryFiles: { state: "unknown", reason: "cancelled" }, pane: { state: "unknown", reason: "cancelled" } });
    await expect(inspectWindowsRootReadiness({ ...f.input, operation: unbounded })).rejects.toThrow(/bounded/);
    expect(f.request).not.toHaveBeenCalled();
  } finally { f.operation.dispose(); cancelled.dispose(); unbounded.dispose(); }
});
