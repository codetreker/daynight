import { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { createSuspendedProcess } from "../../platform/windows-suspended-process.js";

export type GatedNodeChild = EventEmitter & {
  readonly pid: number | undefined;
  readonly connected: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  send(message: object, callback?: (error: Error | null) => void): void;
  kill(signal: NodeJS.Signals): boolean;
};

// The trusted bootstrap restores Node's message channel over a private pipe;
// no user Node preloads run before the process has joined its owned Job.
const bridge = String.raw`
const net = require('node:net');
const channel = net.connect(process.env.DAYNIGHT_CHILD_PIPE);
channel.setEncoding('utf8');
const secret = process.env.DAYNIGHT_CHILD_SECRET;
delete process.env.DAYNIGHT_CHILD_PIPE; delete process.env.DAYNIGHT_CHILD_SECRET;
let pending = '';
Object.defineProperty(process, 'connected', {value:true, configurable:true, writable:true});
process.send = (message, callback) => channel.write(JSON.stringify(message)+'\n', callback);
for (const stream of ['stdout', 'stderr']) Object.defineProperty(process, stream, {configurable:true, value:new (require('node:stream').Writable)({
  write(data, encoding, done) {
    if (data.length===0) { done(); return; }
    for (let offset=0; offset<data.length; offset+=65536) process.send({kind:'launcher-output',stream,data:data.subarray(offset,offset+65536).toString('base64')}, offset+65536>=data.length ? done : undefined);
  }
})});
channel.write(JSON.stringify({secret})+'\n');
channel.on('data', chunk => {
  pending += chunk;
  if (Buffer.byteLength(pending)>33554432) { channel.destroy(); return; }
  let end;
  while ((end=pending.indexOf('\n'))>=0) {
    const line=pending.slice(0,end); pending=pending.slice(end+1);
    try { process.emit('message',JSON.parse(line)); } catch { channel.destroy(); return; }
  }
});
channel.on('error', () => {});
channel.on('close', () => { process.connected=false; process.emit('disconnect'); });
`;

/** A suspended Windows Node guardian; resume is owned by the caller's durable boundary handshake. */
export const createSuspendedNodeChild = async (options: {
  source: string; args: readonly string[]; environment: NodeJS.ProcessEnv; cwd?: string;
}): Promise<{ child: GatedNodeChild; resume(): void; closeHandles(): void }> => {
  const endpoint = `\\\\.\\pipe\\daynight-launch-${randomUUID()}`, secret = randomBytes(32).toString("hex");
  const child = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough();
  let socket: Socket | undefined, authenticated = false, closed = false, exited = false, channelClosed = false, finishing = false, framesPending = false;
  const finish = () => {
    if (!exited || socket !== undefined && !channelClosed || finishing || framesPending) return;
    finishing = true; server.close(); stdout.end(); stderr.end();
    void Promise.all([finished(stdout, { writable: false }), finished(stderr, { writable: false })]).then(() => {
      closed = true; child.emit("close");
    }, error => child.emit("error", error));
  };
  const server = createServer(connection => {
    if (socket !== undefined) { connection.destroy(); return; }
    socket = connection;
    connection.setEncoding("utf8");
    let pending = "", backpressured = false;
    const rejectFrame = (message: string) => {
      pending = ""; framesPending = backpressured;
      connection.destroy(); child.emit("error", new Error(message));
    };
    const parse = () => {
      if (backpressured) return;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let message: unknown;
        try { message = JSON.parse(line); } catch { rejectFrame("Windows guardian sent an invalid JSON frame."); return; }
        if (!authenticated) {
          if (typeof message !== "object" || message === null || !("secret" in message) || message.secret !== secret) { rejectFrame("Windows guardian channel authentication failed."); return; }
          authenticated = true; server.close();
        } else if (typeof message === "object" && message !== null && "kind" in message && message.kind === "launcher-output") {
          const output = message as { stream?: unknown; data?: unknown };
          if ((output.stream !== "stdout" && output.stream !== "stderr") || typeof output.data !== "string") { rejectFrame("Windows guardian sent an invalid output frame."); return; }
          const stream = output.stream === "stdout" ? stdout : stderr;
          if (!stream.write(Buffer.from(output.data, "base64"))) {
            framesPending = true;
            backpressured = true; connection.pause();
            stream.once("drain", () => { backpressured = false; parse(); if (!backpressured) connection.resume(); finish(); });
            return;
          }
        } else child.emit("message", message);
      }
      framesPending = pending.length > 0;
      // EOF cannot supply the missing bytes. Complete frames and their writers
      // drain first; only the unusable tail is discarded, with capture failure.
      if (channelClosed && framesPending) rejectFrame("Windows guardian channel ended with an incomplete frame.");
    };
    connection.on("data", chunk => {
      pending += String(chunk); framesPending = pending.length > 0;
      if (Buffer.byteLength(pending) > 1_048_576) { rejectFrame("Windows guardian frame exceeded its limit."); return; }
      parse();
    });
    connection.on("error", error => child.emit("error", error));
    connection.on("close", () => { channelClosed = true; child.emit("disconnect"); parse(); finish(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, () => { server.off("error", reject); resolve(); }); });
  let native: Awaited<ReturnType<typeof createSuspendedProcess>>;
  try {
    native = await createSuspendedProcess({ file: process.execPath, args: ["-e", `${bridge}\n${options.source}`, ...options.args],
      environment: { ...options.environment, DAYNIGHT_CHILD_PIPE: endpoint, DAYNIGHT_CHILD_SECRET: secret }, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
  } catch (error) { server.close(); throw error; }
  const poll = setInterval(() => {
    try {
      if (!native.hasExited()) return;
      exited = true; clearInterval(poll); finish();
    } catch (error) { child.emit("error", error); }
  }, 10);
  Object.defineProperties(child, {
    pid: { get: () => native.pid }, connected: { get: () => authenticated && !closed && socket?.destroyed === false },
    exitCode: { get: () => closed ? 0 : null }, signalCode: { value: null },
  });
  return {
    child: Object.assign(child, {
      stdout, stderr,
      send: (message: object, callback: (error: Error | null) => void = error => { if (error !== null) child.emit("error", error); }): void => {
        if (!authenticated || closed || socket === undefined || socket.destroyed) { callback(new Error("The original Windows guardian channel is unavailable.")); return; }
        socket.write(`${JSON.stringify(message)}\n`, error => callback(error ?? null));
      },
      kill: (_signal: NodeJS.Signals): boolean => { native.terminate(); return true; },
    }) as GatedNodeChild,
    resume: () => native.resume(),
    closeHandles: () => {
      if (!native.hasExited()) throw new Error("The original Windows guardian is still active; handles remain owned.");
      closed = true; clearInterval(poll); socket?.destroy(); server.close(); native.close();
    },
  };
};
