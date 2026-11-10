import { expect, test } from "vitest";
import { type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { openClaudeTranscriptHelper as OpenHelper } from "../../../src/commands/controller/providers/claude-transcript-helper.js";

test.each([{ count: 1, imageBytes: 25 * 1024 * 1024, available: false }, { count: 3, imageBytes: 9 * 1024 * 1024, available: true }])("streams a greater-than-32-MiB transcript line through a real bounded helper: %j", async ({ count, imageBytes, available }) => {
  await mkdir(".tmp", { recursive: true }); const root = await mkdtemp(path.resolve(".tmp/claude-history-stress-"));
  const nativeHome = path.join(root, "native"), cwd = path.join(root, "workspace"), nativeSessionId = randomUUID(), indexDirectory = path.join(root, "index"), compiled = path.join(root, "compiled");
  const transcriptPath = path.join(nativeHome, "projects", "authorized-project", `${nativeSessionId}.jsonl`);
  let child: ChildProcess | undefined, close: (() => Promise<void>) | undefined;
  const started = performance.now(), rssBefore = process.resourceUsage().maxRSS;
  try {
    await mkdir(path.dirname(transcriptPath), { recursive: true }); await mkdir(cwd); await mkdir(indexDirectory, { mode: 0o700 }); await mkdir(compiled);
    await mkdir(path.join(compiled, "providers"));
    for (const name of ["claude-transcript-json", "claude-transcript", "claude-transcript-helper"]) await writeFile(path.join(compiled, "providers", `${name}.js`), stripTypeScriptTypes(await readFile(`src/commands/controller/providers/${name}.ts`, "utf8"), { mode: "transform" }));
    for (const name of ["process-proof", "windows-job", "windows-process-proof"]) await writeFile(path.join(compiled, `${name}.js`), stripTypeScriptTypes(await readFile(`src/commands/controller/${name}.ts`, "utf8"), { mode: "transform" }));
    const helper: typeof OpenHelper = (await import(/* @vite-ignore */ pathToFileURL(path.join(compiled, "providers", "claude-transcript-helper.js")).href)).openClaudeTranscriptHelper;
    const file = await open(transcriptPath, "wx", 0o600), raw = Buffer.alloc(49_152, 149), expected = createHash("sha256");
    try {
      await file.write(JSON.stringify({ uuid: "u", parentUuid: null, type: "user", sessionId: nativeSessionId, cwd }).slice(0, -1) + ',"message":{"role":"user","content":[{"type":"text","text":"before"}');
      for (let image = 0; image < count; image++) {
        await file.write(',{"type":"image","source":{"type":"base64","media_type":"image/png","data":"');
        for (let remaining = imageBytes; remaining > 0;) {
          const bytes = raw.subarray(0, Math.min(remaining, raw.length)); await file.write(bytes.toString("base64")); if (!image) expected.update(bytes); remaining -= bytes.length;
        }
        await file.write('"}}');
      }
      await file.write(',{"type":"text","text":"after"}]}}\n');
    } finally { await file.close(); }
    const encodedBytes = (await stat(transcriptPath)).size; expect(encodedBytes).toBeGreaterThan(32 * 1024 * 1024);
    let activeReservations = 0, maxReservation = 0, maxChunk = 0, streamedBytes = 0;
    const reader = await helper({ nativeHome, cwd, nativeSessionId, transcriptPath, indexDirectory,
      onSpawn: process => { child = process; },
      acquireIndexReservation: bytes => { expect(activeReservations).toBe(0); activeReservations++; maxReservation = Math.max(bytes, maxReservation); return { release: () => { activeReservations--; } }; },
    }); close = reader.close;
    const page = await reader.nextPage(); expect(page.records).toHaveLength(1); expect(page.records[0]?.media).toHaveLength(count); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(8192);
    expect(page.records[0]?.value.message).toMatchObject({ content: expect.arrayContaining([{ type: "text", text: "before" }, { type: "text", text: "after" }]) });
    await reader.acknowledge(page.cursor); const digest = expected.digest("hex");
    for (const media of page.records[0]!.media) {
      expect(media.byteLength).toBe(imageBytes); expect(media.state).toBe(available ? "available" : "unavailable");
      if (!available) { expect(media.error).toBe("image_too_large"); await expect(reader.readMedia(media.mediaId, () => { throw new Error("must not consume"); })).rejects.toThrow("unavailable"); continue; }
      const observed = createHash("sha256"); await reader.readMedia(media.mediaId, bytes => { maxChunk = Math.max(maxChunk, bytes.length); streamedBytes += bytes.length; observed.update(bytes); }); expect(observed.digest("hex")).toBe(digest);
    }
    expect(maxChunk).toBeLessThanOrEqual(49_152); expect(streamedBytes).toBe(available ? count * imageBytes : 0); expect(activeReservations).toBe(0);
    await reader.close(); close = undefined; expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true); expect(await readdir(indexDirectory)).toEqual([]);
    process.stdout.write(JSON.stringify({ count, imageBytes, encodedBytes, streamedBytes, maxChunk, maxReservation, elapsedMs: Math.round(performance.now() - started), maxRSSBeforeKiB: rssBefore, maxRSSAfterKiB: process.resourceUsage().maxRSS, nodeVersion: process.version, evidence: "controlled-native-JSONL-and-real-helper; no model, SDK execution or image decoder" }) + "\n");
  } finally {
    if (close) await close();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolve => child!.once("exit", () => resolve())); child.kill("SIGKILL"); await exited; }
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
