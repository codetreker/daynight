import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { readHerdrTerminalSnapshot, startHerdrRecordingSampler } from "../../../src/commands/worker/herdr/recording-sampler.js";
import { openHerdrRecordingStore } from "../../../src/commands/worker/herdr/recording-store.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const binding = { session: "w", workspaceId: "workspace", paneId: "pane", terminalId: "terminal" };
const root = fileURLToPath(new URL("../../../../../.tmp/herdr-recording-sampler-test/", import.meta.url));
const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });
const operation = () => createOperation({ limits: { totalMs: 10000 } });

describe("read-only terminal sampling", () => {
  it("returns ANSI styled rows only after verifying the same terminal, tab and geometry after the read", async () => {
    let read = false, checks = 0;
    const op = operation();
    const result = await readHerdrTerminalSnapshot({ binding, operation: op,
      verify: async () => { checks++; }, readSize: async () => ({ width: 80, height: 2 }),
      rpc: { request: async (method, params) => {
        if (method === "session.snapshot") return { type: "session_snapshot", snapshot: { panes: [{ pane_id: "pane", workspace_id: "workspace", terminal_id: "terminal", tab_id: "tab" }] } };
        if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: "pane", shell_pid: 123, tty: "/dev/ttys001" } };
        if (method === "pane.read") { expect(params).toEqual({ pane_id: "pane", source: "visible", format: "ansi", strip_ansi: false }); read = true; return { type: "pane_read", read: { pane_id: "pane", workspace_id: "workspace", tab_id: "tab", source: "visible", format: "ansi", text: "hello", revision: 1, truncated: false } }; }
        throw new Error("Sampling must never attach or write input.");
      } },
    });
    expect(read).toBe(true); expect(checks).toBe(2); expect(result.rows[0]![0]!.text).toBe("hello"); expect(result.rows[1]).toEqual([]);
    op.dispose();
  });
  it("discards a frame if its terminal changes during the read", async () => {
    let read = false; const op = operation();
    await expect(readHerdrTerminalSnapshot({ binding, operation: op, verify: async () => {}, readSize: async () => ({ width: 80, height: 2 }),
      rpc: { request: async (method) => {
        if (method === "session.snapshot") return { type: "session_snapshot", snapshot: { panes: [{ pane_id: "pane", workspace_id: "workspace", terminal_id: read ? "replacement" : "terminal", tab_id: "tab" }] } };
        if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: "pane", shell_pid: 123, tty: "/dev/ttys001" } };
        read = true; return { type: "pane_read", read: { pane_id: "pane", workspace_id: "workspace", tab_id: "tab", source: "visible", format: "ansi", text: "private", revision: 1, truncated: false } };
      } },
    })).rejects.toThrow(); op.dispose();
  });
});

describe("viewer-independent sampling loop", () => {
  it("waits 350ms after each completed read, continues during blocked publication and checkpoints on stop", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T00:00:00.000Z"));
    mkdirSync(root, { recursive: true }); const directory = mkdtempSync(path.join(root, "run-")); directories.push(directory);
    const store = openHerdrRecordingStore({ directory, sessionId: id(6), claimId: id(7), owner: { projectId: id(1), taskId: id(2), workerId: id(3), worktreeId: id(4), ownerUserId: id(5), serverOrigin: "https://daynight.example", provider: "codex" } });
    store.registerRun("1");
    const segment = { segmentId: id(8), segmentOrdinal: "1", executionGeneration: "1", binding: { instanceId: "daemon", sessionId: "w", workspaceId: "workspace", paneId: "pane", terminalId: "terminal", nativeSessionId: null }, startedAt: new Date().toISOString(), endedAt: null, durationMs: null, gap: null };
    store.openSegment(segment); let reads = 0, release!: () => void;
    const sampler = startHerdrRecordingSampler({ store, segment, read: async () => { reads++; return { width: 80, height: 1, rows: [[{ text: String(reads), foreground: null, background: null, bold: false, italic: false, underline: false, inverse: false }]] }; }, publish: async () => new Promise<void>(resolve => { release = resolve; }) });
    await vi.advanceTimersByTimeAsync(0); expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(349); expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1); expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(700); expect(reads).toBe(4);
    const boundary = await sampler.stop(); expect(Number(boundary.durationMs)).toBeGreaterThanOrEqual(1050);
    expect(store.snapshot().files).toHaveLength(4); release(); await vi.advanceTimersByTimeAsync(1000); expect(reads).toBe(4);
  });
});
