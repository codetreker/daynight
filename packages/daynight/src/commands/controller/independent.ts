import { uploadStoppedControllerArchive } from "./archive-upload.js";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, realpath, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CliContext } from "../../cli/context.js";
import { resolveConfigurationPaths } from "../../config/paths.js";
import { loadServerConfiguration } from "../../config/server.js";
import { SESSION_PROTOCOL, sessionFence, assertSessionFence, type SessionSnapshot } from "../../session/protocol.js";
import { parseControllerGrantResponse, parseRegistrationResponse } from "../../session/controller-protocol.js";
import { writeControllerCredential } from "../worker/backends/session-api.js";
import { controllerExecutionDirectory, controllerTicketPath, writeLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import { recordStoppedControllerGeneration, type ControllerSnapshot } from "./lifecycle-store.js";
import { ControllerBootstrapReplacedError, hasUnsafeControllerObservationFailure, isControllerJournalIoFailure, reconcileSubmittedControllerLaunch, stopControllerBootstrap } from "./launch-observation.js";
import { captureProcessProof, confirmControllerProcessesStopped, stopControllerProcesses, type ProcessProof } from "./process-proof.js";
import { ControllerIpcOutcomeUnknownError, requestController } from "./local-client.js";
import { acquireControllerJobLease, releaseControllerJobLease, type ControllerJobLease } from "./windows-job.js";
import { prepareControllerIpcEndpoint } from "./paths.js";
import type { ResumeLease } from "./resume.js";
import type { IndependentControllerInput } from "./index.js";
import { acquireControllerStoragePermit, controllerStorageConnectionIsOpen, isControllerStorageLockHeld, type ControllerStoragePermit } from "./storage-lock.js";
import { prepareControllerStorage } from "./storage-preparation.js";

const withIndependentStorage = async <T>(journalFile: string, action: (permit: ControllerStoragePermit) => Promise<T>, deadline?: number): Promise<T> => {
  const permit = acquireControllerStoragePermit(journalFile, deadline);
  let result: T | undefined, failure: unknown, failed = false;
  try { result = await action(permit); }
  catch (error) { failed = true; failure = error; }
  if (failed && controllerStorageConnectionIsOpen(failure)) throw failure;
  try { permit.release(); }
  catch (release) {
    if (failed) throw new AggregateError([failure, release], "Test controller storage operation and ownership release failed.", { cause: failure });
    throw release;
  }
  if (failed) throw failure;
  return result!;
};

const prepareIndependentWriter = async (journalFile: string, stateDirectory: string, ticket: ControllerLaunchTicket, signal: AbortSignal): Promise<void> => {
  for (;;) {
    signal.throwIfAborted();
    try {
      const prepared = await withIndependentStorage(journalFile, async permit => prepareControllerStorage({ journalFile, stateDirectory, mode: "writer", ticket }, permit));
      if (prepared.kind === "prepared") return;
    } catch (error) { if (!isControllerStorageLockHeld(error)) throw error; }
    await delay(250, undefined, { signal });
  }
};

class TestSessionRequestError extends Error {
  constructor(message: string, readonly retryable: boolean, options?: ErrorOptions) { super(message, options); }
}

class ControllerSnapshotEvidenceConflictError extends Error {}

class TestControllerCommittedCleanupError extends Error {
  readonly outcome = "committed";
  constructor(cause: unknown) { super("Test controller stopped journal was committed, but cleanup could not be completed; archival remains unconfirmed.", { cause }); }
}

const waitForExit = async (exited: Promise<void> | undefined, milliseconds: number): Promise<void> => {
  if (!exited) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
};

const sqliteFailure = (error: unknown): boolean => error instanceof SqliteAccessError
  || error instanceof AggregateError && error.errors.some(sqliteFailure)
  || error instanceof Error && error.cause !== undefined && sqliteFailure(error.cause);
const causedByCancellation = (error: unknown, reason: unknown): boolean => error === reason
  || error instanceof Error && error.cause !== undefined && causedByCancellation(error.cause, reason);

// A saved IPC observation may authorize only a later attempt to stop its known
// process group. It cannot prove that the snapshot contains every later native.
const savedCleanupSnapshot = (snapshot: ControllerSnapshot, ticket: ControllerLaunchTicket, spawn: ProcessProof, previous: ControllerSnapshot | undefined): ControllerSnapshot | undefined => {
  const controller = snapshot.controllerProcess;
  if (controller === null || controller === undefined) {
    if (previous !== undefined) throw new ControllerSnapshotEvidenceConflictError("Test controller IPC discarded its original process evidence.");
    return undefined;
  }
  const valid = (value: ProcessProof): boolean => value !== null && typeof value === "object"
    && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2_147_483_647
    && Number.isSafeInteger(value.parentPid) && value.parentPid >= 0
    && (value.processGroupId === null || Number.isSafeInteger(value.processGroupId) && value.processGroupId > 0)
    && typeof value.startedAt === "string" && value.startedAt.trim() !== ""
    && typeof value.commandHash === "string" && /^[a-f0-9]{64}$/.test(value.commandHash)
    && (value.jobObjectName === undefined || typeof value.jobObjectName === "string" && value.jobObjectName.trim() !== "" && !value.jobObjectName.includes("\0"));
  const same = (left: ProcessProof, right: ProcessProof): boolean => left.pid === right.pid && left.parentPid === right.parentPid
    && left.processGroupId === right.processGroupId && left.startedAt === right.startedAt && left.commandHash === right.commandHash;
  if (!valid(controller) || !valid(spawn) || !same(controller, spawn)
    || snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.testExecutionId !== ticket.testExecutionId
    || snapshot.claimId !== ticket.claimId || snapshot.executionGeneration !== ticket.executionGeneration || snapshot.controllerInstanceId !== ticket.controllerInstanceId
    || !Array.isArray(snapshot.nativeProcesses) || !snapshot.nativeProcesses.every(valid)
    || (process.platform === "win32" ? controller.jobObjectName !== `Local\\Daynight-${ticket.launchId}` : controller.jobObjectName !== undefined || controller.processGroupId !== controller.pid)
    || previous !== undefined && !previous.nativeProcesses.every(proof => snapshot.nativeProcesses.some(current => same(proof, current) && proof.jobObjectName === current.jobObjectName))) {
    throw new ControllerSnapshotEvidenceConflictError("Test controller IPC snapshot has conflicting process evidence.");
  }
  return structuredClone(snapshot);
};

// Keep the registration identity before the first network write. A timeout does
// not authorize replacing it with another execution or replaying initial input.
export const runIndependentController = async (input: IndependentControllerInput, context: CliContext): Promise<void> => {
  const home = context.homeDirectory(), cwd = await realpath(context.workingDirectory());
  const config = await loadServerConfiguration(resolveConfigurationPaths(home));
  if (!config.serverToken) throw new Error("Configure a Daynight serverToken before starting a Test Session.");
  const cancellation = new AbortController(); let requestedStop = false;
  const signal = () => { requestedStop = true; cancellation.abort(new Error("Test Session stopped by the terminal.")); };
  process.on("SIGINT", signal); process.on("SIGTERM", signal);
  let child: ChildProcess | undefined, ticket: ControllerLaunchTicket | undefined;
  let directory: string | undefined, failed: unknown;
  let registeredSession: SessionSnapshot | undefined;
  let spawnAttempted = false, spawnConfirmed = false, archived = false, nativeStopped = false, unstartedTicketRetired = true;
  let resume: ResumeLease | undefined;
  let processProof: ProcessProof | undefined;
  let initialObservationFailure: { cause: unknown } | undefined;
  let previousAuthenticatedSnapshot: ControllerSnapshot | undefined;
  let jobLease: ControllerJobLease | undefined;
  const jobLeaseFailures: unknown[] = [];
  let childExit: Promise<void> | undefined;
  let childExited = false;
  const childFailures: unknown[] = [];
  const request = async (target: string, body?: unknown, independent = false): Promise<unknown> => {
    if (!independent) cancellation.signal.throwIfAborted();
    let response: Response;
    try { response = await fetch(`${config.serverUrl}${target}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${config.serverToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: independent ? AbortSignal.timeout(10_000) : AbortSignal.any([cancellation.signal, AbortSignal.timeout(15_000)]) }); }
    catch (cause) { throw new TestSessionRequestError("Test Session connection failed; its original execution identity is retained.", true, { cause }); }
    if (!response.ok) {
      // The status is authoritative even if a gateway error body is truncated.
      try { await response.body?.cancel(); } catch { /* Error bodies are not used. */ }
      throw new TestSessionRequestError(`Test Session request failed with HTTP ${response.status}; its original execution identity is retained.`, response.status === 408 || response.status === 429 || response.status >= 500);
    }
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2_097_152) { try { await reader.cancel(); } catch { /* Preserve the response limit failure. */ } throw new TestSessionRequestError("Test Session response exceeds its limit; the result is unconfirmed.", false); } chunks.push(value); } }
      catch (cause) { if (cause instanceof TestSessionRequestError) throw cause; throw new TestSessionRequestError("Test Session response was interrupted; its original execution identity is retained.", true, { cause }); }
      finally { reader.releaseLock(); }
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new Error("Test Session response is invalid; its result is unconfirmed."); }
  };
  const persist = async (name: string, value: unknown) => { if (!directory) throw new Error("Test registration directory is unavailable."); await writeFile(path.join(directory, name), `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 }); };
  try {
    const capability = await request("/api/v1/test-session-capabilities") as Record<string, unknown>;
    if (!capability || Object.keys(capability).sort().join() !== ["protocol", "schemaVersion", "projectionVersion", "providers"].sort().join() || capability.protocol !== SESSION_PROTOCOL || capability.schemaVersion !== 1 || capability.projectionVersion !== 1 || !Array.isArray(capability.providers) || !capability.providers.includes(input.provider)) throw new Error("This service has not confirmed compatible Test Session support.");
    if (input.resume) {
      if (input.prompt !== null || input.model !== null || input.args.length) throw new Error("Resume cannot override native settings or replay initial input.");
      resume = await (await import("./resume.js")).acquireResume({ provider: input.provider, ...(input.resume.sessionId ? { sessionId: input.resume.sessionId } : {}) }, context, { serverUrl: config.serverUrl, serverToken: config.serverToken });
      context.stdout(`Resuming native context from Test Session: ${resume.ticket.sessionId}\n`);
    }
    const executionId = randomUUID(), launchId = randomUUID(), controllerId = randomUUID(), controllerInstanceId = randomUUID();
    directory = controllerExecutionDirectory(home, executionId); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    const registration = { protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, registrationId: randomUUID(), testExecutionId: executionId, controllerId, controllerInstanceId, provider: input.provider, initialInput: input.prompt === null ? "none" as const : "prompt" as const };
    await persist("registration.json", { registration, serverOrigin: config.serverUrl, cwd, initialPrompt: input.prompt, ...(resume ? { resumedFromSessionId: resume.ticket.sessionId } : {}) });
    const session = parseRegistrationResponse(await request("/api/v1/test-sessions", registration)).session;
    if (session.testExecutionId !== executionId || session.identity.ownerUserId === undefined || session.identity.provider !== input.provider || session.identity.controllerId !== controllerId || session.identity.controllerInstanceId !== controllerInstanceId || session.executionGeneration !== "1" || session.initialInputState !== (input.prompt === null ? "not_required" : "not_submitted")) throw new Error("Test Session registration does not match the durable launch intent.");
    registeredSession = session;
    context.stdout(`Test Session: ${new URL(`/test-sessions/${session.sessionId}`, config.serverUrl).href}\n`);
    await persist("registration-result.json", { session });
    const prefix = `/api/v1/test-sessions/${session.sessionId}`;
    const grant = async (kind: "bootstrap" | "reconnect") => {
      const result = parseControllerGrantResponse(await request(`${prefix}/controller-grant`, { protocol: SESSION_PROTOCOL, testExecutionId: executionId, controllerId, controllerInstanceId, executionGeneration: "1", kind, previousGeneration: null, stopProof: null }));
      assertSessionFence(result, sessionFence(session));
      if (result.controllerId !== controllerId || result.controllerInstanceId !== controllerInstanceId || Date.parse(result.expiresAt) <= Date.now()) throw new Error("Test controller grant does not match its launch identity or expiry.");
      return result;
    };
    let credential = await grant("bootstrap");
    const credentialFile = path.join(directory, "credential.json"); await writeControllerCredential(credentialFile, credential);
    const ipcEndpoint = await prepareControllerIpcEndpoint(home, launchId);
    const nativeHome = resume?.ticket.nativeHome ?? (input.provider === "codex" ? process.env.CODEX_HOME ?? path.join(home, ".codex") : input.provider === "claude" ? process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude") : process.env.COPILOT_HOME ?? path.join(home, ".copilot"));
    ticket = { schemaVersion: 1, launchId, executionId, controllerId, controllerInstanceId, sessionId: session.sessionId, executionGeneration: session.executionGeneration, testExecutionId: executionId, ownerUserId: session.identity.ownerUserId, initialInput: registration.initialInput, serverOrigin: config.serverUrl, provider: input.provider, cwd, nativeHome, configuration: { agent: input.provider, agentControlMode: "web", model: resume ? null : input.model, args: resume?.ticket.configuration.args ?? input.args, recoveryLimit: 0 }, initialOperationId: randomUUID(), initialPrompt: input.prompt ?? "", resumeNativeSessionId: resume?.nativeSessionId ?? null, credentialFile, ipcEndpoint, ipcSecret: randomBytes(32).toString("hex"), createdAt: new Date().toISOString() };
    await writeLaunchTicket(home, ticket);
    await prepareIndependentWriter(path.join(directory, "journal.sqlite"), resolveConfigurationPaths(home).stateDirectory, ticket, cancellation.signal);
    // Reconnect grants are valid for the first hello and survive a lost first connection.
    credential = await grant("reconnect"); await writeControllerCredential(credentialFile, credential);
    context.stdout(`Provider: ${input.provider}; starting in ${cwd}\nPress Ctrl+C to stop this Test Session.\n`);
    cancellation.signal.throwIfAborted();
    const log = await open(path.join(directory, "controller.log"), "a", 0o600);
    try {
      spawnAttempted = true;
      child = spawn(process.execPath, [path.join(context.packageDirectory, "dist", "main.js"), "controller", input.provider, "--launch-id", launchId], { cwd, env: { ...process.env, DN_CONFIG_DIR: resolveConfigurationPaths(home).stateDirectory }, detached: process.platform !== "win32", stdio: ["ignore", log.fd, log.fd], windowsHide: true });
      childExit = new Promise<void>(resolve => { child!.once("exit", () => { childExited = true; resolve(); }); });
      child.on("error", error => { childFailures.push(error); });
      await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
      spawnConfirmed = true;
    } finally { await log.close(); }
    if (!child.pid) throw new Error("Test controller process identity is unknown.");
    processProof = await captureProcessProof(child.pid);
    await persist("process.json", processProof);
    let submitted = input.prompt === null, connected = false;
    let renewalFailures = 0, nextRenewalAt = 0, ipcUnavailable = false, hasObserved = false, startupTimeoutReported = false;
    const startupDeadline = Date.now() + 60_000;
    while (!requestedStop) {
      let observation: Awaited<ReturnType<typeof reconcileSubmittedControllerLaunch>>;
      try { observation = await reconcileSubmittedControllerLaunch({ journalFile: path.join(directory, "journal.sqlite"), ticket, spawnProof: processProof, signal: cancellation.signal }); }
      catch (error) {
        if (!requestedStop || !causedByCancellation(error, cancellation.signal.reason)) initialObservationFailure = { cause: error };
        throw error;
      }
      if (observation.kind === "observed") {
        try { previousAuthenticatedSnapshot = savedCleanupSnapshot(observation.snapshot, ticket, processProof, previousAuthenticatedSnapshot); }
        catch (error) { initialObservationFailure = { cause: error }; throw error; }
        if (process.platform === "win32" && previousAuthenticatedSnapshot && !jobLease) {
          try { jobLease = await acquireControllerJobLease(ticket.launchId, processProof, Date.now() + 15_000); }
          catch (error) { jobLeaseFailures.push(error); initialObservationFailure = { cause: error }; throw error; }
        }
      }
      if (observation.kind === "unknown") {
        const error = new Error("Test controller process status is unknown; the original execution is retained.", { cause: observation.cause });
        initialObservationFailure = { cause: error }; throw error;
      }
      if (observation.kind === "controller-exited") throw new Error("Test controller exited after committing its generation; the original execution is retained.");
      if (observation.kind === "pre-writer-exited") throw new Error(`Test controller exited before committing its generation (${observation.journal}); the original launch is blocked.`);
      const observed = observation.kind === "observed" ? { snapshot: observation.snapshot } : undefined;
      if (!observed && hasObserved && !ipcUnavailable) {
        context.stderr("Controller IPC observation is temporarily unavailable; the original native execution remains supervised.\n");
        ipcUnavailable = true;
      }
      if (!connected && Date.now() >= startupDeadline && !startupTimeoutReported) {
        startupTimeoutReported = true;
        context.stderr("Test controller startup remains unconfirmed; continuing to observe the original execution.\n");
      }
      if (observed) {
        hasObserved = true;
        if (ipcUnavailable) { context.stderr("Controller IPC observation recovered for the original native execution.\n"); ipcUnavailable = false; }
        if (["paused", "failed", "stopping", "stopped"].includes(observed.snapshot.lifecycle)) throw new Error("Test controller is unavailable; its native outcome is retained in the private journal.");
        // A lost reply may settle as a definitive rejection in the journal while
        // the provider remains ready. Reconcile that outcome without resubmission.
        if (input.prompt !== null && observed.snapshot.initialInputState === "failed") throw new Error("Initial input failed; the same operation remains recorded.");
        if (observed.snapshot.lifecycle === "ready" && !connected) { connected = true; context.stdout(`Provider ready: ${input.provider}; native session ${observed.snapshot.nativeSessionId ?? "awaiting first input confirmation"}\n`); }
        if (!submitted && observed.snapshot.lifecycle === "ready") {
          try {
            const initial = await requestController(ticket, { kind: "submit_initial", operationId: ticket.initialOperationId }, { timeoutMs: 65_000, signal: cancellation.signal });
            if (initial.operation) {
              submitted = true;
              context.stdout(`Initial input: ${initial.operation.state}\n`);
              if (["failed", "rejected", "expired"].includes(initial.operation.state)) throw new Error("Initial input failed; the same operation remains recorded.");
            }
          } catch (error) {
            if (hasUnsafeControllerObservationFailure(error)) initialObservationFailure = { cause: error };
            if (requestedStop || !(error instanceof ControllerIpcOutcomeUnknownError)) throw error;
            // Even a later not_submitted snapshot cannot prove that this request
            // never crossed dispatch. Only observe; keep the original operation ID.
            submitted = true;
            context.stderr(`Initial input outcome is unknown; operation ${ticket.initialOperationId} will not be replayed. The original native execution remains supervised.\n`);
          }
        }
      }
      if (Date.parse(credential.expiresAt) - Date.now() <= 60_000 && Date.now() >= nextRenewalAt) {
        try {
          const renewed = await grant("reconnect"); await writeControllerCredential(credentialFile, renewed); credential = renewed;
          if (renewalFailures) context.stderr(`Test Session ${session.sessionId} credential renewal recovered; its original native execution continues.\n`);
          renewalFailures = 0; nextRenewalAt = 0;
        } catch (error) {
          if (requestedStop || !(error instanceof TestSessionRequestError) || !error.retryable) throw error;
          renewalFailures = Math.min(renewalFailures + 1, 6);
          const retryMs = Math.min(30_000, 1_000 * 2 ** (renewalFailures - 1)); nextRenewalAt = Date.now() + retryMs;
          context.stderr(`Test Session ${session.sessionId} credential renewal is temporarily unavailable; retry in ${retryMs / 1000}s. The original native execution continues; remote writes still require valid relay authorization. ${error.message}\n`);
        }
      }
      await delay(250, undefined, { signal: cancellation.signal });
    }
  } catch (error) { if (!requestedStop || !causedByCancellation(error, cancellation.signal.reason) || sqliteFailure(error)) failed = error; }
  finally {
    // Credential revocation and network failure must never prevent local stop.
    if (child && ticket && directory) {
      let ipcStopFailure: { cause: unknown } | undefined;
      try {
        const deadline = Date.now() + 15_000;
        const remaining = () => { const time = deadline - Date.now(); if (time <= 0) throw new Error("Test controller cleanup exceeded its deadline; execution evidence is retained."); return time; };
        if (process.platform === "win32" && processProof && !jobLease) {
          try { remaining(); jobLease = await acquireControllerJobLease(ticket.launchId, processProof, deadline); remaining(); }
          catch (error) { jobLeaseFailures.push(error); }
        }
        const requireJobLease = () => {
          if (process.platform === "win32" && !jobLease) throw new Error("Original Test controller Job identity is unavailable; complete stopping is unconfirmed.", { cause: jobLeaseFailures.at(-1) });
        };
        const stopKnownSnapshot = async (journalFailure: unknown, prerequisite?: unknown): Promise<unknown[]> => {
          const saved = previousAuthenticatedSnapshot;
          if (process.platform === "win32" || saved?.controllerProcess == null || !isControllerJournalIoFailure(journalFailure)
            || prerequisite !== undefined && !isControllerJournalIoFailure(prerequisite)
            || initialObservationFailure !== undefined && !isControllerJournalIoFailure(initialObservationFailure.cause)
            || ipcStopFailure !== undefined && !(ipcStopFailure.cause instanceof ControllerIpcOutcomeUnknownError)) return [];
          try {
            remaining();
            await stopControllerProcesses(saved.controllerProcess, saved.nativeProcesses, deadline);
            remaining();
            if (!await confirmControllerProcessesStopped(saved.controllerProcess, saved.nativeProcesses, deadline)) throw new Error("Known Test controller processes remain active; complete stopping is unconfirmed.");
            remaining();
            return [];
          } catch (error) { return [error]; }
        };
        if (!processProof) {
          const failures: unknown[] = [];
          let observed: Awaited<ReturnType<typeof requestController>> | undefined;
          try {
            // The original ticket can authenticate an IPC peer, but a failed spawn
            // proof cannot authorize POSIX signals to a possibly recycled PID.
            const observationDeadline = deadline - (process.platform === "win32" ? 2500 : 0);
            while (spawnConfirmed && !childExited && Date.now() < observationDeadline) {
              try {
                const available = observationDeadline - Date.now();
                if (available <= 0) break;
                const response = await requestController(ticket, { kind: "observe" }, { timeoutMs: Math.min(500, available) });
                if (response.snapshot.sessionId !== ticket.sessionId) throw new Error("Test controller IPC session identity mismatch.");
                if (response.snapshot.controllerProcess === null || typeof response.snapshot.controllerProcess !== "object" || response.snapshot.controllerProcess.pid !== child.pid) throw new Error("Test controller IPC process does not match the spawned child.");
                observed = response;
                break;
              } catch (error) {
                failures.push(error);
                if (!(error instanceof ControllerIpcOutcomeUnknownError)) break;
                await waitForExit(childExit, Math.min(250, Math.max(0, observationDeadline - Date.now())));
              }
            }
            if (spawnConfirmed && !childExited && !observed && Date.now() >= observationDeadline) failures.push(new Error("Original Test controller IPC observation window expired; exit remains unconfirmed."));
            if (observed) {
              const available = observationDeadline - Date.now();
              if (available > 0) {
                try { await requestController(ticket, { kind: "stop", deadline }, { timeoutMs: Math.min(2000, available) }); }
                catch (error) { failures.push(error); }
                const wait = observationDeadline - Date.now();
                if (wait > 0) await waitForExit(childExit, Math.min(2500, wait));
              } else failures.push(new Error("Original Test controller IPC stop window expired; exit remains unconfirmed."));
            }
            // Windows retains the original process handle from spawn. POSIX's
            // ChildProcess.kill uses a PID that may already have been recycled.
            if (spawnConfirmed && !childExited && process.platform === "win32") {
              try {
                remaining();
                if (!child.kill("SIGTERM")) throw new Error("Original Test controller handle did not accept termination.");
                await waitForExit(childExit, remaining());
                if (!childExited) throw new Error("Test controller handle termination did not complete before its deadline.");
              } catch (error) { failures.push(error); }
            }
          } catch (error) { failures.push(error); }
          finally {
            failures.push(...childFailures);
            if (spawnConfirmed) { try { child.unref(); } catch (error) { failures.push(error); } }
          }
          throw new AggregateError(failures, "Original controller spawn proof is unavailable; complete stopping remains unconfirmed and execution evidence is retained.");
        }
        const journal = path.join(directory, "journal.sqlite");
        let replacement: ControllerBootstrapReplacedError | undefined;
        let observation: Awaited<ReturnType<typeof reconcileSubmittedControllerLaunch>>;
        try {
          if (initialObservationFailure !== undefined) throw initialObservationFailure.cause;
          observation = await reconcileSubmittedControllerLaunch({ journalFile: journal, ticket, spawnProof: processProof, signal: AbortSignal.timeout(remaining()), deadline });
          remaining();
          if (observation.kind === "observed") previousAuthenticatedSnapshot = savedCleanupSnapshot(observation.snapshot, ticket, processProof, previousAuthenticatedSnapshot);
          if (observation.kind === "unknown") throw new Error("Test controller status is unknown; original execution evidence is retained.", { cause: observation.cause });
        } catch (observationFailure) {
          const failures: unknown[] = [observationFailure];
          let bootstrapStopped = false;
          try { remaining(); await stopControllerBootstrap(processProof, deadline); remaining(); bootstrapStopped = true; }
          catch (stopFailure) {
            failures.push(stopFailure);
            if (stopFailure instanceof ControllerBootstrapReplacedError) { try { remaining(); bootstrapStopped = true; } catch (deadlineFailure) { failures.push(deadlineFailure); } }
          }
          if (bootstrapStopped && !(observationFailure instanceof ControllerSnapshotEvidenceConflictError) && !hasUnsafeControllerObservationFailure(observationFailure)) {
            try {
              const after = await reconcileSubmittedControllerLaunch({ journalFile: journal, ticket, spawnProof: processProof, signal: AbortSignal.timeout(remaining()), deadline });
              remaining();
              if (after.kind === "unknown") throw new Error("Test controller exit could not be classified; original execution evidence is retained.", { cause: after.cause });
              if (after.kind === "pre-writer-exited") throw new Error(`Test controller exited before committing its generation (${after.journal}); the original launch is blocked.`);
              if (after.kind !== "controller-exited") throw new Error("Test controller exit is not confirmed; the original launch is retained.");
              if (!after.snapshot.controllerProcess) throw new Error("Test controller journal lacks complete controller process proof; stopping is blocked.");
              requireJobLease();
              await stopControllerProcesses(after.snapshot.controllerProcess, after.snapshot.nativeProcesses, deadline, ...(process.platform === "win32" ? [jobLease] as const : []));
              remaining();
              if (!await confirmControllerProcessesStopped(after.snapshot.controllerProcess, after.snapshot.nativeProcesses, deadline, ...(process.platform === "win32" ? [jobLease] as const : []))) throw new Error("Test controller native process stop is unconfirmed; original execution evidence is retained.");
              remaining();
            } catch (stopFailure) {
              failures.push(stopFailure);
              failures.push(...await stopKnownSnapshot(stopFailure, observationFailure));
            }
          }
          throw new AggregateError(failures, "Test controller observation failed; bounded bootstrap cleanup was attempted and complete stopping remains unconfirmed.", { cause: observationFailure });
        }
        if (observation.kind === "observed" || observation.kind === "running-unobserved") {
          if (observation.kind === "observed") {
            try { await requestController(ticket, { kind: "stop", deadline }, { timeoutMs: Math.min(2000, remaining()) }); }
            catch (error) { ipcStopFailure = { cause: error }; }
            await waitForExit(childExit, Math.min(2500, remaining()));
          }
          try { await stopControllerBootstrap(processProof, deadline); }
          catch (error) { if (!(error instanceof ControllerBootstrapReplacedError)) throw error; replacement = error; }
          if (ipcStopFailure !== undefined && hasUnsafeControllerObservationFailure(ipcStopFailure.cause)) {
            throw new Error("Test controller IPC identity conflict blocks native process cleanup; original execution evidence is retained.", { cause: replacement ? new AggregateError([ipcStopFailure.cause, replacement]) : ipcStopFailure.cause });
          }
          try { observation = await reconcileSubmittedControllerLaunch({ journalFile: journal, ticket, spawnProof: processProof, signal: AbortSignal.timeout(remaining()), deadline }); remaining(); }
          catch (error) {
            const knownStopFailures = await stopKnownSnapshot(error);
            if (replacement || knownStopFailures.length) throw new AggregateError([...(replacement ? [replacement] : []), error, ...knownStopFailures], "Test controller bootstrap exit and launch classification failed.", { cause: error });
            throw error;
          }
        }
        if (observation.kind === "unknown") throw new Error("Test controller exit could not be classified; the original launch is retained.", { cause: replacement ? new AggregateError([replacement, observation.cause], "Test controller bootstrap replacement and launch status are unconfirmed.") : observation.cause });
        if (observation.kind === "pre-writer-exited") throw new Error(`Test controller exited before committing its generation (${observation.journal}); the original launch is blocked.`, { cause: replacement });
        if (observation.kind !== "controller-exited") throw new Error("Test controller exit is not confirmed; the original launch is retained.", { cause: replacement });
        const snapshot = observation.snapshot;
        if (!snapshot.controllerProcess) throw new Error("Test controller journal lacks complete controller process proof; stopping is blocked.", { cause: replacement });
        let stopped: Awaited<ReturnType<typeof recordStoppedControllerGeneration>>;
        try {
          requireJobLease();
          await stopControllerProcesses(snapshot.controllerProcess, snapshot.nativeProcesses, deadline, ...(process.platform === "win32" ? [jobLease] as const : []));
          remaining();
          if (ipcStopFailure !== undefined) {
            if (!await confirmControllerProcessesStopped(snapshot.controllerProcess, snapshot.nativeProcesses, deadline, ...(process.platform === "win32" ? [jobLease] as const : []))) throw new Error("Test controller native process stop is unconfirmed; original execution evidence is retained.");
            remaining();
            throw new Error("Test controller IPC stop failed; the original execution evidence is retained.");
          }
          let committed = false;
          try {
            stopped = await withIndependentStorage(journal, async permit => {
              const stateDirectory = resolveConfigurationPaths(home).stateDirectory;
              const result = await recordStoppedControllerGeneration(journal, ticket!, { stateDirectory, permit, deadline, ...(jobLease === undefined ? {} : { jobLease }) });
              committed = true;
              remaining();
              return result;
            }, deadline);
          } catch (error) { if (committed) throw new TestControllerCommittedCleanupError(error); throw error; }
          try { remaining(); } catch (error) { throw new TestControllerCommittedCleanupError(error); }
        } catch (error) { if (replacement) throw new AggregateError([replacement, error], "Test controller bootstrap replacement and complete stopping failed.", { cause: error }); throw error; }
        if (jobLeaseFailures.length) throw new AggregateError(jobLeaseFailures, "Test controller Job lease acquisition failed; execution evidence is retained.");
        if (jobLease) {
          const owned = jobLease; jobLease = undefined;
          try { releaseControllerJobLease(owned); } catch (error) { throw new TestControllerCommittedCleanupError(error); }
        }
        nativeStopped = true;
        const stopProof = { recordId: randomUUID(), previousControllerInstanceId: ticket.controllerInstanceId, stoppedAt: stopped.stoppedAt! };
        const body = { protocol: SESSION_PROTOCOL, ...sessionFence(ticket), controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, stopProof };
        await persist("stop-proof.json", body);
        // Publish the upload intent before closing the live page so observers keep polling.
        await request(`/api/v1/test-sessions/${ticket.sessionId}/archive`, { ...sessionFence(ticket), controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, state: "pending", errorCode: null }, true).catch(() => {});
        try {
          const result: SessionSnapshot = parseRegistrationResponse(await request(`/api/v1/test-sessions/${ticket.sessionId}/stop`, body, true)).session;
          assertSessionFence(result, ticket);
          if (result.lifecycle !== "archived") throw new Error("Test Session archival was not confirmed.");
          await persist("stop-result.json", { session: result }); archived = true;

        } catch { context.stderr("Native execution stopped. Server archival is unconfirmed; the original stop proof is retained privately.\n"); }
        if (archived) {
          try {
            await uploadStoppedControllerArchive({ journalPath: journal, ticket, serverToken: config.serverToken, stateDirectory: resolveConfigurationPaths(home).stateDirectory });
            context.stdout("Test Session stopped and archived. Read-only history is available on its page.\n");
          } catch (error) {
            if (sqliteFailure(error)) failed = failed === undefined ? error : new AggregateError([failed, error], "Test Session execution and history archival failed.");
            context.stderr(`Native execution stopped; session history upload is pending. Source retained in ${directory}.\nRetry without starting an agent: daynight controller ${ticket.provider} archive ${ticket.sessionId}\n`);
          }
        } else context.stderr(`Retry without starting an agent: daynight controller ${ticket.provider} archive ${ticket.sessionId}\n`);
      } catch (error) {
        const failures: unknown[] = [...jobLeaseFailures, ...(ipcStopFailure === undefined ? [] : [ipcStopFailure.cause]), error];
        if (jobLease) { const owned = jobLease; jobLease = undefined; try { releaseControllerJobLease(owned); } catch (releaseFailure) { failures.push(releaseFailure); } }
        if (processProof) {
          failures.push(...childFailures);
          if (spawnConfirmed && !childExited) { try { child.unref(); } catch (unrefFailure) { failures.push(unrefFailure); } }
        }
        const cleanupFailure = failures.length === 1 ? error : new AggregateError(failures, "Test controller cleanup and handle release failed.", { cause: error });
        failed = failed === undefined ? cleanupFailure : new AggregateError([failed, cleanupFailure], "Test Session execution and stopping failed.");
        context.stderr(`Test Session stop could not be fully confirmed; execution evidence: ${directory}. Inspect controller.log and the original journal.\n`);
      }
    }
    if (ticket && directory && !spawnAttempted) {
      // A never-launched continuation has no journal. Keep its launch intent as
      // evidence outside the active ticket inventory so it cannot block resume.
      try { await rename(controllerTicketPath(home, ticket.launchId), path.join(directory, "unstarted-launch.json")); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { unstartedTicketRetired = false; failed ??= error; } }
    }
    if (registeredSession && directory && !spawnAttempted) {
      try {
        const body = { protocol: SESSION_PROTOCOL, ...sessionFence(registeredSession), controllerId: registeredSession.identity.controllerId, controllerInstanceId: registeredSession.identity.controllerInstanceId, stopProof: { kind: "never_started", recordId: randomUUID(), previousControllerInstanceId: registeredSession.identity.controllerInstanceId, stoppedAt: new Date().toISOString() } };
        await persist("stop-proof.json", body);
        const result = parseRegistrationResponse(await request(`/api/v1/test-sessions/${registeredSession.sessionId}/stop`, body, true)).session;
        assertSessionFence(result, sessionFence(registeredSession));
        if (result.lifecycle !== "archived") throw new Error("Unstarted Test Session archival was not confirmed.");
        await persist("stop-result.json", { session: result }); archived = true;
        context.stdout("Test Session archived; no controller process was started.\n");
      } catch { /* The printed identity and private proof remain available for reconciliation. */ }
    }
    if (registeredSession && !archived && (!child || !child.pid)) context.stderr(`Test Session ${registeredSession.sessionId} remains unarchived. ${spawnAttempted ? "Controller launch outcome is unconfirmed." : "No controller process was started."} Registration evidence: ${directory}.\n`);
    else if (!registeredSession && directory) context.stderr(`Test Session registration was not confirmed. Preserve and reconcile the original registration identity in ${path.join(directory, "registration.json")} before starting another execution.\n`);
    if (resume && (!spawnAttempted && unstartedTicketRetired || nativeStopped)) { try { await resume.release(); } catch (error) { failed = failed === undefined ? error : new AggregateError([failed, error], "Test Session execution and lease release failed."); } }
    process.off("SIGINT", signal); process.off("SIGTERM", signal);
  }
  if (failed) throw failed;
};
