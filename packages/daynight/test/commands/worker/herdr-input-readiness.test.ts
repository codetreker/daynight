import { describe, expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { inspectHerdrInput } from "../../../src/commands/worker/herdr/input-readiness.js";
import type { HerdrAgentObservation, HerdrTaskBinding } from "../../../src/commands/worker/herdr.js";

const binding: HerdrTaskBinding = { session: "w", workspaceId: "ws", paneId: "pane", terminalId: "terminal" };
const fixture = () => {
  const calls: string[] = [];
  const observation: HerdrAgentObservation = { binding, kind: "copilot", name: null, status: "idle", launchPending: false, interactiveReady: true, nativeSession: null, stateChangeSeq: 1, completionSeq: 0 };
  const snapshot = { panes: [{ pane_id: "pane", terminal_id: "terminal", workspace_id: "ws", tab_id: "tab" }], layouts: [{ tab_id: "tab", workspace_id: "ws", panes: [{ pane_id: "pane", rect: { width: 100, height: 25 } }] }] };
  let visible = "";
  const operation = createOperation();
  const inspect = (purpose: "automatic" | "manual" | "resume" | "cleanup" = "automatic") => inspectHerdrInput({ binding, provider: observation.kind as "codex" | "claude" | "copilot", purpose, operation, observe: async () => observation, readSize: async () => ({ width: 97, height: 23 }),
    rpc: { request: async method => { calls.push(method); if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: "pane", shell_pid: 123, tty: "/dev/ttys001" } }; if (method === "ping") return { type: "pong", version: "0.9.5" }; if (method === "session.snapshot") return { type: "session_snapshot", snapshot }; return { type: "pane_read", read: { pane_id: "pane", workspace_id: "ws", tab_id: "tab", source: "visible", format: "text", text: visible, truncated: false, revision: 0 } }; } } });
  return { observation, snapshot, calls, operation, inspect, text: (text: string) => { visible = text; } };
};
describe("Herdr original input readiness", () => {
  it("reads geometry without attach and does not manufacture a Copilot empty-composer proof", async () => {
    const f = fixture(); try { expect(await f.inspect()).toEqual({ width: 97, height: 23, herdrVersion: "0.9.5", composer: "unavailable" }); expect(f.calls).not.toContain("agent.prompt"); expect(f.calls).not.toContain("terminal.attach"); } finally { f.operation.dispose(); }
  });
  it("rejects a replaced terminal even with the same pane", async () => {
    const f = fixture(); f.snapshot.panes[0]!.terminal_id = "replacement"; try { await expect(f.inspect()).rejects.toThrow(); } finally { f.operation.dispose(); }
  });
  it("permits manual menu handling but forbids automatic input and pending-resume attach", async () => {
    const f = fixture(); try { f.observation.status = "blocked"; await expect(f.inspect("manual")).resolves.toBeDefined(); await expect(f.inspect()).rejects.toThrow(); f.observation.launchPending = true; await expect(f.inspect("manual")).rejects.toThrow(); } finally { f.operation.dispose(); }
  });
  it("requires a recognized empty composer for available provider checks", async () => {
    const f = fixture(); f.observation.kind = "codex"; try { f.text("› a pending draft"); await expect(f.inspect("resume")).rejects.toThrow(); f.text("› Ask Codex to do anything\n gpt · /tmp/project"); expect((await f.inspect("resume")).composer).toBe("empty"); } finally { f.operation.dispose(); }
  });
});
