import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { CopilotClient, CopilotSession, SessionConfig } from "@github/copilot-sdk";
import { CopilotBridgeChannel } from "./copilot-bridge-channel.js";
import type { CopilotBridgeImageInput, CopilotBridgeExport } from "./copilot-bridge-media.js";

export type CopilotBridgeSpool = { readonly path: string; write(bytes: Uint8Array): void; seal(): void; remove(): void };
export type CopilotBridgeMediaOptions = { createSpool(maxBytes: number): CopilotBridgeSpool };
export type CopilotBridgeImage = Readonly<{ kind: "copilot_bridge_image"; path: string; byteLength: string; sha256: string; mediaType: string }>;
type ImageOwnership = { spool: CopilotBridgeSpool; owner: boolean; readers: number; removed: boolean; retired(): void };
const images = new WeakMap<object, ImageOwnership>();
const imageSessions = new WeakMap<object, (input: CopilotBridgeImageInput, verify: () => void) => Promise<string>>();
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const retire = (entry: ImageOwnership) => { if (!entry.owner && !entry.readers && !entry.removed) { entry.spool.remove(); entry.removed = true; entry.retired(); } };
export const isCopilotBridgeImage = (value: unknown): value is CopilotBridgeImage => value !== null && typeof value === "object" && images.has(value) && !images.get(value)!.removed;
/** A reader retains its own lifetime independently from the bridge's transport lifetime. */
export const retainCopilotBridgeImage = (image: CopilotBridgeImage): (() => void) => {
  const entry = images.get(image); if (!entry || entry.removed) throw new Error("Copilot image has no controlled bridge lease.");
  entry.readers++; let released = false;
  return () => { if (!released) { released = true; entry.readers--; } retire(entry); };
};
export const releaseCopilotBridgeImage = (image: CopilotBridgeImage): void => { const entry = images.get(image); if (!entry) throw new Error("Copilot image has no controlled bridge lease."); entry.owner = false; retire(entry); };
export const sendCopilotBridgeImages = (session: CopilotSession, input: CopilotBridgeImageInput, verify: () => void): Promise<string> => {
  const send = imageSessions.get(session); if (!send) return Promise.reject(new Error("Copilot image bridge is unavailable.")); return send(input, verify);
};
const { ResponseError } = createRequire(createRequire(import.meta.url).resolve("@github/copilot-sdk"))("vscode-jsonrpc/node") as { ResponseError: new (code: number, message: string) => Error };
const remoteError = (raw: unknown): Error => {
  const error = object(raw), message = typeof error.message === "string" ? error.message : "Copilot bridge operation failed; outcome is unknown.";
  return error.kind === "response" && typeof error.code === "number" ? new ResponseError(error.code, message) : new Error(message);
};
type Transfer = { spool: CopilotBridgeSpool; length: number; offset: number; mime: string; hash: ReturnType<typeof createHash>; marker?: CopilotBridgeImage; claimed: boolean };
type Callbacks = Record<string, (...args: unknown[]) => unknown>;

/** The Controller holds a facade; only this owned helper creates the SDK client. */
export const startCopilotBridge = (options: {
  cwd: string; env: NodeJS.ProcessEnv; port: number; token: string;
  onSpawn(child: ChildProcess): void; onLost(error: Error): void; onDiagnostic?(line: string): void;
  media?: CopilotBridgeMediaOptions;
}) => {
  const child = spawn(process.execPath, ["--max-old-space-size=512", fileURLToPath(new URL("./copilot-bridge-worker.js", import.meta.url))], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false });
  let closing = false, failed = false, closed = false, peakRss = 0, peakHeap = 0, peakExternal = 0, peakArrayBuffers = 0, samples = 0;
  const waiters = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const admissions = new Map<string, { sessionId: string; verify(): void; consumed: boolean; error: Error | undefined }>();
  const callbacks = new Map<string, Callbacks>(), transfers = new Map<string, Transfer>();
  const permissions = new Map<string, { sessionId: string; request: object; serialized: string }>();
  const owned = new Set<CopilotBridgeImage>();
  const subscriptions = new Map<string, Set<(event: unknown) => void>>();
  let totalTransfers = 0;
  const exited = new Promise<void>(resolve => child.once("exit", () => { closed = true; resolve(); }));
  const fail = (error: Error) => {
    if (failed || closing) return;
    failed = true;
    for (const waiter of waiters.values()) waiter.reject(error); waiters.clear();
    options.onLost(error);
  };
  const channel = new CopilotBridgeChannel(child.stdout!, child.stdin!, value => { void receive(object(value)).catch(fail); }, fail);
  child.once("error", fail);
  child.once("exit", () => { if (!closing) fail(new Error("Copilot SDK bridge exited; operation results are unknown.")); });
  child.stderr!.on("data", chunk => options.onDiagnostic?.(String(chunk).slice(0, 4096)));
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => { try { options.onSpawn(child); resolve(); } catch (error) { reject(error); } });
  });
  const request = (method: string, args: unknown[] = []): Promise<unknown> => {
    if (closed || failed || waiters.size >= 128) return Promise.reject(new Error("Copilot bridge is unavailable or its request budget is exhausted."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      waiters.set(id, { resolve, reject });
      void channel.send({ type: "request", id, method, args }).catch(error => { waiters.delete(id); reject(error); });
    });
  };
  const respond = (id: string, value: unknown, error?: Error) => channel.send({ type: "response", id, ...(error ? { error: { message: error.message } } : { value }) });
  const materialize = (exported: CopilotBridgeExport): unknown => {
    if (!Array.isArray(exported.images) || exported.images.length > 1000) throw new Error("Copilot bridge media positions exceed their limit.");
    const value = exported.value;
    for (const slot of exported.images) {
      if (!Array.isArray(slot.path) || !slot.path.length || slot.path.length > 16 || slot.path.some(part => typeof part !== "string" && typeof part !== "number" || ["__proto__", "prototype", "constructor"].includes(String(part)))) throw new Error("Copilot bridge media position is invalid.");
      let parent: unknown = value;
      for (const key of slot.path.slice(0, -1)) {
        if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, key)) throw new Error("Copilot bridge media position is unavailable.");
        parent = (parent as Record<string | number, unknown>)[key];
      }
      const key = slot.path.at(-1)!;
      if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, key) || (parent as Record<string | number, unknown>)[key] !== null) throw new Error("Copilot bridge media position differs.");
      const transfer = typeof slot.transferId === "string" ? transfers.get(slot.transferId) : undefined;
      if (slot.transferId !== undefined && (!transfer?.marker || transfer.claimed)) throw new Error("Copilot bridge media has no sealed transfer.");
      if (transfer) { transfer.claimed = true; (parent as Record<string | number, unknown>)[key] = transfer.marker; }
      else (parent as Record<string | number, unknown>)[key] = Object.freeze({ kind: "copilot_bridge_unavailable", code: typeof slot.error === "string" ? slot.error : "source_unavailable" });
    }
    return value;
  };
  const media = (message: Record<string, unknown>): unknown => {
    const id = message.transferId;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid Copilot media transfer identity.");
    if (message.action === "begin") {
      if (!options.media) return { available: false, error: "component_unsupported" };
      if (transfers.has(id) || transfers.size >= 1000 || [...transfers.values()].filter(transfer => !transfer.marker).length >= 2 || typeof message.length !== "number" || !Number.isSafeInteger(message.length) || message.length < 1 || message.length > 10_485_760 || typeof message.mimeType !== "string" || !["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(message.mimeType)) return { available: false, error: "capacity_exceeded" };
      let spool: CopilotBridgeSpool;
      try { spool = options.media.createSpool(message.length); } catch { return { available: false, error: "capture_failed" }; }
      totalTransfers += message.length;
      transfers.set(id, { spool, length: message.length, offset: 0, mime: message.mimeType, hash: createHash("sha256"), claimed: false });
      return { available: true };
    }
    const transfer = transfers.get(id); if (!transfer || transfer.marker) throw new Error("Copilot media transfer is unavailable.");
    if (message.action === "part") {
      if (message.offset !== transfer.offset || typeof message.data !== "string" || message.data.length > 699_052) throw new Error("Copilot media chunk has invalid position.");
      const bytes = Buffer.from(message.data, "base64");
      if (!bytes.length || bytes.length > 524_288 || bytes.toString("base64") !== message.data || transfer.offset + bytes.length > transfer.length) throw new Error("Copilot media chunk exceeds its admission.");
      for (let offset = 0; offset < bytes.length; offset += 65_536) transfer.spool.write(bytes.subarray(offset, offset + 65_536));
      transfer.hash.update(bytes); transfer.offset += bytes.length;
      return { offset: transfer.offset };
    }
    if (message.action === "abort") { transfer.spool.remove(); transfers.delete(id); totalTransfers -= transfer.length; return { released: true }; }
    if (message.action !== "seal" || transfer.offset !== transfer.length || typeof message.sha256 !== "string" || transfer.hash.digest("hex") !== message.sha256) throw new Error("Copilot media transfer integrity differs.");
    transfer.spool.seal();
    const marker: CopilotBridgeImage = Object.freeze({ kind: "copilot_bridge_image", path: transfer.spool.path, byteLength: String(transfer.length), sha256: message.sha256, mediaType: transfer.mime });
    images.set(marker, { spool: transfer.spool, owner: true, readers: 0, removed: false, retired: () => { transfers.delete(id); owned.delete(marker); totalTransfers -= transfer.length; } });
    owned.add(marker); transfer.marker = marker;
    return { sealed: true };
  };
  async function receive(message: Record<string, unknown>): Promise<void> {
    if (message.type === "metrics") {
      if (typeof message.rss === "number" && Number.isSafeInteger(message.rss)) peakRss = Math.max(peakRss, message.rss);
      if (typeof message.heapUsed === "number" && Number.isSafeInteger(message.heapUsed)) peakHeap = Math.max(peakHeap, message.heapUsed);
      if (typeof message.external === "number" && Number.isSafeInteger(message.external)) peakExternal = Math.max(peakExternal, message.external);
      if (typeof message.arrayBuffers === "number" && Number.isSafeInteger(message.arrayBuffers)) peakArrayBuffers = Math.max(peakArrayBuffers, message.arrayBuffers);
      samples++;
      return;
    }
    if (message.type === "fatal") { fail(remoteError(message.error)); return; }
    if (message.type === "response") {
      if (typeof message.id !== "string") throw new Error("Copilot bridge response identity is invalid.");
      const waiter = waiters.get(message.id); if (!waiter) return;
      waiters.delete(message.id);
      if (message.error !== undefined) waiter.reject(remoteError(message.error));
      else { try { waiter.resolve(materialize(message.result as CopilotBridgeExport)); } catch (error) { waiter.reject(error instanceof Error ? error : new Error(String(error))); throw error; } }
      return;
    }
    if (message.type === "event") {
      if (typeof message.sessionId !== "string") throw new Error("Copilot bridge event identity is unavailable.");
      const event = materialize(message.result as CopilotBridgeExport);
      if (message.permissionIdentity !== undefined) {
        if (typeof message.permissionIdentity !== "string") throw new Error("Copilot permission event identity is invalid.");
        const pending = permissions.get(message.permissionIdentity), data = object(object(event).data);
        if (!pending || pending.sessionId !== message.sessionId || object(event).type !== "permission.requested" || JSON.stringify(data.permissionRequest) !== pending.serialized) throw new Error("Copilot permission event does not match its callback object.");
        permissions.delete(message.permissionIdentity); data.permissionRequest = pending.request;
      }
      callbacks.get(message.sessionId)?.onEvent?.(event);
      for (const callback of subscriptions.get(message.sessionId) ?? []) callback(event);
      return;
    }
    if (message.type !== "request" || typeof message.id !== "string") throw new Error("Invalid Copilot bridge message.");
    try {
      if (message.method === "image_admission") {
        const admission = typeof message.admissionId === "string" ? admissions.get(message.admissionId) : undefined;
        if (closed || closing || failed || !admission || admission.consumed || admission.sessionId !== message.sessionId) throw new Error("Copilot image admission is no longer current.");
        admission.consumed = true;
        try { admission.verify(); } catch (error) { admission.error = error instanceof Error ? error : new Error(String(error)); throw error; }
        await respond(message.id, true); return;
      }
      if (message.method === "media") { await respond(message.id, media(object(message.args))); return; }
      if (message.method !== "callback" || typeof message.sessionId !== "string" || typeof message.callback !== "string" || !Array.isArray(message.args)) throw new Error("Invalid Copilot bridge callback.");
      const callback = callbacks.get(message.sessionId)?.[message.callback];
      if (!callback) throw new Error("Copilot callback is unavailable.");
      const identity = message.permissionIdentity;
      if (identity !== undefined) {
        const value = message.args[0];
        if (message.callback !== "onPermissionRequest" || typeof identity !== "string" || !/^[a-f0-9-]{36}$/.test(identity) || permissions.has(identity) || permissions.size >= 128 || value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Copilot permission callback identity is invalid.");
        permissions.set(identity, { sessionId: message.sessionId, request: value, serialized: JSON.stringify(value) });
      }
      await respond(message.id, await callback(...message.args));
    } catch (error) { await respond(message.id, undefined, error instanceof Error ? error : new Error(String(error))); }
  }
  const tree = (target: string, parts: readonly string[] = []): unknown => new Proxy(() => {}, {
    get(_object, name) { if (name === "then" || typeof name !== "string") return undefined; return tree(target, [...parts, name]); },
    apply(_object, _this, args: unknown[]) { return request("call", [target, parts, args]); },
  });
  const sessions = new Map<string, CopilotSession>();
  const session = (sessionId: string): CopilotSession => {
    const existing = sessions.get(sessionId); if (existing) return existing;
    const value = new Proxy({}, { get(_object, name) {
      if (name === "then" || typeof name !== "string") return undefined;
      if (name === "sessionId") return sessionId;
      if (name === "rpc") return tree(sessionId, ["rpc"]);
      if (name === "on") return (...args: unknown[]) => {
        const callback = args.at(-1); if (typeof callback !== "function") throw new Error("Copilot event callback is invalid.");
        const wrapped = (event: unknown) => { if (typeof args[0] !== "string" || object(event).type === args[0]) callback(event); };
        let subscribers = subscriptions.get(sessionId); if (!subscribers) subscriptions.set(sessionId, subscribers = new Set()); subscribers.add(wrapped);
        return () => subscribers.delete(wrapped);
      };
      return (...args: unknown[]) => request("call", [sessionId, [name], args]);
    } }) as CopilotSession;
    imageSessions.set(value, async (input, verify) => {
      if (closed || closing || failed || admissions.size) throw new Error("Copilot image admission is unavailable.");
      const admissionId = randomUUID(), admission = { sessionId, verify, consumed: false, error: undefined as Error | undefined };
      admissions.set(admissionId, admission);
      try { return await request("sendImages", [sessionId, input, admissionId]) as string; }
      catch (error) { throw admission.error ?? error; }
      finally { admissions.delete(admissionId); }
    });
    sessions.set(sessionId, value); return value;
  };
  const open = async (method: "createSession" | "resumeSession", sessionId: string, config: SessionConfig): Promise<CopilotSession> => {
    if (!sessionId || callbacks.has(sessionId)) throw new Error("Copilot bridge session is already bound.");
    const clean = { ...config } as Record<string, unknown>, handlers: Callbacks = {};
    for (const name of ["onEvent", "onPermissionRequest", "onUserInputRequest", "onElicitationRequest", "onExitPlanModeRequest"]) {
      if (typeof clean[name] === "function") { handlers[name] = clean[name] as (...args: unknown[]) => unknown; delete clean[name]; }
    }
    callbacks.set(sessionId, handlers);
    const result = object(await request("open", [method, sessionId, clean, Object.keys(handlers)]));
    if (result.sessionId !== sessionId) throw new Error("Copilot bridge returned a different native session.");
    return session(sessionId);
  };
  const client = new Proxy({}, { get(_object, name) {
    if (name === "then" || typeof name !== "string") return undefined;
    if (name === "rpc") return tree("client", ["rpc"]);
    if (name === "createSession") return (config: SessionConfig) => open("createSession", config.sessionId ?? "", config);
    if (name === "resumeSession") return (id: string, config: SessionConfig) => open("resumeSession", id, config);
    return (...args: unknown[]) => request("call", ["client", [name], args]);
  } }) as CopilotClient;
  const ready = spawned.then(async () => { await request("initialize", [options.port, options.token]); return client; });
  const bounded = async (operation: Promise<unknown>, ms: number) => {
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Copilot bridge stop is unconfirmed.")), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  let closePromise: Promise<void> | undefined;
  let closeRequested = false, termRequested = false, killRequested = false;
  const joinHelper = async (): Promise<void> => {
    if (closed) return;
    if (!closeRequested && !failed) {
      closeRequested = true;
      try {
        await bounded(request("close"), 1500);
        // The reply precedes stdio closure. Join normal exit before escalating.
        if (!closed) await bounded(exited, 1500);
      } catch { /* The owned process must still be joined below. */ }
    }
    if (closed) return;
    if (!termRequested && child.pid) {
      termRequested = true;
      try { child.kill("SIGTERM"); await bounded(exited, 2000); } catch { /* Escalate once, then retain an unknown exit. */ }
    }
    if (closed) return;
    if (!killRequested && child.pid) { killRequested = true; child.kill("SIGKILL"); }
    await bounded(exited, 2000);
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    const attempt = (async () => {
      closing = true;
      await joinHelper();
      channel.close();
      for (const waiter of waiters.values()) waiter.reject(new Error("Copilot SDK bridge stopped; operation results are unknown.")); waiters.clear();
      const errors: unknown[] = [];
      for (const [id, transfer] of transfers) if (!transfer.marker) {
        try { transfer.spool.remove(); transfers.delete(id); totalTransfers -= transfer.length; }
        catch (error) { errors.push(error); }
      }
      for (const image of owned) try { releaseCopilotBridgeImage(image); } catch (error) { errors.push(error); }
      admissions.clear(); callbacks.clear(); subscriptions.clear(); permissions.clear();
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Copilot bridge cleanup did not release every retained transfer.");
    })();
    closePromise = attempt;
    // Retried cleanup only joins the original helper and retires retained media.
    const settled = () => { if (closePromise === attempt) closePromise = undefined; };
    void attempt.then(settled, settled);
    return attempt;
  };
  return { child, ready, close, metrics: () => ({ peakRss, peakHeap, peakExternal, peakArrayBuffers, samples, mediaBytes: totalTransfers, mediaCount: transfers.size }) };
};
