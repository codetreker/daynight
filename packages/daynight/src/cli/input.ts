import type { Readable } from "node:stream";
import { CliCancelledError } from "./cancellation.js";

export const readSecretStdin = async (signal: AbortSignal, input: Readable & { isTTY?: boolean } = process.stdin): Promise<string> => {
  signal.throwIfAborted();
  if (input.isTTY === true) throw new Error("--server-token-stdin requires piped input; run daynight login for interactive authentication.");
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = (): void => {
      input.pause();
      input.off("data", data);
      input.off("end", end);
      input.off("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const fail = (cause: unknown): void => { cleanup(); reject(cause); };
    const data = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.byteLength;
      if (bytes > 1_048_576) { fail(new Error("serverToken stdin input exceeds its 1 MiB limit.")); return; }
      chunks.push(buffer);
    };
    const end = (): void => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    const abort = (): void => fail(new CliCancelledError("Setup cancelled."));
    input.on("data", data);
    input.once("end", end);
    input.once("error", fail);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else if (input.readableEnded) end();
    else input.resume();
  });
};
