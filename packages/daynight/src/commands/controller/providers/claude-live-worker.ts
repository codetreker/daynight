import { query, resolveSettings, type Query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureProcessProof } from "../process-proof.js";
import { ClaudeLiveChannel } from "./claude-live-channel.js";
import { encodeClaudeLiveInput, exportClaudeLiveMedia, type ClaudeLiveInput } from "./claude-live-media.js";
import { claudeBackend } from "./claude-live-profile.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
class InputStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []; private wake: (() => void) | null = null; private closed = false;
  push(value: SDKUserMessage) { if (this.closed || this.queue.length >= 8) throw new Error("Claude input queue is unavailable."); this.queue.push(value); this.wake?.(); }
  close() { this.closed = true; this.queue = []; this.wake?.(); }
  async *[Symbol.asyncIterator]() { while (!this.closed) { const next = this.queue.shift(); if (next) yield next; else await new Promise<void>(resolve => { this.wake = resolve; }); } }
}
const within = <T>(promise: Promise<T>, ms: number) => new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Claude native process stop remains unconfirmed.")), ms); promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); });
const input = new InputStream(), children: ChildProcess[] = [], proofs: Promise<unknown>[] = [];
let native: Query | undefined, pump: Promise<void> | undefined, stopping = false, closed: Promise<void> | undefined;
const channel = new ClaudeLiveChannel(process, async (method, raw, signal) => {
  const value = object(raw);
  if (method === "open") {
    if (native || stopping) throw new Error("Claude helper cannot open another native session.");
    const options = value as unknown as Options;
    const sdkPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")), sdkVersion = String(JSON.parse(await readFile(path.join(path.dirname(sdkPath), "package.json"), "utf8")).version);
    const effectiveSettings = await resolveSettings({ ...(options.cwd === undefined ? {} : { cwd: options.cwd }), ...(options.settingSources === undefined ? {} : { settingSources: options.settingSources }), ...(options.managedSettings === undefined ? {} : { managedSettings: options.managedSettings }) }).then(value => value.effective, () => null);
    let profileResolve!: () => void, profileReject!: (error: unknown) => void;
    const profileReady = new Promise<void>((resolve, reject) => { profileResolve = resolve; profileReject = reject; }); void profileReady.catch(() => {});
    native = query({ prompt: input, options: { ...options,
      hooks: { SessionStart: [{ hooks: [async event => { await channel.call("sessionStart", event); return {}; }] }] },
      spawnClaudeCodeProcess: args => {
        const backend = claudeBackend(args.env, effectiveSettings, options.settings);
        const child = spawn(args.command, args.args, { cwd: args.cwd ?? options.cwd, env: args.env, signal: args.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false }); children.push(child);
        const proof = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("spawn", () => { void (async () => {
            await channel.call("nativeProcess", await captureProcessProof(child.pid!));
            // Probe the executable actually selected by this SDK spawn, including
            // optional native-binary packages and explicit JavaScript fixtures.
            const script = /^(?:node|nodejs)(?:\.exe)?$/i.test(path.basename(args.command)) ? args.args.findIndex(value => /\.(?:mjs|cjs|js)$/.test(value)) : -1;
            const executable = script >= 0 ? args.args[script]! : args.command;
            const versionArgs = script >= 0 ? [...args.args.slice(0, script + 1), "--version"] : ["--version"];
            const cliVersion = await new Promise<string>(accept => execFile(args.command, versionArgs, { timeout: 10_000, maxBuffer: 4096, encoding: "utf8", windowsHide: true, env: args.env }, (error, stdout) => accept(error ? "unknown" : /\b\d+\.\d+\.\d+\b/.exec(stdout)?.[0] ?? "unknown")));
            await channel.call("profile", { sdkVersion, cliVersion, executable, backend }); profileResolve();
          })().then(() => resolve(), reject); });
        }); proofs.push(proof); void proof.catch(error => { profileReject(error); fatal(error); });
        return child;
      },
      canUseTool: async (name, toolInput, context) => await channel.call("canUseTool", { name, input: toolInput, toolUseID: context.toolUseID, decisionReason: context.decisionReason }, context.signal, 86_400_000) as Awaited<ReturnType<NonNullable<Options["canUseTool"]>>>,
      onElicitation: async (request, context) => await channel.call("elicitation", { request, requestId: context.requestId }, context.signal, 86_400_000) as Awaited<ReturnType<NonNullable<Options["onElicitation"]>>>,
      stderr: line => { void channel.call("diagnostic", line.slice(0, 4096)).catch(() => {}); },
    } });
    pump = (async () => { for await (const event of native!) { if (stopping) break; await channel.call("event", await exportClaudeLiveMedia(event, transfer)); } if (!stopping) await channel.call("ended"); })().catch(fatal);
    await within(profileReady, 15_000); return null;
  }
  if (method === "stop") { await stop(); return { stopped: true }; }
  if (!native || stopping) throw new Error("Claude native session is unavailable.");
  if (method === "input") { const encoded = await encodeClaudeLiveInput(value as unknown as ClaudeLiveInput); signal.throwIfAborted(); input.push(encoded); return { submitted: true }; }
  if (method === "call" && typeof value.method === "string" && ["initializationResult", "supportedModels", "supportedCommands", "reloadSkills", "getSettings", "setModel", "setPermissionMode", "applyFlagSettings", "interrupt"].includes(value.method) && Array.isArray(value.args)) {
    const method = (native as unknown as Record<string, unknown>)[value.method]; if (typeof method !== "function") throw new Error("Claude native control is unsupported.");
    return await method.apply(native, value.args);
  }
  throw new Error("Claude helper request is unsupported.");
}, fatal);

async function transfer(data: string, mediaType: string): Promise<{ transferId?: string; error?: string }> {
  if (!data.length || data.length % 4 || data.length > 13_981_016) return { error: data.length > 13_981_016 ? "image_too_large" : "invalid_base64" };
  const length = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (length > 10_485_760) return { error: "image_too_large" };
  const transferId = randomUUID(), accepted = object(await channel.call("media", { action: "begin", transferId, length, mediaType }));
  if (accepted.available !== true) return { error: String(accepted.error ?? "component_unsupported") };
  const hash = createHash("sha256"); let offset = 0;
  try {
    for (let at = 0; at < data.length; at += 65_536) {
      const encoded = data.slice(at, at + 65_536), bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw new Error("Claude native Base64 is invalid.");
      hash.update(bytes); await channel.call("media", { action: "chunk", transferId, offset, data: encoded }); offset += bytes.length;
    }
    if (offset !== length) throw new Error("Claude native media length differs.");
    await channel.call("media", { action: "seal", transferId, sha256: hash.digest("hex") }); return { transferId };
  } catch { await channel.call("media", { action: "abort", transferId }).catch(() => {}); return { error: "source_unavailable" }; }
}
async function stop(): Promise<void> {
  return closed ??= (async () => {
    stopping = true; input.close(); native?.close();
    await Promise.all(proofs);
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : within(new Promise<void>(resolve => child.once("exit", () => resolve())), 10_000)));
    await pump;
  })();
}
function fatal(_error: unknown): void { if (stopping) return; void channel.call("fatal", { message: "Claude SDK helper lost its native connection; operation results are unknown." }).catch(() => {}); }
process.on("disconnect", () => { void stop().then(() => { channel.close(); }, () => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { void stop().then(() => { channel.close(); if (process.connected) process.disconnect(); }, () => { process.exitCode = 1; }); });
