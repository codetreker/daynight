import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { jsonContainerSources } from "../../api/json-source.js";
import { canonicalId } from "../../api/parse.js";

const limit = 256 * 1024;
const events = new Set(["task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"]);
const invalid = (): never => { throw new Error("Invalid webhook input."); };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) invalid();
};
const depth = (value: unknown, n = 0): void => {
  if (typeof value === "string") { if (!value.isWellFormed()) invalid(); return; }
  if (typeof value !== "object" || value === null) return;
  if (n >= 32) invalid();
  if (Object.keys(value).some((key) => !key.isWellFormed())) invalid();
  for (const child of Object.values(value)) depth(child, n + 1);
};
const subscriptions = (value: unknown): void => {
  if (!Array.isArray(value)) return invalid();
  const ids = new Set<string>();
  for (const item of value) {
    if (!object(item)) return invalid();
    keys(item, ["id", "projectId", "eventTypes"], ["id", "projectId", "eventTypes"]);
    if (item.id !== null && (typeof item.id !== "string" || canonicalId(item.id) !== item.id || ids.has(item.id))) invalid();
    if (typeof item.id === "string") ids.add(item.id);
    if (typeof item.projectId !== "string" || canonicalId(item.projectId) !== item.projectId || !Array.isArray(item.eventTypes) || item.eventTypes.length === 0 || item.eventTypes.some((event: unknown) => typeof event !== "string" || !events.has(event)) || new Set(item.eventTypes).size !== item.eventTypes.length) invalid();
  }
};

export const parseWebhookInput = (bytes: Uint8Array, kind: "create" | "update" | "subscriptions"): unknown => {
  if (bytes.byteLength > limit) return invalid();
  let value: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    jsonContainerSources(source); // validates JSON, nesting and duplicate keys at every level
    value = JSON.parse(source) as unknown;
    depth(value);
  } catch { return invalid(); }
  if (kind === "subscriptions") { subscriptions(value); return value; }
  if (!object(value)) return invalid();
  keys(value, ["name", "enabled", "destination", "subscriptions"], kind === "create" ? ["name", "enabled", "destination", "subscriptions"] : []);
  if (Object.keys(value).length === 0) invalid();
  if (Object.hasOwn(value, "name") && typeof value.name !== "string") invalid();
  if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") invalid();
  if (Object.hasOwn(value, "subscriptions")) subscriptions(value.subscriptions);
  if (Object.hasOwn(value, "destination")) {
    const d = value.destination;
    if (!object(d)) return invalid();
    keys(d, ["kind", "adapterVersion", "configuration"], ["kind", "adapterVersion", "configuration"]);
    if (typeof d.kind !== "string" || typeof d.adapterVersion !== "string" || !object(d.configuration)) return invalid();
    keys(d.configuration, ["url"], ["url"]);
    if (typeof d.configuration.url !== "string") invalid();
  }
  return value;
};

export const readWebhookInput = async (path: string | undefined, signal: AbortSignal): Promise<Buffer> => {
  signal.throwIfAborted();
  if (path !== undefined) {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit) throw new Error("Webhook input must be a regular file of at most 256 KiB.");
      const buffer = Buffer.allocUnsafe(limit + 1);
      let size = 0;
      while (size < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      signal.throwIfAborted();
      if (size > limit) throw new Error("Webhook input exceeds 256 KiB.");
      return buffer.subarray(0, size);
    } finally { await file.close(); }
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (error?: Error): void => {
      process.stdin.pause(); process.stdin.off("data", onData); process.stdin.off("end", onEnd); process.stdin.off("error", onError); signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error); else resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk: Buffer | string): void => { const data = Buffer.from(chunk); size += data.length; if (size > limit) done(new Error("Webhook input exceeds 256 KiB.")); else chunks.push(data); };
    const onEnd = (): void => done();
    const onError = (): void => done(new Error("Could not read webhook input."));
    const onAbort = (): void => done(new Error("Webhook input cancelled."));
    process.stdin.on("data", onData); process.stdin.once("end", onEnd); process.stdin.once("error", onError); signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort(); else process.stdin.resume();
  });
};
