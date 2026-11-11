import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { endianness } from "node:os";
import { createLocalImageProofSequence, type LocalImageCheckpoint } from "./local-source-proof.js";

export class LocalImageSourceError extends Error {
  readonly code: string;
  constructor(code: string, message = "Local image source is unavailable.") { super(message); this.code = code; this.name = "LocalImageSourceError"; }
}
function refuse(code = "source_forbidden"): never { throw new LocalImageSourceError(code); }

// URI decoding precedes component traversal exactly once; URL must not collapse
// a symlink followed by a parent component into a different filesystem object.
export function parseLocalImagePath(input: string, platform: NodeJS.Platform): string {
  if (!input || Buffer.byteLength(input, "utf8") > 8192 || !input.isWellFormed() || /\p{Cc}/u.test(input) || /[?#]/u.test(input)) refuse();
  let value = input;
  if (/^file:/i.test(value)) {
    if (value.includes("\\")) refuse();
    const match = /^file:\/\/([^/]*)(\/.*)$/i.exec(value);
    if (!match || !["", "localhost"].includes(match[1]!.toLowerCase())) refuse();
    value = match[2]!;
    if (platform === "win32") {
      if (!/^\/[A-Za-z]:\//.test(value)) refuse();
      value = value.slice(1);
    }
  } else if (value.startsWith("//") || (!/^[A-Za-z]:[\\/]/.test(value) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value))) refuse();
  if (/%(?:2f|5c|00)/i.test(value) || /%(?![\da-f]{2})/i.test(value)) refuse();
  try { value = decodeURIComponent(value); } catch { refuse(); }
  if (!value.isWellFormed() || /\p{Cc}/u.test(value) || value.startsWith("//")) refuse();
  if (platform === "win32") {
    if (/[<>"|*]/u.test(value) || /^[\\/]/.test(value) || /^[A-Za-z]:(?![\\/])/.test(value) || value.includes(":" , /^[A-Za-z]:/.test(value) ? 2 : 0)) refuse();
    for (const component of value.split(/[\\/]/).filter(Boolean).slice(/^[A-Za-z]:/.test(value) ? 1 : 0)) {
      if (component === "." || component === "..") continue;
      const deviceBase = component.split(".", 1)[0]!.replace(/[ .]+$/u, "");
      if (/[. ]$/.test(component) || /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(deviceBase)) refuse();
    }
  }
  return value;
}

export type LocalImageRootIdentity = { readonly dev: string; readonly ino: string };
export type LocalImageContext = {
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly policyRevision: string;
  close(): Promise<void>;
};
type InternalContext = { child: ChildProcess; closed: Promise<void>; dead: boolean; busy: boolean; expectedRoot: LocalImageRootIdentity | undefined };
const contexts = new WeakMap<LocalImageContext, InternalContext>();
type HelperMessage = { stage?: string; proof?: unknown; type: "ready" | "checkpoint" | "result" | "error"; code?: string; byteLength?: number; sha256?: string };
const send = (child: ChildProcess, message: object): void => {
  // IPC can disconnect between the connected check and send. The operation
  // observes child close or its deadline; a late EPIPE must not crash Controller.
  if (child.connected) child.send(message, () => {});
};
const helperPath = (): string => fileURLToPath(new URL(`./local-source-${process.platform === "win32" ? "windows-helper" : "helper"}.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));

export async function createLocalImageContext(options: { cwd: string; platform?: NodeJS.Platform; policyRevision: string; nativeReadAllowed: boolean | undefined; expectedRoot?: LocalImageRootIdentity }): Promise<LocalImageContext> {
  const platform = options.platform ?? process.platform;
  if (options.nativeReadAllowed !== true || !options.policyRevision || platform !== process.platform || !["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(process.arch) || endianness() !== "LE" || !path.isAbsolute(options.cwd) || Buffer.byteLength(options.cwd) > 8192 || !options.cwd.isWellFormed() || /\p{Cc}/u.test(options.cwd)) refuse("policy_restricted");
  if (options.expectedRoot && [options.expectedRoot.dev, options.expectedRoot.ino].some(value => !/^(?:0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n)) refuse("context_unavailable");
  const child = fork(helperPath(), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], env: { ...process.env, NODE_OPTIONS: "" } });
  const internal: InternalContext = { child, closed: new Promise(resolve => child.once("close", () => { internal.dead = true; resolve(); })), dead: false, busy: false, expectedRoot: options.expectedRoot ? { ...options.expectedRoot } : undefined };
  const close = async (): Promise<void> => { internal.dead = true; child.kill("SIGKILL"); await internal.closed; };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new LocalImageSourceError("source_timeout")), 5000);
      const onMessage = (message: HelperMessage): void => { if (message.type === "ready") finish(); else if (message.type === "error") finish(new LocalImageSourceError(message.code ?? "context_unavailable")); };
      const onClose = (): void => finish(new LocalImageSourceError("context_unavailable"));
      const finish = (error?: Error): void => { clearTimeout(timer); child.off("message", onMessage); child.off("close", onClose); child.off("error", finish); error ? reject(error) : resolve(); };
      child.on("message", onMessage); child.once("close", onClose); child.once("error", finish);
      send(child, { type: "init", cwd: options.cwd, expectedRoot: options.expectedRoot });
    });
  } catch (error) { await close(); throw error; }
  const context: LocalImageContext = Object.freeze({ cwd: options.cwd, platform, policyRevision: options.policyRevision, close });
  contexts.set(context, internal); return context;
}

export async function copyLocalImage(options: { path: string; context: LocalImageContext; outputPath: string; signal?: AbortSignal; checkPolicy: (checkpoint: LocalImageCheckpoint) => void | Promise<void> }): Promise<{ inputPath: string; byteLength: number; sha256: string }> {
  const internal = contexts.get(options.context);
  if (!internal || internal.dead) refuse("context_unavailable");
  if (internal.busy) refuse("source_busy");
  const parsed = parseLocalImagePath(options.path, options.context.platform);
  const proofSequence = createLocalImageProofSequence({ locator: options.path, path: parsed, cwd: options.context.cwd, platform: options.context.platform, root: internal.expectedRoot });
  if (options.signal?.aborted) refuse("source_cancelled");
  internal.busy = true;
  try {
    return await new Promise((resolve, reject) => {
      let finishing = false, checking = false;
      const finish = async (error?: unknown, result?: { byteLength: number; sha256: string }, terminate = false): Promise<void> => {
        if (finishing) return; finishing = true; clearTimeout(timer); clearTimeout(openTimer);
        options.signal?.removeEventListener("abort", onAbort); internal.child.off("message", onMessage); internal.child.off("close", onClose);
        if (error) { if (terminate) await options.context.close(); reject(error); }
        else resolve({ inputPath: options.outputPath, ...result! });
      };
      const onAbort = (): void => { void finish(new LocalImageSourceError("source_cancelled"), undefined, true); };
      const timer = setTimeout(() => { void finish(new LocalImageSourceError("source_timeout"), undefined, true); }, 30_000);
      const openTimer = setTimeout(() => { void finish(new LocalImageSourceError("source_timeout"), undefined, true); }, 5000);
      const onClose = (): void => { void finish(new LocalImageSourceError("context_unavailable")); };
      const onMessage = (message: HelperMessage): void => {
        if (message.type === "checkpoint") {
          let checkpoint: LocalImageCheckpoint;
          try { if (checking) refuse(); checkpoint = proofSequence.accept({ stage: message.stage, proof: message.proof }); }
          catch (error) { void finish(error, undefined, true); return; }
          if (checkpoint.stage === "opened") clearTimeout(openTimer);
          checking = true;
          void Promise.resolve().then(() => { if (!finishing) return options.checkPolicy(checkpoint); }).then(() => { checking = false; if (!finishing) send(internal.child, { type: "continue" }); }, error => finish(error, undefined, true));
        } else if (message.type === "error") { void finish(new LocalImageSourceError(message.code ?? "source_unavailable")); }
        else if (message.type === "result") {
          try { if (checking) refuse(); proofSequence.complete(); } catch (error) { void finish(error, undefined, true); return; }
          if (!Number.isSafeInteger(message.byteLength) || !message.sha256 || !/^[a-f0-9]{64}$/.test(message.sha256)) void finish(new LocalImageSourceError("source_unavailable"));
          else void finish(undefined, { byteLength: message.byteLength!, sha256: message.sha256 });
        }
      };
      internal.child.on("message", onMessage); internal.child.once("close", onClose); options.signal?.addEventListener("abort", onAbort, { once: true });
      send(internal.child, { type: "copy", locator: options.path, path: parsed, outputPath: options.outputPath });
    });
  } finally { internal.busy = false; }
}
