import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { createWindowsCommandJob, WindowsCommandCleanupError, WindowsCommandJobSetupError } from "./windows-command-job.js";
import type { WindowsNativeCommandOwnership } from "./windows-command-job.js";
import { loadWindowsJobKernel } from "./windows-job.js";
import type { WindowsCommandJobKernel } from "./windows-job.js";
import { loadWindowsNativeProcessKernel } from "./windows-native-process.js";
import type { WindowsNativeCreatedProcess, WindowsNativeProcessKernel } from "./windows-native-process.js";
import { prepareWindowsNativeCommand, windowsNativeSpawnError } from "./windows-native-command-data.js";
import type { WindowsNativeCommandOptions, WindowsOwnedCommand, WindowsOwnedCommandDependencies, WindowsTargetReceipt } from "./windows-owned-command.js";

const pause = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const errorsOf = (error: unknown): unknown[] => error instanceof WindowsCommandCleanupError ? [...error.errors] : [error];
let nativeKernel: Promise<WindowsNativeProcessKernel> | undefined, jobKernel: Promise<WindowsCommandJobKernel> | undefined;

type OutputPipe = {
  prepare(): Promise<void>;
  takeWriter(): unknown;
  closeWriter(): readonly unknown[];
  stopListening(): void;
  drainOutput(): void;
  readonly natural: boolean;
  readonly closed: boolean;
  missingEof(): Error | undefined;
  destroy(): void;
};

const createOutputPipe = (
  api: WindowsNativeProcessKernel,
  output: PassThrough,
  tag: number,
  deadline: number,
  signal: AbortSignal,
  changed: () => void,
  failed: (error: unknown) => void,
  transportFailed: (error: unknown) => void,
  name: string,
  serverFactory: (listener: (socket: Socket) => void) => Server,
): OutputPipe => {
  const frame = Buffer.concat([Buffer.from("DNPIPE1"), randomBytes(32), Buffer.from([tag])]);
  let socket: Socket | undefined, writer: unknown, writerOwned = false, listenerStarted = false, listenerStopped = false;
  let serverClosed = false, socketClosed = false, ended = false, pairing = true, pairedSocket = false, assisting = false;
  let eofError: Error | undefined;
  const missingEof = (): Error | undefined => pairedSocket && !ended ? eofError ??= new Error("Windows command pipe closed without a natural EOF.") : undefined;
  let pairResolve!: () => void, pairReject!: (error: unknown) => void;
  const paired = new Promise<void>((resolve, reject) => { pairResolve = resolve; pairReject = reject; });
  void paired.catch(() => {});
  const fail = (error: unknown): void => { if (pairing) pairReject(error); else failed(error); };
  const server: Server = serverFactory(connection => {
    if (socket !== undefined || listenerStopped) { connection.destroy(); fail(new Error("Windows command pipe accepted an unexpected connection.")); return; }
    socket = connection;
    let received = Buffer.alloc(0);
    const handshake = (chunk: Buffer): void => {
      const take = Math.min(frame.length - received.length, chunk.length);
      received = Buffer.concat([received, chunk.subarray(0, take)]);
      if (received.length < frame.length) return;
      if (!received.equals(frame)) { fail(new Error("Windows command pipe pairing frame is invalid.")); connection.destroy(); return; }
      connection.pause(); connection.removeListener("data", handshake);
      if (take < chunk.length) connection.unshift(chunk.subarray(take));
      pairedSocket = true; connection.pipe(output); pairResolve();
    };
    connection.on("data", handshake);
    connection.on("error", error => { transportFailed(error); fail(error); });
    connection.once("end", () => { ended = true; changed(); });
    connection.once("close", () => {
      socketClosed = true;
      if (!assisting) {
        const error = missingEof();
        if (error !== undefined) { transportFailed(error); fail(error); }
        else if (!ended) fail(new Error("Windows command pipe closed before admission pairing completed."));
      }
      changed();
    });
  });
  server.on("error", error => { if (!server.listening) serverClosed = true; transportFailed(error); fail(error); changed(); });
  server.once("close", () => { serverClosed = true; changed(); });
  server.once("listening", () => { if (listenerStopped) server.close(); });
  const stopListening = (): void => {
    if (listenerStopped) return;
    listenerStopped = true;
    if (!listenerStarted) { serverClosed = true; return; }
    if (server.listening) server.close();
    if (server.listening) throw new Error("Windows command pipe listener did not stop accepting connections.");
  };
  return {
    prepare: async () => {
      const abort = (): void => { pairReject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => pairReject(new Error("Windows command pipe pairing exceeded the command deadline.")), Math.max(0, deadline - performance.now()));
      try {
        signal.throwIfAborted(); listenerStarted = true;
        await Promise.race([new Promise<void>((resolve, reject) => {
          const error = (value: Error): void => { reject(value); };
          server.once("error", error);
          server.listen(name, () => { server.removeListener("error", error); resolve(); });
        }), paired]);
        signal.throwIfAborted();
        writer = api.openPipeClient(name); writerOwned = true;
        if (api.serverPid(writer) !== process.pid) throw new Error("Windows command pipe server is not owned by this CLI.");
        api.write(writer, frame);
        await paired; signal.throwIfAborted(); pairing = false;
      } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
    },
    takeWriter: () => { if (!writerOwned) throw new Error("Windows command pipe writer was already transferred."); writerOwned = false; return writer; },
    closeWriter: () => {
      if (!writerOwned) return [];
      writerOwned = false;
      try { api.close(writer); return []; } catch (error) { return [error]; }
    },
    stopListening,
    drainOutput: () => {
      // Abnormal completion must release backpressure so real EOF and pending native I/O can finish.
      // https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/lib/internal/child_process.js#L347-L361
      if (output.destroyed) { socket?.unpipe(output); socket?.resume(); }
      else output.resume();
    },
    get natural() { return ended; }, get closed() { return serverClosed && (socket === undefined || socketClosed); }, missingEof,
    destroy: () => { assisting = true; stopListening(); socket?.destroy(); output.destroy(); },
  };
};

export type WindowsNativeCommandDependencies = WindowsOwnedCommandDependencies & {
  pipeName?: () => string;
  createServer?: (listener: (socket: Socket) => void) => Server;
};

export const spawnWindowsNativeCommand = (options: WindowsNativeCommandOptions, dependencies: WindowsNativeCommandDependencies = {}): WindowsOwnedCommand => {
  const stdout = new PassThrough(), stderr = new PassThrough(), startupAbort = new AbortController();
  let api: WindowsNativeProcessKernel | undefined, jobs: WindowsCommandJobKernel | undefined, scope: WindowsNativeCommandOwnership | undefined;
  let target: WindowsNativeCreatedProcess | undefined, threadOwned = false, processOwned = false;
  let result: WindowsTargetReceipt | undefined, rootCode: number | undefined, rootExited = false;
  let pipes: OutputPipe[] = [], stopped = false, released = false, assisted = false, naturalClosed = false, terminal = false;
  let lifecycleError: unknown, observing: ReturnType<typeof setTimeout> | undefined;
  const cleanupJournal: unknown[] = [];
  const retainCleanup = (errors: readonly unknown[]): void => { for (const error of errors) for (const original of errorsOf(error)) if (!cleanupJournal.includes(original)) cleanupJournal.push(original); };
  const mergeCleanup = (failures: unknown[]): void => { for (const error of cleanupJournal) if (!failures.includes(error)) failures.push(error); };
  let starting: Promise<void> | undefined, stopping: Promise<void> | undefined, releasing: Promise<void> | undefined;
  let resolveClosed!: () => void, rejectClosed!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void completion.catch(() => {});
  const fail = (error: unknown): void => { lifecycleError ??= error; rejectClosed(error); };
  const observationFailed = (error: unknown): void => { retainCleanup([error]); fail(new WindowsCommandCleanupError(cleanupJournal)); };
  const finish = (): void => {
    if (terminal || target !== undefined && !rootExited || pipes.some(pipe => !pipe.closed)) return;
    if (!stopped && lifecycleError === undefined && !assisted && pipes.every(pipe => pipe.natural) && stdout.readableEnded && stderr.readableEnded) {
      if (target !== undefined) result = { kind: "exit", code: rootCode!, signal: null, failure: null };
      naturalClosed = true; resolveClosed();
    } else if (stopped) resolveClosed();
  };
  stdout.once("end", finish); stderr.once("end", finish);
  stdout.on("error", fail); stderr.on("error", fail);
  const checkAdmission = (): void => {
    if (stopped || terminal || lifecycleError !== undefined || performance.now() >= options.deadline) throw new Error("Windows native command admission is no longer available.");
  };
  const closeOriginal = (failures: unknown[]): void => {
    if (target === undefined || api === undefined) return;
    if (threadOwned) { threadOwned = false; try { api.close(target.thread); } catch (error) { failures.push(error); } }
    if (processOwned) { processOwned = false; try { api.close(target.process); } catch (error) { failures.push(error); } }
  };
  const observeRoot = (): void => {
    if (target === undefined || api === undefined || terminal || rootExited) return;
    try {
      if (api.signaled(target.process)) { rootExited = true; rootCode = api.exitCode(target.process); finish(); }
      else observing = setTimeout(observeRoot, 10);
    } catch (error) { observationFailed(error); }
  };
  const join = async (failures: unknown[], deadline: number): Promise<void> => {
    while (true) {
      try { if (target !== undefined && !rootExited && api!.signaled(target.process)) { rootExited = true; rootCode = api!.exitCode(target.process); } }
      catch (error) { failures.push(error); break; }
      if ((target === undefined || rootExited) && pipes.every(pipe => pipe.closed)) {
        for (const pipe of pipes) { const error = pipe.missingEof(); if (error !== undefined) retainCleanup([error]); }
        break;
      }
      if (performance.now() >= deadline) { failures.push(new Error("Windows native command process and inherited pipes did not close within the termination grace period.")); break; }
      await pause(10);
    }
  };
  const finalizeStop = async (failures: unknown[], deadline: number): Promise<void> => {
    mergeCleanup(failures);
    try { await scope?.stopUntil(deadline); } catch (error) { failures.push(...errorsOf(error)); }
    mergeCleanup(failures);
    if (failures.length) failures.push(...scope?.requestFailureClose() ?? []);
    await join(failures, performance.now() + options.pipeCloseMs);
    mergeCleanup(failures);
    if (failures.length) {
      assisted = true;
      for (const pipe of pipes) { try { pipe.destroy(); } catch (error) { failures.push(error); } }
      stdout.destroy(); stderr.destroy();
      failures.push(...scope?.closeObservations() ?? []);
    }
    closeOriginal(failures); mergeCleanup(failures);
    failures.splice(0, failures.length, ...new Set(failures)); terminal = true; clearTimeout(observing);
    if (failures.length) rejectClosed(new WindowsCommandCleanupError(failures)); else resolveClosed();
  };
  const command: WindowsOwnedCommand = {
    stdin: null, stdout, stderr, get result() { return result; }, closed: completion,
    start: () => {
      starting ??= (async () => {
        checkAdmission();
        [api, jobs] = await Promise.all([dependencies.loadNative === undefined ? nativeKernel ??= loadWindowsNativeProcessKernel() : dependencies.loadNative(),
          dependencies.loadKernel === undefined ? jobKernel ??= loadWindowsJobKernel() : dependencies.loadKernel()]);
        checkAdmission();
        let data: ReturnType<typeof prepareWindowsNativeCommand>;
        try { data = prepareWindowsNativeCommand(options, api); }
        catch (error) {
          const failure = windowsNativeSpawnError(error, options.file, options.args);
          if (failure === undefined) throw error;
          result = { kind: "not-started", error: failure }; stdout.end(); stderr.end(); finish(); return;
        }
        try { scope = createWindowsCommandJob(jobs, { anonymous: true, seal: true, name: null }); }
        catch (error) { if (error instanceof WindowsCommandJobSetupError) scope = error.scope as WindowsNativeCommandOwnership; throw error; }
        for (const [index, output] of [stdout, stderr].entries()) {
          const pipe = createOutputPipe(api, output, index, options.deadline, startupAbort.signal, finish, fail, observationFailed,
            dependencies.pipeName === undefined ? `\\\\.\\pipe\\Daynight-command-${randomUUID()}` : dependencies.pipeName(),
            dependencies.createServer === undefined ? createServer : dependencies.createServer);
          pipes.push(pipe); await pipe.prepare(); checkAdmission();
        }
        for (const pipe of pipes) pipe.stopListening();
        checkAdmission();
        const job = scope.creationJob(), stdin = api.openNullInput();
        const created = api.createSuspended({ ...data, job, stdin, stdout: pipes[0]!.takeWriter(), stderr: pipes[1]!.takeWriter() });
        target = created.created === null ? undefined : created.created;
        if (target !== undefined) { processOwned = true; threadOwned = true; }
        if (target !== undefined || created.cleanupErrors.length) retainCleanup([...(created.failure === undefined ? [] : [created.failure]), ...created.cleanupErrors]);
        if (target !== undefined) {
          try {
            const observation = api.duplicateProcess(target.process); let transferred = false;
            try {
              const identity = jobs.identity(observation);
              if (identity.pid !== target.pid) throw new Error("Windows native creation returned an inconsistent original process identity.");
              transferred = true; scope.adoptCreatedTarget(observation, { pid: target.pid, birth: identity.birth });
            } catch (error) {
              if (!transferred) {
                try { jobs.closeProcess(observation); } catch (closeError) { throw new WindowsCommandCleanupError([error, closeError]); }
              }
              throw error;
            }
          } catch (error) {
            retainCleanup([error]); throw new WindowsCommandCleanupError(cleanupJournal);
          }
        }
        if (created.failure !== undefined || created.cleanupErrors.length) {
          if (target === undefined && created.cleanupErrors.length === 0) {
            const failure = windowsNativeSpawnError(created.failure, options.file, options.args);
            if (failure !== undefined) {
              result = { kind: "not-started", error: failure };
              const errors = [...scope.requestFailureClose(), ...scope.closeObservations()]; scope = undefined;
              if (errors.length) throw new WindowsCommandCleanupError([created.failure, ...errors]);
              return;
            }
            throw created.failure;
          }
          throw new WindowsCommandCleanupError(cleanupJournal);
        }
        if (target === undefined) throw new Error("Windows native creation did not return a process or a failure.");
        checkAdmission(); api.resume(target.thread);
        threadOwned = false; api.close(target.thread); observeRoot();
      })().catch(error => {
        if (error instanceof WindowsCommandCleanupError) retainCleanup([error]);
        const failure = cleanupJournal.length ? new WindowsCommandCleanupError(cleanupJournal) : error;
        fail(failure); throw failure;
      });
      return starting;
    },
    stop: () => {
      if (released) return Promise.reject(new Error("Windows command ownership was already released."));
      stopping ??= (async () => {
        stopped = true; startupAbort.abort(new Error("Windows native command startup was stopped."));
        await starting?.catch(() => {});
        const failures: unknown[] = [];
        for (const pipe of pipes) {
          failures.push(...pipe.closeWriter());
          try { pipe.stopListening(); pipe.drainOutput(); } catch (error) { failures.push(error); }
        }
        if (pipes.length === 0) stdout.end();
        if (pipes.length < 2) stderr.end();
        await finalizeStop(failures, performance.now() + options.graceMs);
        if (failures.length) throw new WindowsCommandCleanupError(failures);
      })();
      return stopping;
    },
    release: () => {
      if (releasing !== undefined) return releasing;
      if (stopped || released || !naturalClosed || lifecycleError !== undefined || assisted || result === undefined) {
        const invalid = new Error("Windows command has not reached natural completion before release.");
        releasing = (async () => { const failures: unknown[] = [invalid]; try { await command.stop(); } catch (error) { failures.push(...errorsOf(error)); } throw new WindowsCommandCleanupError(failures); })();
        return releasing;
      }
      const failures: unknown[] = [], deadline = performance.now() + options.graceMs;
      closeOriginal(failures);
      let resolve!: () => void, reject!: (error: unknown) => void;
      releasing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      try {
        if (failures.length) throw new WindowsCommandCleanupError(failures);
        if (scope === undefined) { released = true; options.onReleased(); }
        else scope.release(() => { released = true; options.onReleased(); });
        terminal = true; clearTimeout(observing); resolve();
      } catch (error) {
        const errors = errorsOf(error);
        if (scope?.killPolicy === "OFF" || released) { errors.push(...scope?.closeObservations() ?? []); terminal = true; reject(new WindowsCommandCleanupError(errors)); }
        else {
          errors.push(...scope?.restoreKillOnCloseUntil(deadline) ?? []); stopped = true;
          void finalizeStop(errors, deadline).then(() => reject(new WindowsCommandCleanupError(errors)), reject);
        }
      }
      return releasing;
    },
  };
  return command;
};
