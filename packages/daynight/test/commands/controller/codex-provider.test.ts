import { textNativeInput } from "../../../src/commands/controller/providers/native-input.js";
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import type { ProviderOptions, ProviderState } from "../../../src/commands/controller/providers/types.js";

let nativeHome: string;
beforeEach(async () => { const base = join(process.cwd(), ".tmp"); await mkdir(base, { recursive: true }); nativeHome = await mkdtemp(join(base, "codex-provider-home-")); vi.stubEnv("CODEX_HOME", nativeHome); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(nativeHome, { recursive: true, force: true }); });

test.each(["", "Inspect this change"])("Codex dispatches a discovered skill with arguments %j", async args => {
  const log = join(nativeHome, "requests.jsonl"), skillPath = join(nativeHome, "review", "SKILL.md"), states: ProviderState[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    env: { ...process.env, CODEX_TEST_REQUEST_LOG: log, CODEX_TEST_SKILLS: JSON.stringify([{ cwd: process.cwd(), skills: [{ name: "review", path: skillPath, enabled: true }] }]) },
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: state => states.push(state), onSpawn: () => {} });
  try {
    const controls = states.at(-1)!.controls!, command = controls.commands.find(value => value.name === "review")!, operationId = randomUUID();
    const receipt = await provider.executeCommand!(command.id, args, operationId, controls.revision, null);
    await provider.waitForTurn(receipt.turnId!, Date.now() + 1000);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const inputs = requests.filter(request => ["turn/start", "turn/steer"].includes(request.method));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ method: "turn/start", params: { clientUserMessageId: operationId, input: [
      { type: "text", text: args, text_elements: [] }, { type: "skill", name: "review", path: skillPath },
    ] } });
  } finally { await provider.close(); }
});

test("Codex rejects an empty ordinary message before native dispatch", async () => {
  const log = join(nativeHome, "requests.jsonl");
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    env: { ...process.env, CODEX_TEST_REQUEST_LOG: log },
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  try {
    await expect(provider.send(textNativeInput(""), randomUUID(), null)).rejects.toThrow("Native input is empty");
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(request => ["turn/start", "turn/steer"].includes(request.method))).toEqual([]);
  } finally { await provider.close(); }
});

test("Codex preserves an accounting error raised at the native send boundary", async () => {
  const log = join(nativeHome, "requests.jsonl");
  const { SqliteAccessError } = await import("../../../src/platform/sqlite-error.js");
  const failure = new SqliteAccessError("invalid-format", { database: "controller-journal", phase: "outbox-read" }, { outcome: "rolled-back" });
  let fenced = false;
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    env: { ...process.env, CODEX_TEST_REQUEST_LOG: log },
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {}, onSpawn: () => {},
    assertNativeDispatch: () => { if (fenced) throw failure; },
  });
  try {
    fenced = true;
    await expect(provider.send(textNativeInput("must not dispatch"), randomUUID(), null)).rejects.toBe(failure);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(request => ["turn/start", "turn/steer"].includes(request.method))).toEqual([]);
  } finally { await provider.close(); }
});

test.each([null, "native-thread"])("Codex startup does not start or resume a thread after its spawn callback fences dispatch (resume=%s)", async resumeNativeSessionId => {
  const log = join(nativeHome, "requests.jsonl"), failure = new Error("accounting failure"); let fenced = false;
  const opening = openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId,
    env: { ...process.env, CODEX_TEST_REQUEST_LOG: log },
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {},
    onSpawn: () => { fenced = true; }, assertNativeDispatch: () => { if (fenced) throw failure; },
  });
  await expect(opening).rejects.toBe(failure);
  const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(requests.filter(request => ["thread/start", "thread/resume"].includes(request.method))).toEqual([]);
});

test("Codex startup does not persist settings after its seeded state fences dispatch", async () => {
  const log = join(nativeHome, "requests.jsonl"), failure = new Error("accounting failure"); let fenced = false;
  const opening = openCodexProvider({ cwd: process.cwd(), model: "selected-model", args: [], resumeNativeSessionId: null,
    env: { ...process.env, CODEX_TEST_REQUEST_LOG: log },
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onSpawn: () => {},
    onState: state => { if (state.nativeSessionId && state.controls) fenced = true; },
    assertNativeDispatch: () => { if (fenced) throw failure; },
  });
  await expect(opening).rejects.toBe(failure);
  const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(requests.filter(request => request.method === "thread/start")).toHaveLength(1);
  expect(requests.filter(request => request.method === "thread/settings/update")).toEqual([]);
});

test("Codex startup waits past an empty settings acknowledgement until the matching native record is complete", async () => {
  const log = join(nativeHome, "requests.jsonl"), rollout = join(nativeHome, "sessions", "rollout.jsonl"), states: ProviderState[] = [];
  let resolved = false, provider: Awaited<ReturnType<typeof openCodexProvider>> | undefined;
  let child: import("node:child_process").ChildProcess | undefined;
  const opening = openCodexProvider({ cwd: process.cwd(), model: "selected-model", args: ["--effort", "high"], resumeNativeSessionId: null,
    env: { ...process.env, CODEX_TEST_REQUEST_LOG: log, CODEX_TEST_ROLLOUT_PATH: rollout, CODEX_TEST_ROLLOUT_MODE: "deferred" },
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: state => states.push(state), onSpawn: value => { child = value; } }).then(value => { resolved = true; provider = value; return value; });
  void opening.catch(() => {});
  try {
    await vi.waitFor(async () => expect(await readFile(log, "utf8")).toContain('"method":"thread/settings/update"'));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(resolved).toBe(false); expect(states.some(state => state.activity === "idle")).toBe(false);
    const event = JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_id: "native-thread", thread_settings: { model: "selected-model", collaboration_mode: { settings: { reasoning_effort: "high" } } } } });
    await appendFile(rollout, event);
    await new Promise(resolve => setTimeout(resolve, 30)); expect(resolved).toBe(false);
    await appendFile(rollout, "\n"); await opening;
    expect(states.at(-1)?.activity).toBe("idle");
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === "thread/settings/update")).toHaveLength(1);
    expect(requests.filter(request => ["turn/start", "turn/steer"].includes(request.method))).toEqual([]);
  } finally { if (!provider) { child?.kill(); await opening.catch(() => {}); } await provider?.close(); }
});

test("an incorrect startup model cannot become persistence evidence for a validated explicit selection", async () => {
  const log = join(nativeHome, "requests.jsonl");
  const opening = openCodexProvider({ cwd: process.cwd(), model: "selected-model", args: [], resumeNativeSessionId: null, validateNativeSelection: true,
    env: { ...process.env, CODEX_TEST_REQUEST_LOG: log, CODEX_TEST_THREAD_SETTINGS: JSON.stringify({ model: "wrong-model" }), CODEX_TEST_MODELS: JSON.stringify([{ model: "wrong-model" }, { model: "selected-model" }]) },
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  await expect(opening).rejects.toThrow("did not apply the requested model");
  const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(requests.filter(request => ["thread/settings/update", "turn/start", "turn/steer"].includes(request.method))).toEqual([]);
});

const initialSelectionCases = [
  { name: "model and effort", model: "selected-model", args: ["--effort", "high"], patch: { model: "selected-model", effort: "high" } },
  { name: "model only", model: "selected-model", args: [], patch: { model: "selected-model" } },
  { name: "effort only", model: null, args: ["--effort", "high"], patch: { effort: "high" } },
  { name: "native defaults", model: null, args: [], patch: null },
];

test.each(initialSelectionCases)("fresh Codex persists $name after materializing the empty thread without requiring a settings notification", async ({ model, args, patch }) => {
  const base = join(process.cwd(), ".tmp"); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "codex-initial-settings-")), log = join(directory, "requests.jsonl");
  try {
    const provider = await openCodexProvider({ cwd: process.cwd(), model, args, resumeNativeSessionId: null,
      env: { ...process.env, CODEX_TEST_REQUEST_LOG: log, CODEX_TEST_EMPTY_READ_ERROR: "1", CODEX_TEST_EFFECTIVE_CONFIG: JSON.stringify({ model: "directory-model", model_reasoning_effort: "low" }) },
      executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
    await provider.close();
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const updates = requests.filter(request => request.method === "thread/settings/update");
    expect(updates.map(request => request.params)).toEqual(patch ? [{ threadId: "native-thread", ...patch }] : []);
    expect(requests.filter(request => request.method === "config/read")).toHaveLength(patch ? 1 : 0);
    expect(requests.filter(request => request.method === "configRequirements/read")).toHaveLength(patch ? 2 : 1);
    if (patch) {
      const readIndex = requests.findIndex(request => request.method === "thread/read" && request.params.includeTurns === true);
      expect(readIndex).toBeGreaterThan(-1);
      expect(requests.indexOf(updates[0])).toBeGreaterThan(readIndex);
    }
    expect(requests.filter(request => ["turn/start", "turn/steer"].includes(request.method))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([
  { name: "permission denial with model", model: "selected-model", args: [], code: -32603, message: "Permission denied" },
  { name: "unsupported read with effort", model: null, args: ["--effort", "high"], code: -32601, message: "Method not found" },
  { name: "unrecognized code with compatibility text", model: "selected-model", args: ["--effort", "high"], code: -32603, message: "list_turns is not supported yet" },
  { name: "omitted selections retain legacy read compatibility", model: null, args: [], code: -32603, message: "Permission denied" },
])("empty thread $name cannot falsely confirm explicit settings persistence", async ({ model, args, code, message }) => {
  const base = join(process.cwd(), ".tmp"); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "codex-read-failure-")), log = join(directory, "requests.jsonl");
  const states: ProviderState[] = []; let child: import("node:child_process").ChildProcess | undefined;
  try {
    const result = await openCodexProvider({ cwd: process.cwd(), model, args, resumeNativeSessionId: null,
      env: { ...process.env, CODEX_TEST_REQUEST_LOG: log, CODEX_TEST_READ_ERROR: JSON.stringify({ code, message }) },
      executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: state => states.push(state), onSpawn: value => { child = value; } })
      .then(provider => ({ provider, error: null }), error => ({ provider: null, error }));
    const explicit = model !== null || args.length > 0;
    try { if (explicit) expect(result.error).toMatchObject({ code, message }); else expect(result.error).toBeNull(); }
    finally { await result.provider?.close(); }
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    expect(states.some(state => state.nativeSessionId === "native-thread")).toBe(true);
    expect(states.some(state => state.activity === "idle")).toBe(!explicit);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === "thread/start")).toHaveLength(1);
    expect(requests.filter(request => ["thread/settings/update", "thread/resume", "turn/start", "turn/steer"].includes(request.method))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Codex resume preserves native settings without replaying frozen initial choices", async () => {
  const base = join(process.cwd(), ".tmp"); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "codex-resume-settings-")), log = join(directory, "requests.jsonl");
  const states: ProviderState[] = [];
  try {
    const provider = await openCodexProvider({ cwd: process.cwd(), model: "old-model", args: ["--effort", "high"], resumeNativeSessionId: "native-thread",
      env: { ...process.env, CODEX_TEST_REQUEST_LOG: log, CODEX_TEST_THREAD_SETTINGS: JSON.stringify({ model: "changed-model", reasoningEffort: "low" }), CODEX_TEST_MODELS: JSON.stringify([{ model: "changed-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }]) },
      executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: state => states.push(state), onSpawn: () => {} });
    try {
      expect(states.at(-1)?.controls?.settings.find(setting => setting.id === "model")?.value).toBe("changed-model");
      expect(states.at(-1)?.controls?.settings.find(setting => setting.id === "effort")?.value).toBe("low");
    } finally { await provider.close(); }
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(request => ["thread/start", "thread/settings/update", "turn/start", "turn/steer"].includes(request.method))).toEqual([]);
    expect(requests.filter(request => request.method === "config/read")).toHaveLength(0);
    expect(requests.filter(request => request.method === "configRequirements/read")).toHaveLength(1);
    const resume = requests.find(request => request.method === "thread/resume");
    expect(resume.params).not.toHaveProperty("model");
    expect(resume.params.config).not.toHaveProperty("model_reasoning_effort");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["reject", "disconnect", "async-error", "null", "[]", "1", "missing"])("initial Codex settings %s closes the provider without retrying or losing its observed native identity", async mode => {
  const base = join(process.cwd(), ".tmp"); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "codex-settings-failure-")), log = join(directory, "requests.jsonl");
  const states: ProviderState[] = []; let child: import("node:child_process").ChildProcess | undefined;
  try {
    const result = await openCodexProvider({ cwd: process.cwd(), model: "selected-model", args: ["--effort", "high"], resumeNativeSessionId: null,
      env: { ...process.env, CODEX_TEST_REQUEST_LOG: log, CODEX_TEST_INITIAL_SETTINGS: mode },
      executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: state => states.push(state), onSpawn: value => { child = value; } })
      .then(provider => ({ provider, error: null }), error => ({ provider: null, error }));
    try { expect(result.error).toBeInstanceOf(Error); } finally { await result.provider?.close(); }
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    expect(states.some(state => state.nativeSessionId === "native-thread")).toBe(true);
    expect(states.some(state => state.activity === "idle")).toBe(false);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === "thread/start")).toHaveLength(1);
    expect(requests.filter(request => request.method === "thread/settings/update")).toHaveLength(1);
    expect(requests.filter(request => ["thread/resume", "turn/start", "turn/steer"].includes(request.method))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new Codex execution applies effort to thread startup before validating its native receipt", async () => {
  const provider = await openCodexProvider({ cwd: process.cwd(), model: "native-model", args: ["--effort", "high"], resumeNativeSessionId: null, validateNativeSelection: true,
    env: { ...process.env, CODEX_TEST_APPLY_EFFORT: "1", CODEX_TEST_MODELS: JSON.stringify([{ model: "native-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }]), CODEX_TEST_THREAD_SETTINGS: JSON.stringify({ model: "native-model" }) },
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  await provider.close();
});
test("new Codex execution rejects unsupported effort before accepting input and closes its process", async () => {
  let child: import("node:child_process").ChildProcess | undefined;
  const opening = openCodexProvider({ cwd: process.cwd(), model: "native-model", args: ["--effort", "high"], resumeNativeSessionId: null, validateNativeSelection: true,
    env: { ...process.env, CODEX_TEST_MODELS: JSON.stringify([{ model: "native-model", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }]), CODEX_TEST_THREAD_SETTINGS: JSON.stringify({ model: "native-model", reasoningEffort: "low" }) },
    executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {}, onSpawn: value => { child = value; } });
  const result = await opening.then(provider => ({ provider, error: null }), error => ({ provider: null, error }));
  try { expect(result.error).toBeInstanceOf(Error); expect(result.error.message).toContain("effort"); }
  finally { await result.provider?.close(); }
  expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
});
test("a late turn/start receipt does not resurrect a completed native turn", async () => {
  const states: ProviderState[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: s => states.push(s), onSpawn: () => {} });
  try { const receipt = await provider.send(textNativeInput("test"), randomUUID(), null); await provider.waitForTurn(receipt.turnId!, Date.now() + 1000); expect(states.at(-1)).toMatchObject({ activity: "idle", currentTurnId: null }); }
  finally { await provider.close(); }
});

test.each([["notifications", false], ["unsupported request", false], ["foreign request", false], ["invalid form", false], ["foreign request", true]] as const)("natural native exit drains %s before shutdown (early close: %s)", async (mode, earlyClose) => {
  const entries: Parameters<ProviderOptions["onTimeline"]>[0][] = [], events: string[] = [], states: ProviderState[] = [];
  const fatal = Promise.withResolvers<void>(), exited = Promise.withResolvers<void>();
  let hold = false, didExit = false, didClose = false, closedBeforeShutdown = false, writesAtExit = -1;
  let writes: ReturnType<typeof vi.spyOn>;
  let shutdown: Promise<void> | undefined;
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null,
    env: { ...process.env, CODEX_TEST_EXIT_BURST: mode }, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)),
    onTimeline: entry => { entries.push(entry); if (entry.kind === "assistant_message") expect(didExit).toBe(true); if (entry.kind === "assistant_message" && entry.content.some(part => part.type === "text" && part.text === "final answer before exit")) events.push("final projection"); },
    onState: state => states.push(state), onSpawn: child => {
      const stdout = child.stdout!, buffered = new PassThrough({ highWaterMark: 1024 * 1024 });
      stdout.pipe(buffered);
      // Drain the real pipe into bounded test storage while holding consumption
      // until the child has actually exited, even on a fast reader.
      Object.defineProperty(stdout, Symbol.asyncIterator, { value: async function* () {
        for await (const chunk of buffered) { if (hold) await exited.promise; yield chunk; }
      } });
      writes = vi.spyOn(child.stdin!, "write");
      child.once("close", () => { didClose = true; });
      process.nextTick(() => child.once("exit", () => {
        didExit = true; writesAtExit = writes.mock.calls.length; exited.resolve();
        if (earlyClose) { closedBeforeShutdown = didClose; shutdown = provider.close(); }
      }));
    },
    onFatalError: () => { events.push("EOF"); shutdown = provider.close(); fatal.resolve(); },
  });
  try {
    hold = true;
    const receipt = await provider.send(textNativeInput("exit after output"), randomUUID(), null).then(value => { events.push("receipt"); return value; });
    expect(receipt).toEqual({ disposition: "started", turnId: "native-turn" });
    await provider.waitForTurn("native-turn", Date.now() + 1000);
    if (!earlyClose) await fatal.promise;
    await shutdown;
    expect(events).toEqual(earlyClose ? ["final projection", "receipt"] : ["final projection", "receipt", "EOF"]);
    if (earlyClose) expect(closedBeforeShutdown).toBe(false);
    expect(entries.filter(entry => entry.kind === "assistant_message")).toHaveLength(1001);
    expect(didExit).toBe(true); expect(writes.mock.calls.length).toBe(writesAtExit);
    if (mode === "unsupported request") expect(entries).toContainEqual(expect.objectContaining({ kind: "error", code: "unsupported_interaction", message: "Unsupported native interaction: unsupported/request" }));
    expect(states.at(-1)).toMatchObject({ currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false } });
  } finally { await provider.close(); }
});

test("concurrent idle sends cannot both pass native turn admission", async () => {
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  try { const first = provider.send(textNativeInput("first"), randomUUID(), null); await expect(provider.send(textNativeInput("second"), randomUUID(), null)).rejects.toThrow("pending"); await first; }
  finally { await provider.close(); }
});

test("native input identity and tool deltas are observed without waiting for the final message", async () => {
  const ids: string[] = [], entries: unknown[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onInputObserved: id => ids.push(typeof id === "string" ? id : id.operationId), onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try { const id = randomUUID(); await provider.send(textNativeInput("test"), id, null); expect(ids).toEqual([id]); expect(entries).toContainEqual(expect.objectContaining({ kind: "tool_call", output: [{ type: "text", text: "safe output" }] })); }
  finally { await provider.close(); }
});

test("resumed native history supplies receipt evidence with the original client message identity", async () => {
  const ids: string[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: "native-thread", executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onInputObserved: id => ids.push(typeof id === "string" ? id : id.operationId), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  try { expect(ids).toEqual(["persisted-operation"]); } finally { await provider.close(); }
});

test("cancel confirmation waits for the matching native turn to end", async () => {
  const states: ProviderState[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: s => states.push(s), onSpawn: () => {} });
  try { const sent = await provider.send(textNativeInput("cancel"), randomUUID(), null); expect(states.at(-1)?.activity).toBe("working"); await provider.cancel(sent.turnId!); expect(states.at(-1)?.activity).toBe("idle"); }
  finally { await provider.close(); }
});

test("native approval resolves exactly once and only exposes native decision choices", async () => {
  const entries: import("../../../src/commands/controller/providers/types.js").ProviderEntry[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: e => entries.push(e), onState: () => {}, onSpawn: () => {} });
  try {
    await provider.send(textNativeInput("approval"), randomUUID(), null);
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
    await provider.send(textNativeInput("approval_cancel"), randomUUID(), null);
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
    await provider.send(textNativeInput("approval_hold"), randomUUID(), null);
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
    await provider.send(textNativeInput("cancel"), randomUUID(), null);
    child.kill("SIGTERM");
    await vi.waitFor(() => expect(fatal).toHaveLength(1));
    expect(states.at(-1)).toMatchObject({ activity: "unknown", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false } });
  } finally { await provider.close(); }
  expect(fatal).toHaveLength(1);
});


test.each([{ unattended: false, resume: false }, { unattended: true, resume: false }, { unattended: true, resume: true }])("Codex full access only changes new Worker sessions: %j", async ({ unattended, resume }) => {
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: resume ? "native-thread" : null, unattended,
    env: { ...process.env, EXPECT_WORKER_PERMISSIONS: unattended && !resume ? "yes" : "no" }, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  await provider.close();
});


test.each([null, "native-thread"])("keeps explicit CLI mappings after native shell snapshot restoration (resume %s)", async resumeNativeSessionId => {
  const agentCliEnvironment = { PATH: "/private/aliases:/usr/bin", DN_CONFIG_DIR: "/private/dev" };
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId, agentCliEnvironment,
    env: { ...process.env, EXPECT_AGENT_CLI_ENV: JSON.stringify(agentCliEnvironment) }, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  await provider.close();
});


test.skipIf(process.platform === "win32").each([null, "native-thread"])("preserves native configured toolchain PATH with CLI aliases (resume %s)", async resumeNativeSessionId => {
  const agentCliEnvironment = { PATH: "/private/aliases:/worker/bin", DN_CONFIG_DIR: "/private/dev" };
  const expected = { ...agentCliEnvironment, PATH: "/private/aliases:/native/toolchain:/usr/bin:/bin" };
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId, agentCliEnvironment,
    env: { ...process.env, CODEX_TEST_EFFECTIVE_CONFIG: JSON.stringify({ shell_environment_policy: { inherit: "none", set: { PATH: "/native/toolchain:/usr/bin:/bin" }, include_only: ["PATH", "DN_CONFIG_DIR"] } }), EXPECT_AGENT_CLI_ENV: JSON.stringify(expected) }, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {}, onSpawn: () => {} });
  await provider.close();
});

test("initial persistence uses the same environment snapshot passed to the native child", async () => {
  const env = { ...process.env, CODEX_HOME: nativeHome };
  const provider = await openCodexProvider({ cwd: process.cwd(), model: "selected-model", args: [], resumeNativeSessionId: null,
    env, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)), onTimeline: () => {}, onState: () => {},
    onSpawn: () => { env.CODEX_HOME = join(nativeHome, "not-the-child-home"); } });
  await provider.close();
});


test.each(["inProgress", "completed"])("Codex historical Markdown waits for the native %s turn state", async status => {
  const projected: { entry: unknown; metadata: unknown }[] = [];
  const provider = await openCodexProvider({ cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: "native-thread",
    env: { ...process.env, CODEX_TEST_MARKDOWN_HISTORY_STATUS: status }, executable: fileURLToPath(new URL("./fixtures/codex-native.mjs", import.meta.url)),
    onTimeline: (entry, metadata) => projected.push({ entry, metadata }), onState: () => {}, onSpawn: () => {} });
  try { expect(projected).toContainEqual({ entry: expect.objectContaining({ kind: "assistant_message", content: [{ type: "text", text: "![image](local)" }] }), metadata: { complete: status === "completed", format: "markdown", truncated: false } }); }
  finally { await provider.close(); }
});
