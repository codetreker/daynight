import { test, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import type { ProviderState } from "../../../src/commands/controller/providers/types.js";
test("a late turn/start receipt does not resurrect a completed native turn", async () => {
  const states: ProviderState[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: s => states.push(s), onSpawn: () => {} });
  try { const receipt = await provider.send("test", randomUUID(), null); await provider.waitForTurn(receipt.turnId!, Date.now() + 1000); expect(states.at(-1)).toMatchObject({ activity: "idle", currentTurnId: null }); }
  finally { await provider.close(); }
});

test("concurrent idle sends cannot both pass native turn admission", async () => {
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  try { const first = provider.send("first", randomUUID(), null); await expect(provider.send("second", randomUUID(), null)).rejects.toThrow("pending"); await first; }
  finally { await provider.close(); }
});

test("native input identity and tool deltas are observed without waiting for the final message", async () => {
  const ids: string[] = [], entries: unknown[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onInputObserved: id => ids.push(id), onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try { const id = randomUUID(); await provider.send("test", id, null); expect(ids).toEqual([id]); expect(entries).toContainEqual(expect.objectContaining({ kind: "tool_call", output: [{ type: "text", text: "safe output" }] })); }
  finally { await provider.close(); }
});

test("resumed native history supplies receipt evidence with the original client message identity", async () => {
  const ids: string[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: "native-thread", executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onInputObserved: id => ids.push(id), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  try { expect(ids).toEqual(["persisted-operation"]); } finally { await provider.close(); }
});

test("cancel confirmation waits for the matching native turn to end", async () => {
  const states: ProviderState[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: s => states.push(s), onSpawn: () => {} });
  try { const sent = await provider.send("cancel", randomUUID(), null); expect(states.at(-1)?.activity).toBe("working"); await provider.cancel(sent.turnId!); expect(states.at(-1)?.activity).toBe("idle"); }
  finally { await provider.close(); }
});

test("native approval resolves exactly once and only exposes native decision choices", async () => {
  const entries: import("../../../src/commands/controller/providers/types.js").ProviderEntry[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try {
    await provider.send("approval", randomUUID(), null);
    const { vi } = await import("vitest");
    await vi.waitFor(() => expect(entries.some(e => e.kind === "interaction")).toBe(true));
    const entry = entries.find(e => e.kind === "interaction"); if (!entry || entry.kind !== "interaction") throw new Error("Missing approval");
    expect(entry.interaction).toMatchObject({ actions: ["allow_once", "reject"] });
    await provider.respond(entry.interaction.interactionId, "1", { kind: "approval", action: "allow_once" });
    expect(entries.filter(e => e.kind === "interaction").at(-1)).toMatchObject({ interaction: { state: "resolved" } });
    await expect(provider.respond(entry.interaction.interactionId, "1", { kind: "approval", action: "allow_once" })).rejects.toThrow("stale");
  } finally { await provider.close(); }
});


test("a native cancel-only approval exposes Reject and sends the offered cancel decision", async () => {
  const entries: import("../../../src/commands/controller/providers/types.js").ProviderEntry[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try {
    await provider.send("approval_cancel", randomUUID(), null);
    const { vi } = await import("vitest"); await vi.waitFor(() => expect(entries.some(e => e.kind === "interaction")).toBe(true));
    const card = entries.find(e => e.kind === "interaction"); if (!card || card.kind !== "interaction") throw new Error("Missing approval");
    expect(card.interaction).toMatchObject({ actions: ["allow_once", "reject"] });
    await provider.respond(card.interaction.interactionId, "1", { kind: "approval", action: "reject" });
    expect(entries).toContainEqual(expect.objectContaining({ kind: "assistant_message", content: [{ type: "text", text: "native-decision:cancel" }] }));
  } finally { await provider.close(); }
});


test("closing native Codex rejects an unresolved response without waiting for its confirmation timeout", async () => {
  const entries: import("../../../src/commands/controller/providers/types.js").ProviderEntry[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try {
    await provider.send("approval_hold", randomUUID(), null);
    const { vi } = await import("vitest"); await vi.waitFor(() => expect(entries.some(e => e.kind === "interaction")).toBe(true));
    const card = entries.find(e => e.kind === "interaction"); if (!card || card.kind !== "interaction") throw new Error("Missing approval");
    const response = provider.respond(card.interaction.interactionId, "1", { kind: "approval", action: "allow_once" });
    const rejected = expect(response).rejects.toThrow("expired");
    await provider.close(); await rejected;
  } finally { await provider.close(); }
}, 3000);

 test("native process loss disables control, clears the turn and reports fatal exactly once", async () => {
  const { vi } = await import("vitest");
  const states: ProviderState[] = [], fatal: Error[] = [];
  let child!: import("node:child_process").ChildProcess;
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: s => states.push(structuredClone(s)), onSpawn: process => { child = process; }, onFatalError: error => fatal.push(error) });
  try {
    await provider.send("cancel", randomUUID(), null);
    child.kill("SIGTERM");
    await vi.waitFor(() => expect(fatal).toHaveLength(1));
    expect(states.at(-1)).toMatchObject({ activity: "unknown", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false } });
  } finally { await provider.close(); }
  expect(fatal).toHaveLength(1);
});
