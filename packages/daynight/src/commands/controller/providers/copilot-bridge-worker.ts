import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { CopilotClient, RuntimeConnection, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import { CopilotBridgeChannel } from "./copilot-bridge-channel.js";
import { encodeCopilotBridgeImages, exportCopilotBridgeMedia, type CopilotBridgeImageInput } from "./copilot-bridge-media.js";
import { startCopilotFrameProxy } from "./copilot-frame.js";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const { ResponseError } = createRequire(createRequire(import.meta.url).resolve("@github/copilot-sdk"))("vscode-jsonrpc/node") as { ResponseError: new (...args: never[]) => Error & { code: number } };
const errorValue = (error: unknown) => ({ kind: error instanceof ResponseError ? "response" : "unknown", ...(error instanceof ResponseError ? { code: error.code } : {}), message: error instanceof Error ? error.message.slice(0, 4096) : "Copilot bridge operation failed; outcome is unknown." });
let client: CopilotClient | undefined, session: CopilotSession | undefined;
let proxy: Awaited<ReturnType<typeof startCopilotFrameProxy>> | undefined;
let closing = false, stoppingClient = false, fatalFailure = false, initializing = false, openingSession = false, sending = false, history = false;
let eventWork: Promise<void> = Promise.resolve(), queuedEventBytes = 0;
const waiters = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const channel = new CopilotBridgeChannel(process.stdin, process.stdout, value => { void receive(object(value)).catch(fatal); }, fatal);
const reportMetrics = () => {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  void channel.send({ type: "metrics", rss, heapUsed, external, arrayBuffers }).catch(fatal);
  if (rss > 1_610_612_736) fatal(new Error("Copilot SDK bridge exceeded its RSS monitoring threshold."));
};
const metrics = setInterval(reportMetrics, 1000);
metrics.unref();

function fatal(error: Error): void {
  if (fatalFailure || closing) return;
  fatalFailure = true;
  for (const waiter of waiters.values()) waiter.reject(error); waiters.clear();
  void (async () => {
    try { await channel.send({ type: "fatal", error: errorValue(error) }); } catch { /* The parent also observes process exit. */ }
    try { await client?.forceStop(); } catch { /* Native ownership remains with the Controller. */ }
    try { await proxy?.close(); } catch { /* Process exit still closes the private sockets. */ }
    channel.close(); clearInterval(metrics); process.exitCode = 1; process.stdin.destroy(); process.stdout.end();
  })();
}
const request = (message: Record<string, unknown>): Promise<unknown> => {
  if (closing || fatalFailure || waiters.size >= 128) return Promise.reject(new Error("Copilot bridge request admission failed."));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    void channel.send({ ...message, type: "request", id }).catch(error => { waiters.delete(id); reject(error); });
  });
};
const transferImage = async (data: string, mimeType: string): Promise<{ transferId?: string; error?: string }> => {
  if (!data.length || data.length > 13_981_016 || data.length % 4 === 1) return { error: "image_too_large_or_invalid" };
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const effective = data.length - padding;
  if (padding && data.length % 4 !== 0 || data.slice(0, effective).includes("=")) return { error: "invalid_base64" };
  const length = Math.floor(effective * 3 / 4);
  if (length < 1 || length > 10_485_760) return { error: "image_too_large_or_invalid" };
  // Validate the entire source before opening a receiver. Unpadded native input
  // is normalized only at this boundary, never accepted as public chunk syntax.
  for (let offset = 0; offset < data.length; offset += 699_048) {
    const part = data.slice(offset, offset + 699_048), bytes = Buffer.from(part, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== part.replace(/=+$/, "")) return { error: "invalid_base64" };
  }
  const transferId = randomUUID();
  const begin = object(await request({ method: "media", args: { action: "begin", transferId, length, mimeType } }));
  if (begin.available !== true) return { error: typeof begin.error === "string" ? begin.error : "capacity_exceeded" };
  try {
    let decoded = 0; const hash = createHash("sha256");
    for (let offset = 0; offset < data.length; offset += 699_048) {
      const bytes = Buffer.from(data.slice(offset, offset + 699_048), "base64"); hash.update(bytes);
      const receipt = object(await request({ method: "media", args: { action: "part", transferId, offset: decoded, data: bytes.toString("base64") } }));
      decoded += bytes.length;
      if (receipt.offset !== decoded) throw new Error("Copilot media receiver offset differs.");
    }
    if (decoded !== length) throw new Error("Copilot media length differs.");
    const sealed = object(await request({ method: "media", args: { action: "seal", transferId, sha256: hash.digest("hex") } }));
    if (sealed.sealed !== true) throw new Error("Copilot media receiver did not seal its bytes.");
    return { transferId };
  } catch {
    try { await request({ method: "media", args: { action: "abort", transferId } }); } catch { /* Unknown receiver ownership is retained until process shutdown. */ }
    return { error: "capture_failed" };
  }
};
const eventSize = (input: unknown): number => {
  let tokens = 0, bytes = 0;
  const scan = (value: unknown, depth: number) => {
    if (++tokens > 100_000 || depth > 64) throw new Error("Copilot event structure exceeded its bound.");
    if (typeof value === "string") bytes += Buffer.byteLength(value) + 2;
    else if (Array.isArray(value)) { bytes += value.length + 2; for (const item of value) scan(item, depth + 1); }
    else if (value !== null && typeof value === "object") { for (const [key, item] of Object.entries(value)) { bytes += Buffer.byteLength(key) + 4; scan(item, depth + 1); } }
    else bytes += 32;
    if (bytes > 134_217_728) throw new Error("Copilot event exceeded its native frame bound.");
  };
  scan(input, 0); return bytes;
};
const permissionIdentities = new WeakMap<object, string>();
const enqueueEvent = (sessionId: string, event: unknown) => {
  try {
    const request = object(object(event).data).permissionRequest;
    const permissionIdentity = object(event).type === "permission.requested" && request !== null && typeof request === "object" ? permissionIdentities.get(request) : undefined;
    const bytes = eventSize(event);
    if (queuedEventBytes + bytes > 201_326_592) throw new Error("Copilot event queue exceeded its bound; native history must be reconciled.");
    queuedEventBytes += bytes;
    eventWork = eventWork.then(async () => {
      if (closing || fatalFailure) return;
      const result = await exportCopilotBridgeMedia(event, "event", transferImage);
      await channel.send({ type: "event", sessionId, result, ...(permissionIdentity ? { permissionIdentity } : {}) });
    }).finally(() => { queuedEventBytes -= bytes; }).catch(fatal);
  } catch (error) { fatal(error instanceof Error ? error : new Error(String(error))); }
};
const callback = (sessionId: string, name: string) => async (...args: unknown[]) => {
  if (name === "onPermissionRequest" && args[0] !== null && typeof args[0] === "object") {
    // Preserve the SDK's callback-before-event order and shared object identity
    // across serialization. This identity grants no permission by itself.
    const permissionIdentity = randomUUID(); permissionIdentities.set(args[0], permissionIdentity);
    return request({ method: "callback", sessionId, callback: name, args, permissionIdentity });
  }
  // SDK callback dispatch can precede its identity-bearing event in one stack.
  // Drain that event before the Controller attempts to bind the callback.
  await Promise.resolve(); await eventWork;
  return request({ method: "callback", sessionId, callback: name, args });
};
const invoke = async (target: unknown, parts: readonly string[], args: unknown[]): Promise<unknown> => {
  if (!parts.length || parts.length > 8 || parts.some(part => !/^[A-Za-z][A-Za-z0-9]*$/.test(part) || ["constructor", "prototype", "__proto__"].includes(part))) throw new Error("Invalid Copilot SDK call path.");
  let owner = target;
  for (const part of parts.slice(0, -1)) owner = object(owner)[part];
  const method = object(owner)[parts.at(-1)!];
  if (typeof method !== "function") throw new Error("Copilot SDK operation is unavailable.");
  return Reflect.apply(method, owner, args);
};
async function operation(method: string, args: unknown[]): Promise<unknown> {
  if (method === "initialize") {
    if (client || initializing || args.length !== 2 || typeof args[0] !== "number" || typeof args[1] !== "string" || !/^[a-f0-9]{64}$/.test(args[1])) throw new Error("Invalid Copilot bridge initialization.");
    initializing = true;
    proxy = await startCopilotFrameProxy(args[0], error => { if (!stoppingClient) fatal(error); });
    client = new CopilotClient({ connection: RuntimeConnection.forUri(`127.0.0.1:${proxy.port}`, { connectionToken: args[1] }) });
    await client.start(); return {};
  }
  if (method === "close") {
    closing = true; clearInterval(metrics);
    for (const waiter of waiters.values()) waiter.reject(new Error("Copilot bridge is closing.")); waiters.clear();
    await client?.forceStop(); await proxy?.close(); return {};
  }
  if (!client || closing || fatalFailure) throw new Error("Copilot SDK bridge is unavailable.");
  if (method === "open") {
    const [opening, id, raw, names] = args;
    if (session || openingSession || opening !== "createSession" && opening !== "resumeSession" || typeof id !== "string" || !id || !Array.isArray(names) || names.some(name => typeof name !== "string" || !["onEvent", "onPermissionRequest", "onUserInputRequest", "onElicitationRequest", "onExitPlanModeRequest"].includes(name))) throw new Error("Invalid Copilot bridge session binding.");
    // Unknown or rejected opens cannot be retried inside this helper. The runtime
    // owner must reconcile the original operation before deciding its lifecycle.
    openingSession = true;
    const config = { ...object(raw), sessionId: id } as SessionConfig;
    const mutable = config as unknown as Record<string, unknown>;
    // Always own the sole subscription; the facade fans it out without another SDK connection.
    mutable.onEvent = (event: unknown) => enqueueEvent(id, event);
    for (const name of names) if (name !== "onEvent") mutable[name] = callback(id, name);
    session = opening === "createSession" ? await client.createSession(config) : await client.resumeSession(id, config);
    if (session.sessionId !== id) throw new Error("Copilot SDK session identity differs.");
    return { sessionId: id };
  }
  if (method === "sendImages") {
    if (!session || args[0] !== session.sessionId || sending) throw new Error("Copilot image send is unavailable or already in progress.");
    sending = true;
    try {
      if (typeof args[2] !== "string") throw new Error("Copilot image admission identity is missing.");
      const input = await encodeCopilotBridgeImages(args[1] as CopilotBridgeImageInput);
      const allowed = await request({ method: "image_admission", sessionId: session.sessionId, admissionId: args[2] });
      if (allowed !== true || closing || fatalFailure) throw new Error("Copilot image admission ended before native dispatch.");
      return await session.send(input);
    }
    finally { sending = false; }
  }
  if (method !== "call" || !Array.isArray(args[1]) || args[1].some(part => typeof part !== "string") || !Array.isArray(args[2])) throw new Error("Invalid Copilot bridge call.");
  const [target, rawParts, input] = args as [unknown, string[], unknown[]];
  const owner = target === "client" ? client : session && target === session.sessionId ? session : undefined;
  if (!owner || rawParts[0] !== "rpc" && !(target === "client" ? ["ping", "getStatus", "getSessionMetadata", "stop", "forceStop"] : ["send", "getEvents", "disconnect"]).includes(rawParts[0]!)) throw new Error("Copilot bridge call is outside its bound session.");
  if (target !== "client" && Object.hasOwn(object(input[0]), "sessionId")) throw new Error("Copilot bridge calls cannot replace their bound session identity.");
  if (rawParts.join(".") === "getEvents") throw new Error("Copilot bridge requires bounded eventLog.read history pages.");
  if (rawParts.join(".") === "rpc.eventLog.read" && (object(input[0]).max !== 1 || object(input[0]).includeEphemeral !== false)) throw new Error("Copilot bridge history requires max=1 and includeEphemeral=false.");
  const isSend = rawParts.join(".") === "send";
  if (isSend && object(input[0]).attachments !== undefined) throw new Error("Copilot image sends require controlled bridge leases.");
  if (isSend && sending) throw new Error("Copilot bridge operation is already in progress.");
  if (isSend) sending = true;
  if (target === "client" && rawParts.length === 1 && ["stop", "forceStop"].includes(rawParts[0]!)) stoppingClient = true;
  if (target === "client" && rawParts.join(".") === "rpc.runtime.shutdown") {
    // The owner shuts down this external SDK runtime. Detach while its socket is
    // still writable, and classify the ensuing native EOF as intentional cleanup.
    stoppingClient = true;
    await session?.disconnect();
  }
  try { return await invoke(owner, rawParts, input); }
  finally { if (isSend) sending = false; }
}
async function receive(message: Record<string, unknown>): Promise<void> {
  if (message.type === "response" && typeof message.id === "string") {
    const waiter = waiters.get(message.id); if (!waiter) return;
    waiters.delete(message.id);
    if (message.error !== undefined) waiter.reject(new Error(typeof object(message.error).message === "string" ? object(message.error).message as string : "Copilot receiver rejected its request."));
    else waiter.resolve(message.value);
    return;
  }
  if (message.type !== "request" || typeof message.id !== "string" || typeof message.method !== "string" || !Array.isArray(message.args)) throw new Error("Invalid Copilot bridge request.");
  let ownsHistory = false;
  try {
    const parts = message.method === "call" && Array.isArray(message.args[1]) ? message.args[1].join(".") : "";
    if (["getEvents", "rpc.eventLog.read"].includes(parts)) {
      if (history) throw new Error("Copilot bridge history operation is already in progress.");
      history = true; ownsHistory = true;
    }
    const value = await operation(message.method, message.args);
    reportMetrics();
    const result = await exportCopilotBridgeMedia(value, parts === "getEvents" ? "events" : parts === "rpc.eventLog.read" ? "eventLog" : "metadata", transferImage);
    await channel.send({ type: "response", id: message.id, result });
    if (message.method === "close") { channel.close(); process.stdin.destroy(); process.stdout.end(); }
  } catch (error) { await channel.send({ type: "response", id: message.id, error: errorValue(error) }); }
  finally { if (ownsHistory) history = false; }
}
