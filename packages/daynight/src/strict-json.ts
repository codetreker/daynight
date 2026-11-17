const utf8 = new TextEncoder();
const invalid = (): never => { throw new Error("Invalid JSON."); };

/** Reject duplicate decoded keys, invalid Unicode and non-JSON values before object parsing. */
export const decodeStrictJson = (input: string | Uint8Array, maxBytes: number, fail: () => never = invalid): unknown => {
  let source: string;
  if (typeof input === "string") { if (!input.isWellFormed() || utf8.encode(input).length > maxBytes) return fail(); source = input; }
  else { if (input.length > maxBytes) return fail(); try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input); } catch { return fail(); } }
  let at = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(source[at] ?? "") && at < source.length) at++; };
  const string = (): string => {
    const begin = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === '"') { let parsed: unknown; try { parsed = JSON.parse(source.slice(begin, at)); } catch { return fail(); } if (typeof parsed !== "string" || !parsed.isWellFormed() || utf8.encode(parsed).length > maxBytes) return fail(); return parsed; }
      if (c === "\\") at++;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 64) return fail(); space(); const c = source[at];
    if (c === '"') return string();
    if (c === "{") {
      at++; space(); const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (source[at] === "}") { at++; return out; }
      for (;;) {
        space(); if (source[at] !== '"') return fail(); const key = string();
        if (Object.hasOwn(out, key)) return fail(); space(); if (source[at++] !== ":") return fail(); out[key] = value(depth + 1); space();
        const end = source[at++]; if (end === "}") return out; if (end !== ",") return fail();
      }
    }
    if (c === "[") {
      at++; space(); const out: unknown[] = []; if (source[at] === "]") { at++; return out; }
      for (;;) { out.push(value(depth + 1)); space(); const end = source[at++]; if (end === "]") return out; if (end !== ",") return fail(); }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(at));
    if (!token) return fail(); at += token[0].length; const parsed: unknown = JSON.parse(token[0]);
    return typeof parsed === "number" && !Number.isFinite(parsed) ? fail() : parsed;
  };
  const result = value(0); space(); if (at !== source.length) return fail(); return result;
};
