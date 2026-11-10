import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { openClaudeTranscriptHelper as OpenHelper } from "../../../src/commands/controller/providers/claude-transcript-helper.js";

const roots: string[] = [], children: ChildProcess[] = [];
let compiled: string, openHelper: typeof OpenHelper;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; };
const observeExit = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()));
beforeAll(async () => {
  await mkdir(".tmp", { recursive: true }); compiled = await mkdtemp(path.resolve(".tmp/claude-helper-code-")); await mkdir(path.join(compiled, "providers"));
  // The actual fork executes the production module as emitted JavaScript; no loader or subprocess double is installed.
  for (const name of ["claude-transcript-json", "claude-transcript", "claude-transcript-helper"]) {
    const source = await readFile(path.resolve(`src/commands/controller/providers/${name}.ts`), "utf8");
    await writeFile(path.join(compiled, "providers", `${name}.js`), stripTypeScriptTypes(source, { mode: "transform" }));
  }
  for (const name of ["process-proof", "windows-job", "windows-process-proof"]) await writeFile(path.join(compiled, `${name}.js`), stripTypeScriptTypes(await readFile(`src/commands/controller/${name}.ts`, "utf8"), { mode: "transform" }));
  openHelper = (await import(/* @vite-ignore */ pathToFileURL(path.join(compiled, "providers", "claude-transcript-helper.js")).href)).openClaudeTranscriptHelper;
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    const exit = observeExit(child); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit;
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
afterAll(async () => { if (compiled) await rm(compiled, { recursive: true, force: true }); });

const fixture = async (size = 102_401) => {
  const root = await mkdtemp(path.resolve(".tmp/claude-helper-")); roots.push(root);
  const nativeHome = path.join(root, "native"), cwd = path.join(root, "workspace"), nativeSessionId = randomUUID(), indexDirectory = path.join(root, "index");
  const transcriptPath = path.join(nativeHome, "projects", "authorized-project", `${nativeSessionId}.jsonl`), bytes = Buffer.alloc(size, 147);
  await mkdir(path.dirname(transcriptPath), { recursive: true }); await mkdir(cwd); await mkdir(indexDirectory, { mode: 0o700 });
  const source = JSON.stringify({ uuid: "u", parentUuid: null, type: "user", sessionId: nativeSessionId, cwd, message: { role: "user", content: [{ type: "text", text: "before" }, { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } }, { type: "text", text: "after" }] } }) + "\n";
  await writeFile(transcriptPath, source, { mode: 0o600 });
  return { nativeHome, cwd, nativeSessionId, indexDirectory, transcriptPath, bytes, source };
};

test("real helper waits for each index lease, returns bounded metadata and streams only ACKed media", async () => {
  const f = await fixture(), firstReservation = deferred<void>(), allow = deferred<void>();
  let child!: ChildProcess, held = 0, grants = 0, releases = 0, frames = 0;
  const opening = openHelper({ ...f, onSpawn: process => {
    child = process; children.push(child);
    child.on("message", message => { frames++; expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(1_048_576); });
  }, acquireIndexReservation: async (_bytes, owner) => {
    expect(owner?.pid).toBe(child.pid); expect(owner?.commandHash).toMatch(/^[a-f0-9]{64}$/);
    expect(held).toBe(0); held++; grants++;
    if (grants === 1) { firstReservation.resolve(); await allow.promise; }
    return { release: () => { expect(held).toBe(1); held--; releases++; } };
  } });
  try {
    await firstReservation.promise;
    const directories = await readdir(f.indexDirectory); expect(directories).toHaveLength(1);
    expect(await readdir(path.join(f.indexDirectory, directories[0]!))).toEqual([]);
  } finally { allow.resolve(); }
  const reader = await opening;
  try {
    expect(child.pid).toBeGreaterThan(0); expect(held).toBe(0); expect(grants).toBeGreaterThan(1); expect(releases).toBe(grants);
    const page = await reader.nextPage(); expect(JSON.stringify(page)).not.toContain(f.bytes.toString("base64")); expect(page.records[0]?.media).toHaveLength(1);
    await expect(reader.readMedia(page.records[0]!.media[0]!.mediaId, () => {})).rejects.toThrow("acknowledged");
    await reader.acknowledge(page.cursor);
    const chunks: Buffer[] = []; await reader.readMedia(page.records[0]!.media[0]!.mediaId, bytes => { chunks.push(Buffer.from(bytes)); });
    expect(Buffer.concat(chunks)).toEqual(f.bytes); expect(chunks.length).toBeGreaterThan(1); expect(frames).toBeGreaterThan(grants * 2);
  } finally { await reader.close(); }
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true); expect(await readdir(f.indexDirectory)).toEqual([]);
  expect(await readFile(f.transcriptPath, "utf8")).toBe(f.source);
});

test("the real helper serializes next-page reads with acknowledged media from the preceding page", async () => {
  const f = await fixture();
  const rows = Array.from({ length: 100 }, (_, index) => JSON.stringify({ uuid: `row-${index}`, parentUuid: index ? `row-${index - 1}` : "u", type: "user", sessionId: f.nativeSessionId, cwd: f.cwd, message: { role: "user", content: [{ type: "text", text: `row ${index}` }] } }));
  await writeFile(f.transcriptPath, f.source + rows.join("\n") + "\n");
  const reader = await openHelper({ ...f, onSpawn: child => { children.push(child); }, acquireIndexReservation: () => ({ release() {} }) });
  try {
    const first = await reader.nextPage(); expect(first.records).toHaveLength(100); await reader.acknowledge(first.cursor);
    const chunks: Buffer[] = [], page = reader.nextPage(), media = reader.readMedia(first.records[0]!.media[0]!.mediaId, bytes => { chunks.push(Buffer.from(bytes)); });
    const [last] = await Promise.all([page, media]);
    expect(last.records).toHaveLength(1); expect(last.done).toBe(true); expect(Buffer.concat(chunks)).toEqual(f.bytes);
  } finally { await reader.close(); }
  expect(await readdir(f.indexDirectory)).toEqual([]);
});

test("close joins an already-started media consumer and observes actual child exit before cleanup", async () => {
  const f = await fixture(), started = deferred<void>(), consumed = deferred<void>(); let child!: ChildProcess;
  const reader = await openHelper({ ...f, onSpawn: process => { child = process; children.push(child); }, acquireIndexReservation: () => ({ release() {} }) });
  const page = await reader.nextPage(); await reader.acknowledge(page.cursor);
  const reading = reader.readMedia(page.records[0]!.media[0]!.mediaId, async () => { started.resolve(); await consumed.promise; });
  const observedRead = reading.catch(error => error);
  await started.promise;
  const exit = observeExit(child); let finished = false;
  const closing = reader.close().then(() => { finished = true; });
  try { await exit; expect(finished).toBe(false); expect(await readdir(f.indexDirectory)).toHaveLength(1); }
  finally { consumed.resolve(); await closing; }
  expect(await observedRead).toBeInstanceOf(Error); expect(await readdir(f.indexDirectory)).toEqual([]);
});

test("a media cancellation joins consumption while retaining the read-only helper for later paging", async () => {
  const f = await fixture(), started = deferred<void>(), consumed = deferred<void>(), abort = new AbortController();
  const reader = await openHelper({ ...f, onSpawn: child => { children.push(child); }, acquireIndexReservation: () => ({ release() {} }) });
  try {
    const page = await reader.nextPage(); await reader.acknowledge(page.cursor);
    let settled = false;
    const reading = reader.readMedia(page.records[0]!.media[0]!.mediaId, async () => { started.resolve(); await consumed.promise; }, abort.signal).then(() => { settled = true; }, error => { settled = true; return error; });
    await started.promise; abort.abort(); expect(settled).toBe(false); consumed.resolve();
    expect(await reading).toBeInstanceOf(Error); expect((await reader.nextPage()).done).toBe(true);
  } finally { consumed.resolve(); await reader.close(); }
});

test("a lease granted after helper death is released only after exit and leaves no index files", async () => {
  const f = await fixture(1), requested = deferred<void>(), grant = deferred<void>(); let child!: ChildProcess, released = 0;
  const opening = openHelper({ ...f, onSpawn: process => { child = process; children.push(child); }, acquireIndexReservation: async () => {
    requested.resolve(); await grant.promise;
    return { release: () => { expect(child.exitCode !== null || child.signalCode !== null).toBe(true); released++; } };
  } });
  const outcome = opening.catch(error => error);
  await requested.promise;
  try { const exit = observeExit(child); child.kill("SIGKILL"); await exit; expect(released).toBe(0); }
  finally { grant.resolve(); }
  expect(await outcome).toBeInstanceOf(Error); expect(released).toBe(1); expect(await readdir(f.indexDirectory)).toEqual([]);
});

test("refused parent budget is sanitized, exits the actual helper and removes its private directory", async () => {
  const f = await fixture(1); let child!: ChildProcess;
  const result = await openHelper({ ...f, onSpawn: process => { child = process; children.push(child); }, acquireIndexReservation: () => { throw new Error(`Private budget details: ${f.nativeHome}`); } }).catch(error => error);
  expect(result).toBeInstanceOf(Error); expect(result.message).not.toContain(f.nativeHome);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true); expect(await readdir(f.indexDirectory)).toEqual([]);
});
