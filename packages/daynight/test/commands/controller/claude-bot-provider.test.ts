import { beforeEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderState } from "../../../src/commands/controller/providers/types.js";
import { textNativeInput } from "../../../src/commands/controller/providers/native-input.js";
const recovery = vi.hoisted(() => ({ prepare: vi.fn(), validateVersion: vi.fn(), markDirty: vi.fn(), append: vi.fn(), protect: vi.fn(), close: vi.fn() }));
const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../src/commands/controller/providers/claude-bot-recovery.js", () => ({ ClaudeBotRecovery: class {
  prepare = recovery.prepare; validateVersion = recovery.validateVersion; markDirty = recovery.markDirty; append = recovery.append; protect = recovery.protect; close = recovery.close;
} }));
vi.mock("../../../src/commands/controller/providers/claude-live.js", async original => ({ ...await original<typeof import("../../../src/commands/controller/providers/claude-live.js")>(), queryClaudeLive: sdk.query }));
vi.mock("../../../src/commands/controller/providers/claude-transcript-helper.js", () => ({ openClaudeTranscriptHelper: async () => ({ nextPage: async () => ({ records: [], cursor: "empty", done: true }), acknowledge: async () => {}, close: async () => {} }) }));
import { openClaudeProvider } from "../../../src/commands/controller/providers/claude.js";
beforeEach(() => { vi.resetAllMocks(); });

const fixture = async (resumeNativeSessionId: string | null = null) => {
  let options!: Options, emit!: (value: unknown) => void, wake: (() => void) | undefined, closed = false;
  const events: unknown[] = [], states: ProviderState[] = [], fatal: Error[] = [], inputs: SDKUserMessage[] = [];
  sdk.query.mockImplementation((request: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    options = request.options; emit = value => { events.push(value); wake?.(); };
    void (async () => { for await (const input of request.prompt) { inputs.push(input); emit(input); } })();
    return {
      profile: { sdkVersion: "0.3.247", cliVersion: "2.1.247", executable: "controlled", backend: "unknown" },
      initializationResult: async () => { await options.hooks!.SessionStart![0]!.hooks[0]!({ hook_event_name: "SessionStart", session_id: options.sessionId ?? String(options.extraArgs?.resume), cwd: process.cwd(), source: resumeNativeSessionId ? "resume" : "startup", transcript_path: "" }, undefined, { signal: new AbortController().signal }); },
      async *[Symbol.asyncIterator]() { while (!closed) { const event = events.shift(); if (event) yield event; else await new Promise<void>(resolve => { wake = resolve; }); } },
      close: () => { closed = true; wake?.(); }, supportedModels: async () => [], supportedCommands: async () => [], reloadSkills: async () => {}, getSettings: async () => ({}),
    };
  });
  const env = { CLAUDE_CONFIG_DIR: process.cwd(), ANTHROPIC_BASE_URL: "https://fixture.invalid" };
  const provider = await openClaudeProvider({ cwd: process.cwd(), env, args: [], model: null, resumeNativeSessionId,
    claudeBotRecovery: { directory: process.cwd(), identity: { serverOrigin: "https://fixture.invalid", ownerUserId: randomUUID(), botId: randomUUID(), sessionId: randomUUID() } },
    imageRuntime: { getIntent: () => null, readState: () => null, writeState: () => {}, indexDirectory: () => process.cwd(), acquireIndexLease: () => ({ release() {} }), createSpool: () => { throw new Error("Controlled fixture has no media storage."); } },
    onTimeline: () => {}, onState: state => states.push(state), onFatalError: error => fatal.push(error), onSpawn: () => {},
  });
  return { provider, emit: (value: unknown) => emit(value), options: () => options, states, fatal, inputs, env };
};

test("Claude Bot waits for durable recovery protection before completing the turn", async () => {
  const f = await fixture(), turn = randomUUID(); let release!: () => void, protecting!: () => void;
  const entered = new Promise<void>(resolve => { protecting = resolve; });
  recovery.protect.mockImplementation(async () => { protecting(); await new Promise<void>(resolve => { release = resolve; }); });
  try {
    await f.provider.send(textNativeInput("first"), turn, null);
    expect(recovery.markDirty).toHaveBeenCalledTimes(2);
    expect(recovery.validateVersion).toHaveBeenCalledWith({ sdkVersion: "0.3.247", cliVersion: "2.1.247" });
    f.emit({ type: "result", subtype: "success", session_id: f.provider.nativeSessionId, user_message_uuid: turn, is_error: false });
    await entered;
    expect(f.states.at(-1)?.currentTurnId).toBe(turn);
    await expect(f.provider.send(textNativeInput("overlap"), randomUUID(), turn)).rejects.toThrow("overlapping");
    expect(f.states.at(-1)?.capabilities.steer).toBe(false);
    release(); await f.provider.waitForTurn(turn, Date.now() + 1000);
    expect(f.states.at(-1)?.activity).toBe("idle");
    expect(recovery.protect).toHaveBeenCalledWith(f.provider.nativeSessionId, turn);
  } finally { release?.(); await f.provider.close(); }
  expect(recovery.close).toHaveBeenCalledOnce();
});

test.each(["mirror_error", "protect"])("Claude Bot retains an unknown result when %s fails", async mode => {
  const f = await fixture(), turn = randomUUID();
  try {
    await f.provider.send(textNativeInput("effect"), turn, null);
    if (mode === "protect") recovery.protect.mockRejectedValue(new Error("Controlled persistence failure"));
    f.emit(mode === "mirror_error" ? { type: "system", subtype: "mirror_error" } : { type: "result", subtype: "success", session_id: f.provider.nativeSessionId, user_message_uuid: turn, is_error: false });
    await expect.poll(() => f.fatal.length).toBe(1);
    expect(f.states.at(-1)?.activity).toBe("unknown");
    await expect(f.provider.waitForTurn(turn, Date.now() + 1000)).rejects.toThrow("unknown");
    await expect(f.provider.send(textNativeInput("again"), randomUUID(), null)).rejects.toThrow("cannot accept");
    if (mode === "mirror_error") expect(recovery.protect).not.toHaveBeenCalled();
  } finally { await f.provider.close(); }
});

test("Claude Bot resume preserves current configuration and rejects SDK materialization", async () => {
  const original = randomUUID(), f = await fixture(original);
  try {
    expect(recovery.prepare).toHaveBeenCalledWith(original);
    expect(f.options().resume).toBeUndefined(); expect(f.options().sessionId).toBeUndefined();
    expect(f.options().extraArgs).toEqual({ resume: original }); expect(f.options().env).toEqual(f.env);
    expect(f.options().settingSources).toEqual(["user", "project", "local"]);
    await expect(f.options().sessionStore!.load({ projectKey: "fixture", sessionId: original })).rejects.toThrow("configuration");
    const entries = [{ type: "user", uuid: randomUUID() }], key = { projectKey: "fixture", sessionId: original };
    await f.options().sessionStore!.append(key, entries); expect(recovery.append).toHaveBeenCalledWith(key, entries);
  } finally { await f.provider.close(); }
});

test("Claude Bot never submits input after its durable dirty marker fails", async () => {
  const f = await fixture(); recovery.markDirty.mockImplementation(() => { throw new Error("Controlled dirty write failure"); });
  try {
    await expect(f.provider.send(textNativeInput("effect"), randomUUID(), null)).rejects.toThrow("dirty write failure");
    expect(f.inputs).toEqual([]); expect(f.states.at(-1)?.activity).toBe("unknown");
  } finally { await f.provider.close(); }
});

test("Claude Bot fences startup hooks before spawning the native session", async () => {
  recovery.markDirty.mockImplementation(() => { throw new Error("Controlled startup fence failure"); });
  await expect(fixture()).rejects.toThrow("startup fence failure");
  expect(sdk.query).not.toHaveBeenCalled(); expect(recovery.close).toHaveBeenCalledOnce();
});

test("Claude Bot closes recovery storage while preserving native stop failure", async () => {
  const f = await fixture(), native = sdk.query.mock.results.at(-1)!.value, close = native.close;
  native.close = () => { close(); throw new Error("Controlled native stop failure"); };
  await expect(f.provider.close()).rejects.toThrow("native stop failure");
  expect(recovery.close).toHaveBeenCalledOnce(); expect(f.states.at(-1)?.activity).not.toBe("stopped");
});

test("Claude Bot declares its image recovery limit and rejects input before dispatch", async () => {
  const f = await fixture();
  recovery.markDirty.mockClear();
  try {
    expect(f.states.at(-1)?.images).toMatchObject({ send: "unsupported", steer: "unsupported", reasonCode: "recovery_profile_unsupported" });
    await expect(f.provider.send({ content: [{ type: "image", imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png",
      byteLength: "1", sha256: "a".repeat(64), localPath: process.cwd() }] }, randomUUID(), null)).rejects.toThrow("does not support image input");
    expect(recovery.markDirty).not.toHaveBeenCalled(); expect(f.inputs).toEqual([]);
  } finally { await f.provider.close(); }
});
