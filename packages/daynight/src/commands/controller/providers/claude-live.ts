import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspectProcessProof, type ProcessProof } from "../process-proof.js";
import { ClaudeLiveChannel } from "./claude-live-channel.js";
import type { ClaudeLiveExport, ClaudeLiveInput } from "./claude-live-media.js";
import type { NativeImageFile, NativeInput, ProviderOptions } from "./types.js";

type Wire = Record<string, unknown>;
const object = (value: unknown): Wire => value && typeof value === "object" && !Array.isArray(value) ? value as Wire : {};
export type ClaudeRuntimeProfile = { sdkVersion: string; cliVersion: string; executable: string; backend: "anthropic" | "bedrock" | "vertex" | "unknown" };
type Media = { readonly mediaType: string; readonly byteLength: string; readonly sha256: string; retain(): NativeImageFile };
const mediaValues = new WeakMap<object, Media>(), recordMedia = new WeakMap<object, (() => void)[]>();
export const claudeLiveImage = (value: unknown): Media | null => value && typeof value === "object" ? mediaValues.get(value) ?? null : null;
export const releaseClaudeLiveRecord = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  const pending: (() => void)[] = [], failures: unknown[] = [];
  for (const release of recordMedia.get(value) ?? []) {
    try { release(); } catch (error) { pending.push(release); failures.push(error); }
  }
  if (pending.length) recordMedia.set(value, pending); else recordMedia.delete(value);
  if (failures.length) throw new AggregateError(failures, "Claude record image owners could not be released.");
};
export type ClaudeLiveQuery = Query & { readonly profile: ClaudeRuntimeProfile | null; submit(input: ClaudeLiveInput): Promise<void>; join(): Promise<void> };
type Transfer = { spool: ReturnType<NonNullable<ProviderOptions["imageRuntime"]>["createSpool"]>; bytes: number; length: number; mediaType: string; hash: ReturnType<typeof createHash>; marker?: object; owner: boolean; readers: number; removed: boolean };

/** The Controller never imports the SDK runtime or receives a native Base64 frame. */
export const queryClaudeLive = (request: { prompt: AsyncIterable<SDKUserMessage>; options: Options }, owner: ProviderOptions): ClaudeLiveQuery => {
  const child = fork(fileURLToPath(new URL("./claude-live-worker.js", import.meta.url)), [], { cwd: owner.cwd, env: owner.env ?? process.env, execArgv: ["--max-old-space-size=512"], stdio: ["ignore", "ignore", "pipe", "ipc"], detached: false, windowsHide: true, serialization: "json" });
  let profile: ClaudeRuntimeProfile | null = null, closing: Promise<void> | null = null, nativeStopped: Promise<void> | null = null, failure: Error | null = null, stopping = false, ended = false, wake: (() => void) | null = null;
  const nativeProofs: ProcessProof[] = [], transfers = new Map<string, Transfer>(), events: { value: unknown; resolve(): void }[] = [];
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const fail = (error: Error) => { failure ??= error; ended = true; wake?.(); };
  const retire = (id: string, transfer: Transfer) => { if (!transfer.owner && transfer.readers === 0 && !transfer.removed) { transfer.spool.remove(); transfer.removed = true; transfers.delete(id); } };
  const media = (value: Wire): unknown => {
    const id = value.transferId;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Claude media transfer identity is invalid.");
    if (value.action === "begin") {
      if (!owner.imageRuntime) return { available: false, error: "component_unsupported" };
      if (transfers.size >= 1000 || transfers.has(id) || !Number.isSafeInteger(value.length) || Number(value.length) < 1 || Number(value.length) > 10_485_760 || typeof value.mediaType !== "string") return { available: false, error: "capacity_exceeded" };
      try { transfers.set(id, { spool: owner.imageRuntime.createSpool(Number(value.length)), bytes: 0, length: Number(value.length), mediaType: value.mediaType, hash: createHash("sha256"), owner: true, readers: 0, removed: false }); return { available: true }; }
      catch { return { available: false, error: "capacity_exceeded" }; }
    }
    const transfer = transfers.get(id); if (!transfer || transfer.marker) throw new Error("Claude media transfer is unavailable.");
    if (value.action === "abort") { transfer.owner = false; retire(id, transfer); return null; }
    if (value.action === "chunk") {
      if (value.offset !== transfer.bytes || typeof value.data !== "string" || value.data.length > 65_536) throw new Error("Claude media chunk ordering is invalid.");
      const bytes = Buffer.from(value.data, "base64");
      if (bytes.length > 49_152 || bytes.toString("base64") !== value.data || transfer.bytes + bytes.length > transfer.length) throw new Error("Claude media chunk exceeds its admission.");
      transfer.spool.write(bytes); transfer.hash.update(bytes); transfer.bytes += bytes.length; return { offset: transfer.bytes };
    }
    if (value.action !== "seal" || transfer.bytes !== transfer.length || typeof value.sha256 !== "string" || transfer.hash.digest("hex") !== value.sha256) throw new Error("Claude media integrity differs.");
    transfer.spool.seal(); const marker = Object.freeze({ kind: "claude_live_media" }); transfer.marker = marker;
    mediaValues.set(marker, { mediaType: transfer.mediaType, byteLength: String(transfer.bytes), sha256: value.sha256, retain: () => {
      if (transfer.removed) throw new Error("Claude media lease expired."); transfer.readers++; let released = false;
      return { kind: "file", path: transfer.spool.path, byteLength: String(transfer.bytes), sha256: String(value.sha256), release: () => { if (!released) { released = true; transfer.readers--; } retire(id, transfer); } };
    } }); return null;
  };
  const materialize = (exported: ClaudeLiveExport): Wire => {
    if (!exported || !Array.isArray(exported.images) || exported.images.length > 1000) throw new Error("Claude helper media positions are invalid.");
    const value = object(exported.value), releases: (() => void)[] = [];
    for (const slot of exported.images) {
      if (!Array.isArray(slot.path) || slot.path.length > 64 || slot.path.some(part => !["string", "number"].includes(typeof part) || ["__proto__", "prototype", "constructor"].includes(String(part)))) throw new Error("Claude media position is invalid.");
      let parent: unknown = value;
      for (const part of slot.path.slice(0, -1)) { if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, part)) throw new Error("Claude media position is unavailable."); parent = (parent as Record<string | number, unknown>)[part]; }
      const key = slot.path.at(-1)!; if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key) || (parent as Wire)[key] !== null) throw new Error("Claude media position differs.");
      const transfer = slot.transferId ? transfers.get(slot.transferId) : undefined;
      if (slot.transferId && !transfer?.marker) throw new Error("Claude media has no sealed transfer.");
      (parent as Wire)[key] = transfer?.marker ?? Object.freeze({ kind: "claude_live_unavailable", error: slot.error ?? "source_unavailable" });
      if (transfer) releases.push(() => { transfer.owner = false; retire(slot.transferId!, transfer); });
    }
    recordMedia.set(value, releases); return value;
  };
  const channel = new ClaudeLiveChannel(child, async (method, raw, signal) => {
    const value = object(raw), options = request.options;
    if (method === "profile") { profile = value as unknown as ClaudeRuntimeProfile; return null; }
    if (method === "nativeProcess") { const proof = value as unknown as ProcessProof; if (!Number.isSafeInteger(proof.pid) || proof.parentPid !== child.pid) throw new Error("Claude native process ownership differs."); nativeProofs.push(proof); owner.onNativeProcessProof?.(proof); return null; }
    if (method === "media") return media(value);
    if (method === "diagnostic") { owner.onDiagnostic?.(typeof raw === "string" ? raw.slice(0, 4096) : "Claude helper diagnostic unavailable."); return null; }
    if (method === "sessionStart") { await options.hooks?.SessionStart?.[0]?.hooks[0]?.(raw as never, undefined, { signal }); return null; }
    if (method === "canUseTool") return await options.canUseTool?.(String(value.name), object(value.input), { signal, toolUseID: String(value.toolUseID), decisionReason: typeof value.decisionReason === "string" ? value.decisionReason : undefined } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
    if (method === "elicitation") return await options.onElicitation?.(value.request as never, { signal, requestId: String(value.requestId) });
    if (method === "fatal") { fail(new Error("Claude helper lost its native connection; operation results are unknown.")); return null; }
    if (method === "ended") { ended = true; wake?.(); return null; }
    if (method === "event") {
      const event = materialize(raw as ClaudeLiveExport);
      // Discarded events retain their spools in transfers until native stop is
      // proved. A failed unlink must never withhold the worker's event ACK.
      if (stopping) { recordMedia.delete(event); return null; }
      if (events.length >= 8) throw new Error("Claude event queue exceeds its bound.");
      await new Promise<void>(resolve => { events.push({ value: event, resolve }); wake?.(); }); return null;
    }
    throw new Error("Claude helper callback is unsupported.");
  }, fail);
  child.once("error", error => { fail(error); channel.close(error); });
  child.once("exit", () => { const error = new Error("Claude SDK helper exited; pending native results are unknown."); if (!stopping) fail(error); channel.close(error); });
  child.stderr?.on("data", chunk => owner.onDiagnostic?.(String(chunk).slice(0, 4096)));
  const spawned = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("spawn", () => { try { owner.onSpawn(child); resolve(); } catch (error) { reject(error); } }); });
  const { hooks: _hooks, canUseTool: _tool, onElicitation: _elicitation, spawnClaudeCodeProcess: _spawn, stderr: _stderr, ...clean } = request.options; void _hooks; void _tool; void _elicitation; void _spawn; void _stderr;
  const opened = spawned.then(() => channel.call("open", clean, undefined, 20_000)); void opened.catch(fail);
  // The provider owns the 30 s initialization deadline. Keep the helper's
  // transport watchdog distinct so native startup retains one decision owner.
  const call = async (method: string, args: unknown[] = []) => { await opened; return channel.call("call", { method, args }, undefined, method === "initializationResult" ? 45_000 : 30_000); };
  const stopNative = (): Promise<void> => nativeStopped ??= (async () => {
    stopping = true; ended = true; wake?.();
    for (const event of events.splice(0)) { if (event.value && typeof event.value === "object") recordMedia.delete(event.value); event.resolve(); }
    await opened.catch(() => {});
    const receipt = object(await channel.call("stop", null, undefined, 15_000));
    if (receipt.stopped !== true) throw new Error("Claude helper stop remains unconfirmed.");
    for (const proof of nativeProofs) if (await inspectProcessProof(proof) === "running") throw new Error("Claude native process stop remains unconfirmed.");
    child.disconnect(); await exit; channel.close();
  })();
  const stop = (): Promise<void> => closing ??= (async () => {
    // Native stop and its evidence are requested once. Only physical resource
    // cleanup is retryable; an unknown native outcome remains unknown.
    await stopNative();
    const failures: unknown[] = [];
    for (const [id, transfer] of transfers) {
      transfer.owner = false;
      try { retire(id, transfer); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Claude stopped image spools could not be released.");
  })().catch(error => { closing = null; throw error; });
  const facade = {
    get profile() { return profile; },
    submit: async (value: ClaudeLiveInput) => { await opened; await channel.call("input", value); },
    close: () => { void stop().catch(fail); }, join: stop,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const event = events.shift(); if (event) { try { yield event.value; } finally { event.resolve(); } continue; }
        if (ended) { if (failure) throw failure; return; }
        await new Promise<void>(resolve => { wake = resolve; }); wake = null;
      }
    },
    ...Object.fromEntries(["initializationResult", "supportedModels", "supportedCommands", "reloadSkills", "getSettings", "setModel", "setPermissionMode", "applyFlagSettings", "interrupt"].map(method => [method, (...args: unknown[]) => call(method, args)])),
  };
  return facade as unknown as ClaudeLiveQuery;
};
