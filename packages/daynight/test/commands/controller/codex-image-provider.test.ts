import { authorizeNativeImageInput } from "../../../src/commands/controller/providers/image-admission.js";
import { expect, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { openCodexProvider } from "../../../src/commands/controller/providers/codex.js";
import { openNativeMediaSpool } from "../../../src/commands/controller/media/native-spool.js";
import { validateImageFile } from "../../../src/commands/controller/media/image-validation.js";
import type { ImageCaptureRequest, InputObservation } from "../../../src/session/image-values.js";
import type { NativeImagePart, NativeInput, ProviderEntry, ProviderOptions, ProviderState } from "../../../src/commands/controller/providers/types.js";
import { NativeRpcError, NativeRpcTimeoutError } from "../../../src/commands/controller/providers/native-rpc.js";

// The native protocol/profile boundary is controlled here. Model visual input
// and the installed executable profile require separate real-provider evidence.
vi.mock("../../../src/commands/controller/providers/codex-image-profile.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/commands/controller/providers/codex-image-profile.js")>();
  return { ...actual, codexImageProfile: (value: any, native: any) => value.userAgent === "controlled-fixture" ? { modelProvider: native.modelProvider, modelId: native.model, geometry: { version: 1, known: true, maxWidth: 1024, maxHeight: 1024, maxPixels: 1_048_576, maxFrames: 1 } } : null };
});
const rpcPolicy = vi.hoisted(() => ({ timeoutMs: 30_000 }));
vi.mock("../../../src/commands/controller/providers/codex-rpc.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/commands/controller/providers/codex-rpc.js")>();
  return { ...actual, CodexRpc: class extends actual.CodexRpc {
    constructor(...args: ConstructorParameters<typeof actual.CodexRpc>) { super(args[0], args[1], { ...args[2], get timeoutMs() { return rpcPolicy.timeoutMs; } }); }
  } };
});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
const fixture = async (mode = "normal", history: unknown[] = []) => {
  const root = await mkdtemp(join(tmpdir(), "codex-image-provider-")), log = join(root, "requests.jsonl");
  const state = new Map<string, unknown>(), intents = new Map<string, any>(), entries: ProviderEntry[] = [], observations: (string | InputObservation)[] = [], states: ProviderState[] = [], captures: ImageCaptureRequest[] = [];
  let child: import("node:child_process").ChildProcess | undefined, sequence = 0;
  const options: ProviderOptions = { cwd: root, model: null, args: [], resumeNativeSessionId: history.length || mode === "cursor-loop" ? "images-thread" : null,
    executable: fileURLToPath(new URL("./fixtures/codex-images-native.mjs", import.meta.url)), env: { ...process.env, CODEX_IMAGES_LOG: log, CODEX_IMAGES_MODE: mode, CODEX_IMAGES_HISTORY: JSON.stringify(history) },
    onSpawn: value => { child = value; }, onState: value => states.push(value), onTimeline: entry => entries.push(structuredClone(entry)), onInputObserved: observation => { observations.push(observation); return true; },
    onImageOccurrence: () => true, imageOccurrenceAcknowledged: () => true,
    imageRuntime: { readState: key => state.get(key) ?? null, writeState: (key, value) => { state.set(key, structuredClone(value)); }, getIntent: id => intents.get(id) ?? null,
      createSpool: maximum => openNativeMediaSpool(join(root, `spool-${sequence++}`), maximum, () => {}, () => {}), indexDirectory: () => root, reserveIndex: () => {}, acquireIndexReservation: () => ({ release() {} }) },
    prepareImageCapture: async () => {},
    submitImageCapture: async ({ request, attemptId, outcome }) => { captures.push(request); return { captureId: request.captureId, attemptId, occurrence: request.occurrence, revision: "1", state: outcome.kind === "failed" ? "failed" : "committed", resourceId: outcome.kind === "failed" ? null : request.locator.kind === "resource" ? request.locator.resourceId : randomUUID(), resource: null, error: outcome.kind === "failed" ? outcome.error : null }; },
    queryImageCapture: vi.fn(), stageImageCapture: vi.fn(async input => ({ mediaType: "image/png" as const, byteLength: input.byteLength, sha256: input.sha256, width: 1, height: 1, frameCount: 1 })),
  };
  const image = async (): Promise<NativeImagePart> => { const localPath = join(root, randomUUID() + ".png"); await writeFile(localPath, png, { mode: 0o400 }); return { type: "image", imageId: randomUUID(), resourceId: randomUUID(), localPath, mediaType: "image/png", byteLength: String(png.length), sha256: createHash("sha256").update(png).digest("hex") }; };
  const input = (content: NativeInput["content"], expectedTurnId: string | null = null) => {
    const operationId = randomUUID(), payload = { content: content.map(part => part.type === "text" ? part : { type: "image", imageId: part.imageId, resourceId: part.resourceId, uploadId: randomUUID(), sha256: part.sha256, byteLength: part.byteLength }), expectedTurnId, target: { expectedNativeSessionId: null } };
    intents.set(operationId, { sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), state: "dispatching", command: { operationId, kind: "send_message", payload } });
    const value = { content: content.map(part => part.type === "image" ? { ...part, validated: { mediaType: part.mediaType as "image/png", byteLength: part.byteLength, sha256: part.sha256, width: 1, height: 1, frameCount: 1 } } : part) };
    const caps = states.at(-1)?.images;
    return { operationId, value: caps ? authorizeNativeImageInput(value, { ...caps, revision: "7", providerRevision: "1" }, () => {}) : value, expectedTurnId };
  };
  const requests = async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { root, options, image, input, requests, entries, states, observations, captures, state, child: () => child, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test.each(["second-geometry", "qualification-revoked"])("Codex sends nothing when final admission rejects %s", async failure => {
  const f = await fixture(), provider = await openCodexProvider(f.options);
  try {
    const prepared = f.input([await f.image(), await f.image()]);
    let allowed = true;
    const current = f.states.at(-1)!.images!;
    const input = authorizeNativeImageInput(prepared.value, { ...current, revision: "7", providerRevision: "1" }, () => { if (!allowed) throw new NativeRpcError(-32602, "Qualification revoked during verification."); });
    if (failure === "second-geometry") Object.assign(input.content[1]!, { validated: { ...(input.content[1] as NativeImagePart).validated!, width: 1025 } });
    const sending = provider.send(input, prepared.operationId, null);
    if (failure === "qualification-revoked") allowed = false;
    await expect(sending).rejects.toBeInstanceOf(NativeRpcError);
    expect((await f.requests()).filter(request => ["turn/start", "turn/steer"].includes(request.method))).toEqual([]);
  } finally { await provider.close(); await f.cleanup(); }
});

test("pure and mixed image inputs use one native request each, preserve order and reuse original resources", async () => {
  const f = await fixture(), onInputMessage = vi.fn();
  const provider = await openCodexProvider({ ...f.options, onInputMessage });
  try {
    const first = await f.image(), second = await f.image(), pure = f.input([first]);
    expect(await provider.send(pure.value, pure.operationId, null)).toEqual({ disposition: "started", turnId: "image-turn" });
    const mixed = f.input([{ type: "text", text: "Which image is first?" }, second, { ...first, imageId: randomUUID() }], "image-turn");
    expect(await provider.send(mixed.value, mixed.operationId, "image-turn")).toEqual({ disposition: "queued", turnId: "image-turn" });
    const dispatches = (await f.requests()).filter(request => ["turn/start", "turn/steer"].includes(request.method));
    expect(dispatches).toHaveLength(2); expect(dispatches[0].params).toMatchObject({ clientUserMessageId: pure.operationId, input: [{ type: "localImage", path: first.localPath }] });
    expect(dispatches[1].params).toMatchObject({ expectedTurnId: "image-turn", clientUserMessageId: mixed.operationId, input: [{ type: "text", text: "Which image is first?", text_elements: [] }, { type: "localImage", path: second.localPath }, { type: "localImage", path: first.localPath }] });
    await vi.waitFor(() => expect(f.captures).toHaveLength(3));
    expect(f.captures.map(capture => capture.locator.kind)).toEqual(["resource", "resource", "resource"]);
    expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(f.observations.every(item => typeof item !== "string" && item.nativeSessionId === "images-thread" && item.nativeMessageId === item.operationId)).toBe(true);
    expect(onInputMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(f.entries)).not.toContain(first.localPath); expect(JSON.stringify(f.entries)).not.toContain(second.localPath);
  } finally { await provider.close(); expect(f.child()!.exitCode !== null || f.child()!.signalCode !== null).toBe(true); await f.cleanup(); }
});

test("a failed second image makes zero native input calls and a text-only model cannot admit images", async () => {
  for (const mode of ["normal", "no-modality"]) {
    const f = await fixture(mode), provider = await openCodexProvider(f.options);
    try {
      const first = await f.image(), second = { ...await f.image(), localPath: join(f.root, "missing.png") }, input = f.input([first, second]);
      await expect(provider.send(input.value, input.operationId, null)).rejects.toBeInstanceOf(NativeRpcError);
      expect((await f.requests()).filter(request => ["turn/start", "turn/steer"].includes(request.method))).toEqual([]);
      expect(f.observations).toEqual([]);
    } finally { await provider.close(); await f.cleanup(); }
  }
});

test("paginated native image history uses one item per page and preserves each outer turn source", async () => {
  const f = await fixture("normal", [{ id: "generated", type: "imageGeneration", status: "completed", result: png.toString("base64") }, { id: "user", type: "userMessage", content: [{ type: "image", fileId: "private-native-file" }] }]);
  const provider = await openCodexProvider(f.options);
  try {
    await vi.waitFor(() => expect(f.captures).toHaveLength(2));
    expect((await f.requests()).filter(request => request.method === "thread/items/list").map(request => request.params)).toEqual([{ threadId: "images-thread", turnId: "history-turn", cursor: null, limit: 1, sortDirection: "asc" }, { threadId: "images-thread", turnId: "history-turn", cursor: "1", limit: 1, sortDirection: "asc" }]);
    expect(f.captures.map(request => request.nativeSource?.nativeMessageId)).toEqual(["generated", "user"]);
    expect(f.state.get("codex:history:images-thread:history-turn")).toEqual({ cursor: null, complete: true });
    expect(JSON.stringify(f.entries)).not.toContain(png.toString("base64")); expect(JSON.stringify(f.entries)).not.toContain("private-native-file");
  } finally { await provider.close(); await f.cleanup(); }
});

test("a repeated native history cursor fails the same connection without starting input", async () => {
  const f = await fixture("cursor-loop");
  try {
    await expect(openCodexProvider(f.options)).rejects.toThrow("cursor repeated");
    expect((await f.requests()).filter(request => ["turn/start", "turn/steer"].includes(request.method))).toEqual([]);
    expect(f.child()!.exitCode !== null || f.child()!.signalCode !== null).toBe(true);
  } finally { await f.cleanup(); }
});

test("the original late response can resolve an unknown input without dispatching it twice", async () => {
  const f = await fixture("late"), provider = await openCodexProvider(f.options);
  try {
    const input = f.input([await f.image()]); rpcPolicy.timeoutMs = 20;
    await expect(provider.send(input.value, input.operationId, null)).rejects.toBeInstanceOf(NativeRpcTimeoutError);
    expect(f.observations).toEqual([]);
    await vi.waitFor(() => expect(f.observations).toContainEqual(expect.objectContaining({ operationId: input.operationId, nativeMessageId: input.operationId })));
    expect((await f.requests()).filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(f.captures).toHaveLength(1);
  } finally { rpcPolicy.timeoutMs = 30_000; await provider.close(); await f.cleanup(); }
});

test("a lost response remains unknown and a mismatched steer response supplies no image acceptance evidence", async () => {
  for (const mode of ["lost", "wrong-turn"]) {
    const f = await fixture(mode), provider = await openCodexProvider(f.options);
    try {
      const input = f.input([await f.image()]);
      if (mode === "lost") {
        rpcPolicy.timeoutMs = 20; await expect(provider.send(input.value, input.operationId, null)).rejects.toBeInstanceOf(NativeRpcTimeoutError); expect(f.observations).toEqual([]);
      } else {
        await provider.send(input.value, input.operationId, null); const steer = f.input([await f.image()], "image-turn"), count = f.observations.length;
        await expect(provider.send(steer.value, steer.operationId, "image-turn")).rejects.toThrow("receipt is unknown"); expect(f.observations).toHaveLength(count);
      }
      expect((await f.requests()).filter(request => request.method === "turn/start")).toHaveLength(1);
    } finally { rpcPolicy.timeoutMs = 30_000; await provider.close(); await f.cleanup(); }
  }
});

test("native inline bytes remain leased until actual decoding finishes and are released after original commit", async () => {
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 4, background: "red" } }).png().toBuffer();
  const f = await fixture("normal", [{ id: "generated", type: "imageGeneration", status: "completed", result: bytes.toString("base64") }]);
  let release!: () => void, entered!: () => void, inputPath = "", request!: ImageCaptureRequest;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const receipt = (state: "reserved" | "committed") => ({ captureId: request.captureId, attemptId: request.attemptId, occurrence: request.occurrence, revision: state === "committed" ? "2" : "1", state, resourceId: state === "committed" ? "11111111-1111-4111-8111-111111111111" : null, resource: null, error: null });
  f.options.prepareImageCapture = async value => { request = value; };
  f.options.stageImageCapture = async input => {
    inputPath = input.inputPath; entered(); await gate;
    return validateImageFile({ version: 1, policy: "image-validation-v1", inputPath, expectedByteLength: input.byteLength, expectedSha256: input.sha256 });
  };
  f.options.submitImageCapture = async () => receipt("committed");
  const provider = await openCodexProvider(f.options);
  try {
    await started; expect(existsSync(inputPath)).toBe(true);
    expect(await provider.refreshControls!()).toEqual({ disposition: "handled" });
    release();
    await vi.waitFor(() => expect(f.entries.at(-1)).toMatchObject({ kind: "tool_call", output: [{ type: "image", resourceId: "11111111-1111-4111-8111-111111111111" }] }));
    expect(existsSync(inputPath)).toBe(false);
  } finally { release(); await provider.close(); await f.cleanup(); }
});

test("a start response inconsistent with the observed native turn remains unknown", async () => {
  const f = await fixture("wrong-start"), provider = await openCodexProvider(f.options);
  try {
    const input = f.input([await f.image()]);
    await expect(provider.send(input.value, input.operationId, null)).rejects.toThrow("receipt is unknown");
    expect(f.observations).toEqual([]); expect(f.captures).toEqual([]);
    expect((await f.requests()).filter(request => request.method === "turn/start")).toHaveLength(1);
  } finally { await provider.close(); await f.cleanup(); }
});
