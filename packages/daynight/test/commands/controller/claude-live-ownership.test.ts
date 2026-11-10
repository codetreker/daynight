import { afterEach, expect, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import { openNativeMediaSpool } from "../../../src/commands/controller/media/native-spool.js";
import { inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";

// Exercise the source owner with the real compiled SDK worker. Fork still starts
// an actual helper and native child; no IPC or process outcome is simulated.
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, fork: (modulePath: string, ...args: unknown[]) => actual.fork(
    modulePath === path.resolve("src/commands/controller/providers/claude-live-worker.js") ? path.resolve("dist/commands/controller/providers/claude-live-worker.js") : modulePath,
    ...args as Parameters<typeof actual.fork> extends [unknown, ...infer Rest] ? Rest : never,
  ) };
});
import { queryClaudeLive, claudeLiveImage, releaseClaudeLiveRecord } from "../../../src/commands/controller/providers/claude-live.js";

const cleanups: (() => Promise<void>)[] = [];
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()));
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const fixture = async (count: number, consume = true) => {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/claude-live-ownership-")), spoolDirectory = path.join(root, "spools"), imagePath = path.join(root, "input.png"), log = path.join(root, "native.jsonl");
  await mkdir(spoolDirectory); const bytes = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]); await writeFile(imagePath, bytes, { mode: 0o400 });
  const blocked = new Set<number>(), attempts: number[] = [], paths: string[] = [], proofs: ProcessProof[] = [], events: any[] = [], queued: string[] = [];
  let child!: ChildProcess;
  const env = { ...process.env, DAYNIGHT_TEST_CLAUDE_LIVE_LOG: log }, sessionId = randomUUID();
  const native = queryClaudeLive({ prompt: (async function* () {})(), options: { cwd: root, sessionId, pathToClaudeCodeExecutable: path.resolve("test/commands/controller/fixtures/claude-live-native.mjs"), env } }, {
    cwd: root, env, onSpawn: (process: ChildProcess) => { child = process; child.on("message", (value: any) => { if (value.method === "event") queued.push(value.value.value.type); }); }, onNativeProcessProof: (proof: ProcessProof) => { proofs.push(proof); },
    imageRuntime: { createSpool: (maximum: number) => {
      const index = paths.length, spool = openNativeMediaSpool(path.join(spoolDirectory, randomUUID()), maximum, () => {}, () => {});
      paths.push(spool.path); attempts.push(0);
      return { ...spool, remove() { attempts[index] = (attempts[index] ?? 0) + 1; if (blocked.has(index)) throw new Error("Controlled spool removal failure."); spool.remove(); } };
    } },
  } as unknown as ProviderOptions);
  const pump = consume ? (async () => { for await (const event of native) { events.push(event); if (event.type !== "user") releaseClaudeLiveRecord(event); } })().catch(error => error) : Promise.resolve();
  cleanups.push(async () => {
    blocked.clear(); await native.join().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) { const exit = exited(child); child.kill("SIGKILL"); await exit; }
    for (const proof of proofs) if (await inspectProcessProof(proof) === "running") process.kill(proof.pid, "SIGTERM");
    for (const proof of proofs) await expect.poll(() => inspectProcessProof(proof)).toBe("stopped");
    await pump; await rm(root, { recursive: true, force: true });
  });
  await native.initializationResult();
  await native.submit({ uuid: randomUUID(), sessionId, input: { content: Array.from({ length: count }, () => ({ type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), localPath: imagePath, mediaType: "image/png", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") })) } });
  if (consume) await expect.poll(() => events.some(event => event.type === "result")).toBe(true);
  return { native, events, queued, blocked, attempts, paths, proofs, child, spoolDirectory, log, bytes };
};

test("the final reader retries failed physical removal without releasing another reader twice", async () => {
  const f = await fixture(1), record = f.events.find(event => event.type === "user"), image = claudeLiveImage(record.message.content[0].source.data)!;
  const first = image.retain(), last = image.retain(); releaseClaudeLiveRecord(record);
  first.release(); first.release(); expect(await readFile(first.path)).toEqual(f.bytes); expect(f.attempts).toEqual([0]);
  f.blocked.add(0); expect(() => last.release()).toThrow("removal failure"); expect(await readFile(last.path)).toEqual(f.bytes);
  f.blocked.clear(); last.release(); last.release();
  expect(f.attempts).toEqual([2]); expect(await readdir(f.spoolDirectory)).toEqual([]);
});

test("record release attempts every owner and retains only failures for retry", async () => {
  const f = await fixture(2), record = f.events.find(event => event.type === "user"); f.blocked.add(0);
  expect(() => releaseClaudeLiveRecord(record)).toThrow();
  expect(f.attempts).toEqual([1, 1]); expect(await readdir(f.spoolDirectory)).toHaveLength(1);
  f.blocked.clear(); releaseClaudeLiveRecord(record); releaseClaudeLiveRecord(record);
  expect(f.attempts).toEqual([2, 1]); expect(await readdir(f.spoolDirectory)).toEqual([]);
});

test("join retries failed spools after proven native stop without restarting or stopping the native twice", async () => {
  const f = await fixture(2); f.blocked.add(0);
  await expect(f.native.join()).rejects.toThrow();
  expect(f.attempts).toEqual([1, 1]); expect(await readdir(f.spoolDirectory)).toHaveLength(1);
  expect(f.child.exitCode !== null || f.child.signalCode !== null).toBe(true);
  for (const proof of f.proofs) expect(await inspectProcessProof(proof)).toBe("stopped");
  f.blocked.clear(); await expect(f.native.join()).resolves.toBeUndefined();
  expect(f.attempts).toEqual([2, 1]); expect(await readdir(f.spoolDirectory)).toEqual([]);
  const records = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(records.filter(row => row.event === "spawn")).toHaveLength(1);
  expect(records.filter(row => row.event === "stop").length).toBeLessThanOrEqual(1);
});

test("a discarded queued event cannot prevent native stop when its image removal fails", async () => {
  const f = await fixture(2, false), iterator = f.native[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({ value: { type: "system" }, done: false }); await iterator.return(undefined);
  await expect.poll(() => f.queued.includes("user")).toBe(true); f.blocked.add(0);
  await expect(f.native.join()).rejects.toThrow();
  expect(f.child.exitCode !== null || f.child.signalCode !== null).toBe(true);
  for (const proof of f.proofs) expect(await inspectProcessProof(proof)).toBe("stopped");
  expect(f.attempts).toEqual([1, 1]);
  f.blocked.clear(); await expect(f.native.join()).resolves.toBeUndefined();
  expect(await readdir(f.spoolDirectory)).toEqual([]);
});
