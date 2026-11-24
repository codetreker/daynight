import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createArchiveRequest } from "../../../src/commands/controller/archive-request.js";
import { transferArchiveStream } from "../../../src/commands/controller/archive-stream.js";
import { ARCHIVE_MAX_RETRIES, type ArchiveRetryRuntime } from "../../../src/commands/controller/archive-retry.js";

const block = 524288;
const deadline = 2100000;
const version = { "Daynight-Archive-Upload-Version": "2" };
const runtime: ArchiveRetryRuntime = { now: () => 0, random: () => 0.5, wait: async (_ms, signal) => { signal.throwIfAborted(); } };
type Purpose = "history" | "timeline" | "resource";
const source = (length: number): Buffer => Buffer.alloc(length).fill(Buffer.from(Array.from({ length: 256 }, (_, index) => index)));

const fixture = (purpose: Purpose, bytes: Buffer) => {
  const file = { fileId: randomUUID(), byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") };
  const descriptor = { resourceId: randomUUID(), byteLength: file.byteLength, sha256: file.sha256 };
  const reads: { offset: number; limit: number }[] = [];
  const receipt = (offset: number, state: "receiving" | "complete" | "failed" = "receiving", error: { code: string; message: string } | null = null) => ({
    ...(purpose === "history" ? { syncId: file.fileId, timelineRevision: state === "complete" ? "7" : null } : { fileId: file.fileId }),
    byteLength: file.byteLength, sha256: file.sha256, acceptedOffset: String(offset), state, error,
  });
  const signal = new AbortController().signal;
  const options = (request: typeof fetch, initial: unknown | null, retryRuntime = runtime, roundSignal = signal) => ({
    purpose, file, ...(purpose === "resource" ? { descriptor } : {}),
    read: (offset: string, limit: number) => {
      reads.push({ offset: Number(offset), limit });
      expect(limit).toBeGreaterThan(0); expect(limit).toBeLessThanOrEqual(block);
      return bytes.subarray(Number(offset), Number(offset) + limit);
    },
    call: createArchiveRequest({ request, url: "https://example.test/archive", serverToken: "fixture", bodyOnly: () => false, signal: roundSignal, deadline, sessionId: randomUUID(), retryRuntime }),
    signal: roundSignal, runtime: retryRuntime, deadline, replacements: {}, initial: initial === null ? null : { raw: initial, corrupt: false },
    reserveReplacement: () => { throw new Error("Valid offsets must preserve the original file identity."); },
    onHistoryRevision: (revision: string) => { expect(revision).toBe("7"); },
  });
  const consume = async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], start: number): Promise<void> => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    expect(url.pathname).toBe(purpose === "history" ? `/archive/prepare/history/${file.fileId}` : `/archive/files/${file.fileId}`);
    expect(url.searchParams.get("offset")).toBe(String(start));
    expect(headers.get("Content-Length")).toBe(String(bytes.length - start));
    expect(headers.get("Daynight-File-Byte-Length")).toBe(file.byteLength);
    expect(headers.get("Daynight-File-SHA256")).toBe(file.sha256);
    expect(headers.get("Daynight-Archive-Upload-Version")).toBe("2");
    expect(headers.get("Daynight-Chunk-SHA256")).toBeNull();
    if (purpose === "resource") {
      expect(url.searchParams.get("purpose")).toBe("resource"); expect(url.searchParams.get("migrationOnly")).toBe("true");
      expect(JSON.parse(headers.get("Daynight-Resource-Descriptor")!)).toEqual(descriptor);
    }
    const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
    let position = start;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        expect(Buffer.from(part.value).equals(bytes.subarray(position, position + part.value.length))).toBe(true);
        expect(part.value.length).toBeLessThanOrEqual(block); position += part.value.length;
      }
    } finally { reader.releaseLock(); }
    expect(position).toBe(bytes.length);
  };
  return { file, reads, receipt, options, consume };
};

test.each(["history", "timeline", "resource"] as const)("resumes %s from an initial arbitrary byte offset and a disconnected PUT status", async purpose => {
  const bytes = source(block * 2 + 19), offset = 123;
  for (const recovered of [false, true]) {
    const f = fixture(purpose, bytes), puts: number[] = [];
    let stored = recovered ? 0 : offset;
    const request: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "GET") return Response.json(f.receipt(stored), { headers: version });
      if (init?.method === "POST") {
        expect(url.pathname.endsWith(`/${f.file.fileId}/complete`)).toBe(true);
        expect(stored).toBe(bytes.length);
        return Response.json(f.receipt(stored, "complete"), { headers: version });
      }
      expect(init?.method).toBe("PUT");
      const start = Number(url.searchParams.get("offset")); puts.push(start);
      await f.consume(input, init, start);
      if (recovered && puts.length === 1) { stored = offset; throw new TypeError("Upload response disconnected."); }
      stored = bytes.length;
      return Response.json(f.receipt(stored), { headers: version });
    };
    expect(await transferArchiveStream(f.options(request, recovered ? null : f.receipt(offset)))).toBe(f.file.fileId);
    expect(puts).toEqual(recovered ? [0, offset] : [offset]);
    expect(f.reads.some(read => read.offset === offset)).toBe(true);
  }
});

test("uses exact boundary and large nonaligned offsets without rounding or replacing identity", async () => {
  const large = source(34 * 1024 * 1024 + 19);
  for (const [bytes, offset] of [[source(19), 0], [large, 33554555], [large, 34078720], [source(19), 18], [source(19), 19]] as const) {
    const f = fixture("timeline", bytes), methods: string[] = [];
    let stored: number = offset;
    const request: typeof fetch = async (input, init) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "PUT") { await f.consume(input, init, offset); stored = bytes.length; return Response.json(f.receipt(stored), { headers: version }); }
      expect(init?.method).toBe("POST"); expect(String(input).endsWith(`/${f.file.fileId}/complete`)).toBe(true);
      return Response.json(f.receipt(stored, "complete"), { headers: version });
    };
    expect(await transferArchiveStream(f.options(request, f.receipt(offset)))).toBe(f.file.fileId);
    expect(methods).toEqual(offset === bytes.length ? ["POST"] : ["PUT", "POST"]);
    expect(f.reads[0]?.offset).toBe(offset === bytes.length ? undefined : offset);
  }
});

test.each([
  ["file identity", { fileId: "00000000-0000-0000-0000-000000000001" }],
  ["length", { byteLength: "1025" }],
  ["digest", { sha256: "0".repeat(64) }],
  ["leading zero", { acceptedOffset: "0123" }],
  ["negative offset", { acceptedOffset: "-1" }],
  ["fractional offset", { acceptedOffset: "1.5" }],
  ["numeric offset", { acceptedOffset: 123 }],
  ["out-of-range offset", { acceptedOffset: "1025" }],
] as const)("rejects an invalid %s before sending or resuming bytes", async (_name, change) => {
  for (const recovered of [false, true]) {
    const f = fixture("timeline", source(1024)), methods: string[] = [];
    const invalid = { ...f.receipt(123), ...change };
    const request: typeof fetch = async (_input, init) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "PUT") throw new TypeError("Upload response disconnected.");
      expect(init?.method).toBe("GET"); return Response.json(invalid, { headers: version });
    };
    await expect(transferArchiveStream(f.options(request, recovered ? null : invalid))).rejects.toThrow();
    expect(methods).toEqual(recovered ? ["PUT", "GET"] : []);
  }
});

test.each(["1", null])("rejects status version %s after an interrupted PUT without sending more bytes", async receivedVersion => {
  const f = fixture("timeline", source(1024)), methods: string[] = [];
  const request: typeof fetch = async (_input, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "PUT") throw new TypeError("Upload response disconnected.");
    return Response.json(f.receipt(123), { headers: receivedVersion === null ? {} : { "Daynight-Archive-Upload-Version": receivedVersion } });
  };
  await expect(transferArchiveStream(f.options(request, null))).rejects.toThrow("upload version");
  expect(methods).toEqual(["PUT", "GET"]);
});

test("preserves a terminal failure at a nonaligned offset without replacing or uploading", async () => {
  const f = fixture("timeline", source(1024)), error = { code: "quota_exceeded", message: "Archive capacity exceeded." };
  const request: typeof fetch = async () => { throw new Error("A terminal receipt must not send a request."); };
  await expect(transferArchiveStream(f.options(request, f.receipt(123, "failed", error)))).rejects.toMatchObject({ name: "ArchiveFileFailedError", code: error.code, serverMessage: error.message });
  expect(f.reads).toEqual([]);
});

test("cancellation during reconciliation prevents a PUT from the recovered nonaligned offset", async () => {
  const f = fixture("timeline", source(1024)), controller = new AbortController(), reason = new Error("Archive cancelled."), methods: string[] = [];
  const retryRuntime = { ...runtime, wait: async (_ms: number, signal: AbortSignal) => { controller.abort(reason); signal.throwIfAborted(); } };
  const request: typeof fetch = async (_input, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "PUT") throw new TypeError("Upload response disconnected.");
    return Response.json(f.receipt(123), { headers: version });
  };
  await expect(transferArchiveStream(f.options(request, null, retryRuntime, controller.signal))).rejects.toBe(reason);
  expect(methods).toEqual(["PUT", "GET"]);
});

test("a nonprogressing nonaligned receipt remains bounded by the reconciliation retry budget", async () => {
  const f = fixture("timeline", source(1024)); let puts = 0, waits = 0;
  const retryRuntime = { ...runtime, wait: async (_ms: number, signal: AbortSignal) => { waits++; signal.throwIfAborted(); } };
  const request: typeof fetch = async (input, init) => {
    expect(init?.method).toBe("PUT"); puts++; await f.consume(input, init, 123);
    return Response.json(f.receipt(123), { headers: version });
  };
  await expect(transferArchiveStream(f.options(request, f.receipt(123), retryRuntime))).rejects.toThrow("retry budget");
  expect(puts).toBe(ARCHIVE_MAX_RETRIES + 1); expect(waits).toBe(ARCHIVE_MAX_RETRIES);
});
