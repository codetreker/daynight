import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { record, type NativeObject } from "./native-rpc.js";

/** The shared media owner reserves capacity before creating a private spool. */
export interface CodexMediaSpool {
  readonly path: string;
  write(bytes: Uint8Array): void;
  seal(): void;
  /** Sealed bytes, in chunks no larger than 64 KiB. */
  read(): Iterable<Uint8Array>;
  /** Closes owned handles and returns capacity only after the actual unlink. */
  remove(): void;
}
export type CodexSpoolFactory = (maxBytes: number) => CodexMediaSpool;
export const CODEX_RPC_LIMITS = Object.freeze({ bufferBytes: 65_536, imageBytes: 10_485_760, wireBytes: 100_663_296, mediaSlots: 1000, metadataBytes: 16_777_216, depth: 64, tokens: 100_000, frameBytes: 134_217_728, frameMs: 30_000 });
export type CodexRpcLimits = { readonly [K in keyof typeof CODEX_RPC_LIMITS]: number };
export type CodexMediaLease = { readonly path: string; release(): void };

/** A branded native value cannot be forged by a JSON object or reveal its path. */
export class CodexMediaReference {
  #readers = 1;
  #spool: CodexMediaSpool | null;
  constructor(readonly status: "available" | "unavailable", readonly mediaType: string | null, readonly byteLength: number | null, readonly sha256: string | null, readonly errorCode: string | null, spool: CodexMediaSpool | null = null) { this.#spool = spool; }
  retain(): CodexMediaLease {
    if (this.status !== "available" || this.#spool === null || this.#readers < 1) throw new Error("Native image bytes are unavailable.");
    const path = this.#spool.path; this.#readers += 1; let released = false;
    return { path, release: () => { if (!released) { this.release(); released = true; } } };
  }
  /** Releases a frame or retained reader; transport shutdown cannot revoke readers. */
  release(): void {
    if (this.#readers < 1) return;
    if (this.#readers > 1) { this.#readers -= 1; return; }
    if (this.#spool !== null) { this.#spool.remove(); this.#spool = null; }
    this.#readers = 0;
  }
  toJSON(): unknown { return { type: "native_image", status: this.status, mediaType: this.mediaType, byteLength: this.byteLength, sha256: this.sha256, errorCode: this.errorCode }; }
}
export const codexMedia = (value: unknown): CodexMediaReference | null => value instanceof CodexMediaReference ? value : null;
export type CodexJsonFrame = { readonly value: NativeObject; release(): void };
type JsonPath = (string | number)[];
type ObjectContext = { kind: "object"; value: NativeObject; path: JsonPath; state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd"; key: string | null; keys: Set<string> };
type ArrayContext = { kind: "array"; value: unknown[]; path: JsonPath; state: "valueOrEnd" | "value" | "commaOrEnd" };
type Context = ObjectContext | ArrayContext;
type StringToken = { kind: "string"; key: boolean; path: JsonPath; value: string; media: WireString | null; text: boolean; truncated: boolean; escape: "none" | "escape" | "unicode"; unicode: string; high: number | null };
type ScalarToken = { kind: "scalar"; value: string };
type Candidate = { path: JsonPath; itemPath: JsonPath; relative: JsonPath; wire: WireString };
const formats = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const unavailable = (code: string, mediaType: string | null = null) => new CodexMediaReference("unavailable", mediaType, null, null, code);
const bytesOf = (character: string): number => { const cp = character.codePointAt(0)!; return cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4; };
const samePath = (a: JsonPath, pattern: (string | "#")[]): boolean => a.length === pattern.length && a.every((value, i) => pattern[i] === "#" ? typeof value === "number" : value === pattern[i]);

/** Candidate paths are structural; semantic types may occur after their bytes. */
const itemPath = (path: JsonPath): { itemPath: JsonPath; relative: JsonPath } | null => {
  const roots: (string | "#")[][] = [["params", "item"], ["params", "turn", "items", "#"], ["result", "data", "#", "item"], ["result", "thread", "turns", "#", "items", "#"]];
  for (const root of roots) {
    if (!samePath(path.slice(0, root.length), root)) continue;
    return { itemPath: path.slice(0, root.length), relative: path.slice(root.length) };
  }
  return null;
};
const candidatePath = (path: JsonPath): { itemPath: JsonPath; relative: JsonPath } | null => {
  const found = itemPath(path);
  return found && [["result"], ["content", "#", "url"], ["result", "content", "#", "data"], ["result", "content", "#", "resource", "blob"], ["contentItems", "#", "imageUrl"], ["output", "#", "image_url"]].some(pattern => samePath(found.relative, pattern)) ? found : null;
};
const textPath = (path: JsonPath): boolean => {
  if (samePath(path, ["params", "delta"])) return true;
  const found = itemPath(path);
  return found !== null && [["text"], ["aggregatedOutput"], ["output"], ["summary", "#"], ["content", "#"], ["content", "#", "text"], ["result", "content", "#", "text"], ["result", "content", "#", "resource", "text"], ["contentItems", "#", "text"], ["output", "#", "text"]].some(pattern => samePath(found.relative, pattern));
};
const at = (root: unknown, path: JsonPath): unknown => path.reduce<unknown>((value, key) => typeof value === "object" && value !== null ? (value as Record<string | number, unknown>)[key] : undefined, root);
const put = (root: unknown, path: JsonPath, value: unknown): void => { const parent = at(root, path.slice(0, -1)) as Record<string | number, unknown>; parent[path.at(-1)!] = value; };

class WireString {
  #spool: CodexMediaSpool | null = null;
  #buffer = "";
  #bufferLength = 0;
  #prefix = "";
  #length = 0;
  #inputBytes = 0;
  #sealed = false;
  error: string | null = null;
  constructor(private readonly create: CodexSpoolFactory, private readonly limit: number, private readonly bufferBytes: number) {}
  append(value: string): void {
    if (this.#prefix.length < 256) this.#prefix += value.slice(0, 256 - this.#prefix.length);
    const bytes = Buffer.byteLength(value); this.#length += bytes;
    if (this.error) return;
    if (this.#length > this.limit) { this.error = "image_too_large"; this.remove(); return; }
    if (this.#bufferLength + bytes > this.bufferBytes) this.flush();
    this.#buffer += value; this.#bufferLength += bytes;
    if (this.#bufferLength === this.bufferBytes) this.flush();
  }
  private flush(): void {
    if (!this.#buffer || this.error) return;
    try { this.#spool ??= this.create(this.limit); this.#spool.write(Buffer.from(this.#buffer)); this.#buffer = ""; this.#bufferLength = 0; }
    catch { this.error = "media_capacity_exceeded"; this.remove(); }
  }
  seal(): void { if (this.#sealed) return; this.#sealed = true; if (this.#spool) { this.flush(); this.#spool?.seal(); } }
  get prefix(): string { return this.#prefix; }
  get length(): number { return this.#length; }
  get inputBytes(): number { return this.#inputBytes; }
  countInput(bytes: number): void { this.#inputBytes += bytes; }
  get inline(): string | null { return this.#spool === null && !this.error ? this.#buffer : null; }
  *read(): Iterable<Uint8Array> {
    if (!this.#sealed || this.error) throw new Error("Native media token is not readable.");
    if (this.#spool) yield* this.#spool.read(); else if (this.#buffer) yield Buffer.from(this.#buffer);
  }
  remove(): void { this.#buffer = ""; this.#bufferLength = 0; if (this.#spool) { const spool = this.#spool; spool.remove(); this.#spool = null; } }
}

/** Decode one known native image, retaining at most one quartet and one 64 KiB block. */
const decodeImage = (wire: WireString, expectedMediaType: string | null, dataUrl: boolean, create: CodexSpoolFactory, limits: CodexRpcLimits): CodexMediaReference => {
  let mediaType = expectedMediaType, skip = 0;
  if (dataUrl) {
    const header = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(wire.prefix);
    if (!header || header[0].length > 128) return unavailable("invalid_native_image");
    mediaType = header[1]!; skip = header[0].length;
  }
  if (!mediaType || !formats.has(mediaType)) return unavailable("unsupported_native_image", mediaType);
  if (wire.error) return unavailable(wire.error, mediaType);
  let spool: CodexMediaSpool | null = null, remainder = "", padded = false, size = 0;
  const hash = createHash("sha256");
  try {
    for (const chunk of wire.read()) {
      if (chunk.length > limits.bufferBytes) throw new Error("Invalid private spool chunk.");
      const start = Math.min(skip, chunk.length); skip -= start;
      if (start === chunk.length) continue;
      if (padded) throw new Error("Invalid native image encoding.");
      const encoded = remainder + Buffer.from(chunk.subarray(start)).toString("latin1"), end = encoded.length - encoded.length % 4;
      const complete = encoded.slice(0, end); remainder = encoded.slice(end);
      if (!complete) continue;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/.test(complete)) throw new Error("Invalid native image encoding.");
      const bytes = Buffer.from(complete, "base64");
      if (bytes.toString("base64") !== complete) throw new Error("Invalid native image encoding.");
      padded = complete.includes("="); if (padded && remainder) throw new Error("Invalid native image encoding.");
      size += bytes.length;
      if (size > limits.imageBytes) { spool?.remove(); spool = null; return unavailable("image_too_large", mediaType); }
      hash.update(bytes); spool ??= create(limits.imageBytes); spool.write(bytes);
    }
    if (skip !== 0 || remainder || size === 0) throw new Error("Invalid native image encoding.");
    spool!.seal();
    const result = new CodexMediaReference("available", mediaType, size, hash.digest("hex"), null, spool); spool = null; return result;
  } catch (error) {
    spool?.remove();
    return unavailable(error instanceof Error && error.message === "Invalid native image encoding." ? "invalid_native_image" : "media_capacity_exceeded", mediaType);
  }
};

const imageShape = (root: unknown, candidate: Candidate): { mediaType: string | null; dataUrl: boolean } | "url" | "pending" | "failed" | null => {
  const item = record(at(root, candidate.itemPath)), rel = candidate.relative;
  if (typeof item.id !== "string" || !item.id || !item.id.isWellFormed()) return null;
  if (item.type === "imageGeneration" && samePath(rel, ["result"])) {
    if (item.failure || ["failed", "cancelled"].includes(String(item.status))) return "failed";
    if (item.status !== "completed") return "pending";
    return { mediaType: "image/png", dataUrl: false };
  }
  let url = false;
  if (item.type === "userMessage" && samePath(rel, ["content", "#", "url"]) && record(at(item, rel.slice(0, -1))).type === "image") url = true;
  else if (item.type === "dynamicToolCall" && samePath(rel, ["contentItems", "#", "imageUrl"]) && record(at(item, rel.slice(0, -1))).type === "inputImage") url = true;
  else if (item.type === "functionCallOutput" && samePath(rel, ["output", "#", "image_url"]) && record(at(item, rel.slice(0, -1))).type === "input_image") url = true;
  if (url) return candidate.wire.prefix.startsWith("data:") ? { mediaType: null, dataUrl: true } : "url";
  if (item.type === "mcpToolCall" && samePath(rel, ["result", "content", "#", "data"])) { const part = record(at(item, rel.slice(0, -1))); if (part.type === "image") return { mediaType: typeof part.mimeType === "string" ? part.mimeType : null, dataUrl: false }; }
  if (item.type === "mcpToolCall" && samePath(rel, ["result", "content", "#", "resource", "blob"])) { const part = record(at(item, rel.slice(0, -2))), resource = record(part.resource); if (part.type === "resource") return { mediaType: typeof resource.mimeType === "string" ? resource.mimeType : null, dataUrl: false }; }
  return null;
};

/** Incremental NDJSON parser; media never enters an aggregated JSON string. */
export class CodexJsonDecoder {
  readonly limits: CodexRpcLimits;
  #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  #utf8Pending = 0;
  #stack: Context[] = [];
  #token: StringToken | ScalarToken | null = null;
  #root: unknown;
  #rootSet = false;
  #candidates: Candidate[] = [];
  #cleanup = new Set<CodexMediaReference>();
  #frameBytes = 0;
  #metadataBytes = 0;
  #wireBytes = 0;
  #tokens = 0;
  #startedAt: number | null = null;
  #disposed = false;
  constructor(private readonly createSpool: CodexSpoolFactory, limits: Partial<CodexRpcLimits> = {}) {
    const selected = { ...CODEX_RPC_LIMITS, ...limits };
    for (const key of Object.keys(CODEX_RPC_LIMITS) as (keyof CodexRpcLimits)[]) if (!Number.isSafeInteger(selected[key]) || selected[key] < 1 || selected[key] > CODEX_RPC_LIMITS[key]) throw new Error("Invalid native protocol budget.");
    if (selected.bufferBytes < 4) throw new Error("Invalid native protocol byte buffer.");
    this.limits = selected;
  }
  get frameStartedAt(): number | null { return this.#startedAt; }
  private fail(message = "Invalid native protocol frame."): never { throw new Error(message); }
  private checkDeadline(): void { if (this.#startedAt !== null && Date.now() - this.#startedAt > this.limits.frameMs) this.fail("Native protocol frame deadline exceeded."); }
  private countToken(): void { if (++this.#tokens > this.limits.tokens) this.fail("Native protocol token budget exceeded."); }
  private expectValue(): boolean { const context = this.#stack.at(-1); return !context ? !this.#rootSet : context.kind === "array" ? context.state === "value" || context.state === "valueOrEnd" : context.state === "value"; }
  private valuePath(): JsonPath { const context = this.#stack.at(-1); return !context ? [] : [...context.path, context.kind === "array" ? context.value.length : context.key!]; }
  private add(value: unknown): void {
    const parent = this.#stack.at(-1);
    if (!parent) { if (this.#rootSet) this.fail(); this.#root = value; this.#rootSet = true; return; }
    if (!this.expectValue()) this.fail();
    if (parent.kind === "array") { parent.value.push(value); parent.state = "commaOrEnd"; }
    else { parent.value[parent.key!] = value; parent.key = null; parent.state = "commaOrEnd"; }
  }
  private appendString(token: StringToken, value: string): void {
    const cp = value.charCodeAt(0);
    if (token.high !== null) { if (value.length !== 1 || cp < 0xdc00 || cp > 0xdfff) this.fail(); value = String.fromCharCode(token.high, cp); token.high = null; }
    else if (value.length === 1 && cp >= 0xd800 && cp <= 0xdbff) { token.high = cp; return; }
    else if (value.length === 1 && cp >= 0xdc00 && cp <= 0xdfff) this.fail();
    if (token.media) token.media.append(value);
    else if (!token.text) token.value += value;
    else if (!token.truncated) {
      if (token.value.length + value.length <= 200_000) token.value += value;
      else { token.truncated = true; const marker = "\n[Output truncated at 200000 characters]"; token.value += marker; this.#metadataBytes += marker.length; if (this.#metadataBytes > this.limits.metadataBytes) this.fail("Native protocol metadata budget exceeded."); }
    }
  }
  private stringCharacter(token: StringToken, character: string): void {
    if (token.escape === "unicode") { if (!/^[\da-fA-F]$/.test(character)) this.fail(); token.unicode += character; if (token.unicode.length === 4) { this.appendString(token, String.fromCharCode(Number.parseInt(token.unicode, 16))); token.unicode = ""; token.escape = "none"; } return; }
    if (token.escape === "escape") {
      token.escape = "none";
      if (character === "u") { token.escape = "unicode"; return; }
      const escape: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (!Object.hasOwn(escape, character)) this.fail(); this.appendString(token, escape[character]!); return;
    }
    if (character === "\\") { token.escape = "escape"; return; }
    if (character === '"') {
      if (token.high !== null) this.fail(); this.#token = null;
      if (token.key) { const parent = this.#stack.at(-1) as ObjectContext; if (parent.keys.has(token.value)) this.fail("Duplicate native protocol object key."); parent.keys.add(token.value); parent.key = token.value; parent.state = "colon"; }
      else { token.media?.seal(); this.add(token.media ?? token.value); }
      return;
    }
    if (character.codePointAt(0)! < 32) this.fail(); this.appendString(token, character);
  }
  private endScalar(): void {
    const token = this.#token as ScalarToken; this.#token = null;
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token.value)) this.fail();
    this.add(JSON.parse(token.value));
  }
  private character(character: string): void {
    if (this.#token?.kind === "string") { this.stringCharacter(this.#token, character); return; }
    if (this.#token?.kind === "scalar") {
      if (!/[\s,}\]]/.test(character)) { if (this.#token.value.length >= 1024) this.fail("Native scalar token exceeds its budget."); this.#token.value += character; return; }
      this.endScalar();
    }
    if (character === " " || character === "\t" || character === "\r") return;
    const parent = this.#stack.at(-1);
    if (character === '"') {
      const key = parent?.kind === "object" && (parent.state === "key" || parent.state === "keyOrEnd");
      if (!key && !this.expectValue()) this.fail(); this.countToken();
      const path = this.valuePath(), candidate = key ? null : candidatePath(path); let media: WireString | null = null;
      if (candidate) {
        if (this.#candidates.length >= this.limits.mediaSlots) this.fail("Native media slot budget exceeded.");
        media = new WireString(this.createSpool, 4 * Math.ceil(this.limits.imageBytes / 3) + 128, this.limits.bufferBytes);
        this.#candidates.push({ ...candidate, path, wire: media });
      }
      this.#token = { kind: "string", key, path, value: "", media, text: !key && textPath(path), truncated: false, escape: "none", unicode: "", high: null }; return;
    }
    if (character === "{" || character === "[") {
      if (!this.expectValue()) this.fail(); this.countToken(); const path = this.valuePath();
      if (this.#stack.length >= this.limits.depth) this.fail("Native protocol depth budget exceeded.");
      if (character === "{") { const value = Object.create(null) as NativeObject; this.add(value); this.#stack.push({ kind: "object", path, value, state: "keyOrEnd", key: null, keys: new Set() }); }
      else { const value: unknown[] = []; this.add(value); this.#stack.push({ kind: "array", path, value, state: "valueOrEnd" }); }
      return;
    }
    if (character === ":") { if (!parent || parent.kind !== "object" || parent.state !== "colon") this.fail(); parent.state = "value"; return; }
    if (character === ",") { if (!parent || parent.state !== "commaOrEnd") this.fail(); parent.state = parent.kind === "object" ? "key" : "value"; return; }
    if (character === "}" || character === "]") {
      if (!parent || (character === "}") !== (parent.kind === "object") || parent.state !== "commaOrEnd" && parent.state !== "keyOrEnd" && parent.state !== "valueOrEnd") this.fail(); this.#stack.pop(); return;
    }
    if (!this.expectValue() || !/^[\dtfn-]$/.test(character)) this.fail(); this.countToken(); this.#token = { kind: "scalar", value: character };
  }
  private complete(): CodexJsonFrame {
    this.checkDeadline();
    if (this.#token?.kind === "scalar") this.endScalar();
    if (this.#stack.length || this.#token || !this.#rootSet || typeof this.#root !== "object" || this.#root === null || Array.isArray(this.#root)) this.fail();
    const refs: CodexMediaReference[] = [], root = this.#root as NativeObject;
    try {
      for (const candidate of this.#candidates) {
        const shape = imageShape(root, candidate); let value: unknown;
        if (shape === "pending" || shape === "failed") value = unavailable(shape === "pending" ? "native_image_pending" : "native_image_failed");
        else if (shape && shape !== "url") value = decodeImage(candidate.wire, shape.mediaType, shape.dataUrl, this.createSpool, this.limits);
        else if (shape === "url" && candidate.wire.inline !== null) {
          const locator = candidate.wire.inline;
          let valid = false;
          try { valid = ["http:", "https:"].includes(new URL(locator).protocol); } catch { /* The source remains an unavailable image slot. */ }
          value = valid ? locator : unavailable("invalid_native_image");
          this.#metadataBytes += candidate.wire.inputBytes;
          if (this.#metadataBytes > this.limits.metadataBytes) this.fail("Native protocol metadata budget exceeded.");
        } else value = unavailable(shape === "url" ? "invalid_native_image" : "unsupported_native_media");
        if (value instanceof CodexMediaReference) refs.push(value); put(root, candidate.path, value); candidate.wire.remove();
        this.checkDeadline();
      }
    } catch (error) {
      const failures = [error];
      for (const ref of refs) try { ref.release(); } catch (failure) { this.#cleanup.add(ref); failures.push(failure); }
      if (failures.length > 1) throw new AggregateError(failures, "Native frame validation and cleanup failed.");
      throw error;
    }
    this.#root = undefined; this.#rootSet = false; this.#frameBytes = 0; this.#metadataBytes = 0; this.#wireBytes = 0; this.#tokens = 0; this.#candidates = []; this.#startedAt = null;
    const remaining = new Set(refs);
    return { value: root, release: () => {
      const errors: unknown[] = [];
      for (const ref of remaining) try { ref.release(); remaining.delete(ref); this.#cleanup.delete(ref); } catch (error) { this.#cleanup.add(ref); errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Native media cleanup failed.");
    } };
  }
  *write(bytes: Uint8Array): Iterable<CodexJsonFrame> {
    if (this.#disposed) this.fail("Native decoder is closed.");
    try {
      for (let offset = 0; offset < bytes.length; offset += this.limits.bufferBytes) {
        const chunk = bytes.subarray(offset, offset + this.limits.bufferBytes);
        this.#startedAt ??= Date.now();
        const text = this.#decoder.decode(chunk, { stream: true });
        this.#utf8Pending += chunk.length - Buffer.byteLength(text);
        this.checkDeadline();
        for (const character of text) {
          if (this.#startedAt === null && character !== "\n") this.#startedAt = Date.now();
          const bytes = bytesOf(character); this.#frameBytes += bytes;
          if (this.#frameBytes > this.limits.frameBytes) this.fail("Native protocol frame budget exceeded.");
          const payload = this.#token?.kind === "string" && (character !== '"' || this.#token.escape !== "none");
          const media = payload && this.#token?.kind === "string" && this.#token.media;
          const truncated = payload && this.#token?.kind === "string" && this.#token.truncated;
          if (media) { media.countInput(bytes); this.#wireBytes += bytes; if (this.#wireBytes > this.limits.wireBytes) this.fail("Native media wire budget exceeded."); }
          else if (!truncated) { this.#metadataBytes += bytes; if (this.#metadataBytes > this.limits.metadataBytes) this.fail("Native protocol metadata budget exceeded."); }
          if (character === "\n") {
            if (!this.#rootSet && !this.#token && !this.#stack.length) { this.#frameBytes = 0; this.#metadataBytes = 0; this.#startedAt = null; continue; }
            yield this.complete();
          } else this.character(character);
        }
        if (this.#utf8Pending > 0) this.#startedAt ??= Date.now();
      }
    } catch (error) { this.dispose(); throw error; }
  }
  end(): void {
    try { this.#decoder.decode(); if (this.#rootSet || this.#token || this.#stack.length) this.fail("Native protocol ended with an incomplete frame."); }
    finally { this.dispose(); }
  }
  dispose(): void {
    this.#disposed = true;
    const errors: unknown[] = [], remaining: Candidate[] = [];
    for (const candidate of this.#candidates) try { candidate.wire.remove(); } catch (error) { remaining.push(candidate); errors.push(error); }
    for (const ref of this.#cleanup) try { ref.release(); this.#cleanup.delete(ref); } catch (error) { errors.push(error); }
    this.#candidates = remaining; this.#stack = []; this.#token = null; this.#root = undefined;
    if (errors.length) throw new AggregateError(errors, "Native wire cleanup failed.");
  }
}
