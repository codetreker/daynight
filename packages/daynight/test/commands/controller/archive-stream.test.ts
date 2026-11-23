import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createArchiveRequest } from "../../../src/commands/controller/archive-request.js";
import { transferArchiveStream } from "../../../src/commands/controller/archive-stream.js";
import { ArchiveFileFailedError } from "../../../src/commands/controller/archive-error.js";

const block = 524288;
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const version = { "Daynight-Archive-Upload-Version": "2" };
const runtime = { now: () => 0, random: () => 0.5, wait: async (_ms: number, signal: AbortSignal) => { signal.throwIfAborted(); } };

test.each(["history", "resource"] as const)("preserves the original %s terminal failure after completion reconciliation and replay", async purpose => {
  const bytes = Buffer.from("frozen"), id = randomUUID(), hash = digest(bytes), signal = new AbortController().signal;
  const error = { code: "quota_exceeded", message: "Archive capacity exceeded." };
  const receipt = { ...(purpose === "history" ? { syncId: id, timelineRevision: null } : { fileId: id }), byteLength: String(bytes.length), sha256: hash, acceptedOffset: String(bytes.length), state: "failed", error };
  const receiving = { ...receipt, state: "receiving", error: null };
  const operations: string[] = [];
  const request: typeof fetch = async (_input, init) => {
    operations.push(init?.method ?? "GET");
    if (init?.method === "POST") return Response.json({ code: "quota_exceeded", message: error.message }, { status: 409, headers: version });
    return Response.json(receipt, { headers: version });
  };
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => false, signal, deadline: 2100000, sessionId: randomUUID(), retryRuntime: runtime });
  for (const raw of [receiving, receipt]) {
    await expect(transferArchiveStream({ purpose, file: { fileId: id, byteLength: String(bytes.length), sha256: hash }, read: () => bytes, call, signal, runtime, deadline: 0, replacements: {}, initial: { raw, corrupt: false }, reserveReplacement: () => { throw new Error("must not replace"); }, onHistoryRevision: () => {} })).rejects.toMatchObject({ name: "ArchiveFileFailedError", code: error.code, serverMessage: error.message });
  }
  expect(operations).toEqual(["POST", "GET"]);
  expect(new ArchiveFileFailedError(error.code, error.message).message).toContain("quota_exceeded");
});

test("reports a terminal receipt found after a failed PUT even after the retry deadline", async () => {
  const bytes = Buffer.from("frozen"), id = randomUUID(), hash = digest(bytes), signal = new AbortController().signal;
  const request: typeof fetch = async (_input, init) => init?.method === "PUT" ? Response.json({ code: "quota_exceeded" }, { status: 409 }) : Response.json({ fileId: id, byteLength: String(bytes.length), sha256: hash, acceptedOffset: "0", state: "failed", error: { code: "quota_exceeded", message: "Archive capacity exceeded." } }, { headers: version });
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => false, signal, deadline: 0, sessionId: randomUUID(), retryRuntime: runtime });
  await expect(transferArchiveStream({ purpose: "resource", file: { fileId: id, byteLength: String(bytes.length), sha256: hash }, read: () => bytes, call, signal, runtime, deadline: 0, replacements: {}, initial: null, reserveReplacement: () => { throw new Error("must not replace"); }, onHistoryRevision: () => {} })).rejects.toMatchObject({ code: "quota_exceeded" });
});

test("preserves a non-capacity terminal error without replacing the file", async () => {
  const bytes = Buffer.from("frozen"), id = randomUUID(), signal = new AbortController().signal;
  const request: typeof fetch = async () => { throw new Error("must not write"); };
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => false, signal, deadline: 2100000, sessionId: randomUUID(), retryRuntime: runtime });
  await expect(transferArchiveStream({ purpose: "timeline", file: { fileId: id, byteLength: String(bytes.length), sha256: digest(bytes) }, read: () => bytes, call, signal, runtime, deadline: 2100000, replacements: {}, initial: { raw: { fileId: id, byteLength: String(bytes.length), sha256: digest(bytes), acceptedOffset: "0", state: "failed", error: { code: "invalid_archive", message: "Invalid archive." } }, corrupt: false }, reserveReplacement: () => { throw new Error("must not replace"); }, onHistoryRevision: () => {} })).rejects.toMatchObject({ code: "invalid_archive", serverMessage: "Invalid archive." });
});

test("streams remaining bytes from the recovered lower offset and reconciles a lost completion", async () => {
  const bytes = Buffer.alloc(block * 2 + 19, 42), id = randomUUID(), hash = digest(bytes), puts: number[] = [];
  let stored = Buffer.alloc(0), complete = false, first = true, completions = 0, maxRead = 0;
  const receipt = () => ({ fileId: id, byteLength: String(bytes.length), sha256: hash, acceptedOffset: String(stored.length), state: complete ? "complete" : "receiving", error: null });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    if (init?.method === "GET") return Response.json(receipt(), { headers: version });
    if (url.pathname.endsWith("/complete")) { expect(headers.get("Daynight-Archive-Upload-Version")).toBe("2"); completions++; complete = true; throw new Error("completion response lost"); }
    expect(init?.method).toBe("PUT");
    const start = Number(url.searchParams.get("offset")); puts.push(start);
    expect(headers.get("Content-Length")).toBe(String(bytes.length - start));
    expect(headers.get("Daynight-Chunk-SHA256")).toBeNull();
    const body = Buffer.from(await new Response(init?.body as ConstructorParameters<typeof Response>[0]).arrayBuffer());
    expect(body.equals(bytes.subarray(start))).toBe(true);
    if (first) { first = false; stored = body.subarray(0, block); throw new Error("response lost"); }
    stored = Buffer.concat([stored.subarray(0, start), body]);
    return Response.json(receipt(), { headers: version });
  };
  const signal = new AbortController().signal;
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => false, signal, deadline: 2100000, sessionId: randomUUID(), retryRuntime: runtime });
  const result = await transferArchiveStream({ purpose: "timeline", file: { fileId: id, byteLength: String(bytes.length), sha256: hash }, read: (offset, limit) => { maxRead = Math.max(maxRead, limit); return bytes.subarray(Number(offset), Number(offset) + limit); }, call, signal, runtime, deadline: 2100000, replacements: {}, initial: null, reserveReplacement: () => { throw new Error("unexpected restart"); }, onHistoryRevision: () => {} });
  expect(result).toBe(id); expect(puts).toEqual([0, block]); expect(maxRead).toBeLessThanOrEqual(block); expect(completions).toBe(1); expect(stored.equals(bytes)).toBe(true);
});

test("confirms observed corruption with complete and verifies both receipts after a lost restart", async () => {
  const bytes = Buffer.from("frozen history"), id = randomUUID(), next = randomUUID(), hash = digest(bytes), operations: string[] = [], replacements: Record<string, string> = {};
  let failed = false, successor = false, uploaded = false, completed = false, revision = "";
  const receipt = (target: string) => ({ syncId: target, byteLength: String(bytes.length), sha256: hash, acceptedOffset: target === next && uploaded ? String(bytes.length) : "0", state: target === id && failed ? "failed" : target === next && completed ? "complete" : "receiving", error: target === id && failed ? { code: "staging_corrupt", message: "Archive staging is corrupt." } : null, timelineRevision: target === next && completed ? "7" : null, ...(target === id && successor ? { successorFileId: next } : {}) });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), parts = url.pathname.split("/"), target = parts[parts.length - 2]!, action = parts.at(-1)!;
    operations.push(`${init?.method} ${target} ${action}`);
    if (init?.method === "GET") return target === next && !successor ? Response.json({}, { status: 404 }) : Response.json(receipt(target), { headers: version });
    if (action === "complete" && target === id) { failed = true; return Response.json(receipt(id), { headers: version }); }
    if (action === "restart") { expect(replacements[id]).toBe(next); expect(JSON.parse(String(init?.body))).toEqual({ replacementFileId: next }); successor = true; throw new Error("restart response lost"); }
    if (init?.method === "PUT") { expect(Buffer.from(await new Response(init.body as ConstructorParameters<typeof Response>[0]).arrayBuffer())).toEqual(bytes); uploaded = true; return Response.json(receipt(next), { headers: version }); }
    if (action === "complete" && target === next) { completed = true; return Response.json(receipt(next), { headers: version }); }
    throw new Error("unexpected request");
  };
  const signal = new AbortController().signal;
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => false, signal, deadline: 2100000, sessionId: randomUUID(), retryRuntime: runtime });
  const result = await transferArchiveStream({ purpose: "history", file: { fileId: id, byteLength: String(bytes.length), sha256: hash }, read: (offset, limit) => bytes.subarray(Number(offset), Number(offset) + limit), call, signal, runtime, deadline: 2100000, replacements, initial: { raw: receipt(id), corrupt: true }, reserveReplacement: old => { replacements[old] = next; return next; }, onHistoryRevision: value => { revision = value; } });
  expect(result).toBe(next); expect(revision).toBe("7"); expect(operations[0]).toBe(`POST ${id} complete`); expect(operations).toContain(`GET ${id} status`); expect(operations).toContain(`GET ${next} status`);
});

test.each(["history", "timeline", "resource"] as const)("uploads a revoked %s successor from zero using its confirmed original intent", async purpose => {
  const bytes = Buffer.from("frozen migration source"), id = randomUUID(), successor = randomUUID(), hash = digest(bytes);
  const puts: string[] = [];
  let uploaded = false, complete = false, revision = "";
  const receipt = (target: string) => {
    const failed = target === id;
    const value = { fileId: target, byteLength: String(bytes.length), sha256: hash, acceptedOffset: failed || !uploaded ? "0" : String(bytes.length), state: failed ? "failed" : complete ? "complete" : "receiving", error: failed ? { code: "staging_corrupt", message: "Archive staging is corrupt." } : null, ...(failed ? { successorFileId: successor } : {}) };
    if (purpose !== "history") return value;
    const { fileId, ...rest } = value;
    return { syncId: fileId, ...rest, timelineRevision: !failed && complete ? "7" : null };
  };
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), target = url.pathname.includes(successor) ? successor : id;
    if (init?.method === "GET") return target === successor && !uploaded ? Response.json({}, { status: 404 }) : Response.json(receipt(target), { headers: version });
    if (init?.method === "PUT") {
      expect(target).toBe(successor);
      expect(url.searchParams.get("offset")).toBe("0");
      expect(new Headers(init.headers).get("Daynight-File-SHA256")).toBe(hash);
      expect(new Headers(init.headers).get("Daynight-File-Byte-Length")).toBe(String(bytes.length));
      expect(Buffer.from(await new Response(init.body as ConstructorParameters<typeof Response>[0]).arrayBuffer())).toEqual(bytes);
      puts.push(target); uploaded = true;
      return Response.json(receipt(target), { headers: version });
    }
    if (url.pathname.endsWith("/complete") && target === successor) { complete = true; return Response.json(receipt(target), { headers: version }); }
    throw new Error("Confirmed replacement must not restart or rotate again.");
  };
  const signal = new AbortController().signal;
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => false, signal, deadline: 2100000, sessionId: randomUUID(), retryRuntime: runtime });
  const result = await transferArchiveStream({ purpose, file: { fileId: id, byteLength: String(bytes.length), sha256: hash }, read: (offset, limit) => bytes.subarray(Number(offset), Number(offset) + limit), call, signal, runtime, deadline: 2100000, replacements: { [id]: successor }, initial: { raw: receipt(id), corrupt: false }, reserveReplacement: () => { throw new Error("Must preserve the reserved successor."); }, onHistoryRevision: value => { revision = value; } });
  expect(result).toBe(successor); expect(puts).toEqual([successor]); expect(complete).toBe(true);
  if (purpose === "history") expect(revision).toBe("7");
});

test.each(["PUT", "complete", "restart"])("refuses an invalid successful %s receipt without reconciling it away", async action => {
  const bytes = Buffer.from("original"), id = randomUUID(), next = randomUUID(), hash = digest(bytes), requests: string[] = [];
  const receiving = { fileId: id, byteLength: String(bytes.length), sha256: hash, acceptedOffset: action === "complete" ? String(bytes.length) : "0", state: "receiving", error: null };
  const failed = { ...receiving, state: "failed", error: { code: "staging_corrupt", message: "Archive staging is corrupt." } };
  const request: typeof fetch = async (_input, init) => { requests.push(init?.method ?? "GET"); return Response.json({ ...receiving, fileId: randomUUID() }, { headers: version }); };
  const signal = new AbortController().signal;
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => false, signal, deadline: 2100000, sessionId: randomUUID(), retryRuntime: runtime });
  await expect(transferArchiveStream({ purpose: "timeline", file: { fileId: id, byteLength: String(bytes.length), sha256: hash }, read: (offset, limit) => bytes.subarray(Number(offset), Number(offset) + limit), call, signal, runtime, deadline: 2100000, replacements: action === "restart" ? { [id]: next } : {}, initial: action === "PUT" ? null : { raw: action === "restart" ? failed : receiving, corrupt: false }, reserveReplacement: () => next, onHistoryRevision: () => {} })).rejects.toThrow("original intent");
  expect(requests).toEqual([action === "PUT" ? "PUT" : "POST"]);
});

test("refuses a failed receipt presented as a non-durable corruption observation", async () => {
  const id = randomUUID(), bytes = Buffer.from("frozen"), signal = new AbortController().signal;
  const request: typeof fetch = async () => { throw new Error("must not write"); };
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => false, signal, deadline: 2100000, sessionId: randomUUID(), retryRuntime: runtime });
  await expect(transferArchiveStream({ purpose: "timeline", file: { fileId: id, byteLength: String(bytes.length), sha256: digest(bytes) }, read: (offset, limit) => bytes.subarray(Number(offset), Number(offset) + limit), call, signal, runtime, deadline: 2100000, replacements: {}, initial: { raw: { fileId: id, byteLength: String(bytes.length), sha256: digest(bytes), acceptedOffset: "0", state: "failed", error: { code: "staging_corrupt", message: "Archive staging is corrupt." } }, corrupt: true }, reserveReplacement: () => randomUUID(), onHistoryRevision: () => {} })).rejects.toThrow("Invalid archive staging observation");
});

test.each(["PUT", "complete", "restart"])("reconciles a %s response body interrupted after successful headers", async action => {
  const bytes = Buffer.from("archive bytes"), id = randomUUID(), next = randomUUID(), hash = digest(bytes), requests: string[] = [];
  let interrupted = false, successor = false, uploaded = action !== "restart", complete = false;
  const receipt = (target: string) => ({ fileId: target, byteLength: String(bytes.length), sha256: hash, acceptedOffset: target === id && action === "restart" ? "0" : uploaded ? String(bytes.length) : "0", state: target === id && action === "restart" ? "failed" : complete ? "complete" : "receiving", error: target === id && action === "restart" ? { code: "staging_corrupt", message: "Archive staging is corrupt." } : null, ...(target === id && successor ? { successorFileId: next } : {}) });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET"; requests.push(`${method} ${url.pathname}`);
    const target = url.pathname.includes(next) ? next : id;
    if (method === "GET") return Response.json(receipt(target), { headers: version });
    const matching = action === "PUT" ? method === "PUT" : url.pathname.endsWith(`/${action}`);
    if (matching && !interrupted) {
      interrupted = true; if (action === "complete") complete = true; if (action === "restart") { successor = true; uploaded = false; }
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"fileId":')); controller.error(new TypeError("response connection lost")); } }), { status: 200, headers: version });
    }
    if (method === "PUT") { uploaded = true; return Response.json(receipt(target), { headers: version }); }
    complete = true; return Response.json(receipt(target), { headers: version });
  };
  const signal = new AbortController().signal;
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => false, signal, deadline: 2100000, sessionId: randomUUID(), retryRuntime: runtime });
  const initial = action === "PUT" ? null : { raw: receipt(id), corrupt: false };
  expect(await transferArchiveStream({ purpose: "timeline", file: { fileId: id, byteLength: String(bytes.length), sha256: hash }, read: (offset, limit) => bytes.subarray(Number(offset), Number(offset) + limit), call, signal, runtime, deadline: 2100000, replacements: action === "restart" ? { [id]: next } : {}, initial, reserveReplacement: () => next, onHistoryRevision: () => {} })).toBe(action === "restart" ? next : id);
  expect(requests.some(value => value.startsWith("GET "))).toBe(true);
});

test("rejects a mismatched successful version even when its response body disconnects", async () => {
  const bytes = Buffer.from("archive"), id = randomUUID(), signal = new AbortController().signal, requests: string[] = [];
  const request: typeof fetch = async (_input, init) => { requests.push(init?.method ?? "GET"); return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("connection lost")); } }), { headers: { "Daynight-Archive-Upload-Version": "1" } }); };
  const call = createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => false, signal, deadline: 2100000, sessionId: randomUUID(), retryRuntime: runtime });
  await expect(transferArchiveStream({ purpose: "timeline", file: { fileId: id, byteLength: String(bytes.length), sha256: digest(bytes) }, read: (offset, limit) => bytes.subarray(Number(offset), Number(offset) + limit), call, signal, runtime, deadline: 2100000, replacements: {}, initial: null, reserveReplacement: () => randomUUID(), onHistoryRevision: () => {} })).rejects.toThrow("upload version");
  expect(requests).toEqual(["PUT"]);
});
