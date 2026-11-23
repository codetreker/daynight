/** Encode JSON-compatible archive values without constructing an entire document. */
export function* jsonPieces(value: unknown, sorted = false): Generator<string> {
  if (typeof value === "string") {
    yield '"';
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 65536, value.length);
      if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1); start = end;
    }
    yield '"'; return;
  }
  if (value === null || typeof value !== "object") { yield JSON.stringify(value) ?? "null"; return; }
  if (Array.isArray(value)) { yield "["; for (let i = 0; i < value.length; i++) { if (i) yield ","; yield* jsonPieces(value[i], sorted); } yield "]"; return; }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined); if (sorted) entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  yield "{"; let first = true; for (const [key, item] of entries) { if (!first) yield ","; first = false; yield* jsonPieces(key, sorted); yield ":"; yield* jsonPieces(item, sorted); } yield "}";
}
