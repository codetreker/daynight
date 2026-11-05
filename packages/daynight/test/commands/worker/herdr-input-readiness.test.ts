import { describe, expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { inspectHerdrInput } from "../../../src/commands/worker/herdr/input-readiness.js";
import { HerdrInputBlockedError } from "../../../src/commands/worker/herdr/agents.js";
import type { HerdrAgentObservation, HerdrTaskBinding } from "../../../src/commands/worker/herdr.js";
import { expandedNarrowSessionPickerScreens, narrowSessionPickerScreens } from "../../fixtures/native-session-picker-screens.js";

const binding: HerdrTaskBinding = { session: "w", workspaceId: "ws", paneId: "pane", terminalId: "terminal" };
const fixture = (width = 97) => {
  const calls: string[] = [];
  const observation: HerdrAgentObservation = { binding, kind: "copilot", name: null, status: "idle", launchPending: false, interactiveReady: true, nativeSession: null, stateChangeSeq: 1, completionSeq: 0 };
  const snapshot = { panes: [{ pane_id: "pane", terminal_id: "terminal", workspace_id: "ws", tab_id: "tab" }], layouts: [{ tab_id: "tab", workspace_id: "ws", panes: [{ pane_id: "pane", rect: { width: 100, height: 25 } }] }] };
  let visible = "";
  const operation = createOperation();
  const inspect = (purpose: "automatic" | "manual" | "resume" | "cleanup" = "automatic") => inspectHerdrInput({ binding, provider: observation.kind as "codex" | "claude" | "copilot", purpose, operation, observe: async () => observation, readSize: async () => ({ width, height: 23 }),
    rpc: { request: async (method, params) => { calls.push(method); if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: "pane", shell_pid: 123, tty: "/dev/ttys001" } }; if (method === "ping") return { type: "pong", version: "0.9.5" }; if (method === "session.snapshot") return { type: "session_snapshot", snapshot }; return { type: "pane_read", read: { pane_id: "pane", workspace_id: "ws", tab_id: "tab", source: "visible", format: params.format, text: visible, truncated: false, revision: 0 } }; } } });
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
    const f = fixture(); f.observation.kind = "codex"; try { f.text("› a pending draft"); await expect(f.inspect("resume")).rejects.toThrow(); f.text("› \x1b[2mAsk Codex to do anything\x1b[0m\n\n ? for shortcuts"); expect((await f.inspect("resume")).composer).toBe("empty"); } finally { f.operation.dispose(); }
  });
});

const readyComposer = {
  codex: "› \x1b[2mAsk Codex to do anything\x1b[0m\n\n ? for shortcuts",
  claude: "────────\n❯\n────────\n ? for shortcuts",
  copilot: "",
} as const;

it.each(["codex", "claude", "copilot"] as const)("accepts an interactive %s completion without claiming automatic empty-composer proof", async provider => {
  const f = fixture(); f.observation.kind = provider; f.text(readyComposer[provider]);
  try {
    f.observation.status = "working"; await expect(f.inspect()).rejects.toMatchObject({ code: "automation_suspended" });
    f.observation.status = "done";
    await expect(f.inspect()).resolves.toMatchObject({ width: 97, height: 23, composer: "unavailable" });
    if (provider !== "copilot") {
      f.text(provider === "codex" ? "› a pending draft" : "────────\n❯ a pending draft\n────────\n ? for shortcuts");
      await expect(f.inspect()).resolves.toMatchObject({ composer: "unavailable" });
      await expect(f.inspect("resume")).rejects.toMatchObject({ code: "automation_suspended" });
    }
  } finally { f.operation.dispose(); }
});

it.each(["automatic", "cleanup"] as const)("uses only known blockers for %s input", async purpose => {
  for (const provider of ["codex", "claude"] as const) {
    const f = fixture(); f.observation.kind = provider;
    try {
      for (const screen of ["Unrecognized normal layout", readyComposer[provider], "› Ask Codex to do anything\n GPT-6.1 Terra medium · daynight/task\n ? for shortcuts"]) {
        f.text(screen); await expect(f.inspect(purpose)).resolves.toMatchObject({ composer: "unavailable" });
      }
      f.text(provider === "codex" ? "› 1. GPT-6.1 Terra\nenter default · s session · esc back" : "❯ 1. Yes\nEnter to confirm · Esc to cancel");
      await expect(f.inspect(purpose)).rejects.toBeInstanceOf(HerdrInputBlockedError);
      f.calls.splice(0); await expect(f.inspect("manual")).resolves.toMatchObject({ composer: "unavailable" });
      expect(f.calls).not.toContain("pane.read");
    } finally { f.operation.dispose(); }
  }
});

it.each(narrowSessionPickerScreens)("refuses the primary-only $action picker at its original PTY width", async ({ action, screen, width }) => {
  const f = fixture(width); f.observation.kind = "codex";
  try {
    for (const visible of [screen, screen.replace("Type to search", "Search: original"), screen.replace("Type to search", "Failed to read session metadata"), screen.replace("  › Original session\n    now", " No sessions yet")]) {
      f.text(visible);
      for (const purpose of ["automatic", "cleanup"] as const) await expect(f.inspect(purpose)).rejects.toMatchObject({ name: "HerdrInputBlockedError", blocker: "menu", promptSubmission: "not-submitted" });
    }
    f.text(screen);
    await expect(f.inspect("resume")).rejects.toMatchObject({ code: "automation_suspended" });
    f.calls.splice(0);
    await expect(f.inspect("manual")).resolves.toMatchObject({ width, composer: "unavailable" });
    expect(f.calls).not.toContain("pane.read");
    for (const visible of [
      `${screen}\n› Any custom current composer`,
      screen.replace(/(?:Resume|Fork) a previous session/, "A discussion of previous sessions"),
      screen.replace("a previous session", "a previous sess"),
      screen.replace(" Type to search\n\n  › Original session\n    now", " A business example"),
      screen.replace(`⌃⇧⌥⌘fwd del ${action}`, "⌃⇧⌥⌘fwd del send"),
      screen.replace("⌃⇧⌥⌘fwd del", "f25"),
      screen.replace(` ⌃⇧⌥⌘fwd del ${action}`, ` Prose about ⌃⇧⌥⌘fwd del ${action}`),
    ]) {
      f.text(visible);
      await expect(f.inspect()).resolves.toMatchObject({ composer: "unavailable" });
    }
    expect(f.calls).not.toContain("terminal.attach");
    expect(f.calls).not.toContain("agent.prompt");
  } finally { f.operation.dispose(); }
});

it.each(expandedNarrowSessionPickerScreens)("refuses an expanded primary-only $action picker with an inline error", async ({ screen, width }) => {
  const f = fixture(width); f.observation.kind = "codex"; f.text(screen);
  try {
    for (const purpose of ["automatic", "cleanup"] as const) await expect(f.inspect(purpose)).rejects.toMatchObject({ name: "HerdrInputBlockedError", blocker: "menu", promptSubmission: "not-submitted" });
    for (const visible of [screen.replace(/(?:Resume|Fork) a previous session/, "A discussion of previous sessions"), `${screen}\n› Any custom current composer`]) {
      f.text(visible);
      await expect(f.inspect()).resolves.toMatchObject({ composer: "unavailable" });
    }
    expect(f.calls).not.toContain("terminal.attach");
    expect(f.calls).not.toContain("agent.prompt");
  } finally { f.operation.dispose(); }
});

it.each(["codex", "claude"] as const)("requires honest current %s empty-input evidence only for resume", async provider => {
  const f = fixture(); f.observation.kind = provider;
  try {
    f.text(readyComposer[provider]); await expect(f.inspect("resume")).resolves.toMatchObject({ composer: "empty" });
    if (provider === "codex") {
      f.text("› \x1b[2mAsk Codex to do anything\x1b[0m\n\n GPT-6.1 Terra medium · daynight/task\n ? for shortcuts");
      await expect(f.inspect("resume")).resolves.toMatchObject({ composer: "empty" });
    }
    for (const screen of ["Unknown layout", provider === "codex" ? "› Ask Codex to do anything" : "❯", `${readyComposer[provider]}\n${provider === "codex" ? "›" : "❯"} current draft`, provider === "codex" ? "› 1. Model\nenter select · esc back" : "❯ 1. Yes\nEnter to confirm · Esc to cancel"]) {
      f.text(screen); await expect(f.inspect("resume")).rejects.toMatchObject({ code: "automation_suspended" });
    }
  } finally { f.operation.dispose(); }
});

it.each([
  "› Ask Codex to do anything\n\n ? for shortcuts",
  "› Ask Codex to do anything\nsecond line of an actual multiline draft\n ? for shortcuts",
  "› \x1b[2mAsk Codex to do anything\x1b[0m\nsecond line of a draft\n ? for shortcuts",
  "› \x1b[38;2;2;4;6mAsk Codex to do anything\x1b[0m\n\n ? for shortcuts",
  "› \x1b[38;5;2mAsk Codex to do anything\x1b[0m\n\n ? for shortcuts",
  "› \x1b[38;2;;4;6;2mAsk Codex to do anything\x1b[0m\n\n ? for shortcuts",
  "› \x1b[2mAsk Codex to do anything\x1b[0m\x1b[H\n\n ? for shortcuts",
])("does not label an ambiguous, nonempty or unsupported Codex field empty: %j", async screen => {
  const f = fixture(); f.observation.kind = "codex"; f.text(screen);
  try { await expect(f.inspect("resume")).rejects.toMatchObject({ code: "automation_suspended" }); }
  finally { f.operation.dispose(); }
});

it("keeps actual DIM evidence distinct from RGB/indexed channel values", async () => {
  const f = fixture(); f.observation.kind = "codex";
  try {
    f.text("\x1b[1m› \x1b[0;2;38;2;2;4;6mAsk Codex to do anything\x1b[0m\n\n ? for shortcuts");
    await expect(f.inspect("resume")).resolves.toMatchObject({ composer: "empty" });
    f.text("› \x1b[2;38;5;2mAsk Codex to do anything\x1b[22m\n\n ? for shortcuts");
    await expect(f.inspect("resume")).resolves.toMatchObject({ composer: "empty" });
  } finally { f.operation.dispose(); }
});

it.each(["────────\n❯ Try \"explain this repository\"\n────────\n ? for shortcuts", "────────\n❯\nactual multiline draft\n────────\n ? for shortcuts"])("does not label ambiguous Claude placeholder or multiline draft empty: %j", async screen => {
  const f = fixture(); f.observation.kind = "claude"; f.text(screen);
  try { await expect(f.inspect("resume")).rejects.toMatchObject({ code: "automation_suspended" }); }
  finally { f.operation.dispose(); }
});

it.each(["automatic", "manual", "resume", "cleanup"] as const)("requires readiness for done input in %s mode", async purpose => {
  const f = fixture(); f.observation.status = "done";
  try {
    await expect(f.inspect(purpose)).resolves.toBeDefined();
    f.observation.interactiveReady = false;
    await expect(f.inspect(purpose)).rejects.toMatchObject({ code: "automation_suspended" });
  } finally { f.operation.dispose(); }
});

it("does not grant manual input to unknown or pending completed observations", async () => {
  const f = fixture();
  try {
    f.observation.status = "unknown"; await expect(f.inspect("manual")).rejects.toMatchObject({ code: "automation_suspended" });
    f.observation.status = "done"; f.observation.launchPending = true;
    await expect(f.inspect("manual")).rejects.toMatchObject({ code: "automation_suspended" });
  } finally { f.operation.dispose(); }
});
