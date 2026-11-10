import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import { inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
const { queryClaudeLive, claudeLiveImage, releaseClaudeLiveRecord } = await import(new URL("../../../dist/commands/controller/providers/claude-live.js", import.meta.url).href) as typeof import("../../../src/commands/controller/providers/claude-live.js");
const { openNativeMediaSpool } = await import(new URL("../../../dist/commands/controller/media/native-spool.js", import.meta.url).href) as typeof import("../../../src/commands/controller/media/native-spool.js");

for (const mode of ["oversized", "pending-budget"] as const) test(`Claude real SDK helper isolates a large ${mode} native frame`, async () => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/claude-live-stress-")), log = path.join(root, "native.jsonl"), spoolDirectory = path.join(root, "spools"); await mkdir(spoolDirectory);
  const proofs: ProcessProof[] = []; let child!: ChildProcess, metadataPeak = 0, decodedPeak = 0, reserved = 0, reservedPeak = 0, helperRssKiB = 0, sampling = false;
  const environment = { ...process.env, DAYNIGHT_TEST_CLAUDE_LIVE_LOG: log, DAYNIGHT_TEST_CLAUDE_LIVE_STRESS: mode };
  const native = queryClaudeLive({ prompt: (async function* () {})(), options: { cwd: root, sessionId: randomUUID(), pathToClaudeCodeExecutable: path.resolve("test/commands/controller/fixtures/claude-live-native.mjs"), env: environment, includePartialMessages: true } }, {
    cwd: root, env: environment,
    onSpawn: (process: ChildProcess) => { child = process; child.on("message", (value: any) => {
      metadataPeak = Math.max(metadataPeak, Buffer.byteLength(JSON.stringify(value)));
      if (value.method === "media" && value.value.action === "chunk") decodedPeak = Math.max(decodedPeak, Buffer.from(value.value.data, "base64").length);
    }); },
    onNativeProcessProof: (proof: ProcessProof) => { proofs.push(proof); },
    imageRuntime: { createSpool(maximum: number) {
      let held = 0;
      return openNativeMediaSpool(path.join(spoolDirectory, randomUUID()), maximum, bytes => {
        const total = reserved - held + bytes; if (total > 33_554_432) throw new Error("Pending media budget exceeded.");
        reserved = total; held = bytes; reservedPeak = Math.max(reservedPeak, reserved);
      }, () => { reserved -= held; held = 0; });
    } },
  } as unknown as ProviderOptions);
  const timer = process.platform === "win32" ? undefined : setInterval(() => {
    if (!child?.pid || sampling) return; sampling = true;
    execFile("ps", ["-o", "rss=", "-p", String(child.pid)], { timeout: 1000 }, (error, stdout) => { if (!error) helperRssKiB = Math.max(helperRssKiB, Number(stdout.trim()) || 0); sampling = false; });
  }, 50);
  const iterator = native[Symbol.asyncIterator](); let current: unknown;
  try {
    await native.initializationResult();
    await native.submit({ uuid: randomUUID(), sessionId: randomUUID(), input: { content: [{ type: "text", text: "large output" }] } });
    current = (await iterator.next()).value; expect(current).toMatchObject({ type: "system" }); releaseClaudeLiveRecord(current);
    current = (await iterator.next()).value;
    // The event acknowledgement is held while a separate control RPC completes.
    expect(await native.supportedModels()).toEqual([expect.objectContaining({ value: "claude-sonnet-5-5" })]);
    const content = (current as any).message.content as any[];
    expect(content[0]).toEqual({ type: "text", text: "before" }); expect(content.at(-1)).toEqual({ type: "text", text: "after" });
    if (mode === "oversized") {
      expect(content[1].source.data).toMatchObject({ kind: "claude_live_unavailable", error: "image_too_large" }); expect(reservedPeak).toBe(0);
    } else {
      for (let index = 0; index < 3; index++) {
        const source = claudeLiveImage(content[index + 1].source.data); expect(source?.byteLength).toBe(String(9 * 1024 * 1024));
        const lease = source!.retain(); try {
          expect(createHash("sha256").update(await readFile(lease.path)).digest("hex")).toBe(createHash("sha256").update(Buffer.alloc(9 * 1024 * 1024, index + 1)).digest("hex"));
        } finally { lease.release(); }
      }
      expect(content[4].source.data).toMatchObject({ kind: "claude_live_unavailable", error: "source_unavailable" });
      expect(reservedPeak).toBeLessThanOrEqual(33_554_432); expect(reservedPeak).toBeGreaterThan(27 * 1024 * 1024);
    }
    expect(metadataPeak).toBeLessThanOrEqual(1_048_576); expect(decodedPeak).toBeLessThanOrEqual(49_152);
    const recorded = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(value => value.event === "stress"); expect(recorded.frameBytes).toBeGreaterThan(32 * 1024 * 1024);
    process.stdout.write(JSON.stringify({ mode, ...recorded, metadataPeak, decodedPeak, reservedPeak, helperRssKiB, helperHeapLimitMiB: 512 }) + "\n");
  } finally {
    if (timer) clearInterval(timer); releaseClaudeLiveRecord(current); await iterator.return?.(); native.close(); await native.join();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true); for (const proof of proofs) expect(await inspectProcessProof(proof)).toBe("stopped");
    expect(reserved).toBe(0); expect(await readdir(spoolDirectory)).toEqual([]); await rm(root, { recursive: true, force: true });
  }
}, 60_000);
