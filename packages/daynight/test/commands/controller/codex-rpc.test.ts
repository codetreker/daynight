import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { CodexRpc } from "../../../src/commands/controller/providers/codex-rpc.js";
import { CodexJsonDecoder, codexMedia, type CodexMediaSpool } from "../../../src/commands/controller/providers/codex-rpc-json.js";
import { NativeRpcError, NativeRpcTimeoutError } from "../../../src/commands/controller/providers/native-rpc.js";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const storage = () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-rpc-")); roots.push(root);
  const files: string[] = [], writes: number[] = [];
  const createSpool = (limit: number): CodexMediaSpool => {
    const file = path.join(root, String(files.length)); files.push(file);
    let fd: number | null = openSync(file, "wx", 0o600), size = 0;
    return { path: file, write(bytes) { if (fd === null || size + bytes.length > limit) throw new Error("Spool admission failed."); writes.push(bytes.length); writeSync(fd, bytes); size += bytes.length; }, seal() { if (fd !== null) { closeSync(fd); fd = null; } },
      *read() { if (fd !== null) throw new Error("Spool is not sealed."); const reader = openSync(file, "r"); try { let offset = 0; const bytes = Buffer.alloc(65536); while (offset < size) { const count = readSync(reader, bytes, 0, Math.min(bytes.length, size - offset), offset); if (!count) throw new Error("Short spool read."); offset += count; yield bytes.subarray(0, count); } } finally { closeSync(reader); } },
      remove() { if (fd !== null) { closeSync(fd); fd = null; } if (existsSync(file)) unlinkSync(file); },
    };
  };
  return { createSpool, files, writes };
};
const imageFrame = (data: string, extra = "") => `{"params":{"item":{"result":${JSON.stringify(data)},"id":"image-1","status":"completed","type":"imageGeneration"${extra}},"threadId":"thread-1"},"method":"item/completed"}\n`;
const decode = (decoder: CodexJsonDecoder, value: string, chunk = 7) => {
  const bytes = Buffer.from(value), frames = [];
  for (let offset = 0; offset < bytes.length; offset += chunk) frames.push(...decoder.write(bytes.subarray(offset, offset + chunk)));
  return frames;
};

test("arbitrarily ordered image fields become private decoded leases only after the entire frame validates", () => {
  const s = storage(), decoder = new CodexJsonDecoder(s.createSpool);
  const original = Buffer.from("an image payload"), frame = imageFrame(original.toString("base64"));
  const prefix = frame.slice(0, -2);
  expect(decode(decoder, prefix)).toEqual([]);
  const [parsed] = decode(decoder, frame.slice(-2));
  const value = (parsed!.value.params as any).item.result, media = codexMedia(value)!;
  expect(media.status).toBe("available"); expect(media.mediaType).toBe("image/png");
  expect(media.byteLength).toBe(original.length); expect(media.sha256).toBe(createHash("sha256").update(original).digest("hex"));
  const lease = media.retain(); expect(readFileSync(lease.path)).toEqual(original);
  expect(JSON.stringify(parsed!.value)).not.toContain(original.toString("base64")); expect(JSON.stringify(parsed!.value)).not.toContain(lease.path);
  parsed!.release(); expect(existsSync(lease.path)).toBe(true);
  lease.release(); expect(s.files.every(file => !existsSync(file))).toBe(true);
  decoder.dispose();
});

test("split UTF-8 and JSON escapes retain ordinary values while media paths are schema specific", () => {
  const s = storage(), decoder = new CodexJsonDecoder(s.createSpool);
  const value = { id: 1, result: { text: "中文😀\n\"\\", data: "ordinary metadata", literal: "\ud83d\ude00" } };
  const [frame] = decode(decoder, JSON.stringify(value) + "\n", 1);
  expect(frame!.value).toEqual(value); expect(s.files).toEqual([]); frame!.release(); decoder.dispose();
});

test("MCP, user, dynamic and function image tokens preserve their exact owning array slots", () => {
  const s = storage(), decoder = new CodexJsonDecoder(s.createSpool), data = Buffer.from("bytes").toString("base64");
  const items = [
    { type: "userMessage", id: "u", content: [{ type: "text", text: "first" }, { type: "image", url: `data:image/jpeg;base64,${data}` }] },
    { type: "mcpToolCall", id: "m", result: { content: [{ data, mimeType: "image/gif", type: "image" }, { type: "resource", resource: { blob: data, mimeType: "image/avif" } }] } },
    { type: "dynamicToolCall", id: "d", contentItems: [{ imageUrl: `data:image/webp;base64,${data}`, type: "inputImage" }] },
    { type: "functionCallOutput", id: "f", output: [{ type: "input_image", image_url: `data:image/png;base64,${data}` }] },
  ];
  const [frame] = decode(decoder, JSON.stringify({ id: 3, result: { data: items.map(item => ({ turnId: "turn", item })), nextCursor: null } }) + "\n");
  const actual = (frame!.value.result as any).data.map((entry: any) => entry.item);
  expect(actual[0].content[0]).toEqual(items[0]!.content![0]);
  const media = [actual[0].content[1].url, actual[1].result.content[0].data, actual[1].result.content[1].resource.blob, actual[2].contentItems[0].imageUrl, actual[3].output[0].image_url].map(codexMedia);
  expect(media.map(item => item?.mediaType)).toEqual(["image/jpeg", "image/gif", "image/avif", "image/webp", "image/png"]);
  frame!.release(); expect(s.files.every(file => !existsSync(file))).toBe(true); decoder.dispose();
});

test("an unrecognized media-shaped field cannot leak its bytes through ordinary JSON serialization", () => {
  const s = storage(), decoder = new CodexJsonDecoder(s.createSpool);
  const [frame] = decode(decoder, imageFrame("c2VjcmV0LWltYWdl", ',"unrecognized":true').replace('"type":"imageGeneration"', '"type":"unknownItem"'));
  const media = codexMedia((frame!.value.params as any).item.result);
  expect(media).toMatchObject({ status: "unavailable", errorCode: "unsupported_native_media" }); expect(JSON.stringify(frame!.value)).not.toContain("c2VjcmV0LWltYWdl"); frame!.release(); decoder.dispose();
});

test("only bounded HTTP URLs survive as source locators, and their escaped wire bytes count as metadata", () => {
  const s = storage(), frameFor = (url: string) => JSON.stringify({ params: { item: { id: "u", type: "userMessage", content: [{ type: "image", url }] } } }) + "\n";
  for (const url of ["https://example.test/image.png", "file:///private/image.png", "javascript:alert(1)", "not a URL"]) {
    const decoder = new CodexJsonDecoder(s.createSpool), [frame] = decode(decoder, frameFor(url));
    const actual = (frame!.value.params as any).item.content[0].url;
    if (url.startsWith("https:")) expect(actual).toBe(url);
    else expect(codexMedia(actual)).toMatchObject({ status: "unavailable", errorCode: "invalid_native_image" });
    frame!.release(); decoder.dispose();
  }
  const escaped = frameFor("https://example.test/image.png").replaceAll("/", "\\u002f");
  const decoder = new CodexJsonDecoder(s.createSpool, { metadataBytes: Buffer.byteLength(escaped) - 1 });
  expect(() => decode(decoder, escaped)).toThrow("metadata budget"); decoder.dispose();
});

test("a frame exceeding its deadline during final media decoding cannot publish", () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const s = storage(), decoder = new CodexJsonDecoder(limit => { const spool = s.createSpool(limit); return { ...spool, write(bytes) { spool.write(bytes); vi.setSystemTime(1101); } }; }, { frameMs: 100 });
  expect(() => decode(decoder, imageFrame("YQ=="), 65536)).toThrow("deadline");
  decoder.dispose(); expect(s.files.every(file => !existsSync(file))).toBe(true);
});

test("storage admission refusal preserves the failed image slot and subsequent ordinary text", () => {
  const decoder = new CodexJsonDecoder(() => { throw new Error("Media storage full."); }, { bufferBytes: 4 });
  const [frame] = decode(decoder, imageFrame("YWFhYWFh", ',"revisedPrompt":"retained"'));
  const item = (frame!.value.params as any).item;
  expect(codexMedia(item.result)).toMatchObject({ status: "unavailable", errorCode: "media_capacity_exceeded" });
  expect(item.revisedPrompt).toBe("retained"); frame!.release(); decoder.dispose();
});

test("over-limit images are drained without losing following text or parsing the media into memory", () => {
  const s = storage(), decoder = new CodexJsonDecoder(s.createSpool, { imageBytes: 4 });
  const [frame] = decode(decoder, imageFrame(Buffer.from("too large").toString("base64"), ',"revisedPrompt":"retained text"'), 1);
  const item = (frame!.value.params as any).item;
  expect(codexMedia(item.result)).toMatchObject({ status: "unavailable", errorCode: "image_too_large" }); expect(item.revisedPrompt).toBe("retained text");
  expect(s.files.every(file => !existsSync(file))).toBe(true); frame!.release(); decoder.dispose();
});

test.each(["!!!!", "YQ=", "YR==", "YQ==YQ=="])("malformed base64 %s remains a safe unavailable slot", data => {
  const s = storage(), decoder = new CodexJsonDecoder(s.createSpool), [frame] = decode(decoder, imageFrame(data));
  expect(codexMedia((frame!.value.params as any).item.result)).toMatchObject({ status: "unavailable", errorCode: "invalid_native_image" });
  frame!.release(); decoder.dispose(); expect(s.files.every(file => !existsSync(file))).toBe(true);
});

test.each([
  '{"a":1,"a":2}\n', '{"a": [1,]}\n', '{"a":01}\n', '{"a":"\\uD800"}\n', '{"a":true} trailing\n', '{"a":true\n',
])("malformed JSON never publishes a partial frame: %s", value => {
  const s = storage(), decoder = new CodexJsonDecoder(s.createSpool);
  expect(() => decode(decoder, value)).toThrow(); decoder.dispose(); expect(s.files.every(file => !existsSync(file))).toBe(true);
});

test("trailing malformed metadata removes staged image bytes before publication", () => {
  const s = storage(), decoder = new CodexJsonDecoder(s.createSpool), value = imageFrame(Buffer.alloc(60000, 1).toString("base64"));
  expect(() => decode(decoder, value.slice(0, -2) + ',"bad":}\n', 65536)).toThrow(); decoder.dispose(); expect(s.files.length).toBeGreaterThan(0); expect(s.files.every(file => !existsSync(file))).toBe(true);
});

test("invalid UTF-8 and structural, metadata, token and wire budgets fail closed", () => {
  const s = storage();
  for (const [limits, wire] of [
    [{ depth: 2 }, '{"a":{"b":{}}}\n'], [{ metadataBytes: 12 }, '{"long":"metadata"}\n'], [{ tokens: 3 }, '{"a":1,"b":2}\n'], [{ frameBytes: 12 }, '{"long":"frame"}\n'], [{ wireBytes: 8 }, imageFrame("YWFhYWFhYWFh")], [{ mediaSlots: 1 }, JSON.stringify({ params: { item: { id: "u", type: "userMessage", content: [{ type: "image", url: "data:image/png;base64,YQ==" }, { type: "image", url: "data:image/png;base64,Yg==" }] } } }) + "\n"],
  ] as const) { const decoder = new CodexJsonDecoder(s.createSpool, limits); expect(() => decode(decoder, wire)).toThrow(); decoder.dispose(); }
  const decoder = new CodexJsonDecoder(s.createSpool); expect(() => [...decoder.write(Buffer.from([0x7b, 0x22, 0xc3, 0x28]))]).toThrow(); decoder.dispose();
});

test("large known text is explicitly truncated while the complete wire syntax is still checked", () => {
  const s = storage(), decoder = new CodexJsonDecoder(s.createSpool, { metadataBytes: 210000 });
  const wire = JSON.stringify({ params: { item: { text: "a".repeat(220000), id: "text", type: "agentMessage" } }, method: "item/completed" }) + "\n";
  const [frame] = decode(decoder, wire, 65536), text = ((frame!.value.params as any).item.text) as string;
  expect(text).toBe("a".repeat(200000) + "\n[Output truncated at 200000 characters]"); expect(s.files).toEqual([]); frame!.release(); decoder.dispose();
  const invalid = new CodexJsonDecoder(s.createSpool, { metadataBytes: 210000 });
  expect(() => decode(invalid, wire.slice(0, -2) + ',"broken":}\n', 65536)).toThrow(); invalid.dispose();
});

test("a partial UTF-8 prefix starts the absolute frame deadline", () => {
  const s = storage(), decoder = new CodexJsonDecoder(s.createSpool);
  expect([...decoder.write(Buffer.from([0xf0]))]).toEqual([]); expect(decoder.frameStartedAt).not.toBeNull();
  expect(() => decoder.end()).toThrow(); decoder.dispose();
});

test("a media reader may retry release after a failed actual unlink", () => {
  const s = storage(); let fail = true;
  const decoder = new CodexJsonDecoder(limit => { const spool = s.createSpool(limit); return { ...spool, remove() { if (fail) { fail = false; throw new Error("Unlink failed."); } spool.remove(); } }; });
  const [frame] = decode(decoder, imageFrame("YQ==")), media = codexMedia((frame!.value.params as any).item.result)!, lease = media.retain(); frame!.release();
  expect(() => lease.release()).toThrow("Unlink failed"); expect(existsSync(lease.path)).toBe(true); lease.release(); expect(existsSync(lease.path)).toBe(false); decoder.dispose();
});

test("failed frame and partial-wire cleanup retain ownership until a later unlink succeeds", () => {
  const s = storage(); let failures = 1;
  const create = (limit: number) => { const spool = s.createSpool(limit); return { ...spool, remove() { if (failures-- > 0) throw new Error("Unlink failed."); spool.remove(); } }; };
  const decoder = new CodexJsonDecoder(create), [frame] = decode(decoder, imageFrame("YQ=="));
  expect(() => frame!.release()).toThrow("cleanup failed"); frame!.release(); decoder.dispose();
  expect(s.files.every(file => !existsSync(file))).toBe(true);
  failures = 1;
  const partial = new CodexJsonDecoder(create, { bufferBytes: 4 });
  decode(partial, imageFrame("YWFhYWFh").slice(0, -2));
  expect(() => partial.dispose()).toThrow("cleanup failed"); partial.dispose();
  expect(s.files.every(file => !existsSync(file))).toBe(true);
});

test("retrying a frame's failed cleanup cannot consume another reader's retained image", () => {
  const s = storage(); let fail = true;
  const decoder = new CodexJsonDecoder(limit => { const spool = s.createSpool(limit); return { ...spool, remove() { if (spool.path.endsWith("1") && fail) { fail = false; throw new Error("Unlink failed."); } spool.remove(); } }; });
  const [frame] = decode(decoder, JSON.stringify({ params: { item: { id: "u", type: "userMessage", content: [{ type: "image", url: "data:image/png;base64,YQ==" }, { type: "image", url: "data:image/png;base64,Yg==" }] } } }) + "\n");
  const lease = codexMedia((frame!.value.params as any).item.content[0].url)!.retain();
  expect(() => frame!.release()).toThrow("cleanup failed"); frame!.release(); decoder.dispose();
  expect(readFileSync(lease.path).toString()).toBe("a"); lease.release(); expect(s.files.every(file => !existsSync(file))).toBe(true);
});

const transport = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
test("RPC responses, errors and notifications preserve request identity and release frame media independently of consumers", async () => {
  const s = storage(), child = transport(), received: unknown[] = []; let wire = ""; child.stdin.on("data", chunk => { wire += chunk.toString(); });
  const rpc = new CodexRpc(child, message => { received.push(message); }, { createSpool: s.createSpool });
  try {
    const success = rpc.request("read", { cursor: "one" });
    await vi.waitFor(() => expect(wire).not.toBe("")); expect(JSON.parse(wire)).toEqual({ id: 1, method: "read", params: { cursor: "one" } });
    child.stdout.write('{"id":1,"result":{"value":"ok"}}\n'); expect(await success).toEqual({ value: "ok" });
    const rejected = rpc.request("turn/start", {}); const rejection = expect(rejected).rejects.toMatchObject({ code: -1, message: "rejected" });
    child.stdout.write('{"id":2,"error":{"code":-1,"message":"rejected"}}\n'); await rejection;
    child.stdout.write('{"method":"turn/started","params":{"turnId":"t"}}\n'); await vi.waitFor(() => expect(received).toHaveLength(1));
    rpc.notify("initialized"); rpc.respond(8, { ok: true }); rpc.reject(9, "unsupported");
    await vi.waitFor(() => expect(wire).toContain('"unsupported"'));
    const writes = wire.trim().split("\n").map(line => JSON.parse(line));
    expect(writes.slice(-3)).toEqual([{ method: "initialized" }, { id: 8, result: { ok: true } }, { id: 9, error: { code: -32601, message: "unsupported" } }]);
  } finally { rpc.dispose(); await rpc.stopped; }
});

test("an awaited response can retain image media before frame cleanup", async () => {
  const s = storage(), child = transport(), rpc = new CodexRpc(child, () => {}, { createSpool: s.createSpool });
  try {
    const pending = rpc.request("thread/items/list", {});
    child.stdout.write(JSON.stringify({ id: 1, result: { data: [{ item: { id: "image", type: "imageGeneration", status: "completed", result: "YQ==" } }] } }) + "\n");
    const result = await pending as any, media = codexMedia(result.data[0].item.result)!, lease = media.retain();
    await new Promise(resolve => setImmediate(resolve)); expect(readFileSync(lease.path).toString()).toBe("a"); lease.release();
    expect(s.files.every(file => !existsSync(file))).toBe(true);
  } finally { rpc.dispose(); await rpc.stopped; }
});

test("natural close drains response media and preserves a consumer's retained lease after EOF cleanup", async () => {
  const s = storage(), child = transport(), rpc = new CodexRpc(child, () => {}, { createSpool: s.createSpool });
  let lease: ReturnType<NonNullable<ReturnType<typeof codexMedia>>["retain"]> | undefined;
  try {
    const pending = rpc.request("thread/items/list", {});
    child.stdout.end(JSON.stringify({ id: 1, result: { data: [{ item: { id: "image", type: "imageGeneration", status: "completed", result: "YQ==" } }] } }) + "\n");
    child.emit("close");
    const result = await pending as any;
    lease = codexMedia(result.data[0].item.result)!.retain();
    await rpc.stopped;
    expect(readFileSync(lease.path).toString()).toBe("a");
    lease.release(); lease = undefined; expect(s.files.every(file => !existsSync(file))).toBe(true);
  } finally { lease?.release(); rpc.dispose(); await rpc.stopped; }
});

test.each(["dispose", "error", "malformed"])("retained response media survives %s while later frames stop", async action => {
  const s = storage(), child = transport(), received: unknown[] = [], failures: Error[] = [], original = new Error("Original native failure.");
  const rpc = new CodexRpc(child, message => received.push(message), { createSpool: s.createSpool, onFatalError: error => failures.push(error) });
  let lease: ReturnType<NonNullable<ReturnType<typeof codexMedia>>["retain"]> | undefined;
  try {
    const pending = rpc.request("thread/items/list", {});
    child.stdout.write(JSON.stringify({ id: 1, result: { data: [{ item: { id: "image", type: "imageGeneration", status: "completed", result: "YQ==" } }] } }) + "\n");
    const result = await pending as any;
    lease = codexMedia(result.data[0].item.result)!.retain();
    if (action === "dispose") rpc.dispose();
    else if (action === "error") child.emit("error", original);
    else child.stdout.write('{"bad":}\n{"method":"late"}\n');
    await rpc.stopped;
    expect(received).toEqual([]); expect(readFileSync(lease.path).toString()).toBe("a");
    if (action === "dispose") expect(failures).toEqual([]);
    else if (action === "error") expect(failures).toEqual([original]);
    else expect(failures[0]!.message).toContain("Invalid native protocol");
    lease.release(); lease = undefined; expect(s.files.every(file => !existsSync(file))).toBe(true);
  } finally { lease?.release(); rpc.dispose(); await rpc.stopped; }
});

test("a throwing media consumer releases its frame and stops subsequent dispatch", async () => {
  const s = storage(), child = transport(), original = new Error("Consumer failed."), failures: Error[] = [];
  let delivered = 0;
  const rpc = new CodexRpc(child, () => { delivered += 1; throw original; }, { createSpool: s.createSpool, onFatalError: error => failures.push(error) });
  try {
    child.stdout.write(imageFrame("YQ==") + imageFrame("Yg=="));
    await rpc.stopped;
    expect(delivered).toBe(1); expect(failures).toEqual([original]); expect(s.files.every(file => !existsSync(file))).toBe(true);
  } finally { rpc.dispose(); await rpc.stopped; }
});

test("request timeouts remain unknown and malformed input terminates pending requests", async () => {
  const s = storage(), child = transport(), failures: Error[] = [], rpc = new CodexRpc(child, () => {}, { createSpool: s.createSpool, timeoutMs: 20, onFatalError: error => failures.push(error) });
  try {
    await expect(rpc.request("turn/start", {})).rejects.toBeInstanceOf(NativeRpcTimeoutError);
    const pending = rpc.request("turn/steer", {}), rejected = expect(pending).rejects.not.toBeInstanceOf(NativeRpcError);
    child.stdout.write('{"bad":}\n'); await rejected; await rpc.stopped; expect(failures).toHaveLength(1);
    await expect(rpc.request("read", {})).rejects.toThrow("closed");
  } finally { rpc.dispose(); await rpc.stopped; }
});

test("a stalled partial frame closes the reader and leaves the original request unknown", async () => {
  const s = storage(), child = transport(), failures: Error[] = [], rpc = new CodexRpc(child, () => {}, { createSpool: s.createSpool, limits: { frameMs: 20 }, onFatalError: error => failures.push(error) });
  try {
    const rejected = expect(rpc.request("turn/start", {})).rejects.toThrow("frame deadline");
    child.stdout.write('{"id":1,"result":');
    await rejected; await rpc.stopped; expect(failures).toHaveLength(1); expect(child.stdout.destroyed).toBe(true);
  } finally { rpc.dispose(); await rpc.stopped; }
});

test("only the original timed-out request's late response reaches its evidence observer", async () => {
  const s = storage(), child = transport(), rpc = new CodexRpc(child, () => {}, { createSpool: s.createSpool, timeoutMs: 10 }), observed: unknown[] = [];
  try {
    await expect(rpc.request("turn/start", { clientUserMessageId: "original-operation" }, response => { observed.push(response); })).rejects.toBeInstanceOf(NativeRpcTimeoutError);
    child.stdout.write('{"id":99,"result":{"turn":{"id":"unrelated"}}}\n');
    child.stdout.write('{"id":1,"result":{"turn":{"id":"original-turn"}}}\n');
    await vi.waitFor(() => expect(observed).toEqual([{ result: { turn: { id: "original-turn" } } }]));
    child.stdout.write('{"id":1,"result":{"turn":{"id":"duplicate"}}}\n');
    const normal = rpc.request("read", {}, response => { observed.push(response); }); child.stdout.write('{"id":2,"result":{"ok":true}}\n');
    expect(await normal).toEqual({ ok: true }); expect(observed).toHaveLength(1);
    const rejected = rpc.request("turn/steer", {}, response => { observed.push(response); }); await expect(rejected).rejects.toBeInstanceOf(NativeRpcTimeoutError);
    child.stdout.write('{"id":3,"error":{"code":-32602,"message":"wrong turn"}}\n');
    await vi.waitFor(() => expect(observed).toHaveLength(2)); expect(observed[1]).toEqual({ error: new NativeRpcError(-32602, "wrong turn") });
  } finally { rpc.dispose(); await rpc.stopped; }
});

test("late-evidence capacity refuses a new observed request before its native write and retains existing evidence", async () => {
  const s = storage(), child = transport(), rpc = new CodexRpc(child, () => {}, { createSpool: s.createSpool, timeoutMs: 100 }); let calls = 0;
  child.stdin.on("data", chunk => { calls += String(chunk).split("\n").length - 1; });
  const requests = Array.from({ length: 1000 }, () => rpc.request("turn/start", {}, () => {})); const settled = Promise.allSettled(requests);
  try {
    await expect(rpc.request("turn/start", {}, () => {})).rejects.toThrow("observer capacity"); expect(calls).toBe(1000);
    const control = rpc.request("read", {}); child.stdout.write('{"id":1001,"result":{"ok":true}}\n'); expect(await control).toEqual({ ok: true });
  } finally { rpc.dispose(); await rpc.stopped; await settled; }
});
