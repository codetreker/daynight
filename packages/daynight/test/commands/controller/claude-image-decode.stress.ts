import { expect, test } from "vitest";
import { type ChildProcess } from "node:child_process";
import { createHash, randomFillSync, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { ImageCaptureRequest, ValidatedImage } from "../../../src/session/image-values.js";
const { openClaudeTranscriptHelper } = await import(new URL("../../../dist/commands/controller/providers/claude-transcript-helper.js", import.meta.url).href) as typeof import("../../../src/commands/controller/providers/claude-transcript-helper.js");
const { openControllerLifecycleStore } = await import(new URL("../../../dist/commands/controller/lifecycle-store.js", import.meta.url).href) as typeof import("../../../src/commands/controller/lifecycle-store.js");
const { createImageDecoder } = await import(new URL("../../../dist/commands/controller/media/image-decoder.js", import.meta.url).href) as typeof import("../../../src/commands/controller/media/image-decoder.js");
const { releaseControllerMediaBudget } = await import(new URL("../../../dist/commands/controller/media/budget-ledger.js", import.meta.url).href) as typeof import("../../../src/commands/controller/media/budget-ledger.js");

test("valid large Claude history originals survive bounded helper reads, public staging and complete isolated decoding", async () => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-valid-decode-"));
  const nativeHome = path.join(root, "native"), cwd = path.join(root, "workspace"), nativeSessionId = randomUUID(), stateDirectory = path.join(root, "state"), executionId = randomUUID();
  const executionDirectory = path.join(stateDirectory, "controller", "executions", executionId), file = path.join(executionDirectory, "journal.sqlite"), png = path.join(root, "large.png"), gif = path.join(root, "animated.gif");
  const transcriptPath = path.join(nativeHome, "projects", "authorized-project", `${nativeSessionId}.jsonl`);
  await mkdir(executionDirectory, { recursive: true, mode: 0o700 }); await mkdir(cwd); await mkdir(path.dirname(transcriptPath), { recursive: true });
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", testExecutionId: randomUUID(), ownerUserId: randomUUID(), provider: "claude", cwd, nativeHome, configuration: { agent: "claude", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialInput: "none", initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"), ipcEndpoint: path.join(root, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const manifest = JSON.parse(await readFile("dist/commands/controller/media/image-validation-manifest.json", "utf8"));
  const decoderPeaks: number[] = [], decoder = createImageDecoder({ runtimePath: process.execPath, helperPath: path.resolve("dist/commands/controller/media/image-validation-helper.js"), enginePath: path.resolve("dist/commands/controller/media/image-validation.js"), buildId: manifest.buildId, helperSha256: manifest.helperSha256, engineSha256: manifest.engineSha256, onPeakRss: bytes => decoderPeaks.push(bytes) });
  const options = { imageDecoder: decoder, mediaStateDirectory: stateDirectory }, captures: { request: ImageCaptureRequest; validated: ValidatedImage }[] = [];
  let journal = openControllerLifecycleStore(file, ticket, options), reader: Awaited<ReturnType<typeof openClaudeTranscriptHelper>> | undefined, child: ChildProcess | undefined, maxChunk = 0, transferred = 0;
  try {
    journal.patchSnapshot({ nativeSessionId });
    await sharp(randomFillSync(Buffer.alloc(2048 * 1152 * 4)), { raw: { width: 2048, height: 1152, channels: 4 } }).png({ compressionLevel: 0 }).toFile(png);
    const pixels = Buffer.alloc(8 * 16 * 4, 255); pixels.fill(0, 0, 8 * 8 * 4);
    await sharp(pixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).gif({ loop: 0, delay: [40, 40] }).toFile(gif);
    const pngBytes = (await stat(png)).size; expect(pngBytes).toBeGreaterThan(9 * 1024 * 1024); expect(pngBytes).toBeLessThan(10 * 1024 * 1024);
    const files = [png, png, png, png, gif], expected: { byteLength: string; sha256: string; mediaType: string; frames: number }[] = [];
    const transcript = await open(transcriptPath, "wx", 0o600);
    try {
      await transcript.write(JSON.stringify({ type: "user", uuid: "input", parentUuid: null, sessionId: nativeSessionId, cwd, message: { role: "user", content: "output original images" } }) + "\n");
      await transcript.write(JSON.stringify({ type: "assistant", uuid: "output", parentUuid: "input", sessionId: nativeSessionId, cwd }).slice(0, -1) + ',"message":{"id":"images","role":"assistant","content":[{"type":"text","text":"before"}');
      for (const [index, filename] of files.entries()) {
        const mediaType = index === 4 ? "image/gif" : "image/png", digest = createHash("sha256"); let size = 0;
        await transcript.write(',{"type":"image","source":{"type":"base64","media_type":' + JSON.stringify(mediaType) + ',"data":"');
        for await (const chunk of createReadStream(filename, { highWaterMark: 49_152 })) { const bytes = chunk as Buffer; digest.update(bytes); size += bytes.length; await transcript.write(bytes.toString("base64")); }
        await transcript.write('"}}'); expected.push({ byteLength: String(size), sha256: digest.digest("hex"), mediaType, frames: index === 4 ? 2 : 1 });
      }
      await transcript.write(',{"type":"text","text":"after"}]}}\n');
    } finally { await transcript.close(); }
    const encodedBytes = (await stat(transcriptPath)).size; expect(encodedBytes).toBeGreaterThan(32 * 1024 * 1024);
    reader = await openClaudeTranscriptHelper({ nativeHome, cwd, nativeSessionId, transcriptPath, indexDirectory: journal.media().nativeIndexDirectory(), acquireIndexReservation: journal.acquireNativeIndexReservation, onSpawn: process => { child = process; } });
    const page = await reader.nextPage(), row = page.records.find(record => record.value.uuid === "output")!; expect(row.media).toHaveLength(5); await reader.acknowledge(page.cursor);
    for (const [index, media] of row.media.entries()) {
      expect(media.state).toBe("available");
      const imageId = randomUUID(), entryId = randomUUID(), nativeSource = { provider: "claude" as const, nativeSessionId, nativeMessageId: "images", nativePartId: `content:${index + 1}` };
      const occurrence = { imageId, entryId, container: "content" as const, partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: `native-image:${index}` };
      journal.projectTimeline({ entryId, revision: "1", kind: "assistant_message", imageProjectionError: null, content: [{ type: "image_unavailable", imageId, label: "Original", error: { code: "capture_pending", message: "Capture pending." } }] });
      journal.registerImageOccurrence(occurrence, nativeSource); journal.acknowledgeEvents(journal.getLastSourceSequence());
      const request: ImageCaptureRequest = { captureId: randomUUID(), attemptId: randomUUID(), occurrence, nativeSource, locator: { kind: "native", ...nativeSource } }; journal.registerImageCaptureRequest(request);
      const spool = journal.media().createSpool(media.byteLength), digest = createHash("sha256");
      try {
        await reader.readMedia(media.mediaId, bytes => { maxChunk = Math.max(maxChunk, bytes.length); transferred += bytes.length; digest.update(bytes); spool.write(bytes); }); spool.seal();
        const sha256 = digest.digest("hex"); expect(sha256).toBe(expected[index]!.sha256);
        const validated = await journal.media().stageCapture({ captureId: request.captureId, attemptId: request.attemptId, imageId, inputPath: spool.path, byteLength: String(media.byteLength), sha256 });
        expect(validated).toMatchObject({ byteLength: expected[index]!.byteLength, sha256, mediaType: expected[index]!.mediaType, frameCount: expected[index]!.frames }); captures.push({ request, validated });
      } finally { spool.remove(); }
      expect(existsSync(spool.path)).toBe(false); expect(await readdir(`${file}.media-staging/wire`)).toEqual([]);
    }
    await reader.close(); reader = undefined; expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true); expect(await readdir(`${file}.native-index`)).toEqual([]);
    await rm(nativeHome, { recursive: true }); await rm(png); await rm(gif);
    await journal.stopMedia(); journal.close(); journal = openControllerLifecycleStore(file, ticket, options);
    for (const { request, validated } of captures) {
      expect(journal.media().captureStatus(request.captureId, request.attemptId)).toEqual(validated);
      const digest = createHash("sha256"); let offset = 0;
      for (;;) {
        const chunk = await journal.media().readCapture({ captureId: request.captureId, attemptId: request.attemptId, sha256: validated.sha256, byteLength: validated.byteLength, offset: String(offset), limit: 524_288 });
        const bytes = Buffer.from(chunk.data, "base64"); digest.update(bytes); offset += bytes.length; if (chunk.eof) break;
      }
      expect(digest.digest("hex")).toBe(validated.sha256);
    }
    expect(decoderPeaks).toHaveLength(5); expect(maxChunk).toBeLessThanOrEqual(49_152);
    process.stdout.write(JSON.stringify({ evidence: "controlled Claude transcript, real bounded helper, real journal/public stage and isolated complete decoder; no real model or service commit", encodedBytes, transferred, maxChunk, originals: expected, decoderPeakRssBytes: Math.max(...decoderPeaks), sourceRemovedBeforeJournalReopen: true, captureCopiesReadableAfterReopen: captures.length }) + "\n");
  } finally {
    await reader?.close(); await journal.stopMedia(); journal.close(); await rm(executionDirectory, { recursive: true, force: true });
    releaseControllerMediaBudget(stateDirectory, executionId, executionDirectory);
    const ledgerFile = path.join(stateDirectory, "controller", "media", "budget.sqlite");
    if (existsSync(ledgerFile)) { const ledger = new Database(ledgerFile, { readonly: true }); try { expect(ledger.prepare("SELECT COUNT(*) AS count FROM allocations WHERE execution_id=?").get(executionId)).toEqual({ count: 0 }); } finally { ledger.close(); } }
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
