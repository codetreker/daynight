import { expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import { openNativeMediaSpool } from "../../../src/commands/controller/media/native-spool.js";
import { inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
// The package test command builds these production helper entries before collection.
import { queryClaudeLive, claudeLiveImage, releaseClaudeLiveRecord } from "../../../dist/commands/controller/providers/claude-live.js";
import { openClaudeProvider } from "../../../dist/commands/controller/providers/claude.js";

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

test("an unexpectedly killed helper never confirms its still-running native child stopped", async () => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-live-loss-")); let child!: ChildProcess; const proofs: ProcessProof[] = [];
  const env = { ...process.env, DAYNIGHT_TEST_CLAUDE_HOLD_ON_EOF: "1" };
  const native = queryClaudeLive({ prompt: (async function* () {})(), options: { cwd: root, sessionId: randomUUID(), pathToClaudeCodeExecutable: path.resolve("test/commands/controller/fixtures/claude-live-native.mjs"), env } }, { cwd: root, env, onSpawn: (process: ChildProcess) => { child = process; }, onNativeProcessProof: (proof: ProcessProof) => { proofs.push(proof); } } as unknown as ProviderOptions);
  const pump = (async () => { for await (const event of native) releaseClaudeLiveRecord(event); })().catch(error => error);
  try {
    await native.initializationResult(); expect(proofs).toHaveLength(1);
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
    expect(await inspectProcessProof(proofs[0]!)).toBe("running");
    await expect(native.join()).rejects.toThrow(/closed|unknown/); expect(await pump).toBeInstanceOf(Error);
    await expect(native.join()).rejects.toThrow(/closed|unknown/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGTERM"); await exited; }
    for (const proof of proofs) if (await inspectProcessProof(proof) === "running") process.kill(proof.pid, "SIGTERM");
    for (const proof of proofs) await expect.poll(() => inspectProcessProof(proof)).toBe("stopped");
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("the actual Claude adapter submits image-only input once and waits for durable root evidence", async () => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-adapter-images-")), log = path.join(root, "native.jsonl"), imagePath = path.join(root, "image.png"), spoolDirectory = path.join(root, "spools"); await mkdir(spoolDirectory);
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]), image = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), localPath: imagePath, mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") }; await writeFile(imagePath, bytes, { mode: 0o400 });
  const operationId = randomUUID(), saved = new Map<string, unknown>(), observed: unknown[] = [], children: ChildProcess[] = [];
  const command: any = { kind: "send_message", operationId, payload: { expectedTurnId: null, target: { expectedNativeSessionId: null }, content: [{ ...image, uploadId: randomUUID() }] } };
  const provider = await openClaudeProvider({ cwd: root, model: null, args: [], resumeNativeSessionId: null, executable: path.resolve("test/commands/controller/fixtures/claude-live-native.mjs"), env: { ...process.env, ANTHROPIC_BASE_URL: "https://api.anthropic.com", CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "0", CLAUDE_CODE_USE_FOUNDRY: "0", DAYNIGHT_TEST_CLAUDE_LIVE_LOG: log },
    imageRuntime: { getIntent: id => id === operationId ? { command, sha256: "c".repeat(64), state: "unknown" } : null, readState: key => saved.get(key), writeState: (key, value) => { saved.set(key, structuredClone(value)); }, indexDirectory: () => root, reserveIndex() {}, acquireIndexReservation: () => ({ release() {} }), createSpool: maximum => openNativeMediaSpool(path.join(spoolDirectory, randomUUID()), maximum, () => {}, () => {}) },
    onTimeline() {}, onState() {}, onSpawn: child => { children.push(child); }, onInputObserved: value => { observed.push(value); return observed.length > 1; }, imageOccurrenceAcknowledged: () => false,
  });
  try {
    await expect(provider.send({ content: [image] }, operationId, null)).resolves.toEqual({ disposition: "started", turnId: operationId });
    expect(observed.length).toBeGreaterThanOrEqual(2); expect(observed.at(-1)).toMatchObject({ provider: "claude", operationId, nativeMessageId: operationId, intentSha256: "c".repeat(64) });
    await expect(provider.send({ content: [image] }, randomUUID(), operationId)).rejects.toThrow("steering");
    await expect(provider.send({ content: [image, { ...image, sha256: "f".repeat(64) }] }, randomUUID(), null)).rejects.toThrow("integrity");
    const records = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)); expect(records.filter(row => row.event === "input")).toHaveLength(1);
  } finally { await provider.close(); expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true); expect(await readdir(spoolDirectory)).toEqual([]); await rm(root, { recursive: true, force: true }); }
}, 20_000);

test.each(["success", "blocked"])("the actual adapter never accepts a zero-turn %s terminal without root execution", async mode => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-zero-turns-")), imagePath = path.join(root, "image.png");
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]), image = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), localPath: imagePath, mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") }; await writeFile(imagePath, bytes, { mode: 0o400 });
  const operationId = randomUUID(), saved = new Map<string, unknown>(), observed: unknown[] = [], children: ChildProcess[] = [];
  const command: any = { kind: "send_message", operationId, payload: { expectedTurnId: null, target: { expectedNativeSessionId: null }, content: [{ ...image, uploadId: randomUUID() }] } };
  const provider = await openClaudeProvider({ cwd: root, model: null, args: [], resumeNativeSessionId: null, executable: path.resolve("test/commands/controller/fixtures/claude-live-native.mjs"), env: { ...process.env, ANTHROPIC_BASE_URL: "https://api.anthropic.com", CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "0", CLAUDE_CODE_USE_FOUNDRY: "0", DAYNIGHT_TEST_CLAUDE_RESULT_ONLY: mode },
    imageRuntime: { getIntent: id => id === operationId ? { command, sha256: "c".repeat(64), state: "unknown" } : null, readState: key => saved.get(key), writeState: (key, value) => { saved.set(key, structuredClone(value)); }, indexDirectory: () => root, reserveIndex() {}, acquireIndexReservation: () => ({ release() {} }), createSpool() { throw new Error("This terminal has no output images."); } },
    onTimeline() {}, onState() {}, onSpawn: child => { children.push(child); }, onInputObserved: value => { observed.push(value); return true; }, imageOccurrenceAcknowledged: () => false,
  });
  try { await expect(provider.send({ content: [image] }, operationId, null)).rejects.toThrow("root execution"); expect(observed).toEqual([]); }
  finally { await provider.close(); expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true); await rm(root, { recursive: true, force: true }); }
}, 20_000);
