import { spawn, type Serializable } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

type NativeFailure = { name: string; message: string; stage?: string; code?: number };
export type DirectoryHandleTrace = {
  startedAt: string;
  finishedAt: string;
  target: string;
  matchingHandles: { pid: number; handle: string; path: string }[];
  examined: number | null;
  snapshotHandles: number | null;
  processErrors: Record<string, number> | null;
  duplicateErrors: Record<string, number> | null;
  typeErrors: Record<string, number> | null;
  nameErrors: Record<string, number> | null;
  scanComplete: boolean;
  failure?: NativeFailure;
};
type Message = { kind: "ready"; pid: number } | { kind: "released" } | { kind: "snapshot"; startedAt: string; target: string; snapshotHandles: number } | { kind: "candidate"; value: DirectoryHandleTrace["matchingHandles"][number] } | { kind: "result"; value: DirectoryHandleTrace } | { kind: "failure"; error: NativeFailure };
const executable = path.join(import.meta.dirname, "fixtures/windows-directory-handles.mjs");
const deadlineMs = 10_000;
const bounded = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
};

const startProbe = async (mode: "trace" | "hold", target?: string) => {
  const child = spawn(process.execPath, [executable, mode, ...(target === undefined ? [] : [target])], {
    cwd: path.resolve(import.meta.dirname, "../../../../.."), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  let closed = false, stderr = "";
  child.stdout!.resume();
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
  const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => {
    closed = true; resolve({ code, signal });
  }));
  const stop = async (): Promise<void> => {
    if (!closed) child.kill();
    await bounded(finished, 5000, "Windows directory evidence child did not close after termination.");
  };
  const receive = async (): Promise<Message> => {
    const abort = AbortSignal.timeout(deadlineMs);
    const message = once(child, "message", { signal: abort }).then(([value]) => value as Message);
    const earlyClose = finished.then(({ code, signal }) => { throw new Error(`Windows directory evidence child exited before its receipt (exit=${code}, signal=${signal}): ${stderr}`); });
    return await Promise.race([message, earlyClose]);
  };
  const send = async (message: Serializable): Promise<void> => {
    await new Promise<void>((resolve, reject) => child.send(message, error => error ? reject(error) : resolve()));
  };
  try {
    const ready = await receive();
    if (ready.kind !== "ready" || ready.pid !== child.pid) throw new Error("Windows directory evidence child did not establish its identity.");
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Directory evidence startup and cleanup failed.", { cause: error }); }
    throw error;
  }
  return { child, finished, stop, send, receive, isClosed: () => closed, stderr: () => stderr, join: async () => await bounded(finished, 5000, "Windows directory evidence child did not close after its receipt.") };
};

const complete = async (probe: Awaited<ReturnType<typeof startProbe>>): Promise<void> => {
  const result = await probe.join();
  if (result.code !== 0 || result.signal !== null) throw new Error(`Windows directory evidence child failed (exit=${result.code}, signal=${result.signal}): ${probe.stderr()}`);
};
const preserve = async <T>(probe: Awaited<ReturnType<typeof startProbe>>, action: () => Promise<T>): Promise<T> => {
  try { return await action(); }
  catch (error) {
    try { await probe.stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Directory evidence and child cleanup failed.", { cause: error }); }
    throw error;
  }
};

export const startWindowsDirectoryTrace = async () => {
  if (process.platform !== "win32") throw new Error("Windows directory tracing requires Windows.");
  const probe = await startProbe("trace");
  let consumed = false;
  return {
    trace: async (target: string, preferredPids: readonly number[] = []): Promise<DirectoryHandleTrace> => {
      if (consumed) throw new Error("A Windows directory trace can be requested only once.");
      consumed = true;
      const partial: DirectoryHandleTrace = { startedAt: new Date().toISOString(), finishedAt: "", target,
        matchingHandles: [], examined: null, snapshotHandles: null, processErrors: null, duplicateErrors: null, typeErrors: null, nameErrors: null, scanComplete: false };
      let resolveResult!: (value: DirectoryHandleTrace) => void, rejectResult!: (error: Error) => void;
      const result = new Promise<DirectoryHandleTrace>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      const receipt = (message: Message): void => {
        if (message.kind === "snapshot") Object.assign(partial, { startedAt: message.startedAt, target: message.target, snapshotHandles: message.snapshotHandles });
        else if (message.kind === "candidate") partial.matchingHandles.push(message.value);
        else if (message.kind === "result") resolveResult(message.value);
        else if (message.kind === "failure") rejectResult(Object.assign(new Error(message.error.message), message.error));
        else rejectResult(new Error("Windows directory tracing returned an unexpected receipt."));
      };
      probe.child.on("message", receipt);
      try {
        const finishedEarly = probe.finished.then(({ code, signal }) => { throw new Error(`Windows directory evidence child exited before its result (exit=${code}, signal=${signal}): ${probe.stderr()}`); });
        await probe.send({ kind: "trace", target, preferredPids: [...preferredPids] });
        const evidence = await bounded(Promise.race([result, finishedEarly]), deadlineMs, "Windows directory handle tracing exceeded its deadline.");
        await complete(probe);
        return evidence;
      } catch (error) {
        await probe.stop();
        const failure = error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
        return { ...partial, finishedAt: new Date().toISOString(), failure };
      } finally { probe.child.off("message", receipt); }
    },
    close: async (): Promise<void> => {
      if (probe.isClosed()) { if (!consumed) await complete(probe); return; }
      await preserve(probe, async () => { await probe.send({ kind: "close" }); await complete(probe); });
    },
  };
};

export const startWindowsDirectoryHolder = async (target: string) => {
  if (process.platform !== "win32") throw new Error("Windows directory holding requires Windows.");
  const probe = await startProbe("hold", target);
  return {
    pid: probe.child.pid!,
    release: async (): Promise<void> => await preserve(probe, async () => {
      const response = probe.receive();
      await probe.send("release");
      const message = await response;
      if (message.kind !== "released") throw new Error("Windows directory holder did not confirm handle release.");
      await complete(probe);
    }),
    stop: probe.stop,
  };
};
