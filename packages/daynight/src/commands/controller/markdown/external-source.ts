import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { Agent, request, type IncomingMessage } from "node:http";
import { isIP, connect, type Socket } from "node:net";
import { connect as connectTls, checkServerIdentity } from "node:tls";
import { performance } from "node:perf_hooks";
import type { DisplayMime } from "../../../session/image-values.js";

export type ExternalImageSourceErrorCode = "policy_restricted" | "source_forbidden" | "source_unavailable" | "source_not_found" | "permission_denied" | "source_rate_limited" | "source_busy" | "source_timeout" | "source_cancelled" | "source_too_large" | "invalid_image" | "unsupported_media_type";
export class ExternalImageSourceError extends Error {
  constructor(readonly code: ExternalImageSourceErrorCode, readonly retryAfterSeconds?: number) { super(code); this.name = "ExternalImageSourceError"; }
}
const failure = (code: ExternalImageSourceErrorCode) => new ExternalImageSourceError(code);
const MAX_BYTES = 10_485_760;
export const EXTERNAL_IMAGE_ADDRESS_POLICY_REVISION = "iana-special-use-2026-11-10";
// Snapshot: IANA IPv4/IPv6 Special-Purpose Address Registries, 2026-11-10.
// A special-purpose assignment is refused even when IANA marks it globally reachable.
const IPV4_SPECIAL = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.31.196.0/24", "192.52.193.0/24", "192.88.99.0/24", "192.168.0.0/16", "192.175.48.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"];
const IPV6_SPECIAL = ["2001::/23", "2001:db8::/32", "2002::/16", "2620:4f:8000::/48", "3fff::/20"];
function addressBits(input: string): { family: number; bits: bigint } | null {
  if (input.includes("%")) return null;
  const family = isIP(input);
  if (family === 4) return { family, bits: input.split(".").reduce((n, octet) => (n << 8n) | BigInt(octet), 0n) };
  if (family !== 6) return null;
  let value = input.toLowerCase();
  if (value.includes(".")) {
    const pos = value.lastIndexOf(":"), v4 = addressBits(value.slice(pos + 1));
    if (!v4) return null;
    value = value.slice(0, pos + 1) + (v4.bits >> 16n).toString(16) + ":" + (v4.bits & 65535n).toString(16);
  }
  const halves = value.split("::"), left = halves[0] ? halves[0].split(":") : [], right = halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  const bits = words.reduce((n, word) => (n << 16n) | BigInt("0x" + word), 0n);
  if ((bits >> 32n) === 65535n) return { family: 4, bits: bits & 0xffffffffn };
  return { family, bits };
}
function inRange(bits: bigint, cidr: string, width: number): boolean {
  const [address, prefix] = cidr.split("/"), base = addressBits(address!)!;
  const shift = BigInt(width - Number(prefix));
  return (bits >> shift) === (base.bits >> shift);
}
function sameAddress(a: string, b: string): boolean { const x = addressBits(a), y = addressBits(b); return !!x && !!y && x.family === y.family && x.bits === y.bits; }
export function isPublicImageAddress(address: string): boolean {
  const value = addressBits(address); if (!value) return false;
  if (value.family === 4) return !IPV4_SPECIAL.some(cidr => inRange(value.bits, cidr, 32));
  // Ordinary public IPv6 unicast is within 2000::/3; all other allocations fail closed.
  return inRange(value.bits, "2000::/3", 128) && !IPV6_SPECIAL.some(cidr => inRange(value.bits, cidr, 128));
}
function assertHostname(host: string): void {
  if (!host || host.length > 253 || host.endsWith(".") || !host.includes(".") || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal" || host === "metadata.goog" || host === "instance-data.ec2.internal" || host.endsWith(".internal")) throw failure("source_forbidden");
}
export function parseExternalImageUrl(input: string): URL {
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > 8192 || !/^https?:\/\//i.test(input) || /[\u0000-\u0020\u007f-\u009f\\]/u.test(input) || /[\ud800-\udfff]/u.test(input.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ""))) throw failure("source_forbidden");
  const authority = input.slice(input.indexOf("://") + 3).split(/[/?#]/, 1)[0]!;
  if (!authority || authority.includes("@") || authority.includes("%")) throw failure("source_forbidden");
  let url: URL; try { url = new URL(input); } catch { throw failure("source_forbidden"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) throw failure("source_forbidden");
  if (authority.endsWith(":")) throw failure("source_forbidden");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (isIP(hostname)) { if (!isPublicImageAddress(hostname)) throw failure("source_forbidden"); }
  else assertHostname(hostname);
  url.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return url;
}
export interface ExternalImageDnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveCname(hostname: string): Promise<string[]>;
  cancel(): void;
}
function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw signal.reason instanceof ExternalImageSourceError ? signal.reason : failure("source_cancelled"); }
export async function resolveExternalImageAddresses(hostname: string, signal: AbortSignal, resolver: ExternalImageDnsResolver = new Resolver({ timeout: 3000, tries: 1 })): Promise<string[]> {
  if (isIP(hostname)) { if (!isPublicImageAddress(hostname)) throw failure("source_forbidden"); return [hostname]; }
  assertHostname(hostname); checkSignal(signal);
  const controller = new AbortController(), stop = () => controller.abort(signal.reason ?? failure("source_cancelled"));
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => controller.abort(failure("source_timeout")), 3000);
  const cancel = () => resolver.cancel(); controller.signal.addEventListener("abort", cancel, { once: true });
  const results: string[] = [], seen = new Set<string>(); let current = hostname;
  try {
    for (let depth = 0; depth <= 8; depth++) {
      checkSignal(controller.signal); assertHostname(current);
      if (seen.has(current)) throw failure("source_forbidden"); seen.add(current);
      // All families and the alias query must settle before a socket can be opened.
      const answers = await Promise.allSettled([resolver.resolve4(current), resolver.resolve6(current), resolver.resolveCname(current)]);
      checkSignal(controller.signal);
      const values = answers.map(answer => {
        if (answer.status === "fulfilled") return answer.value;
        if ((answer.reason as NodeJS.ErrnoException)?.code === "ENODATA") return [];
        throw failure((answer.reason as NodeJS.ErrnoException)?.code === "ETIMEOUT" ? "source_timeout" : "source_unavailable");
      });
      for (const address of [...values[0]!, ...values[1]!]) {
        if (!isPublicImageAddress(address)) throw failure("source_forbidden"); results.push(address);
        if (results.length > 32) throw failure("source_forbidden");
      }
      if (values[2]!.length > 1) throw failure("source_forbidden");
      const alias = values[2]![0];
      if (!alias) { if (!results.length) throw failure("source_unavailable"); return [...new Set(results)]; }
      if (depth === 8) throw failure("source_forbidden");
      current = alias.toLowerCase().replace(/\.$/, "");
    }
    throw failure("source_forbidden");
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); controller.signal.removeEventListener("abort", cancel); resolver.cancel(); }
}
export interface ExternalImageControlledNetworkBoundary {
  /** A trusted isolated network boundary; never inferred from environment variables. */
  hostname: string;
  address: string;
  port: number;
  ca?: string;
}
export interface ExternalImagePolicyOptions {
  /** Must prove the deployed egress boundary and current authorization, including per-block revocation. */
  assertEgressPolicy(): void | Promise<void>;
  /** Must durably charge every hop and address retry before any connection starts. */
  beforeRequest(input: { hostname: string }): void | Promise<void>;
  controlledNetworkBoundary?: ExternalImageControlledNetworkBoundary;
}
const policies = new WeakMap<object, ExternalImagePolicyOptions>();
export interface ExternalImagePolicy { readonly addressPolicyRevision: string }
/** Internal capability issued by the trusted runtime, never by locator data or an environment flag. */
export function createExternalImagePolicy(options: ExternalImagePolicyOptions): ExternalImagePolicy {
  const policy = Object.freeze({ addressPolicyRevision: EXTERNAL_IMAGE_ADDRESS_POLICY_REVISION }); policies.set(policy, options); return policy;
}
async function assertPolicy(policy: ExternalImagePolicyOptions, signal: AbortSignal): Promise<void> {
  checkSignal(signal); try { await policy.assertEgressPolicy(); } catch { throw failure("policy_restricted"); } checkSignal(signal);
}
function controlledBoundary(url: URL, policy: ExternalImagePolicyOptions): ExternalImageControlledNetworkBoundary | null {
  const b = policy.controlledNetworkBoundary;
  return b && b.hostname === url.hostname && b.port === Number(url.port || (url.protocol === "https:" ? 443 : 80)) && isIP(b.address) ? b : null;
}
async function destroyAndJoin(socket: Socket): Promise<void> {
  if (socket.closed) return;
  await new Promise<void>(resolve => { socket.once("close", resolve); socket.destroy(); });
}
export function assertExternalImageSocketPeer(socket: Socket, selectedAddress: string, controlledAddress?: string): void {
  const actual = socket.remoteAddress;
  if (!actual || !sameAddress(actual, selectedAddress) || !(isPublicImageAddress(actual) || controlledAddress !== undefined && sameAddress(actual, controlledAddress))) throw failure("source_forbidden");
}
async function openVerifiedSocket(url: URL, address: string, policy: ExternalImagePolicyOptions, signal: AbortSignal): Promise<Socket> {
  const boundary = controlledBoundary(url, policy), host = url.hostname.replace(/^\[|\]$/g, ""), port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const approved = (candidate: string) => isPublicImageAddress(candidate) || !!boundary && sameAddress(candidate, boundary.address);
  if (!approved(address)) throw failure("source_forbidden");
  const socket = connect({ host: address, port, family: isIP(address) === 6 ? 6 : 4, autoSelectFamily: false });
  socket.on("error", () => {});
  let current: Socket = socket;
  const abort = () => current.destroy(signal.reason instanceof Error ? signal.reason : failure("source_cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => current.destroy(failure("source_timeout")), 5000);
  const connected = (candidate: Socket, event: "connect" | "secureConnect") => new Promise<void>((resolve, reject) => {
    const ok = () => { candidate.removeListener("error", bad); resolve(); }, bad = (error: Error) => { candidate.removeListener(event, ok); reject(error); };
    candidate.once(event, ok); candidate.once("error", bad);
  });
  try {
    checkSignal(signal); await connected(socket, "connect");
    if (socket.readableHighWaterMark > 65536 || socket.writableHighWaterMark > 65536) throw failure("policy_restricted");
    assertExternalImageSocketPeer(socket, address, boundary?.address);
    await assertPolicy(policy, signal);
    if (url.protocol === "https:") {
      const tls = connectTls({ socket, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: true, minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"], ...(boundary?.ca ? { ca: boundary.ca } : {}), checkServerIdentity: (_servername, certificate) => checkServerIdentity(host, certificate) });
      tls.on("error", () => {}); current = tls;
      await connected(tls, "secureConnect");
      if (tls.readableHighWaterMark > 65536 || tls.writableHighWaterMark > 65536) throw failure("policy_restricted");
      if (!tls.authorized || (tls.alpnProtocol && tls.alpnProtocol !== "http/1.1")) throw failure("source_forbidden");
      assertExternalImageSocketPeer(tls, address, boundary?.address);
      // Node skips the identity callback when no SNI is supplied for an IP SAN.
      const identityError = checkServerIdentity(host, tls.getPeerCertificate()); if (identityError) throw failure("source_forbidden");
    }
    checkSignal(signal); return current;
  } catch (error) { await destroyAndJoin(current); if (current !== socket) await destroyAndJoin(socket); throw error; }
  finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
}
function validateResponseHeaders(response: IncomingMessage): { length: number | null; contentType: string | null } {
  if (response.rawHeaders.length > 200) throw failure("source_unavailable");
  const critical = new Set(["content-length", "transfer-encoding", "content-encoding", "content-type", "location", "retry-after"]), seen = new Set<string>();
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const name = response.rawHeaders[i]!.toLowerCase(), value = response.rawHeaders[i + 1]!;
    if (/[\u0000-\u001f\u007f]/.test(value)) throw failure("source_unavailable");
    if (critical.has(name) && seen.has(name)) throw failure("source_unavailable"); seen.add(name);
  }
  const encoding = response.headers["content-encoding"];
  if (encoding !== undefined && (typeof encoding !== "string" || encoding.toLowerCase() !== "identity")) throw failure("source_unavailable");
  const lengthHeader = response.headers["content-length"], transfer = response.headers["transfer-encoding"];
  if (lengthHeader !== undefined && transfer !== undefined || transfer !== undefined && transfer.toLowerCase() !== "chunked") throw failure("source_unavailable");
  if (lengthHeader !== undefined && !/^(?:0|[1-9][0-9]*)$/.test(lengthHeader)) throw failure("source_unavailable");
  const length = lengthHeader === undefined ? null : Number(lengthHeader);
  if (length !== null && (!Number.isSafeInteger(length) || length > MAX_BYTES)) throw failure("source_too_large");
  const contentType = response.headers["content-type"] ?? null;
  return { length, contentType };
}
async function readBodyBlock(response: IncomingMessage): Promise<Buffer | null> {
  for (;;) {
    const block: unknown = response.readableLength > 0 ? response.read(Math.min(65536, response.readableLength)) : null;
    if (Buffer.isBuffer(block)) return block;
    if (response.readableEnded) return null;
    if (response.destroyed) throw failure("source_unavailable");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { response.removeListener("readable", ready); response.removeListener("end", ready); response.removeListener("error", error); response.removeListener("close", closed); };
      const ready = () => { cleanup(); resolve(); }, error = (cause: Error) => { cleanup(); reject(cause); }, closed = () => { cleanup(); if (response.complete) resolve(); else reject(failure("source_unavailable")); };
      response.once("readable", ready); response.once("end", ready); response.once("error", error); response.once("close", closed);
    });
  }
}
function retryAfter(value: string | string[] | undefined): number {
  if (typeof value !== "string") return 30;
  if (/^[0-9]+$/.test(value)) return Math.min(300, Number(value));
  const httpDate = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [0-9]{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-9][0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})$/;
  if (!httpDate.test(value)) return 30;
  const date = Date.parse(value); return Number.isFinite(date) ? Math.min(300, Math.max(0, Math.ceil((date - Date.now()) / 1000))) : 30;
}
export async function copyExternalImage(input: { url: string; outputPath: string; signal?: AbortSignal; policy?: ExternalImagePolicy }): Promise<{ inputPath: string; byteLength: string; sha256: string; declaredMediaType: DisplayMime | null }> {
  const policy = input.policy && policies.get(input.policy); if (!policy) throw failure("policy_restricted");
  const controller = new AbortController(), outerAbort = () => controller.abort(failure("source_cancelled"));
  input.signal?.addEventListener("abort", outerAbort, { once: true }); if (input.signal?.aborted) outerAbort();
  const signal = controller.signal, started = performance.now(), totalTimeout = setTimeout(() => controller.abort(failure("source_timeout")), 30000);
  let active: Socket | null = null, handle: Awaited<ReturnType<typeof open>> | null = null;
  const abort = () => active?.destroy(signal.reason instanceof Error ? signal.reason : failure("source_cancelled")); signal.addEventListener("abort", abort);
  try {
    await assertPolicy(policy, signal);
    let url = parseExternalImageUrl(input.url); const visited = new Set<string>();
    const before = await lstat(input.outputPath, { bigint: true });
    if (!before.isFile() || before.size !== 0n || before.nlink !== 1n) throw failure("policy_restricted");
    handle = await open(input.outputPath, constants.O_WRONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true }), after = await lstat(input.outputPath, { bigint: true });
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || after.ino !== stat.ino || after.dev !== stat.dev || stat.size !== 0n || stat.nlink !== 1n) throw failure("policy_restricted");
    for (let hop = 0; hop <= 5; hop++) {
      await assertPolicy(policy, signal);
      const key = new URL(url); key.hash = "";
      if (visited.has(key.href)) throw failure("source_forbidden"); visited.add(key.href);
      const boundary = controlledBoundary(url, policy), hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = boundary ? [boundary.address] : await resolveExternalImageAddresses(hostname, signal);
      let lastError: unknown;
      for (const address of addresses.slice(0, 2)) {
        await assertPolicy(policy, signal); await policy.beforeRequest({ hostname }); checkSignal(signal);
        try { active = await openVerifiedSocket(url, address, policy, signal); break; }
        catch (error) { lastError = error; if (error instanceof ExternalImageSourceError && error.code !== "source_timeout") throw error; }
      }
      if (!active) throw lastError ?? failure("source_unavailable");
      const socket = active, agent = new Agent({ keepAlive: false, maxSockets: 1 });
      // An explicit dedicated Agent prevents agent:false from discarding createConnection.
      agent.createConnection = () => socket;
      let response: IncomingMessage | null = null;
      try {
        await assertPolicy(policy, signal);
        response = await new Promise<IncomingMessage>((resolve, reject) => {
          const req = request({ protocol: "http:", hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), path: url.pathname + url.search, method: "GET", agent, maxHeaderSize: 32768, insecureHTTPParser: false, headers: { Host: url.host, Accept: "image/png,image/jpeg,image/webp,image/gif,image/avif", "Accept-Encoding": "identity", "User-Agent": "Daynight-Image-Source/1", Connection: "close" }, signal });
          req.maxHeadersCount = 0;
          const timeout = setTimeout(() => req.destroy(failure("source_timeout")), Math.min(8000, Math.max(1, 30000 - (performance.now() - started))));
          req.once("response", incoming => { clearTimeout(timeout); resolve(incoming); });
          req.once("error", error => { clearTimeout(timeout); reject(error); });
          req.once("upgrade", incoming => { clearTimeout(timeout); incoming.destroy(); req.destroy(failure("source_unavailable")); reject(failure("source_unavailable")); });
          req.once("connect", incoming => { clearTimeout(timeout); incoming.destroy(); reject(failure("source_unavailable")); });
          req.end();
        });
        const { length, contentType } = validateResponseHeaders(response), status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status ?? 0)) {
          if (hop === 5 || typeof response.headers.location !== "string" || !response.headers.location || /[\u0000-\u0020\u007f\\]/u.test(response.headers.location)) throw failure("source_forbidden");
          let destination: URL; try { destination = new URL(response.headers.location, url); } catch { throw failure("source_forbidden"); }
          url = parseExternalImageUrl(destination.href); continue;
        }
        if (status === 404 || status === 410) throw failure("source_not_found");
        if (status === 401 || status === 403) throw failure("permission_denied");
        if (status === 429 || status === 503) throw new ExternalImageSourceError(status === 429 ? "source_rate_limited" : "source_busy", retryAfter(response.headers["retry-after"]));
        if (status !== 200) throw failure("source_unavailable");
        const mime = contentType?.match(/^(image\/(?:png|jpeg|webp|gif|avif)|application\/octet-stream)(?: *; *[!#$%&'*+.^_`|~0-9A-Za-z-]+ *= *(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[ !#-\[\]-~]|\\[ -~])*"))* *$/i);
        if (contentType !== null && !mime) throw failure("unsupported_media_type");
        const declaredMediaType = mime?.[1]?.toLowerCase().startsWith("image/") ? mime[1].toLowerCase() as DisplayMime : null;
        let bytes = 0, idle: ReturnType<typeof setTimeout>;
        const progress = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(failure("source_timeout")), 5000); }; progress();
        const hash = createHash("sha256");
        try {
          if (response.readableHighWaterMark > 65536) throw failure("source_unavailable");
          // Socket, response queue and the current block each have a 64 KiB bound.
          socket.on("data", progress);
          for (;;) {
            const block = await readBodyBlock(response); if (block === null) break;
            progress(); await assertPolicy(policy, signal);
            if (block.length > 65536 || bytes + block.length > MAX_BYTES) throw failure("source_too_large");
            let written = 0;
            while (written < block.length) { const result = await handle.write(block, written, block.length - written, bytes + written); if (!result.bytesWritten) throw failure("source_unavailable"); written += result.bytesWritten; }
            hash.update(block); bytes += block.length;
          }
        } finally { clearTimeout(idle!); socket.removeListener("data", progress); }
        checkSignal(signal);
        if (!response.complete || length !== null && bytes !== length) throw failure("source_unavailable");
        await assertPolicy(policy, signal);
        const end = await lstat(input.outputPath, { bigint: true }), finalStat = await handle.stat({ bigint: true });
        if (end.dev !== stat.dev || end.ino !== stat.ino || finalStat.nlink !== 1n || finalStat.size !== BigInt(bytes)) throw failure("policy_restricted");
        await handle.sync(); await handle.chmod(0o400); await assertPolicy(policy, signal);
        return { inputPath: input.outputPath, byteLength: String(bytes), sha256: hash.digest("hex"), declaredMediaType };
      } finally { response?.destroy(); agent.destroy(); await destroyAndJoin(socket); active = null; }
    }
    throw failure("source_forbidden");
  } catch (error) {
    if (signal.aborted) throw signal.reason instanceof ExternalImageSourceError ? signal.reason : failure("source_cancelled");
    if (error instanceof ExternalImageSourceError) throw error;
    throw failure("source_unavailable");
  } finally {
    clearTimeout(totalTimeout); input.signal?.removeEventListener("abort", outerAbort); signal.removeEventListener("abort", abort);
    if (active) await destroyAndJoin(active); await handle?.close();
  }
}
