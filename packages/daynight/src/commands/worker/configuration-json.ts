import { parseChunked, stringifyChunked } from "@discoveryjs/json-ext";
import { MAX_JSON_SOURCE_DEPTH } from "../../api/json-source.js";

function invalid(): never { throw new SyntaxError("Invalid worker configuration cache JSON."); }

type ObjectFrame = { readonly kind: "object"; state: "firstKey" | "key" | "colon" | "value" | "after"; readonly keys: Set<string> };
type ArrayFrame = { readonly kind: "array"; state: "firstValue" | "value" | "after" };
type Frame = ObjectFrame | ArrayFrame;
type Token =
  | { kind: "string"; key: boolean; value: string; escape: "none" | "escape" | "unicode"; digits: string }
  | { kind: "number"; zero: boolean }
  | { kind: "literal"; expected: string; position: number };

// Only cache documents use this guard. It validates each fragment before the
// chunk parser sees it, retaining keys and parser state but never value text.
class CacheJsonGuard {
  private readonly stack: Frame[] = [];
  private root: "value" | "done" = "value";
  private token: Token | undefined;
  private readonly valueStringBoundary = /["\\\u0000-\u001f]/g;

  private appendKey(token: Extract<Token, { kind: "string" }>, value: string): void {
    if (!token.key) return;
    token.value += value;
    // All schema field names and native mode keys are shorter than this.
    if (token.value.length > 256) invalid();
  }

  private startValue(character: string): void {
    const frame = this.stack.at(-1);
    if (frame === undefined) {
      if (this.root !== "value" || character !== "{") invalid();
      this.root = "done";
    } else if (frame.kind === "object") {
      if (frame.state !== "value") invalid();
      frame.state = "after";
    } else {
      if (frame.state !== "firstValue" && frame.state !== "value") invalid();
      frame.state = "after";
    }
    if (character === "{" || character === "[") {
      if (this.stack.length >= MAX_JSON_SOURCE_DEPTH) invalid();
      this.stack.push(character === "{" ? { kind: "object", state: "firstKey", keys: new Set() } : { kind: "array", state: "firstValue" });
    } else if (character === '"') this.token = { kind: "string", key: false, value: "", escape: "none", digits: "" };
    else if (character >= "0" && character <= "9") this.token = { kind: "number", zero: character === "0" };
    else if (character === "t" || character === "f" || character === "n") this.token = { kind: "literal", expected: character === "t" ? "true" : character === "f" ? "false" : "null", position: 1 };
    else invalid();
  }

  feed(text: string): void {
    let i = 0;
    while (i < text.length) {
      const token = this.token;
      if (token?.kind === "string") {
        if (!token.key && token.escape === "none") {
          this.valueStringBoundary.lastIndex = i;
          const boundary = this.valueStringBoundary.exec(text);
          if (boundary === null) return;
          i = boundary.index;
        }
        const c = text[i++]!;
        if (token.escape === "unicode") {
          if (!/^[0-9a-f]$/i.test(c)) invalid();
          token.digits += c;
          if (token.digits.length === 4) {
            this.appendKey(token, String.fromCharCode(parseInt(token.digits, 16)));
            token.digits = "";
            token.escape = "none";
          }
        } else if (token.escape === "escape") {
          if (c === "u") token.escape = "unicode";
          else {
            const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
            if (!Object.hasOwn(escapes, c)) invalid();
            this.appendKey(token, escapes[c]!);
            token.escape = "none";
          }
        } else if (c === "\\") token.escape = "escape";
        else if (c === '"') {
          this.token = undefined;
          if (token.key) {
            const frame = this.stack.at(-1);
            if (frame?.kind !== "object" || frame.state !== "key") invalid();
            if (token.value === "__proto__" || /^[0-9]+$/.test(token.value) || frame.keys.has(token.value)) invalid();
            frame.keys.add(token.value);
            frame.state = "colon";
          }
        } else {
          if (c.charCodeAt(0) < 0x20) invalid();
          this.appendKey(token, c);
        }
        continue;
      }
      if (token?.kind === "number") {
        const c = text[i]!;
        if (c >= "0" && c <= "9") { if (token.zero) invalid(); i++; continue; }
        this.token = undefined;
        continue;
      }
      if (token?.kind === "literal") {
        if (text[i++] !== token.expected[token.position++]) invalid();
        if (token.position === token.expected.length) this.token = undefined;
        continue;
      }
      const c = text[i++]!;
      if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
      const frame = this.stack.at(-1);
      if (frame === undefined) { this.startValue(c); continue; }
      if (frame.kind === "object") {
        if (frame.state === "firstKey" || frame.state === "key") {
          if (c === "}" && frame.state === "firstKey") { this.stack.pop(); continue; }
          if (c !== '"') invalid();
          frame.state = "key";
          this.token = { kind: "string", key: true, value: "", escape: "none", digits: "" };
        } else if (frame.state === "colon") {
          if (c !== ":") invalid();
          frame.state = "value";
        } else if (frame.state === "after") {
          if (c === "}") this.stack.pop();
          else if (c === ",") frame.state = "key";
          else invalid();
        } else this.startValue(c);
      } else if (frame.state === "after") {
        if (c === "]") this.stack.pop();
        else if (c === ",") frame.state = "value";
        else invalid();
      } else if (frame.state === "firstValue" && c === "]") this.stack.pop();
      else this.startValue(c);
    }
  }

  finish(): void {
    if (this.token?.kind === "number") this.token = undefined;
    if (this.token !== undefined || this.stack.length !== 0 || this.root !== "done") invalid();
  }
}

export const parseConfigurationJson = async (bytes: AsyncIterable<Uint8Array>): Promise<unknown> => {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const guard = new CacheJsonGuard();
  let reachedEof = false;
  async function* checked(): AsyncGenerator<string> {
    for await (const chunk of bytes) {
      const text = decoder.decode(chunk, { stream: true });
      guard.feed(text);
      if (text.length !== 0) yield text;
    }
    const last = decoder.decode();
    guard.feed(last);
    guard.finish();
    reachedEof = true;
    if (last.length !== 0) yield last;
  }
  const value = await parseChunked(checked(), { mode: "json" });
  if (!reachedEof) invalid();
  return value;
};

export const configurationJsonChunks = (snapshot: unknown): Iterable<string> =>
  stringifyChunked(snapshot, { mode: "json", highWaterMark: 65_536 });
