import { textNativeInput } from "../../../src/commands/controller/providers/native-input.js";
import { test, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderEntry, ProviderOptions } from "../../../src/commands/controller/providers/types.js";
const historyOpen = vi.hoisted(() => vi.fn());
vi.mock("../../../src/commands/controller/providers/claude-transcript-helper.js", () => ({ openClaudeTranscriptHelper: historyOpen }));
const sdk = vi.hoisted(() => ({ query: vi.fn(), getSessionInfo: vi.fn(), getSessionMessages: vi.fn() }));
vi.mock("../../../src/commands/controller/providers/claude-live.js", async original => ({ ...await original<typeof import("../../../src/commands/controller/providers/claude-live.js")>(), queryClaudeLive: sdk.query }));
import { openClaudeProvider as openProvider } from "../../../src/commands/controller/providers/claude.js";
const openClaudeProvider = (options: ProviderOptions) => {
  const saved = new Map<string, unknown>();
  return openProvider({ imageRuntime: { getIntent: () => null, readState: key => saved.get(key) ?? null, writeState: (key, value) => { saved.set(key, structuredClone(value)); }, indexDirectory: () => "/private/test-index", reserveIndex() {}, acquireIndexReservation: () => ({ release() {} }), createSpool: () => { throw new Error("This controlled fixture has no image source."); } }, ...options });
};
const historyFixture = (nativeSessionId: string, messages: unknown[]) => ({
  snapshot: { nativeSessionId }, nextPage: async () => ({ done: true, cursor: "cursor", records: messages.map(message => ({ value: { ...message as object, session_id: nativeSessionId }, media: [], assistantBlockOffset: null })) }), acknowledge: async () => {}, close: async () => {},
});
import { startupFailure } from "../../../src/commands/controller/startup.js";
import { NativeRpcTimeoutError } from "../../../src/commands/controller/providers/native-rpc.js";

test.each(["reject", "timeout"])("Claude cleanup failure preserves the original startup %s without asserting stopped", async mode => {
  const failure = mode === "reject" ? Object.assign(new Error("Native initialization rejected"), { errorClass: "control_request_failed" }) : new NativeRpcTimeoutError("initialize");
  let wake: (() => void) | undefined, ended = false;
  sdk.query.mockImplementation(() => ({
    initializationResult: async () => { throw failure; },
    async *[Symbol.asyncIterator]() { if (!ended) await new Promise<void>(resolve => { wake = resolve; }); },
    close() { ended = true; wake?.(); throw new Error("Fixture cleanup failed"); },
  }));
  const activities: string[] = [], diagnostics: string[] = [];
  const error = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    onTimeline: () => {}, onState: state => activities.push(state.activity), onSpawn: () => {}, onDiagnostic: message => diagnostics.push(message),
  }).catch(error => error);
  expect(startupFailure(error)).toEqual(mode === "reject" ? { state: "failed", reasonCode: "native_rejected" } : { state: "unknown", reasonCode: "native_timeout" });
  expect(diagnostics.some(message => /stop|cleanup/i.test(message))).toBe(true);
  expect(activities).not.toContain("stopped");
});

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
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], instructions: "Keep the native approval policy.", resumeNativeSessionId: null, onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try {
    await provider.send(textNativeInput("run a tool"), randomUUID(), null);
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
  historyOpen.mockImplementation(async options => {
    const info = await sdk.getSessionInfo(options.nativeSessionId, { dir: options.cwd });
    if (!info || info.sessionId !== options.nativeSessionId) throw new Error("Claude history identity is unavailable.");
    return historyFixture(options.nativeSessionId, await sdk.getSessionMessages(options.nativeSessionId));
  });
  const interrupt = vi.fn(async (): Promise<unknown> => ({}));
  let captured!: Options, wake: (() => void) | undefined, ended = false, failure: Error | undefined;
  const messages: unknown[] = [], inputs: SDKUserMessage[] = [];
  const emit = (message: unknown) => { messages.push(message); wake?.(); };
  sdk.query.mockImplementation(({ options, prompt }: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) => {
    captured = options;
    void (async () => { for await (const user of prompt) { inputs.push(user); if (echo) emit(user); } })();
    return {
      async initializationResult() {
        await options.hooks!.SessionStart![0]!.hooks[0]!({ hook_event_name: "SessionStart", session_id: options.sessionId ?? options.resume!, transcript_path: "", cwd: process.cwd(), source: "startup" }, undefined, { signal: new AbortController().signal });
        return {};
      },
      async *[Symbol.asyncIterator]() { while (!ended) { const message = messages.shift(); if (message) yield message; else await new Promise<void>(resolve => { wake = resolve; }); } if (failure) throw failure; },
      close() { ended = true; wake?.(); }, interrupt,
    };
  });
  return { emit, interrupt, inputs, options: () => captured, end(error?: Error) { failure = error; ended = true; wake?.(); } };
};
test("Claude provider retries failed native resource cleanup without requesting another native stop", async () => {
  nativeFixture(); const activities: string[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline() {}, onState: state => activities.push(state.activity), onSpawn() {} });
  const native = sdk.query.mock.results.at(-1)!.value, originalClose = native.close;
  native.close = vi.fn(originalClose); let unavailable = true;
  native.join = vi.fn(async () => { if (unavailable) throw new Error("Native media cleanup failed after stop."); });
  await expect(provider.close()).rejects.toThrow("cleanup failed"); expect(activities).not.toContain("stopped");
  unavailable = false;
  await expect(provider.close()).resolves.toBeUndefined();
  expect(activities.at(-1)).toBe("stopped"); expect(native.close).toHaveBeenCalledOnce(); expect(native.join).toHaveBeenCalledTimes(2);
});

test("Claude provider cannot report stopped while native stop proof remains unknown across close retries", async () => {
  nativeFixture(); const activities: string[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline() {}, onState: state => activities.push(state.activity), onSpawn() {} });
  const native = sdk.query.mock.results.at(-1)!.value;
  native.join = async () => { throw new Error("Native process stop remains unconfirmed."); };
  await expect(provider.close()).rejects.toThrow("unconfirmed");
  await expect(provider.close()).rejects.toThrow("unconfirmed");
  expect(activities).not.toContain("stopped");
});

test("a failed helper submission disconnects without replay or a retained acceptance waiter", async () => {
  const fixture = nativeFixture(), fatal = vi.fn(), observed = vi.fn(), states: unknown[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline() {}, onState: state => states.push(state), onSpawn() {}, onFatalError: fatal, onInputObserved: observed });
  const native = sdk.query.mock.results.at(-1)!.value, submit = vi.fn(async () => { throw new Error("Transport response lost."); }); native.submit = submit;
  try {
    await expect(provider.send(textNativeInput("work"), randomUUID(), null)).rejects.toThrow("response lost");
    expect(fatal).toHaveBeenCalledOnce(); expect(states.at(-1)).toMatchObject({ activity: "unknown", currentTurnId: null, capabilities: { send: false } });
    await expect(provider.send(textNativeInput("work"), randomUUID(), null)).rejects.toThrow("session state");
    expect(submit).toHaveBeenCalledOnce(); expect(observed).not.toHaveBeenCalled(); expect(fixture.inputs).toEqual([]);
  } finally { await provider.close(); }
});
test("new Claude selection cannot pass startup when native effective settings are unknown", async () => {
  const fixture = nativeFixture();
  const result = await openClaudeProvider({ cwd: process.cwd(), model: "sonnet", args: [], resumeNativeSessionId: null, validateNativeSelection: true, onTimeline: () => {}, onState: () => {}, onSpawn: () => {} }).then(provider => ({ provider, error: null }), error => ({ provider: null, error }));
  try { expect(result.error).toBeInstanceOf(Error); expect(result.error.message).toContain("unknown"); expect(fixture.inputs).toEqual([]); }
  finally { await result.provider?.close(); fixture.end(); }
});

test.each([
  { name: "Bash", input: { command: 'printf "first\\nsecond"', description: "Print two lines", timeout: 0, run_in_background: false }, detail: 'printf "first\\nsecond"\ndescription: Print two lines\ntimeout: 0\nrun_in_background: false' },
  { name: "Write", input: { file_path: "/tmp/review.ts", content: 'const value = "first";\nconsole.log(value);\n', encoding: "utf8" }, detail: 'file_path: /tmp/review.ts\nencoding: utf8\n\nContent:\nconst value = "first";\nconsole.log(value);\n' },
  { name: "Write", input: { file_path: "/tmp/empty", content: "", extra: null }, detail: 'file_path: /tmp/empty\nextra: null\n\nContent:\n' },
  { name: "Edit", input: { file_path: "/tmp/review.ts", old_string: 'one\n"two"', new_string: "", replace_all: false }, detail: 'file_path: /tmp/review.ts\nreplace_all: false\n\nBefore:\none\n"two"\n\nAfter:\n' },
  { name: "MultiEdit", input: { file_path: "/tmp/review.ts", edits: [{ old_string: "one\ntwo", new_string: "three", replace_all: true }, { old_string: "", new_string: '"four"', extra: null }], extension: [] }, detail: 'file_path: /tmp/review.ts\nextension: []\nEdit 1 replace_all: true\nEdit 2 extra: null\n\nEdit 1\nBefore:\none\ntwo\n\nAfter:\nthree\n\nEdit 2\nBefore:\n\n\nAfter:\n"four"' },
  { name: "CustomTool", input: { text: 'first\n"second"', empty: "", zero: 0, enabled: false, absent: null, options: { nested: ["value", 1] } }, detail: 'text: first\n"second"\nempty: \nzero: 0\nenabled: false\nabsent: null\noptions: {"nested":["value",1]}' },
  { name: "Write", input: { file_path: "/tmp/review.ts", content: null }, detail: '{\n  "file_path": "/tmp/review.ts",\n  "content": null\n}' },
  { name: "MultiEdit", input: { file_path: "/tmp/review.ts", edits: [{ old_string: "one", new_string: 2 }] }, detail: '{\n  "file_path": "/tmp/review.ts",\n  "edits": [\n    {\n      "old_string": "one",\n      "new_string": 2\n    }\n  ]\n}' },
])("Claude $name approval preserves readable tool input", async ({ name, input, detail }) => {
  const fixture = nativeFixture(), entries: ProviderEntry[] = [], abort = new AbortController();
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: entry => entries.push(entry), onState: () => {}, onSpawn: () => {} });
  const permission = fixture.options().canUseTool!(name, input, { signal: abort.signal, toolUseID: "native-tool", decisionReason: "test" } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
  const expired = expect(permission).rejects.toThrow("expired");
  try {
    expect(entries.find(entry => entry.kind === "interaction")).toMatchObject({ interaction: { kind: "approval", title: `Approve ${name}`, detail, actions: ["allow_once", "reject"] } });
  } finally { abort.abort(); await expired; await provider.close(); }
});

test("Claude long Write approval retains metadata before truncating content at a Unicode boundary", async () => {
  const fixture = nativeFixture(), entries: ProviderEntry[] = [], abort = new AbortController();
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: entry => entries.push(entry), onState: () => {}, onSpawn: () => {} });
  const prefix = "file_path: /tmp/large\nmode: overwrite\n\nContent:\n";
  const permission = fixture.options().canUseTool!("Write", { file_path: "/tmp/large", content: "x".repeat(199_999 - prefix.length) + "😀tail", mode: "overwrite" }, { signal: abort.signal, toolUseID: "native-tool", decisionReason: "test" } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
  const expired = expect(permission).rejects.toThrow("expired");
  try {
    const card = entries.find(entry => entry.kind === "interaction");
    if (card?.kind !== "interaction" || card.interaction.kind !== "approval") throw new Error("Missing approval");
    expect(card.interaction.detail.startsWith(prefix)).toBe(true);
    expect(card.interaction.detail.slice(prefix.length, 199_999).replaceAll("x", "")).toBe("");
    expect(card.interaction.detail.slice(199_999)).toBe("\n[Output truncated at 200000 characters]");
    expect(card.interaction.detail.isWellFormed()).toBe(true);
  } finally { abort.abort(); await expired; await provider.close(); }
});

test.each(["allow_once", "reject"] as const)("Claude formatted approval leaves native %s behavior unchanged", async action => {
  const fixture = nativeFixture(), entries: ProviderEntry[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: entry => entries.push(entry), onState: () => {}, onSpawn: () => {} });
  const input = { file_path: "/tmp/review.ts", content: 'first\n"second"\n' };
  try {
    const permission = fixture.options().canUseTool!("Write", input, { signal: new AbortController().signal, toolUseID: "native-tool", decisionReason: "test" } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
    const card = entries.find(entry => entry.kind === "interaction");
    if (card?.kind !== "interaction") throw new Error("Missing approval");
    const response = provider.respond(card.interaction.interactionId, "1", { kind: "approval", action });
    const result = await permission;
    if (action === "allow_once") { if (result?.behavior !== "allow") throw new Error("Missing native allow result"); expect(result.updatedInput).toBe(input); }
    else expect(result).toEqual({ behavior: "deny", message: "User rejected this operation." });
    expect(entries.filter(entry => entry.kind === "interaction").at(-1)).toMatchObject({ interaction: { state: "pending" } });
    fixture.emit({ type: "user", uuid: randomUUID(), session_id: provider.nativeSessionId, message: { content: [{ type: "tool_result", tool_use_id: "native-tool", content: action === "allow_once" ? "Written" : "Rejected", is_error: action === "reject" }] } });
    await expect(response).resolves.toEqual({ disposition: "handled" });
  } finally { await provider.close(); }
});

test.each([false, true])("Claude disables control and rejects unconfirmed input when the native iterator ends (error=%s)", async error => {
  const fatal: Error[] = [];
  const fixture = nativeFixture(false), states: import("../../../src/commands/controller/providers/types.js").ProviderState[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], instructions: "Keep uncertain input unknown.", resumeNativeSessionId: null, onTimeline: () => {}, onState: state => states.push(structuredClone(state)), onSpawn: () => {}, onFatalError: error => fatal.push(error) });
  const send = provider.send(textNativeInput("uncertain input"), randomUUID(), null);
  const rejection = expect(send).rejects.toThrow(/unknown|ended|connection/i);
  fixture.end(error ? new Error("lost native pipe") : undefined);
  await rejection;
  expect(states.at(-1)).toMatchObject({ activity: "unknown", capabilities: { send: false, steer: false, cancel: false, respond: false } });
  await expect(provider.send(textNativeInput("must not replay"), randomUUID(), null)).rejects.toThrow();
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
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: nativeId, onInputObserved: id => observed.push(typeof id === "string" ? id : id.operationId), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  try {
    const operationId = randomUUID(); await provider.send(textNativeInput("new input"), operationId, null);
    fixture.emit({ type: "user", uuid: toolInput, message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "output" }] } });
    await new Promise(resolve => setImmediate(resolve));
    expect(observed).toEqual([oldInput, operationId]);
  } finally { await provider.close(); }
});


test("Claude resume reads the private native home without changing the parent environment", async () => {
  nativeFixture(); const nativeId = randomUUID(), observed: string[] = [], operationId = randomUUID();
  const parentHome = process.env.CLAUDE_CONFIG_DIR;
  historyOpen.mockImplementation(async options => {
    expect(options.nativeHome).toBe("/private/isolated-claude-home");
    return historyFixture(nativeId, [{ type: "user", uuid: operationId, message: { content: "accepted before restart" } }]);
  });
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], env: { ...process.env, CLAUDE_CONFIG_DIR: "/private/isolated-claude-home" }, resumeNativeSessionId: nativeId, onInputObserved: id => observed.push(typeof id === "string" ? id : id.operationId), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  expect(observed).toEqual([operationId]); expect(process.env.CLAUDE_CONFIG_DIR).toBe(parentHome);
  await provider.close();
});

test.each(["error", "wrong_identity", "invalid_json"])("Claude fails closed on private history reader %s", async failure => {
  nativeFixture(); sdk.query.mockClear(); const nativeId = randomUUID();
  historyOpen.mockImplementation(async () => { throw new Error(`Claude history ${failure} rejected.`); });
  await expect(openClaudeProvider({ cwd: process.cwd(), model: null, args: [], env: { ...process.env, CLAUDE_CONFIG_DIR: "/private/isolated-claude-home" }, resumeNativeSessionId: nativeId, onTimeline: () => {}, onState: () => {}, onSpawn: () => {} })).rejects.toThrow(/history/);
  expect(sdk.query).not.toHaveBeenCalled();
});

test("Claude native loss expires an approval without confirming its submitted response", async () => {
  const fixture = nativeFixture(), entries: ProviderEntry[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: entry => entries.push(entry), onState: () => {}, onSpawn: () => {} });
  await provider.send(textNativeInput("run a tool"), randomUUID(), null);
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
  await provider.send(textNativeInput("run a tool"), operationId, null);
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
    await provider.send(textNativeInput("the sole initial input"), randomUUID(), null);
    expect(states.at(-1)?.nativeSessionId).toBe(provider.nativeSessionId);
    fixture.emit({ type: "result", session_id: provider.nativeSessionId });
  } finally { await provider.close(); }
});

test("Claude cannot start native transport after a dispatch fence", async () => {
  nativeFixture(); const failure = new Error("accounting failure"); sdk.query.mockClear();
  await expect(openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    onTimeline: () => {}, onState: () => {}, onSpawn: () => {}, assertNativeDispatch: () => { throw failure; },
  })).rejects.toBe(failure);
  expect(sdk.query).not.toHaveBeenCalled();
});

test("Claude cannot submit input when the working-state callback fences dispatch", async () => {
  const fixture = nativeFixture(), failure = new Error("accounting failure"); let fenced = false;
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    onTimeline: () => {}, onState: state => { if (state.activity === "working") fenced = true; }, onSpawn: () => {},
    assertNativeDispatch: () => { if (fenced) throw failure; },
  });
  try {
    await expect(provider.send(textNativeInput("must not dispatch"), randomUUID(), null)).rejects.toBe(failure);
    expect(fixture.inputs).toEqual([]);
  } finally { await provider.close(); }
});

test("Claude first input defers provenance until delayed native identity is verified", async () => {
  const fixture = nativeFixture(false), entries: ProviderEntry[] = [], associations: { operationId: string; nativeSessionId: string; observedNativeId: string | null }[] = [];
  const original = sdk.query.getMockImplementation()!;
  sdk.query.mockImplementation((args: unknown) => ({ ...original(args), initializationResult: async () => ({}) }));
  let observedNativeId: string | null = null;
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    onTimeline: entry => entries.push(entry), onState: state => { observedNativeId = state.nativeSessionId; }, onSpawn() {},
    onInputMessage: (operationId, nativeSessionId) => { associations.push({ operationId, nativeSessionId, observedNativeId }); },
  });
  const operationId = randomUUID();
  const sending = provider.send(textNativeInput("first Daynight input"), operationId, null).then(result => ({ result }), error => ({ error }));
  try {
    await vi.waitFor(() => expect(entries.some(entry => entry.kind === "user_message")).toBe(true));
    expect(observedNativeId).toBeNull();
    expect(associations).toEqual([]);
    fixture.emit({ type: "user", uuid: operationId, session_id: provider.nativeSessionId, message: { content: "first Daynight input" } });
    expect(await sending).toMatchObject({ result: { disposition: "started", turnId: operationId } });
    expect(associations.length).toBeGreaterThan(0);
    expect(associations.every(item => item.operationId === operationId && item.nativeSessionId === provider.nativeSessionId && item.observedNativeId === provider.nativeSessionId)).toBe(true);
    expect(fixture.inputs).toHaveLength(1);
  } finally { await provider.close(); await sending; }
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
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: entry => entries.push(entry), onInputObserved: id => observed.push(typeof id === "string" ? id : id.operationId), onState: () => {}, onSpawn: () => {} });
  const operationId = randomUUID(); let acknowledged = false;
  const send = provider.send(textNativeInput("first line\n第二行"), operationId, null).then(result => { acknowledged = true; return result; });
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
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onState: s => states.push(structuredClone(s)), onTimeline: e => entries.push(e), onSpawn: () => {}, onInputObserved: id => observed.push(typeof id === "string" ? id : id.operationId) });
  try {
    await vi.waitFor(() => expect(states.at(-1)?.capabilities.steer).toBe(true));
    const first = randomUUID(), second = randomUUID(); await provider.send(textNativeInput("first"), first, null);
    expect(states.at(-1)?.turnStartedAt).toBeNull();
    await expect(provider.send(textNativeInput("steer"), second, first)).resolves.toMatchObject({ disposition: "queued", turnId: first });
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
    const id = randomUUID(); await provider.send(textNativeInput("work"), id, null);
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
    const id = randomUUID(); await provider.send(textNativeInput("work"), id, null);
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
    const id = randomUUID(); await provider.send(textNativeInput("work"), id, null);
    fixture.interrupt.mockImplementation(async () => {
      fixture.emit({ type: "result", uuid: "cancel-result", is_error: true, terminal_reason: "aborted_tools", errors: ["native diagnostic"] }); return {};
    });
    await provider.cancel(id);
    expect(entries.filter(e => e.kind === "error").at(-1)).toMatchObject({ code: "native_result_error" });
    const next = randomUUID(); await provider.send(textNativeInput("next"), next, null);
    fixture.emit({ type: "result", uuid: "other-result", user_message_uuid: next, is_error: true, terminal_reason: "aborted_tools", errors: ["native diagnostic"] });
    await new Promise(resolve => setImmediate(resolve));
    expect(entries.filter(e => e.kind === "error").at(-1)).toMatchObject({ code: "native_result_error" });
  } finally { await provider.close(); }
});

test.each([false, true])("Claude only gives a new unattended Worker session full access (worker=%s)", async unattended => {
  const fixture = nativeFixture();
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, unattended, onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  try {
    expect(fixture.options().permissionMode).toBe(unattended ? "bypassPermissions" : "default");
    expect(fixture.options().sandbox).toEqual(unattended ? { enabled: false } : undefined);
  } finally { await provider.close(); }
});


test("Claude Worker resume preserves native permission and sandbox settings", async () => {
  const fixture = nativeFixture(), nativeId = randomUUID();
  sdk.getSessionInfo.mockResolvedValue({ sessionId: nativeId, cwd: process.cwd() }); sdk.getSessionMessages.mockResolvedValue([]);
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: nativeId, unattended: true, onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  try { expect(fixture.options().permissionMode).toBeUndefined(); expect(fixture.options().sandbox).toBeUndefined(); }
  finally { await provider.close(); }
});


test.each([false, true])("Claude appends the role without creating user input or replacing native settings (resume=%s)", async resume => {
  const fixture = nativeFixture(), nativeId = randomUUID(), entries: ProviderEntry[] = [];
  const instructions = "  Daynight 助手\nPreserve e\u0301 and native permissions.  ";
  sdk.getSessionInfo.mockResolvedValue({ sessionId: nativeId, cwd: process.cwd() });
  sdk.getSessionMessages.mockResolvedValue([]);
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: "selected-model", args: ["--effort", "high"], instructions, resumeNativeSessionId: resume ? nativeId : null, onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try {
    expect(fixture.options().systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: instructions });
    expect(fixture.options().model).toBe(resume ? undefined : "selected-model");
    expect(fixture.options().effort).toBe(resume ? undefined : "high");
    expect(fixture.options().permissionMode).toBe(resume ? undefined : "default");
    expect(fixture.options().sandbox).toBeUndefined();
    expect(fixture.options().settingSources).toEqual(["user", "project", "local"]);
    expect(fixture.options().resume).toBe(resume ? nativeId : undefined);
    expect(fixture.options().sessionId).toBe(resume ? undefined : provider.nativeSessionId);
    if (resume) expect(provider.nativeSessionId).toBe(nativeId);
    expect(fixture.inputs).toEqual([]);
    expect(entries).toEqual([]);
    const operationId = randomUUID();
    await provider.send(textNativeInput("The first actual request"), operationId, null);
    expect(fixture.inputs).toHaveLength(1);
    expect(fixture.inputs[0]).toMatchObject({ uuid: operationId, session_id: provider.nativeSessionId, message: { role: "user", content: "The first actual request" } });
  } finally { await provider.close(); }
  await expect(provider.send(textNativeInput("after close"), randomUUID(), null)).rejects.toThrow(/cannot accept/);
});

test.each([false, true])("Claude omits role configuration when absent (resume=%s)", async resume => {
  const fixture = nativeFixture(), nativeId = randomUUID();
  sdk.getSessionInfo.mockResolvedValue({ sessionId: nativeId, cwd: process.cwd() });
  sdk.getSessionMessages.mockResolvedValue([]);
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: resume ? nativeId : null, onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  try { expect(fixture.options()).not.toHaveProperty("systemPrompt"); expect(fixture.options()).not.toHaveProperty("model"); }
  finally { await provider.close(); }
});

test.each([false, true])("Claude propagates role startup failure and closes initialized SDK resources (query throws=%s)", async queryThrows => {
  const fixture = nativeFixture(), original = sdk.query.getMockImplementation()!;
  const failure = new Error("Native role initialization rejected"), close = vi.fn();
  sdk.query.mockImplementation((args: unknown) => {
    if (queryThrows) throw failure;
    const native = original(args);
    close.mockImplementation(() => native.close());
    return { ...native, close, initializationResult: async () => { throw failure; } };
  });
  const entries: ProviderEntry[] = [];
  await expect(openClaudeProvider({ cwd: process.cwd(), model: null, args: [], instructions: "Daynight role", resumeNativeSessionId: null, onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} })).rejects.toBe(failure);
  expect(close).toHaveBeenCalledTimes(queryThrows ? 0 : 1);
  expect(fixture.inputs).toEqual([]);
  expect(entries).toEqual([]);
});

test.each([
  ["[Request interrupted by user]", "aborted_streaming"],
  ["[Request interrupted by user for tool use]", "aborted_tools"],
])("Claude hides native interruption text %s and reuses its identity on resume", async (text, reason) => {
  const fixture = nativeFixture(), entries: ProviderEntry[] = [], observed: string[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: entry => entries.push(entry), onInputObserved: id => observed.push(typeof id === "string" ? id : id.operationId), onState: () => {}, onSpawn: () => {} });
  const id = randomUUID(), markerId = randomUUID();
  // Native interruption messages omit isSynthetic, including in SDK history.
  const marker = { type: "user", uuid: markerId, message: { content: [{ type: "text", text }] } };
  try {
    await provider.send(textNativeInput("work"), id, null);
    let acknowledge!: () => void;
    fixture.interrupt.mockImplementation(async () => {
      fixture.emit(marker);
      fixture.emit({ type: "result", uuid: randomUUID(), user_message_uuid: id, is_error: true, terminal_reason: reason });
      await new Promise<void>(resolve => { acknowledge = resolve; });
      return {};
    });
    const cancel = provider.cancel(id);
    await new Promise(resolve => setImmediate(resolve));
    const beforeReceipt = [...entries];
    acknowledge(); await cancel;
    expect(beforeReceipt.filter(entry => entry.kind === "user_message").every(entry => JSON.stringify(entry).includes('"work"'))).toBe(true);
    expect(observed).toEqual([id]);
    expect(beforeReceipt.filter(entry => entry.kind === "error")).toEqual([]);
    expect(entries.filter(entry => entry.kind === "error")).toEqual([expect.objectContaining({ code: "turn_interrupted" })]);
  } finally { await provider.close(); }
  const liveMarker = entries.find(entry => entry.kind === "error");
  nativeFixture();
  sdk.getSessionInfo.mockResolvedValue({ sessionId: provider.nativeSessionId, cwd: process.cwd() });
  sdk.getSessionMessages.mockResolvedValue([{ type: "user", uuid: id, message: { content: "work" } }, marker]);
  const history: ProviderEntry[] = [], historyObserved: string[] = [];
  const resumed = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: provider.nativeSessionId, onTimeline: entry => history.push(entry), onInputObserved: id => historyObserved.push(typeof id === "string" ? id : id.operationId), onState: () => {}, onSpawn: () => {} });
  try {
    expect(history.filter(entry => entry.kind === "error")).toEqual([liveMarker]);
    expect(history.filter(entry => entry.kind === "user_message")).toHaveLength(1);
    expect(historyObserved).toEqual([id]);
  } finally { await resumed.close(); }
});

test.each([false, true])("Claude preserves ordinary text and tool results around interruption-like content (history=%s)", async history => {
  const fixture = nativeFixture(), nativeId = randomUUID(), entries: ProviderEntry[] = [];
  const marker = "[Request interrupted by user]";
  const messages = [
    { type: "user", uuid: randomUUID(), message: { content: `Explain ${marker}` } },
    { type: "user", uuid: randomUUID(), isSynthetic: true, message: { content: `${marker}\n` } },
    { type: "user", uuid: randomUUID(), message: { content: [{ type: "text", text: marker }, { type: "text", text: "quoted example" }] } },
    { type: "user", uuid: randomUUID(), message: { content: [{ type: "tool_result", tool_use_id: "tool", content: marker, is_error: true }] } },
    { type: "assistant", uuid: randomUUID(), message: { content: marker } },
  ];
  sdk.getSessionInfo.mockResolvedValue({ sessionId: nativeId, cwd: process.cwd() });
  sdk.getSessionMessages.mockResolvedValue(messages);
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: history ? nativeId : null, onTimeline: entry => entries.push(entry), onState: () => {}, onSpawn: () => {} });
  try {
    if (!history) { for (const message of messages) fixture.emit(message); await new Promise(resolve => setImmediate(resolve)); }
    expect(entries.filter(entry => entry.kind === "user_message")).toHaveLength(3);
    expect(entries.flatMap(entry => entry.kind === "user_message" ? entry.content.map(part => part.type === "text" ? part.text : "") : [])).toEqual([`Explain ${marker}`, `${marker}\n`, marker, "quoted example"]);
    expect(entries.filter(entry => entry.kind === "assistant_message")).toHaveLength(1);
    expect(entries.filter(entry => entry.kind === "tool_call")).toEqual([expect.objectContaining({ status: "failed", output: [{ type: "text", text: marker }] })]);
    expect(entries.filter(entry => entry.kind === "error")).toEqual([]);
  } finally { await provider.close(); }
});

test.each(["[Request interrupted by user]", "[Request interrupted by user for tool use]"])("Claude projects string-form historical interruption %s without a live receipt", async text => {
  nativeFixture(); const nativeId = randomUUID(), entries: ProviderEntry[] = [], observed: string[] = [];
  sdk.getSessionInfo.mockResolvedValue({ sessionId: nativeId, cwd: process.cwd() });
  sdk.getSessionMessages.mockResolvedValue([{ type: "user", uuid: randomUUID(), message: { content: text } }]);
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: nativeId, onTimeline: entry => entries.push(entry), onInputObserved: id => observed.push(typeof id === "string" ? id : id.operationId), onState: () => {}, onSpawn: () => {} });
  try { expect(entries).toEqual([expect.objectContaining({ kind: "error", code: "turn_interrupted" })]); expect(observed).toEqual([]); }
  finally { await provider.close(); }
});

test("Claude subagent interruption does not replace the main turn marker identity", async () => {
  const fixture = nativeFixture(), entries: ProviderEntry[] = [], id = randomUUID(), mainMarker = randomUUID();
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, onTimeline: entry => entries.push(entry), onState: () => {}, onSpawn: () => {} });
  try {
    await provider.send(textNativeInput("work"), id, null);
    fixture.interrupt.mockImplementation(async () => {
      fixture.emit({ type: "user", uuid: mainMarker, message: { content: "[Request interrupted by user]" } });
      fixture.emit({ type: "user", uuid: randomUUID(), parent_tool_use_id: "child-tool", message: { content: "[Request interrupted by user for tool use]" } });
      fixture.emit({ type: "result", uuid: randomUUID(), user_message_uuid: id, is_error: true, terminal_reason: "aborted_streaming" });
      return {};
    });
    await provider.cancel(id);
    expect(entries.filter(entry => entry.kind === "user_message").every(entry => JSON.stringify(entry).includes('"work"'))).toBe(true);
    const { nativeEntryId } = await import("../../../src/commands/controller/providers/projection.js");
    expect(entries.filter(entry => entry.kind === "error")).toEqual([expect.objectContaining({ code: "turn_interrupted", entryId: nativeEntryId(provider.nativeSessionId, `${mainMarker}:0`) })]);
  } finally { await provider.close(); }
});

test("Claude native text and thinking become complete only at a block stop or completed SDK block", async () => {
  const fixture = nativeFixture(), events: { entry: ProviderEntry; metadata: unknown }[] = [];
  const provider = await openClaudeProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    onTimeline: (entry, metadata) => events.push({ entry, metadata }), onState: () => {}, onSpawn: () => {} });
  const stream = (event: unknown) => fixture.emit({ type: "stream_event", session_id: provider.nativeSessionId, event });
  try {
    stream({ type: "message_start", message: { id: "message" } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "![image](local)" } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.metadata).toEqual({ complete: false, format: "markdown", truncated: false });
    stream({ type: "content_block_stop", index: 0 });
    fixture.emit({ type: "assistant", uuid: "assistant-body", session_id: provider.nativeSessionId, message: { id: "message", content: [{ type: "text", text: "![image](local)" }] } });
    fixture.emit({ type: "assistant", uuid: "assistant-thought", session_id: provider.nativeSessionId, message: { id: "message", content: [{ type: "thinking", thinking: "reason" }] } });
    fixture.emit({ type: "user", uuid: "tool-result", session_id: provider.nativeSessionId, message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "![raw](local)" }] } });
    await vi.waitFor(() => expect(events).toHaveLength(5));
    expect(events.slice(1).map(event => event.metadata)).toEqual([
      { complete: true, format: "markdown", truncated: false }, { complete: true, format: "markdown", truncated: false }, { complete: true, format: "markdown", truncated: false }, { complete: true, format: "plain", truncated: false },
    ]);
    expect(events[0]!.entry.entryId).toBe(events[1]!.entry.entryId); expect(events[1]!.entry.entryId).toBe(events[2]!.entry.entryId);
  } finally { await provider.close(); }
});
