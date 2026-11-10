import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { UsageError } from "../../../cli/context.js";
import { isNonemptyText } from "../../../platform/text.js";

export const SESSION_TEXT_BYTES = 1_048_576;
const help = "daynight task session send --help";
const invalid = (): UsageError => new UsageError("Message input must be nonempty, well-formed UTF-8 text without NUL, at most 1048576 bytes.", help);
export const validateSessionText = (text: string): string => {
  if (!isNonemptyText(text) || Buffer.byteLength(text, "utf8") > SESSION_TEXT_BYTES) throw invalid();
  return text;
};
export const decodeSessionText = (bytes: Uint8Array): string => {
  if (bytes.byteLength > SESSION_TEXT_BYTES) throw invalid();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw invalid(); }
  return validateSessionText(text);
};
export const readSessionText = async (input: { readonly text?: string; readonly file?: string; readonly stdin?: boolean }, signal: AbortSignal, stream: Readable = process.stdin): Promise<string> => {
  if ([input.text !== undefined, input.file !== undefined, input.stdin === true].filter(Boolean).length !== 1) throw new UsageError("Select exactly one of --text, --file or --stdin.", help);
  signal.throwIfAborted();
  if (input.text !== undefined) return validateSessionText(input.text);
  if (input.file !== undefined) {
    const entity = await lstat(input.file);
    signal.throwIfAborted();
    if (!entity.isFile()) throw invalid();
    // Recheck the opened entity; nonblocking open also protects a raced-in FIFO.
    const file = await open(input.file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > SESSION_TEXT_BYTES) throw invalid();
      const buffer = Buffer.allocUnsafe(SESSION_TEXT_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(buffer, size, Math.min(65_536, buffer.length - size), null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      signal.throwIfAborted();
      return decodeSessionText(buffer.subarray(0, size));
    } finally { await file.close(); }
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, finished = false;
    const done = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      stream.pause(); stream.off("data", onData); stream.off("end", onEnd); stream.off("error", onError); signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else { try { resolve(decodeSessionText(Buffer.concat(chunks, size))); } catch (cause) { reject(cause); } }
    };
    const onData = (chunk: Buffer | string): void => { const data = Buffer.from(chunk); size += data.length; if (size > SESSION_TEXT_BYTES) done(invalid()); else chunks.push(data); };
    const onEnd = (): void => done();
    const onError = (): void => done(new Error("Could not read message input."));
    const onAbort = (): void => done(signal.reason);
    stream.on("data", onData); stream.once("end", onEnd); stream.once("error", onError); signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort(); else if (stream.readableEnded) done(); else stream.resume();
  });
};
