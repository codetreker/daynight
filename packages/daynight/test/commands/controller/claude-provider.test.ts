import { test, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";
const historyReader = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), execFile: historyReader }));
const sdk = vi.hoisted(() => ({ query: vi.fn(), getSessionInfo: vi.fn(), getSessionMessages: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);
import { openClaudeProvider } from "../../../src/commands/controller/providers/claude.js";

test("Claude approval stays pending after SDK callback resolution until the matching native tool result", async () => {
  let captured!: Options, emit!: (value: unknown) => void; let end!: () => void;
  const messages: unknown[] = []; let wake: (() => void) | undefined, closed = false;
  sdk.query.mockImplementation(({ options, prompt }: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) => {
    captured = options; emit = value => { messages.push(value); wake?.(); }; end = () => { closed = true; wake?.(); };
    void (async () => { for await (const user of prompt) emit({ ...user }); })();
    return {
      async initializationResult() {
        const callback = options.hooks!.SessionStart![0]!.hooks[0]!;
        await callback({ hook_event_name: "SessionStart", session_id: options.sessionId!, transcript_path: "", cwd: process.cwd(), source: "startup" }, undefined, { signal: new AbortController().signal });
        return {};
      },
      async *[Symbol.asyncIterator]() { while (!closed) { const message = messages.shift(); if (message) yield message; else await new Promise<void>(resolve => { wake = resolve; }); } },
      close: () => end(), interrupt: async () => {},
    };
  });
  const entries: ProviderEntry[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try {
    await provider.send("run a tool", randomUUID(), null);
    const permission = captured.canUseTool!("Bash", { command: "echo safe" }, { signal: new AbortController().signal, toolUseID: "native-tool", decisionReason: "test" } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
    const card = entries.find(e => e.kind === "interaction"); expect(card?.kind).toBe("interaction"); if (!card || card.kind !== "interaction") throw new Error("Missing interaction");
    let completed = false;
    const response = provider.respond(card.interaction.interactionId, "1", { kind: "approval", action: "allow_once" }).then(value => { completed = true; return value; });
    await expect(permission).resolves.toMatchObject({ behavior: "allow" });
    await Promise.resolve(); expect(completed).toBe(false);
    expect(entries.filter(e => e.kind === "interaction").at(-1)).toMatchObject({ interaction: { state: "pending" } });
    emit({ type: "user", uuid: randomUUID(), session_id: provider.nativeSessionId, message: { content: [{ type: "tool_result", tool_use_id: "different-tool", content: "unrelated" }] } });
    await new Promise(resolve => setImmediate(resolve)); expect(completed).toBe(false);
    emit({ type: "user", uuid: randomUUID(), session_id: provider.nativeSessionId, message: { content: [{ type: "tool_result", tool_use_id: "native-tool", content: "safe" }] } });
    await expect(response).resolves.toEqual({ disposition: "handled" });
    expect(entries.filter(e => e.kind === "interaction").at(-1)).toMatchObject({ interaction: { state: "resolved" } });
  } finally { await provider.close(); }
});

const nativeFixture = (echo = true) => {
  const interrupt = vi.fn(async (): Promise<unknown> => ({}));
  let captured!: Options, wake: (() => void) | undefined, ended = false, failure: Error | undefined;
  const messages: unknown[] = [];
  const emit = (message: unknown) => { messages.push(message); wake?.(); };
  sdk.query.mockImplementation(({ options, prompt }: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) => {
    captured = options;
    void (async () => { for await (const user of prompt) if (echo) emit(user); })();
    return {
      async initializationResult() {
        await options.hooks!.SessionStart![0]!.hooks[0]!({ hook_event_name: "SessionStart", session_id: options.sessionId ?? options.resume!, transcript_path: "", cwd: process.cwd(), source: "startup" }, undefined, { signal: new AbortController().signal });
        return {};
      },
      async *[Symbol.asyncIterator]() { while (!ended) { const message = messages.shift(); if (message) yield message; else await new Promise<void>(resolve => { wake = resolve; }); } if (failure) throw failure; },
      close() { ended = true; wake?.(); }, interrupt,
    };
  });
  return { emit, interrupt, options: () => captured, end(error?: Error) { failure = error; ended = true; wake?.(); } };
};

test.each([false, true])("Claude disables control and rejects unconfirmed input when the native iterator ends (error=%s)", async error => {
  const fatal: Error[] = [];
  const fixture = nativeFixture(false), states: import("../../../src/commands/controller/providers/types.js").ProviderState[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: () => {}, onState: state => states.push(structuredClone(state)), onSpawn: () => {}, onFatalError: error => fatal.push(error) });
  const send = provider.send("uncertain input", randomUUID(), null);
  const rejection = expect(send).rejects.toThrow(/unknown|ended|connection/i);
  fixture.end(error ? new Error("lost native pipe") : undefined);
  await rejection;
  expect(states.at(-1)).toMatchObject({ activity: "unknown", capabilities: { send: false, steer: false, cancel: false, respond: false } });
  await expect(provider.send("must not replay", randomUUID(), null)).rejects.toThrow();
  expect(fatal).toHaveLength(1);
  expect(states.at(-1)?.currentTurnId).toBeNull();
  await provider.close();
});

test("Claude reports only exact native user text UUIDs from history and live messages", async () => {
  const fixture = nativeFixture(), observed: string[] = [], nativeId = randomUUID(), oldInput = randomUUID(), toolInput = randomUUID();
  sdk.getSessionInfo.mockResolvedValue({ sessionId: nativeId, cwd: process.cwd() });
  sdk.getSessionMessages.mockResolvedValue([
    { type: "user", uuid: oldInput, message: { content: "previous input" } },
    { type: "user", uuid: toolInput, message: { content: [{ type: "tool_result", tool_use_id: "old-tool", content: "output" }] } },
  ]);
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: nativeId, onInputObserved: id => observed.push(id), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  try {
    const operationId = randomUUID(); await provider.send("new input", operationId, null);
    fixture.emit({ type: "user", uuid: toolInput, message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "output" }] } });
    await new Promise(resolve => setImmediate(resolve));
    expect(observed).toEqual([oldInput, operationId]);
  } finally { await provider.close(); }
});


test("Claude resume reads the private native home without changing the parent environment", async () => {
  nativeFixture(); const nativeId = randomUUID(), observed: string[] = [], operationId = randomUUID();
  const parentHome = process.env.CLAUDE_CONFIG_DIR;
  historyReader.mockImplementation((_file, _args, options, callback) => {
    expect(options.env.CLAUDE_CONFIG_DIR).toBe("/private/isolated-claude-home");
    expect(options.timeout).toBe(30_000); expect(options.maxBuffer).toBeGreaterThan(0);
    callback(null, JSON.stringify({ info: { sessionId: nativeId, cwd: process.cwd() }, messages: [{ type: "user", uuid: operationId, message: { content: "accepted before restart" } }] }));
  });
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], env: { ...process.env, CLAUDE_CONFIG_DIR: "/private/isolated-claude-home" }, resumeNativeSessionId: nativeId, onInputObserved: id => observed.push(id), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  expect(observed).toEqual([operationId]); expect(process.env.CLAUDE_CONFIG_DIR).toBe(parentHome);
  await provider.close();
});

test.each(["error", "wrong_identity", "invalid_json"])("Claude fails closed on private history reader %s", async failure => {
  nativeFixture(); sdk.query.mockClear(); const nativeId = randomUUID();
  historyReader.mockImplementation((_file, _args, _options, callback) => callback(failure === "error" ? new Error("private output must not leak") : null, failure === "invalid_json" ? "private malformed output" : JSON.stringify({ info: { sessionId: randomUUID() }, messages: [] })));
  await expect(openClaudeProvider({ cwd: process.cwd(), model: null, args: [], env: { ...process.env, CLAUDE_CONFIG_DIR: "/private/isolated-claude-home" }, resumeNativeSessionId: nativeId, onTimeline: () => {}, onState: () => {}, onSpawn: () => {} })).rejects.toThrow(/history/);
  expect(sdk.query).not.toHaveBeenCalled();
});

test("Claude native loss expires an approval without confirming its submitted response", async () => {
  const fixture = nativeFixture(), entries: ProviderEntry[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: entry => entries.push(entry), onState: () => {}, onSpawn: () => {} });
  await provider.send("run a tool", randomUUID(), null);
  const permission = fixture.options().canUseTool!("Bash", { command: "echo safe" }, { signal: new AbortController().signal, toolUseID: "native-tool", decisionReason: "test" } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
  const card = entries.find(entry => entry.kind === "interaction"); if (!card || card.kind !== "interaction") throw new Error("Missing interaction");
  const response = provider.respond(card.interaction.interactionId, "1", { kind: "approval", action: "allow_once" });
  const rejected = expect(response).rejects.toThrow(/unknown/);
  await permission; fixture.end(); await rejected;
  expect(entries.filter(entry => entry.kind === "interaction").at(-1)).toMatchObject({ interaction: { state: "expired" } });
  await provider.close();
});

test("Claude native loss does not confirm a pending cancellation", async () => {
  const fixture = nativeFixture(), operationId = randomUUID();
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  await provider.send("run a tool", operationId, null);
  const cancellation = provider.cancel(operationId), rejected = expect(cancellation).rejects.toThrow(/unknown/);
  fixture.end(); await rejected; await provider.close();
});

test("Claude initializes its transport before the first prompt proves native session identity", async () => {
  const fixture = nativeFixture(), states: import("../../../src/commands/controller/providers/types.js").ProviderState[] = [];
  const original = sdk.query.getMockImplementation()!;
  sdk.query.mockImplementation((args: unknown) => ({ ...original(args), initializationResult: async () => ({}) }));
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: () => {}, onState: state => states.push(structuredClone(state)), onSpawn: () => {} });
  expect(states.at(-1)?.nativeSessionId).toBeNull();
  try {
    await provider.send("the sole initial input", randomUUID(), null);
    expect(states.at(-1)?.nativeSessionId).toBe(provider.nativeSessionId);
    fixture.emit({ type: "result", session_id: provider.nativeSessionId });
  } finally { await provider.close(); }
});

test("Claude blockwise assistant messages replace matching stream blocks without losing reasoning or duplicating text", async () => {
  const fixture = nativeFixture(), entries: ProviderEntry[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: entry => entries.push(entry), onState: () => {}, onSpawn: () => {} });
  try {
    fixture.emit({ type: "stream_event", event: { type: "message_start", message: { id: "native-message" } } });
    fixture.emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    fixture.emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reasoning" } } });
    fixture.emit({ type: "assistant", uuid: "thinking-uuid", message: { id: "native-message", content: [{ type: "thinking", thinking: "Reasoning" }] } });
    fixture.emit({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } });
    fixture.emit({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } } });
    fixture.emit({ type: "assistant", uuid: "text-uuid", message: { id: "native-message", content: [{ type: "text", text: "Answer" }] } });
    await new Promise(resolve => setImmediate(resolve));
    const projected = new Map(entries.map(entry => [entry.entryId, entry]));
    expect([...projected.values()].filter(entry => entry.kind === "reasoning")).toHaveLength(1);
    expect([...projected.values()].filter(entry => entry.kind === "assistant_message")).toHaveLength(1);
    expect(entries.filter(entry => entry.kind === "assistant_message").map(entry => entry.entryId)[0]).toBe(entries.filter(entry => entry.kind === "assistant_message").at(-1)?.entryId);
  } finally { await provider.close(); }
});

test("Claude displays dispatched text without claiming native input acceptance and merges a later echo", async () => {
  const fixture = nativeFixture(false), entries: ProviderEntry[] = [], observed: string[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: entry => entries.push(entry), onInputObserved: id => observed.push(id), onState: () => {}, onSpawn: () => {} });
  const operationId = randomUUID(); let acknowledged = false;
  const send = provider.send("first line\n第二行", operationId, null).then(result => { acknowledged = true; return result; });
  void send.catch(() => {});
  try {
    await new Promise(resolve => setImmediate(resolve));
    const submitted = entries.find(entry => entry.kind === "user_message");
    expect(submitted).toMatchObject({ kind: "user_message", content: [{ type: "text", text: "first line\n第二行" }] });
    expect(observed).toEqual([]); expect(acknowledged).toBe(false);
    fixture.emit({ type: "user", uuid: operationId, session_id: provider.nativeSessionId, message: { content: "first line\n第二行" } });
    await send;
    expect(observed).toEqual([operationId]);
    expect(new Set(entries.filter(entry => entry.kind === "user_message").map(entry => entry.entryId)).size).toBe(1);
  } finally { await provider.close(); await send.catch(() => {}); }
});

test.each([true, false])("Claude interrupt withdraws queued input from lifecycle or receipt without duplicate diagnostics (lifecycle=%s)", async lifecycle => {
  const messages: unknown[] = [], inputs: SDKUserMessage[] = []; let wake: (() => void) | undefined, ended = false, captured!: Options;
  const emit = (value: unknown) => { messages.push(value); wake?.(); };
  const interrupt = vi.fn(async (options?: { cancelQueued?: boolean }) => {
    expect(options).toEqual({ cancelQueued: true });
    if (lifecycle) emit({ type: "command_lifecycle", command_uuid: inputs[1]!.uuid, state: "cancelled" });
    emit({ type: "result", uuid: randomUUID(), user_message_uuid: inputs[0]!.uuid, is_error: false });
    return { cancelled: [inputs[1]!.uuid], still_queued: [] };
  });
  sdk.query.mockImplementation(({ options, prompt }: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) => {
    captured = options;
    void (async () => { for await (const user of prompt) { inputs.push(user); if (inputs.length === 1) emit({ ...user }); else emit({ type: "command_lifecycle", command_uuid: user.uuid, state: "queued" }); } })();
    return {
      async initializationResult() { await options.hooks!.SessionStart![0]!.hooks[0]!({ hook_event_name: "SessionStart", session_id: options.sessionId!, transcript_path: "", cwd: process.cwd(), source: "startup" }, undefined, { signal: new AbortController().signal }); emit({ type: "system", subtype: "init", session_id: options.sessionId!, model: "native-model", permissionMode: "default", capabilities: ["msg_lifecycle_v1", "interrupt_cancel_queued_v1"] }); return {}; },
      async *[Symbol.asyncIterator]() { while (!ended) { const value = messages.shift(); if (value) yield value; else await new Promise<void>(resolve => { wake = resolve; }); } },
      close() { ended = true; wake?.(); }, interrupt,
    };
  });
  const states: import("../../../src/commands/controller/providers/types.js").ProviderState[] = [], observed: string[] = [], entries: ProviderEntry[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onState: s => states.push(structuredClone(s)), onTimeline: e => entries.push(e), onSpawn: () => {}, onInputObserved: id => observed.push(id) });
  try {
    await vi.waitFor(() => expect(states.at(-1)?.capabilities.steer).toBe(true));
    const first = randomUUID(), second = randomUUID(); await provider.send("first", first, null);
    expect(states.at(-1)?.turnStartedAt).toBeNull();
    await expect(provider.send("steer", second, first)).resolves.toMatchObject({ disposition: "queued", turnId: first });
    expect(observed).toContain(second);
    emit({ type: "result", uuid: randomUUID(), user_message_uuid: second, is_error: false });
    await Promise.resolve(); expect(states.at(-1)?.currentTurnId).toBe(first);
    await provider.cancel(first); expect(states.at(-1)?.currentTurnId).toBeNull(); expect(interrupt).toHaveBeenCalledOnce();
    expect(captured.allowDangerouslySkipPermissions).toBe(true);
    expect(inputs).toHaveLength(2);
    expect(entries.filter(e => e.kind === "error" && e.code === "input_cancelled")).toHaveLength(1);
  } finally { await provider.close(); }
});


test.each(["aborted_streaming", "aborted_tools", "api_error", undefined])("Claude classifies only native-confirmed user interruption (%s)", async reason => {
  const fixture = nativeFixture(), entries: ProviderEntry[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try {
    const id = randomUUID(); await provider.send("work", id, null);
    let ack!: () => void;
    fixture.interrupt.mockImplementation(async () => {
      fixture.emit({ type: "result", uuid: "cancel-result", user_message_uuid: id, is_error: true, terminal_reason: reason, errors: ["native diagnostic"] });
      await new Promise<void>(resolve => { ack = resolve; });
      return {};
    });
    const cancel = provider.cancel(id);
    await new Promise(resolve => setImmediate(resolve));
    const aborted = reason === "aborted_streaming" || reason === "aborted_tools";
    expect(entries.some(e => e.kind === "error" && e.code === "turn_interrupted")).toBe(false);
    ack(); await cancel;
    expect(entries.filter(e => e.kind === "error").at(-1)).toMatchObject({ code: aborted ? "turn_interrupted" : "native_result_error" });
    await expect(provider.waitForTurn(id, Date.now() + 100)).rejects.toThrow(aborted ? "interrupted" : "failed");
  } finally { await provider.close(); }
});

test("Claude keeps aborted native results as errors when the interrupt receipt fails", async () => {
  const fixture = nativeFixture(), entries: ProviderEntry[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try {
    const id = randomUUID(); await provider.send("work", id, null);
    fixture.interrupt.mockImplementation(async () => {
      fixture.emit({ type: "result", uuid: "cancel-result", user_message_uuid: id, is_error: true, terminal_reason: "aborted_tools", errors: ["native diagnostic"] });
      await new Promise(resolve => setImmediate(resolve));
      throw new Error("Interrupt rejected");
    });
    await expect(provider.cancel(id)).rejects.toThrow("Interrupt rejected");
    expect(entries.filter(e => e.kind === "error").at(-1)).toMatchObject({ code: "native_result_error" });
  } finally { await provider.close(); }
});

test("Claude does not infer user interruption from aborted result without the exact requested UUID", async () => {
  const fixture = nativeFixture(), entries: ProviderEntry[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try {
    const id = randomUUID(); await provider.send("work", id, null);
    fixture.interrupt.mockImplementation(async () => {
      fixture.emit({ type: "result", uuid: "cancel-result", is_error: true, terminal_reason: "aborted_tools", errors: ["native diagnostic"] }); return {};
    });
    await provider.cancel(id);
    expect(entries.filter(e => e.kind === "error").at(-1)).toMatchObject({ code: "native_result_error" });
    const next = randomUUID(); await provider.send("next", next, null);
    fixture.emit({ type: "result", uuid: "other-result", user_message_uuid: next, is_error: true, terminal_reason: "aborted_tools", errors: ["native diagnostic"] });
    await new Promise(resolve => setImmediate(resolve));
    expect(entries.filter(e => e.kind === "error").at(-1)).toMatchObject({ code: "native_result_error" });
  } finally { await provider.close(); }
});
