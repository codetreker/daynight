import { parseSessionArchiveFileReceipt, type SessionArchiveFileReceipt } from "../../session/archive.js";
import { ArchiveProtocolError, ArchiveRequestError } from "./archive-error.js";
import { ARCHIVE_MAX_RETRIES, archiveRetryDelay, type ArchiveRetryRuntime } from "./archive-retry.js";
import { type createArchiveRequest } from "./archive-request.js";

const VERSION = "Daynight-Archive-Upload-Version";
const BLOCK = 524288;
type Receipt = SessionArchiveFileReceipt;
type Call = ReturnType<typeof createArchiveRequest>;
class InvalidArchiveResponse extends Error {}
const reconcileable = (error: unknown): boolean => !(error instanceof InvalidArchiveResponse || error instanceof ArchiveProtocolError) && (!(error instanceof ArchiveRequestError) || error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500);

/** A pull stream holds at most one bounded source block, including on retries. */
const remaining = (length: number, start: number, read: (offset: string, limit: number) => Uint8Array): ReadableStream<Uint8Array> => {
  let position = start;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position === length) { controller.close(); return; }
      const block = read(String(position), Math.min(BLOCK, length - position));
      if (block.length === 0 || block.length > length - position || block.length > BLOCK) throw new Error("Frozen archive source returned an invalid block.");
      position += block.length;
      controller.enqueue(block);
    },
  }, { highWaterMark: 1 });
};

export const transferArchiveStream = async (options: {
  purpose: "history" | "timeline" | "resource";
  file: { fileId: string; byteLength: string; sha256: string };
  descriptor?: unknown;
  read(offset: string, limit: number): Uint8Array;
  call: Call;
  signal: AbortSignal;
  runtime: ArchiveRetryRuntime;
  deadline: number;
  replacements: Record<string, string>;
  initial: { raw: unknown; corrupt: boolean } | null;
  reserveReplacement(fileId: string): string;
  onHistoryRevision(revision: string): void;
}): Promise<string> => {
  const { purpose, file, call, signal } = options;
  const base = (id: string) => purpose === "history" ? `/prepare/history/${id}` : `/files/${id}`;
  const parse = (raw: unknown): Receipt => {
    if (purpose !== "history") return parseSessionArchiveFileReceipt(raw);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid archive history receipt.");
    const { syncId, timelineRevision, ...rest } = raw as Record<string, unknown>;
    if (Object.keys(raw).length !== (Object.hasOwn(raw, "successorFileId") ? 8 : 7) || rest.state === "complete" && (typeof timelineRevision !== "string" || !/^[1-9][0-9]*$/.test(timelineRevision)) || rest.state !== "complete" && timelineRevision !== null) throw new Error("Invalid archive history checkpoint.");
    if (rest.state === "complete") options.onHistoryRevision(timelineRevision as string);
    return parseSessionArchiveFileReceipt({ fileId: syncId, ...rest });
  };
  const check = (receipt: Receipt, id: string): Receipt => {
    if (receipt.fileId !== id || receipt.byteLength !== file.byteLength || receipt.sha256 !== file.sha256 || receipt.state === "receiving" && receipt.acceptedOffset !== file.byteLength && BigInt(receipt.acceptedOffset) % BigInt(BLOCK) !== 0n) throw new Error("Archive file differs from its original intent.");
    return receipt;
  };
  const versioned = async (method: string, suffix: string, replayable: boolean, body?: string | Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}, streaming = false): Promise<unknown> => {
    let version: string | null = null, successfulResponse = false;
    let result: unknown;
    try { result = await call(method, suffix, replayable, body, headers, undefined, { streaming, onResponse: response => { version = response.headers.get(VERSION); successfulResponse = response.ok; } }); }
    catch (error) { if (successfulResponse && version !== "2") throw new InvalidArchiveResponse("Archive file upload version differs from its original intent.", { cause: error }); if (successfulResponse && error instanceof SyntaxError) throw new InvalidArchiveResponse("Invalid successful archive response.", { cause: error }); throw error; }
    if (version !== "2") throw new InvalidArchiveResponse("Archive file upload version differs from its original intent.");
    return result;
  };
  const status = async (id: string): Promise<{ receipt: Receipt | null; corrupt: boolean }> => {
    try { return { receipt: check(parse(await versioned("GET", `${base(id)}/status`, true)), id), corrupt: false }; }
    catch (error) {
      if (error instanceof ArchiveRequestError && error.status === 404) return { receipt: null, corrupt: false };
      if (error instanceof ArchiveRequestError && error.status === 409 && error.code === "staging_corrupt" && error.uploadVersion === "2" && error.payload && typeof error.payload === "object" && "file" in error.payload) {
        const receipt = check(parse(error.payload.file), id);
        if (receipt.state !== "receiving") throw new Error("Invalid archive staging observation.");
        return { receipt, corrupt: true };
      }
      throw error;
    }
  };
  let id = file.fileId, retries = 0;
  const seen = new Set<string>();
  const wait = async (): Promise<void> => {
    if (++retries > ARCHIVE_MAX_RETRIES) throw new Error("Archive stream reconciliation exhausted its retry budget.");
    const now = options.runtime.now();
    const delay = archiveRetryDelay({ retry: retries, retryAfter: null, now, random: () => options.runtime.random(), remainingMs: options.deadline - now });
    if (delay === null) throw new Error("Archive stream reconciliation exceeded its deadline.");
    await options.runtime.wait(delay, signal);
  };
  while (true) {
    signal.throwIfAborted();
    if (seen.has(id)) throw new Error("Archive replacement chain contains a cycle.");
    seen.add(id);
    let current = id === file.fileId && options.initial ? { receipt: check(parse(options.initial.raw), id), corrupt: options.initial.corrupt } : id === file.fileId ? { receipt: null, corrupt: false } : await status(id);
    if (current.corrupt && current.receipt?.state !== "receiving") throw new Error("Invalid archive staging observation.");
    for (;;) {
      signal.throwIfAborted();
      const receipt = current.receipt;
      if (receipt?.state === "complete") return id;
      if (receipt?.state === "failed") {
        if (receipt.error?.code !== "staging_corrupt") throw new Error("Archive file failed before completion.");
        if (receipt.successorFileId && !options.replacements[id]) throw new Error("Archive successor has no original local intent.");
        const replacement = options.replacements[id] ?? options.reserveReplacement(id);
        if (receipt.successorFileId && receipt.successorFileId !== replacement) throw new Error("Archive successor differs from its original intent.");
        if (!receipt.successorFileId) {
          let restarted: unknown;
          try { restarted = await versioned("POST", `${base(id)}/restart`, false, JSON.stringify({ replacementFileId: replacement }), { [VERSION]: "2" }); }
          catch (error) { if (signal.aborted || !reconcileable(error)) throw error; }
          if (restarted !== undefined) { const result = check(parse(restarted), id); if (result.state !== "failed" || result.error?.code !== "staging_corrupt" || result.successorFileId !== replacement) throw new Error("Archive restart receipt differs from its original intent."); }
        }
        const old = await status(id), next = await status(replacement);
        if (old.corrupt || old.receipt?.state !== "failed" || old.receipt.error?.code !== "staging_corrupt") throw new Error("Original archive failure receipt could not be confirmed.");
        if (old.receipt.successorFileId && old.receipt.successorFileId !== replacement) throw new Error("Archive successor differs from its original intent.");
        if (old.receipt.successorFileId !== replacement || !next.receipt) { await wait(); current = old; continue; }
        id = replacement; retries = 0; break;
      }
      if (current.corrupt || receipt && receipt.acceptedOffset === file.byteLength) {
        let response: unknown;
        try { response = await versioned("POST", `${base(id)}/complete`, false, undefined, { [VERSION]: "2" }); }
        catch (error) { if (signal.aborted || !reconcileable(error)) throw error; current = await status(id); if (!current.receipt) throw error; await wait(); continue; }
        const completed = check(parse(response), id); current = { receipt: completed, corrupt: false }; if (completed.state === "receiving" && completed.acceptedOffset === file.byteLength) await wait();
        continue;
      }
      const offset = receipt?.acceptedOffset ?? "0", start = Number(offset), length = Number(file.byteLength);
      const body = length === start ? new Uint8Array() : remaining(length, start, options.read);
      const headers = { [VERSION]: "2", "Daynight-File-Byte-Length": file.byteLength, "Daynight-File-SHA256": file.sha256, "Content-Length": String(length - start), ...(options.descriptor === undefined ? {} : { "Daynight-Resource-Descriptor": JSON.stringify(options.descriptor) }) };
      let response: unknown;
      try { response = await versioned("PUT", `${base(id)}?offset=${offset}${purpose === "resource" ? "&purpose=resource&migrationOnly=true" : ""}`, false, body, headers, true); }
      catch (error) {
        if (signal.aborted || !reconcileable(error)) throw error;
        current = await status(id);
        await wait();
        continue;
      }
      const received = check(parse(response), id);
      current = { receipt: received, corrupt: false };
      if (received.state === "receiving" && received.acceptedOffset === offset && offset !== file.byteLength) await wait();
    }
  }
};
