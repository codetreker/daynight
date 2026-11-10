/** Byte ranges stay inside the authorized transcript reader and never cross its IPC boundary. */
export type TranscriptMediaRange = { path: (string | number)[]; start: number; end: number; byteLength: number; error: "invalid_base64" | "image_too_large" | null };
export type TranscriptLine = { value: Record<string, unknown>; media: TranscriptMediaRange[] };
type Container = { kind: "object" | "array"; path: (string | number)[]; key: string | null; index: number; expectingKey: boolean; keys: Set<string> };
const MAX_METADATA = 1_048_576, MAX_IMAGE = 10_485_760;
const mediaPath = (path: readonly (string | number)[]) => {
  if (path[0] !== "message" || path[1] !== "content" || typeof path[2] !== "number") return false;
  let i = 3;
  while (path[i] === "content" && typeof path[i + 1] === "number") i += 2;
  return i === path.length - 2 && path[i] === "source" && path[i + 1] === "data";
};

/** Incremental JSONL scanner. Only explicitly located image data strings are elided. */
export class ClaudeTranscriptJson {
  private buffers: Buffer[] = [];
  private buffer = Buffer.allocUnsafe(65_536);
  private used = 0;
  private size = 0;
  private stack: Container[] = [];
  private quoted = false;
  private key = false;
  private keyBytes: number[] = [];
  private escaped = false;
  private unicode = "";
  private unicodeLeft = 0;
  private candidate: { path: (string | number)[]; start: number; chars: number; padding: number; last: number; invalid: boolean } | null = null;
  private media: TranscriptMediaRange[] = [];
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private error: Error | null = null;
  private tokens = 0;
  private scalar = false;

  private append(byte: number) {
    if (++this.size > MAX_METADATA) throw new Error("Claude transcript metadata limit exceeded.");
    if (this.used === this.buffer.length) { this.buffers.push(this.buffer); this.buffer = Buffer.allocUnsafe(65_536); this.used = 0; }
    this.buffer[this.used++] = byte;
  }
  private valuePath(): (string | number)[] {
    const parent = this.stack.at(-1);
    if (!parent) return [];
    if (parent.kind === "array") return [...parent.path, parent.index++];
    if (parent.key === null || parent.expectingKey) throw new Error("Invalid Claude transcript JSON value.");
    return [...parent.path, parent.key];
  }
  private token() { if (++this.tokens > 100_000) throw new Error("Claude transcript token limit exceeded."); }
  private imageCharacter(char: number) {
    const value = this.candidate!; value.chars++;
    if (char === 61) {
      value.padding++;
      if (value.padding > 2 || value.chars % 4 < 3 && value.chars % 4 !== 0 || value.padding === 1 && (value.chars % 4 === 3 ? value.last % 16 !== 0 : value.last % 4 !== 0)) value.invalid = true;
    } else {
      const sextet = char >= 65 && char <= 90 ? char - 65 : char >= 97 && char <= 122 ? char - 71 : char >= 48 && char <= 57 ? char + 4 : char === 43 ? 62 : char === 47 ? 63 : -1;
      if (value.padding || sextet < 0) value.invalid = true;
      value.last = sextet;
    }
  }
  write(bytes: Uint8Array, offset: number): void {
    if (this.error) return;
    try {
      this.decoder.decode(bytes, { stream: true });
      for (let i = 0; i < bytes.length; i++) this.byte(bytes[i]!, offset + i);
    } catch (error) { this.error = error instanceof Error ? error : new Error("Invalid Claude transcript JSON."); }
  }
  private byte(byte: number, offset: number): void {
    if (this.quoted) {
      if (!this.candidate) { this.append(byte); if (this.key) { if (this.keyBytes.length >= 1024) throw new Error("Claude transcript key limit exceeded."); this.keyBytes.push(byte); } }
      if (this.unicodeLeft) {
        if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) throw new Error("Invalid Claude transcript JSON escape.");
        this.unicode += String.fromCharCode(byte);
        if (--this.unicodeLeft === 0 && this.candidate) this.imageCharacter(parseInt(this.unicode, 16));
        return;
      }
      if (this.escaped) {
        this.escaped = false;
        if (byte === 117) { this.unicode = ""; this.unicodeLeft = 4; return; }
        const escapes: Record<number, number> = { 34: 34, 47: 47, 92: 92, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9 };
        if (escapes[byte] === undefined) throw new Error("Invalid Claude transcript JSON escape.");
        if (this.candidate) this.imageCharacter(escapes[byte]!);
        return;
      }
      if (byte === 92) { this.escaped = true; return; }
      if (byte === 34) {
        this.quoted = false;
        if (this.key) {
          const parent = this.stack.at(-1)!;
          const key: unknown = JSON.parse(Buffer.from(this.keyBytes).toString("utf8"));
          if (typeof key !== "string" || !key.isWellFormed() || parent.keys.has(key)) throw new Error("Invalid or duplicate Claude transcript JSON key.");
          parent.keys.add(key); parent.key = key; parent.expectingKey = false; this.key = false;
        }
        if (this.candidate) {
          const c = this.candidate, byteLength = c.chars / 4 * 3 - c.padding;
          this.media.push({ path: c.path, start: c.start, end: offset, byteLength, error: c.invalid || !c.chars || c.chars % 4 !== 0 ? "invalid_base64" : byteLength > MAX_IMAGE ? "image_too_large" : null });
          this.candidate = null;
        }
        return;
      }
      if (byte < 32) throw new Error("Invalid Claude transcript JSON string.");
      if (this.candidate) this.imageCharacter(byte);
      return;
    }
    if (byte === 34) {
      this.token(); this.quoted = true; this.scalar = false;
      const parent = this.stack.at(-1);
      this.key = !!parent && parent.kind === "object" && parent.expectingKey;
      if (this.key) { this.keyBytes = [34]; this.append(byte); return; }
      const path = this.valuePath();
      if (mediaPath(path)) {
        if (this.media.length >= 1000) throw new Error("Claude transcript media position limit exceeded.");
        this.candidate = { path, start: offset + 1, chars: 0, padding: 0, last: 0, invalid: false };
        this.append(34); this.append(34);
      } else this.append(byte);
      return;
    }
    this.append(byte);
    if (byte === 123 || byte === 91) {
      this.token(); this.scalar = false;
      const path = this.valuePath();
      if (mediaPath(path)) throw new Error("Claude transcript image data must be a JSON string.");
      if (this.stack.length >= 64) throw new Error("Claude transcript depth limit exceeded.");
      this.stack.push({ kind: byte === 123 ? "object" : "array", path, key: null, index: 0, expectingKey: byte === 123, keys: new Set() });
    } else if (byte === 125 || byte === 93) {
      const parent = this.stack.pop();
      if (!parent || parent.kind !== (byte === 125 ? "object" : "array")) throw new Error("Invalid Claude transcript JSON structure.");
      this.scalar = false;
    } else if (byte === 44) { const parent = this.stack.at(-1); if (parent?.kind === "object") { parent.expectingKey = true; parent.key = null; } this.scalar = false; }
    else if (byte === 58 || byte === 32 || byte === 9 || byte === 13) this.scalar = false;
    else if (!this.scalar) { this.token(); if (mediaPath(this.valuePath())) throw new Error("Claude transcript image data must be a JSON string."); this.scalar = true; }
  }
  finish(): TranscriptLine | null {
    if (this.error) throw this.error;
    this.decoder.decode();
    if (this.quoted || this.stack.length) throw new Error("Invalid complete Claude transcript JSON line.");
    const bytes = Buffer.concat([...this.buffers, this.buffer.subarray(0, this.used)], this.size);
    if (!bytes.toString("utf8").trim()) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Claude transcript record must be an object.");
    return { value: value as Record<string, unknown>, media: this.media };
  }
}

/** Decode a bounded JSON string fragment without assembling its Base64 value. */
export class TranscriptBase64Decoder {
  private escape = false;
  private unicode = "";
  private remaining = 0;
  private chars = "";
  private finished = false;
  private count = 0;
  constructor(private readonly emit: (bytes: Uint8Array) => void) {}
  write(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (this.remaining) {
        if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) throw new Error("Invalid transcript media escape.");
        this.unicode += String.fromCharCode(byte); if (--this.remaining === 0) this.character(parseInt(this.unicode, 16));
      } else if (this.escape) {
        this.escape = false;
        if (byte === 117) { this.remaining = 4; this.unicode = ""; }
        else if (byte === 47) this.character(47);
        else throw new Error("Invalid transcript media escape.");
      } else if (byte === 92) this.escape = true;
      else this.character(byte);
    }
  }
  private character(byte: number): void {
    if (this.finished || !(byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || byte === 43 || byte === 47 || byte === 61)) throw new Error("Invalid transcript media Base64.");
    this.chars += String.fromCharCode(byte);
    if (this.chars.length >= 65_536 || byte === 61 && this.chars.length % 4 === 0) this.flush();
  }
  private flush(): void {
    if (!this.chars) return;
    if (this.chars.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(this.chars)) throw new Error("Invalid transcript media Base64.");
    const bytes = Buffer.from(this.chars, "base64");
    if (bytes.toString("base64") !== this.chars) throw new Error("Noncanonical transcript media Base64.");
    this.count += bytes.length;
    if (this.count > MAX_IMAGE) throw new Error("Claude transcript image limit exceeded.");
    this.finished = this.chars.endsWith("="); this.chars = ""; this.emit(bytes);
  }
  finish(): number { if (this.escape || this.remaining) throw new Error("Invalid transcript media escape."); this.flush(); return this.count; }
}
