import { expect, onTestFinished, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import sharp from "sharp";
import type { NativeInput, ProviderOptions, ProviderState } from "../../../src/commands/controller/providers/types.js";
import { openNativeMediaSpool } from "../../../src/commands/controller/media/native-spool.js";
import { inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { stopNativeFixture, withCleanup, withNativeFixtureExit } from "./claude-live-loss-cleanup.js";
// The package test command builds these production helper entries before collection.
const { queryClaudeLive, claudeLiveImage, releaseClaudeLiveRecord } = await import(new URL("../../../dist/commands/controller/providers/claude-live.js", import.meta.url).href) as typeof import("../../../src/commands/controller/providers/claude-live.js");
const { openClaudeProvider } = await import(new URL("../../../dist/commands/controller/providers/claude.js", import.meta.url).href) as typeof import("../../../src/commands/controller/providers/claude.js");
const { ClaudeControls } = await import(new URL("../../../dist/commands/controller/providers/controls-claude.js", import.meta.url).href) as typeof import("../../../src/commands/controller/providers/controls-claude.js");
const { authorizeNativeImageInput } = await import(new URL("../../../dist/commands/controller/providers/image-admission.js", import.meta.url).href) as typeof import("../../../src/commands/controller/providers/image-admission.js");

const authorizeControlledInput = (input: NativeInput, state: ProviderState | undefined): NativeInput => {
  if (!state?.images) throw new Error("Controlled image capability was not published.");
  return authorizeNativeImageInput({ content: input.content.map(part => part.type === "image" ? { ...part, validated: { mediaType: "image/png", byteLength: part.byteLength, sha256: part.sha256, width: 1, height: 1, frameCount: 1 } } : part) }, { ...state.images, revision: "7", providerRevision: "1" }, () => {});
};

const enableControlledImageInput = () => {
  const original = ClaudeControls.prototype.imageCapabilities;
  return vi.spyOn(ClaudeControls.prototype, "imageCapabilities").mockImplementation(function (this: InstanceType<typeof ClaudeControls>, ...args) {
    return { ...original.apply(this, args), send: "supported", reasonCode: null, inputMediaTypes: ["image/png", "image/jpeg", "image/webp"], maxImageBytes: "3750000", maxMessageImageBytes: "20971520", maxImagesPerMessage: 8, geometry: { version: 1, known: true, maxWidth: 3000, maxHeight: 3000, maxPixels: 9_000_000, maxFrames: 1 } };
  });
};

test("actual SDK helper joins its native child, preserves control RPC and transfers image bytes through bounded frames", async () => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-live-process-")), log = path.join(root, "native.jsonl"), imagePath = path.join(root, "image.png"), spoolDirectory = path.join(root, "spools"); await mkdir(spoolDirectory);
  const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(80_003, 72)]), sessionId = randomUUID(), uuid = randomUUID(); await writeFile(imagePath, bytes, { mode: 0o400 });
  const nativeProofs: ProcessProof[] = [], events: any[] = [], transfers: Buffer[] = []; let child!: ChildProcess, peakFrame = 0;
  const owner = { cwd: root, env: { ...process.env, DAYNIGHT_TEST_CLAUDE_LIVE_LOG: log },
    onSpawn: (process: ChildProcess) => { child = process; child.on("message", value => { peakFrame = Math.max(peakFrame, Buffer.byteLength(JSON.stringify(value))); }); },
    onNativeProcessProof: (proof: ProcessProof) => { nativeProofs.push(proof); },
    imageRuntime: { createSpool: (maximum: number) => openNativeMediaSpool(path.join(spoolDirectory, randomUUID()), maximum, () => {}, () => {}) },
  } as unknown as ProviderOptions;
  const native = queryClaudeLive({ prompt: (async function* () {})(), options: { cwd: root, sessionId, pathToClaudeCodeExecutable: path.resolve("test/commands/controller/fixtures/claude-live-native.mjs"), env: owner.env ?? process.env, includePartialMessages: true } }, owner);
  const pump = (async () => { for await (const event of native) {
    events.push(event);
    const raw = event as any; if (raw.type === "user") for (const part of raw.message.content) {
      const source = claudeLiveImage(part.source?.data); if (!source) continue;
      const lease = source.retain(); try { transfers.push(await readFile(lease.path)); } finally { lease.release(); }
    }
    releaseClaudeLiveRecord(event);
  } })();
  try {
    await native.initializationResult(); expect(native.profile).toMatchObject({ sdkVersion: "0.3.247", cliVersion: "2.1.247" });
    expect(await native.supportedModels()).toEqual([expect.objectContaining({ value: "claude-sonnet-5-5" })]);
    await native.submit({ uuid, sessionId, input: { content: [{ type: "text", text: "look" }, { type: "image", imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), localPath: imagePath }] } });
    await expect.poll(() => events.some(event => event.type === "result")).toBe(true);
    expect(transfers).toEqual([bytes]); expect(peakFrame).toBeLessThanOrEqual(1_048_576);
    const records = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records.filter(row => row.event === "input")).toEqual([{ event: "input", uuid, blocks: [{ type: "text", text: "look" }, { type: "image", sha256: createHash("sha256").update(bytes).digest("hex") }] }]);
    expect(nativeProofs).toHaveLength(1); expect(nativeProofs[0]?.parentPid).toBe(child.pid);
  } finally {
    native.close(); await native.join(); await pump;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    for (const proof of nativeProofs) expect(await inspectProcessProof(proof)).toBe("stopped");
    expect(await readdir(spoolDirectory)).toEqual([]); await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test.each(["read", "unknown-metadata"])("the SDK helper bounds duplicate Read images and tool text and cleans every transfer after %s", async mode => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-live-read-")), imagePath = path.join(root, "image.png"), spoolDirectory = path.join(root, "spools"); await mkdir(spoolDirectory);
  const bytes = await sharp(Buffer.alloc(520 * 520 * 3, 73), { raw: { width: 520, height: 520, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  await writeFile(imagePath, bytes, { mode: 0o400 });
  const sessionId = randomUUID(), proofs: ProcessProof[] = [], events: any[] = [], media: Buffer[] = []; let child!: ChildProcess, peakFrame = 0, spools = 0;
  const owner = { cwd: root, env: { ...process.env, DAYNIGHT_TEST_CLAUDE_READ_RESULT: mode }, onSpawn: (process: ChildProcess) => { child = process; child.on("message", value => { peakFrame = Math.max(peakFrame, Buffer.byteLength(JSON.stringify(value))); }); }, onNativeProcessProof: (proof: ProcessProof) => { proofs.push(proof); }, imageRuntime: { createSpool: (maximum: number) => { spools++; return openNativeMediaSpool(path.join(spoolDirectory, randomUUID()), maximum, () => {}, () => {}); } } } as unknown as ProviderOptions;
  const native = queryClaudeLive({ prompt: (async function* () {})(), options: { cwd: root, sessionId, pathToClaudeCodeExecutable: path.resolve("test/commands/controller/fixtures/claude-live-native.mjs"), env: owner.env ?? process.env } }, owner);
  const pump = (async () => { for await (const event of native) {
    events.push(event);
    const value = event as any;
    try {
      if (value.type !== "user") continue;
      const content = value.message.content[0].content, marker = content[1].source.data;
      expect(value.tool_use_result.file.base64).toBe(marker);
      expect(value.tool_use_result.file.dimensions).toEqual({ originalWidth: 520, originalHeight: 520, displayWidth: 520, displayHeight: 520 });
      expect(content[0]).toEqual({ type: "text", text: "before" }); expect(content[3]).toEqual({ type: "text", text: "after" });
      expect(content[2].text.length).toBeLessThanOrEqual(200_002); expect(content[2].text.isWellFormed()).toBe(true);
      const source = claudeLiveImage(marker); expect(source).not.toBeNull();
      const lease = source!.retain(); try { media.push(await readFile(lease.path)); } finally { lease.release(); }
    } finally { releaseClaudeLiveRecord(event); }
  } })().catch(error => error);
  try {
    await native.initializationResult();
    await native.submit({ uuid: randomUUID(), sessionId, input: { content: [{ type: "image", imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), localPath: imagePath }] } });
    if (mode === "read") {
      await expect.poll(() => events.some(event => event.type === "result")).toBe(true);
      expect(media).toHaveLength(1); expect(media[0]!.equals(bytes)).toBe(true);
      expect(await native.supportedModels()).toHaveLength(1);
    } else { expect(await pump).toBeInstanceOf(Error); expect(events.some(event => event.type === "user")).toBe(false); }
    expect(spools).toBe(1); expect(peakFrame).toBeLessThanOrEqual(1_048_576);
  } finally {
    try {
      native.close(); await native.join(); const pumpResult = await pump;
      if (mode === "read") expect(pumpResult).toBeUndefined();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      for (const proof of proofs) expect(await inspectProcessProof(proof)).toBe("stopped");
      expect(await readdir(spoolDirectory)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}, 20_000);

test("helper loss remains unknown even after native child stop is independently observed", async () => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-live-loss-")); let child!: ChildProcess; const proofs: ProcessProof[] = [];
  const token = randomUUID(); let control: Socket | undefined, closing = false, controlError: unknown;
  const server = createServer();
  const connected = new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native fixture control connection timed out.")), 10_000); timer.unref();
    server.once("connection", socket => {
      control = socket; if (closing) { socket.destroy(); return; }
      socket.on("error", error => { controlError = error; clearTimeout(timer); reject(error); });
      socket.once("end", () => { clearTimeout(timer); reject(new Error("Native fixture control connection closed before identification.")); });
      let received = "";
      socket.on("data", data => {
        received += data.toString();
        if (received.length >= token.length) {
          clearTimeout(timer);
          if (received === token) resolve(socket); else reject(new Error("Unexpected native fixture control connection."));
        }
      });
    });
  });
  void connected.catch(() => {});
  const stop = () => { if (controlError) throw controlError; if (control === undefined) throw new Error("Native fixture control connection is unavailable."); if (!control.destroyed && !control.writableEnded) control.end("stop"); };
  await withCleanup(async () => {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Native fixture control listener has no port.");
    const env = { ...process.env, DAYNIGHT_TEST_CLAUDE_HOLD_ON_EOF: "1", DAYNIGHT_TEST_CLAUDE_CONTROL_PORT: String(address.port), DAYNIGHT_TEST_CLAUDE_CONTROL_TOKEN: token };
    const native = queryClaudeLive({ prompt: (async function* () {})(), options: { cwd: root, sessionId: randomUUID(), pathToClaudeCodeExecutable: path.resolve("test/commands/controller/claude-live-loss-fixture.mjs"), env } }, { cwd: root, env, onSpawn: (process: ChildProcess) => { child = process; }, onNativeProcessProof: (proof: ProcessProof) => { proofs.push(proof); } } as unknown as ProviderOptions);
    const pump = (async () => { for await (const event of native) releaseClaudeLiveRecord(event); })().catch(error => error);
    await native.initializationResult(); expect(proofs).toHaveLength(1);
    await connected;
    expect(await inspectProcessProof(proofs[0]!)).toBe("running");
    await withNativeFixtureExit(proofs[0]!, async () => {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) }); child.kill("SIGKILL"); await exited;
      // Holding this fixture open after helper death is a POSIX mechanism. Every
      // platform still requires the missing helper stop receipt, even after exit.
      if (process.platform !== "win32") expect(await inspectProcessProof(proofs[0]!)).toBe("running");
      await expect(native.join()).rejects.toThrow(/closed|unknown/); expect(await pump).toBeInstanceOf(Error);
    }, stop);
    await expect(native.join()).rejects.toThrow(/closed|unknown/);
  }, async () => {
    const failures: unknown[] = [];
    const stopHelper = async () => { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) }); child.kill("SIGTERM"); await exited; } };
    try {
      if (proofs.length) {
        await withNativeFixtureExit(proofs[0]!, stopHelper, stop);
        for (const proof of proofs.slice(1)) await withNativeFixtureExit(proof, async () => {}, stop);
      } else await stopHelper();
    } catch (error) { failures.push(error); }
    closing = true;
    const closed = server.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    control?.destroy();
    try { await closed; } catch (error) { failures.push(error); }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Native fixture cleanup failed.");
  });
}, 20_000);

test("native fixture cleanup waits through exiting and never signals a replacement", async () => {
  const proof: ProcessProof = { pid: 1, parentPid: 2, processGroupId: null, startedAt: "birth", commandHash: "hash" };
  const stop = vi.fn(), observe = vi.fn().mockResolvedValueOnce("running").mockResolvedValueOnce("exiting").mockResolvedValueOnce("stopped");
  await stopNativeFixture(proof, stop, Date.now() + 1000, observe);
  expect(stop).toHaveBeenCalledOnce(); expect(observe).toHaveBeenCalledTimes(3);
  stop.mockClear();
  await expect(stopNativeFixture(proof, stop, Date.now() + 1000, vi.fn().mockResolvedValueOnce("exiting").mockResolvedValueOnce("stopped"))).resolves.toBeUndefined();
  expect(stop).not.toHaveBeenCalled();
  await expect(stopNativeFixture(proof, stop, Date.now() + 1000, vi.fn().mockResolvedValue("replaced"))).rejects.toThrow(/replaced/);
  expect(stop).not.toHaveBeenCalled();
  await expect(stopNativeFixture(proof, stop, Date.now() - 1, observe)).rejects.toThrow(/deadline/);
});

test("native fixture cleanup retains both test and cleanup errors", async () => {
  const body = new Error("body"), cleanup = new Error("cleanup");
  await expect(withCleanup(async () => { throw body; }, async () => { throw cleanup; })).rejects.toMatchObject({ errors: [body, cleanup] });
});

test("the actual Claude adapter submits image-only input once and waits for durable root evidence", async () => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-adapter-images-")), log = path.join(root, "native.jsonl"), imagePath = path.join(root, "image.png"), spoolDirectory = path.join(root, "spools"); await mkdir(spoolDirectory);
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer(), image = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), localPath: imagePath, mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") }; await writeFile(imagePath, bytes, { mode: 0o400 });
  let state: ProviderState | undefined;
  const operationId = randomUUID(), saved = new Map<string, unknown>(), observed: unknown[] = [], children: ChildProcess[] = [];
  const command: any = { kind: "send_message", operationId, payload: { expectedTurnId: null, target: { expectedNativeSessionId: null }, content: [{ ...image, uploadId: randomUUID() }] } };
  const capability = enableControlledImageInput(); onTestFinished(() => capability.mockRestore());
  const provider = await openClaudeProvider({ cwd: root, model: null, args: [], resumeNativeSessionId: null, executable: path.resolve("test/commands/controller/fixtures/claude-live-native.mjs"), env: { ...process.env, ANTHROPIC_BASE_URL: "https://api.anthropic.com", CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "0", CLAUDE_CODE_USE_FOUNDRY: "0", DAYNIGHT_TEST_CLAUDE_LIVE_LOG: log },
    imageRuntime: { getIntent: id => id === operationId ? { command, sha256: "c".repeat(64), state: "unknown" } : null, readState: key => saved.get(key), writeState: (key, value) => { saved.set(key, structuredClone(value)); }, indexDirectory: () => root, reserveIndex() {}, acquireIndexReservation: () => ({ release() {} }), createSpool: maximum => openNativeMediaSpool(path.join(spoolDirectory, randomUUID()), maximum, () => {}, () => {}) },
    onTimeline() {}, onState(value) { state = value; }, onSpawn: child => { children.push(child); }, onInputObserved: value => { observed.push(value); return observed.length > 1; }, imageOccurrenceAcknowledged: () => false,
  });
  try {
    await expect(provider.send(authorizeControlledInput({ content: [image] }, state), operationId, null)).resolves.toEqual({ disposition: "started", turnId: operationId });
    expect(observed.length).toBeGreaterThanOrEqual(2); expect(observed.at(-1)).toMatchObject({ provider: "claude", operationId, nativeMessageId: operationId, intentSha256: "c".repeat(64) });
    await expect(provider.send({ content: [image] }, randomUUID(), operationId)).rejects.toThrow("steering");
    await expect(provider.send({ content: [image, { ...image, sha256: "f".repeat(64) }] }, randomUUID(), null)).rejects.toThrow("integrity");
    const records = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)); expect(records.filter(row => row.event === "input")).toHaveLength(1);
  } finally { await provider.close(); expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true); expect(await readdir(spoolDirectory)).toEqual([]); await rm(root, { recursive: true, force: true }); }
}, 20_000);

test.each(["success", "blocked"])("the actual adapter never accepts a zero-turn %s terminal without root execution", async mode => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-zero-turns-")), imagePath = path.join(root, "image.png");
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer(), image = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), localPath: imagePath, mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") }; await writeFile(imagePath, bytes, { mode: 0o400 });
  let state: ProviderState | undefined;
  const operationId = randomUUID(), saved = new Map<string, unknown>(), observed: unknown[] = [], children: ChildProcess[] = [];
  const command: any = { kind: "send_message", operationId, payload: { expectedTurnId: null, target: { expectedNativeSessionId: null }, content: [{ ...image, uploadId: randomUUID() }] } };
  const capability = enableControlledImageInput(); onTestFinished(() => capability.mockRestore());
  const provider = await openClaudeProvider({ cwd: root, model: null, args: [], resumeNativeSessionId: null, executable: path.resolve("test/commands/controller/fixtures/claude-live-native.mjs"), env: { ...process.env, ANTHROPIC_BASE_URL: "https://api.anthropic.com", CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "0", CLAUDE_CODE_USE_FOUNDRY: "0", DAYNIGHT_TEST_CLAUDE_RESULT_ONLY: mode },
    imageRuntime: { getIntent: id => id === operationId ? { command, sha256: "c".repeat(64), state: "unknown" } : null, readState: key => saved.get(key), writeState: (key, value) => { saved.set(key, structuredClone(value)); }, indexDirectory: () => root, reserveIndex() {}, acquireIndexReservation: () => ({ release() {} }), createSpool() { throw new Error("This terminal has no output images."); } },
    onTimeline() {}, onState(value) { state = value; }, onSpawn: child => { children.push(child); }, onInputObserved: value => { observed.push(value); return true; }, imageOccurrenceAcknowledged: () => false,
  });
  try { await expect(provider.send(authorizeControlledInput({ content: [image] }, state), operationId, null)).rejects.toThrow("root execution"); expect(observed).toEqual([]); }
  finally { await provider.close(); expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true); await rm(root, { recursive: true, force: true }); }
}, 20_000);
