import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeRpcTimeoutError, record } from "./native-rpc.js";

import { codexMetadataPath, observeCodexMetadata, type CodexPersistenceConfiguration } from "./codex-settings-metadata.js";

type Selection = { model?: string; effort?: string };
type Options = {
  path: unknown; home: string; cwd: string; threadId: string; expected: Selection;
  readConfiguration(): Promise<CodexPersistenceConfiguration>; env: NodeJS.ProcessEnv;
  update(): Promise<unknown>; signal: AbortSignal; timeoutMs?: number;
};
const maxBytes = 16 * 1024 * 1024;
const inside = (root: string, file: string): boolean => { const part = relative(root, file); return !!part && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`); };
const invalid = (): Error => new Error("Native Codex initial settings persistence is unconfirmed.");

/** Confirm the owned rollout and committed resume metadata; the RPC only queues an update. */
export const persistCodexInitialSettings = async (options: Options): Promise<void> => {
  const deadline = performance.now() + (options.timeoutMs ?? 30_000);
  let file: FileHandle | undefined;
  let confirmed = false;
  const check = () => { options.signal.throwIfAborted(); if (performance.now() >= deadline) throw new NativeRpcTimeoutError("Codex initial settings persistence"); };
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    let timer: NodeJS.Timeout | undefined;
    let aborted = () => {};
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        aborted = () => reject(options.signal.reason);
        options.signal.addEventListener("abort", aborted, { once: true });
        timer = setTimeout(() => reject(new NativeRpcTimeoutError("Codex initial settings persistence")), Math.max(1, deadline - performance.now()));
        if (options.signal.aborted) aborted();
      })]);
    } finally { clearTimeout(timer); options.signal.removeEventListener("abort", aborted); }
  };
  try {
    check();
    if (typeof options.path !== "string" || !isAbsolute(options.path)) throw invalid();
    const home = await realpath(options.home), sessions = await realpath(join(home, "sessions")), path = await realpath(options.path), cwd = await realpath(options.cwd);
    if (!inside(home, sessions) || !inside(sessions, path)) throw invalid();
    const named = await lstat(options.path);
    if (!named.isFile()) throw invalid();
    // Nonblocking open also bounds a replacement with a FIFO between lstat and open.
    file = await open(options.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const identity = await file.stat();
    if (!identity.isFile() || identity.dev !== named.dev || identity.ino !== named.ino || identity.size > maxBytes) throw invalid();
    let position = 0, pending = Buffer.alloc(0);
    const verify = async () => {
      check();
      const [current, named] = await Promise.all([file!.stat(), lstat(options.path as string)]);
      if (!current.isFile() || !named.isFile() || current.dev !== identity.dev || current.ino !== identity.ino || named.dev !== identity.dev || named.ino !== identity.ino
        || current.size < position || current.size > maxBytes || await realpath(options.path as string) !== path) throw invalid();
      return current.size;
    };
    const read = async (): Promise<unknown[]> => {
      const size = await verify();
      while (position < size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, size - position));
        const { bytesRead } = await file!.read(buffer, 0, buffer.length, position);
        if (!bytesRead) throw invalid();
        position += bytesRead; pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]); check();
      }
      const entries: unknown[] = []; let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
        if (line.length) { try { const entry: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid(); entries.push(entry); } catch { throw invalid(); } }
      }
      await verify(); return entries;
    };
    const baseline = await read();
    const metadata = baseline.filter(value => record(value).type === "session_meta");
    if (metadata.length !== 1) throw invalid();
    const owner = record(record(metadata[0]).payload);
    if (owner.id !== options.threadId || typeof owner.cwd !== "string" || await realpath(owner.cwd) !== cwd) throw invalid();
    const configuration = await bounded(options.readConfiguration);
    const observeMetadata = observeCodexMetadata(codexMetadataPath(configuration, options.env, home, cwd), { threadId: options.threadId, path, cwd }, options.expected);
    // A record that began before dispatch cannot acknowledge this update.
    let discardPartial = pending.length > 0; pending = Buffer.alloc(0);
    check();
    const receipt = await bounded(options.update);
    check();
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw invalid();
    let matched = false;
    while (true) {
      const size = await verify();
      if (discardPartial && size > position) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, size - position));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (!bytesRead) throw invalid();
        const end = buffer.subarray(0, bytesRead).indexOf(10);
        position += end === -1 ? bytesRead : end + 1; discardPartial = end === -1;
      }
      const entries = discardPartial ? [] : await read();
      for (const raw of entries) {
        const entry = record(raw), payload = record(entry.payload);
        if (entry.type === "session_meta") throw invalid();
        if (entry.type !== "event_msg" || payload.type !== "thread_settings_applied") continue;
        const settings = record(payload.thread_settings), effort = record(record(settings.collaboration_mode).settings).reasoning_effort;
        matched = payload.thread_id === options.threadId && (options.expected.model === undefined || settings.model === options.expected.model)
          && (options.expected.effort === undefined || effort === options.expected.effort);
      }
      check();
      if (matched && pending.length === 0) {
        if (await observeMetadata() && await verify() === position) {
          confirmed = true; return;
        }
      }
      await delay(Math.min(20, Math.max(1, deadline - performance.now())), undefined, { signal: options.signal });
    }
  } finally { await file?.close(); if (confirmed) check(); }
};
