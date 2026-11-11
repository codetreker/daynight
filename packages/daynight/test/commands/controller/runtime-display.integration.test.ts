import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { TimelineEntry } from "../../../src/session/protocol.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { NativeProvider, ProviderEntry, ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import type { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";

const f = vi.hoisted(() => ({
  open: null as null | ((provider: "codex" | "copilot", options: ProviderOptions) => NativeProvider),
  options: null as ProviderOptions | null,
  journal: null as ReturnType<typeof openControllerLifecycleStore> | null,
  close: vi.fn(), sdkQuery: vi.fn(), history: [] as unknown[], nativeId: "",
}));

// The real socket stays in this worktree. Use its equivalent relative pathname
// at the OS boundary so long checkout roots do not exceed sockaddr_un limits.
vi.mock("node:net", async importOriginal => {
  const net = await importOriginal<typeof import("node:net")>();
  const relative = (endpoint: string) => process.platform === "win32" ? endpoint : path.relative(process.cwd(), endpoint);
  return { ...net,
    createServer: (handler: (socket: import("node:net").Socket) => void) => {
      const server = net.createServer(handler), listen = server.listen.bind(server);
      server.listen = ((endpoint: string, callback: () => void) => listen(relative(endpoint), callback)) as typeof server.listen;
      return server;
    },
    createConnection: (endpoint: string) => net.createConnection(relative(endpoint)),
  };
});
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureControllerProcessProof: async () => ({ pid: 1, parentPid: 0, processGroupId: 1, startedAt: "fixture", commandHash: "fixture" }) }));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_ticket: unknown, journal: ReturnType<typeof openControllerLifecycleStore>, callbacks: { onConnection(connected: boolean): void }) => {
  f.journal = journal; queueMicrotask(() => callbacks.onConnection(true));
  return { flush: async () => {}, close: () => {}, connected: () => true, receipt: () => {} };
} }));
vi.mock("../../../src/commands/controller/providers/codex.js", () => ({ openCodexProvider: async (options: ProviderOptions) => { f.options = options; return f.open!("codex", options); } }));
vi.mock("../../../src/commands/controller/providers/copilot.js", () => ({ openCopilotProvider: async (options: ProviderOptions) => { f.options = options; return f.open!("copilot", options); } }));
vi.mock("../../../src/commands/controller/providers/claude.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../../src/commands/controller/providers/claude.js")>();
  return { openClaudeProvider: (options: ProviderOptions) => { f.options = options; return original.openClaudeProvider(options); } };
});
vi.mock("../../../src/commands/controller/providers/claude-live.js", async original => ({ ...await original<typeof import("../../../src/commands/controller/providers/claude-live.js")>(), queryClaudeLive: (...args: unknown[]) => f.sdkQuery(...args) }));
vi.mock("../../../src/commands/controller/providers/claude-transcript-helper.js", () => ({ openClaudeTranscriptHelper: async () => ({
  snapshot: { nativeSessionId: f.nativeId },
  nextPage: async () => ({ done: true, cursor: "fixture", records: f.history.map(value => ({ value: { ...value as object, session_id: f.nativeId }, media: [], assistantBlockOffset: null })) }),
  acknowledge: async () => {}, close: async () => {},
}) }));

import { runController } from "../../../src/commands/controller/runtime.js";
import { requestController } from "../../../src/commands/controller/local-client.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openPendingContent } from "../../../src/commands/controller/pending-content.js";
import { readControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { CodexProjection } from "../../../src/commands/controller/providers/projection.js";
import { CopilotProjection } from "../../../src/commands/controller/providers/copilot-projection.js";

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks(); f.open = null; f.options = null; f.journal = null; f.history = [];
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const sample = "x".repeat(5125) + "\0".repeat(15455);
const normal = "后续正常输出 😀\n\tunchanged";
const surrogates = "high=\ud800 low=\udc00 literal=\\ud800 中文😀\n\t";
const claudeMessages = (id: string, text: string) => [
  { type: "assistant", uuid: `${id}-start`, message: { id: `${id}-message`, content: [{ type: "tool_use", id, name: "Bash", input: { command: "fixture" } }] } },
  { type: "user", uuid: `${id}-result`, message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } },
];
const setup = async (provider: "codex" | "claude" | "copilot", history = false) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "display-")); roots.push(home);
  f.nativeId = randomUUID();
  let emit!: (id: string, text: string) => void;
  f.open = (kind, options) => {
    if (kind === "codex") {
      const projection = new CodexProjection(f.nativeId, options.onTimeline);
      emit = (id, text) => projection.item({ id, type: "commandExecution", command: "fixture", aggregatedOutput: text, status: "completed" }, true);
    } else {
      const projection = new CopilotProjection(f.nativeId, options.onTimeline);
      emit = (id, text) => {
        projection.accept({ type: "tool.execution_start", data: { toolCallId: id, toolName: "fixture", arguments: {} } });
        projection.accept({ type: "tool.execution_complete", data: { toolCallId: id, success: true, result: text } });
      };
    }
    if (history) { emit("bad-output", sample); emit("surrogates", surrogates); }
    options.onState({ nativeSessionId: f.nativeId, activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: true, respond: true } });
    return { nativeSessionId: f.nativeId, close: async () => { f.close(); }, send: async () => ({ disposition: "handled" }), cancel: async () => ({ disposition: "handled" }), respond: async () => ({ disposition: "handled" }), waitForTurn: async () => {} };
  };
  f.history = history ? [...claudeMessages("bad-output", sample), ...claudeMessages("surrogates", surrogates)] : [];
  f.sdkQuery.mockImplementation(({ options }: { options: Options }) => {
    const messages: unknown[] = []; let ended = false, wake: (() => void) | undefined;
    emit = (id, text) => { messages.push(...claudeMessages(id, text)); wake?.(); };
    return {
      async initializationResult() {
        await options.hooks!.SessionStart![0]!.hooks[0]!({ hook_event_name: "SessionStart", session_id: options.resume ?? options.sessionId!, transcript_path: "", cwd: process.cwd(), source: "startup" }, undefined, { signal: new AbortController().signal });
        return {};
      },
      supportedModels: async () => [], supportedCommands: async () => [], reloadSkills: async () => {},
      async *[Symbol.asyncIterator]() { while (!ended) { const item = messages.shift(); if (item) yield item; else await new Promise<void>(resolve => { wake = resolve; }); } },
      close() { f.close(); ended = true; wake?.(); },
    };
  });
  const ticket: ControllerLaunchTicket = {
    schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1",
    serverOrigin: "https://daynight.example", testExecutionId: randomUUID(), ownerUserId: randomUUID(), provider, cwd: process.cwd(), nativeHome: path.join(home, "native"),
    configuration: { agent: provider, agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialInput: "none", initialOperationId: randomUUID(), initialPrompt: "",
    resumeNativeSessionId: history ? f.nativeId : null, credentialFile: path.join(home, "grant.json"),
    ipcEndpoint: process.platform === "win32" ? String.raw`\\.\pipe\daynight-display-${randomUUID()}` : path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
  };
  await writeLaunchTicket(home, ticket);
  let error: unknown, settled = false;
  const running = runController({ homeDirectory: home, provider, launchId: ticket.launchId }).then(() => { settled = true; }, cause => { settled = true; error = cause; });
  const stop = async () => { if (!settled) await requestController(ticket, { kind: "stop", deadline: Date.now() + 2000 }, { timeoutMs: 2000 }).catch(() => {}); await running; };
  try {
    await vi.waitFor(async () => { if (error) throw error; expect((await requestController(ticket, { kind: "observe" }, { timeoutMs: 100 })).snapshot.lifecycle).toBe("ready"); });
  } catch (error) { await stop(); throw error; }
  return { ticket, running, stop, emit: (id: string, text: string) => emit(id, text), journalFile: path.join(controllerExecutionDirectory(home, ticket.executionId), "journal.sqlite") };
};

for (const provider of ["codex", "claude", "copilot"] as const) {
  test.each([false, true])(`${provider} persists malformed tool text through runtime and keeps processing (history=%s)`, async history => {
    expect(sample.length).toBe(20580); expect(sample.match(/\0/g)).toHaveLength(15455);
    const v = await setup(provider, history);
    let saved: readonly TimelineEntry[];
    try {
      if (!history) { v.emit("bad-output", sample); v.emit("surrogates", surrogates); }
      v.emit("next-output", normal);
      await vi.waitFor(() => {
        expect(readControllerSnapshot(v.journalFile)?.error).toBeNull();
        const entries = f.journal!.readTimeline({ historyEpoch: "fixture", direction: "tail", cursor: null, limit: 20 }).items;
        expect(entries.filter(entry => entry.kind === "tool_call" && entry.status === "completed")).toHaveLength(3);
      });
      saved = f.journal!.readTimeline({ historyEpoch: "fixture", direction: "tail", cursor: null, limit: 20 }).items;
      const bad = saved.find(entry => entry.kind === "tool_call" && entry.callId === "bad-output");
      expect(bad).toMatchObject({ kind: "tool_call", status: "completed", truncated: false });
      if (bad?.kind !== "tool_call" || bad.output[0]?.type !== "text") throw new Error("Missing tool output");
      expect(bad.output[0].text).not.toContain("\0");
      expect(bad.output[0].text.match(/\\u0000/g)).toHaveLength(15455);
      expect(bad.output[0].text).toMatch(/escaped/i);
      const unicode = saved.find(entry => entry.kind === "tool_call" && entry.callId === "surrogates");
      if (unicode?.kind !== "tool_call" || unicode.output[0]?.type !== "text") throw new Error("Missing Unicode tool output");
      expect(unicode.output[0].text.isWellFormed()).toBe(true);
      expect(unicode.output[0].text).toContain("high=\\ud800 low=\\udc00 literal=\\\\ud800 中文😀\n\t");
      expect(saved.find(entry => entry.kind === "tool_call" && entry.callId === "next-output")).toMatchObject({ output: [{ type: "text", text: normal }], status: "completed" });
      expect((await requestController(v.ticket, { kind: "observe" })).snapshot.error).toBeNull();
      expect(f.close).not.toHaveBeenCalled();
    } finally { await v.stop(); }
    // Reopening the actual pending archive source reparses bytes from disk.
    const db = new Database(v.journalFile, { readonly: true });
    try {
      const reopened = openPendingContent(v.journalFile, v.ticket.sessionId, db);
      expect([...reopened.entries.values()].sort((a, b) => Number(a.entrySeq) - Number(b.entrySeq))).toEqual(saved!);
    } finally { db.close(); }
  });
}

test("runtime waits for trusted completion and retains withdrawn Markdown image occurrences", async () => {
  const v = await setup("codex"), entryId = randomUUID();
  const emit = (text: string, complete: boolean) => f.options!.onTimeline({ entryId, revision: "1", kind: "assistant_message", content: [{ type: "text", text }] }, { complete, format: "markdown", truncated: false });
  try {
    emit("![original](missing.png)", false);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(f.journal!.markdownStore.listIds("source", { limit: 32 })).toEqual([]);
    emit("![original](missing.png)", true);
    // The parser owns a two-second deadline independently of the 250 ms poll.
    await vi.waitFor(() => expect(f.journal!.markdownStore.listIds("source", { limit: 32 })).toHaveLength(1), { timeout: 4000 });
    const imageId = f.journal!.markdownStore.listIds("source", { limit: 32 })[0]!;
    emit("Image was withdrawn.", true);
    await vi.waitFor(() => {
      const current = f.journal!.readTimeline({ historyEpoch: "fixture", direction: "tail", cursor: null, limit: 20 }).items.find(item => item.entryId === entryId);
      expect(current).toMatchObject({ content: [{ type: "markdown", complete: true, bindings: [], retainedImages: [{ imageId }] }] });
    }, { timeout: 4000 });
    expect(f.journal!.markdownStore.listIds("source", { limit: 32 })).toEqual([imageId]);
  } finally { await v.stop(); }
  const db = new Database(v.journalFile, { readonly: true });
  try {
    const recovered = openPendingContent(v.journalFile, v.ticket.sessionId, db).entries.get(entryId);
    expect(recovered).toMatchObject({ content: [{ type: "markdown", text: "Image was withdrawn.", bindings: [], retainedImages: [expect.objectContaining({ imageId: expect.any(String) })] }] });
  } finally { db.close(); }
}, 10_000);

test.each(["identity", "interaction"] as const)("runtime still stops for invalid authoritative %s", async kind => {
  const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const v = await setup("codex");
  try {
    const entry: ProviderEntry = kind === "identity"
      ? { entryId: "invalid\0id", revision: "1", kind: "reasoning", text: "valid body" }
      : { entryId: randomUUID(), revision: "1", kind: "interaction", interaction: { interactionId: randomUUID(), revision: "1", state: "pending", kind: "approval", title: "invalid\0title", detail: "", actions: ["allow_once"] } };
    f.options!.onTimeline(entry);
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    await v.running;
    expect(readControllerSnapshot(v.journalFile)?.error).toBe("Invalid Daynight session protocol value.");
  } finally { await v.stop(); diagnostic.mockRestore(); }
});
