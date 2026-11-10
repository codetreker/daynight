import { createServer, Socket } from "node:net";
import { Transform, type TransformCallback } from "node:stream";

export const COPILOT_NATIVE_FRAME_BYTES = 134_217_728;
export const COPILOT_NATIVE_HEADER_BYTES = 8192;
export const COPILOT_TRANSFER_BYTES = 524_288;
const STALL_MS = 30_000;

/** Validate framing before the SDK allocates a body, preserving the original wire bytes. */
export const createCopilotFrameTransform = (): Transform => {
  const header = Buffer.alloc(COPILOT_NATIVE_HEADER_BYTES);
  let used = 0, remaining = 0, timer: NodeJS.Timeout | undefined;
  const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const progress = () => {
    clear();
    if (used || remaining) {
      timer = setTimeout(() => stream.destroy(new Error("Copilot frame made no progress before its deadline.")), STALL_MS);
      timer.unref();
    }
  };
  const stream = new Transform({
    readableHighWaterMark: COPILOT_TRANSFER_BYTES,
    writableHighWaterMark: COPILOT_TRANSFER_BYTES,
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          if (remaining > 0) {
            const length = Math.min(remaining, chunk.length - offset, COPILOT_TRANSFER_BYTES);
            this.push(chunk.subarray(offset, offset + length));
            offset += length; remaining -= length;
            continue;
          }
          if (used === header.length) throw new Error("Copilot frame header exceeds its limit.");
          const byte = chunk[offset++]!;
          if (byte > 127 || byte === 0) throw new Error("Copilot frame header is not ASCII.");
          header[used++] = byte;
          if (used < 4 || header[used - 4] !== 13 || header[used - 3] !== 10 || header[used - 2] !== 13 || byte !== 10) continue;
          const lines = header.subarray(0, used - 4).toString("ascii").split("\r\n");
          let declared: number | undefined;
          for (const line of lines) {
            const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
            if (!match) throw new Error("Copilot frame header is malformed.");
            if (match[1]!.toLowerCase() !== "content-length") continue;
            if (declared !== undefined || !/^(?:0|[1-9][0-9]*)$/.test(match[2]!)) throw new Error("Copilot frame Content-Length is ambiguous or invalid.");
            declared = Number(match[2]);
            if (!Number.isSafeInteger(declared) || declared > COPILOT_NATIVE_FRAME_BYTES) throw new Error("Copilot native frame exceeds its limit.");
          }
          if (declared === undefined) throw new Error("Copilot frame has no Content-Length.");
          // Copy only the bounded header: its fixed backing storage is reused.
          this.push(Buffer.from(header.subarray(0, used)));
          used = 0; remaining = declared;
        }
        progress(); callback();
      } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
    },
    flush(callback) { clear(); callback(used || remaining ? new Error("Copilot native frame is incomplete.") : undefined); },
    destroy(error, callback) { clear(); callback(error); },
  });
  return stream;
};

/** Exactly one SDK connection is admitted; a broken connection never creates a replacement. */
export const startCopilotFrameProxy = async (nativePort: number, lost: (error: Error) => void) => {
  if (!Number.isSafeInteger(nativePort) || nativePort < 1 || nativePort > 65535) throw new Error("Invalid native Copilot port.");
  let accepted = false, closing = false, failureReported = false;
  const sockets = new Set<Socket>(), completions = new Set<Promise<void>>();
  const fail = (error: Error) => {
    if (closing || failureReported) return;
    failureReported = true;
    for (const socket of sockets) socket.destroy();
    lost(error);
  };
  const own = (socket: Socket) => {
    sockets.add(socket);
    const stopped = new Promise<void>(resolve => socket.once("close", () => { sockets.delete(socket); resolve(); }));
    completions.add(stopped); void stopped.then(() => completions.delete(stopped));
    socket.on("error", () => fail(new Error("Copilot native framing connection failed; operation results are unknown.")));
    socket.once("close", () => { if (!closing) fail(new Error("Copilot native framing connection closed; operation results are unknown.")); });
    return socket;
  };
  const server = createServer({ highWaterMark: COPILOT_TRANSFER_BYTES }, incoming => {
    if (accepted || closing) { incoming.destroy(); return; }
    accepted = true;
    const socketOptions = { allowHalfOpen: false, highWaterMark: COPILOT_TRANSFER_BYTES };
    const client = own(incoming), native = own(new Socket(socketOptions).connect(nativePort, "127.0.0.1"));
    const requests = createCopilotFrameTransform(), responses = createCopilotFrameTransform();
    for (const framing of [requests, responses]) framing.once("error", fail);
    client.pipe(requests).pipe(native); native.pipe(responses).pipe(client);
    client.once("close", () => { requests.destroy(); responses.destroy(); native.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.on("error", fail);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Copilot frame proxy has no listener.");
  let completion: Promise<void> | undefined;
  return {
    port: address.port,
    close: () => completion ??= (async () => {
      closing = true;
      const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await Promise.all([...completions, stopped]);
    })(),
  };
};
