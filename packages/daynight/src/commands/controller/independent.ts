import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, realpath, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { CliContext } from "../../cli/context.js";
import { resolveConfigurationPaths } from "../../config/paths.js";
import { loadServerConfiguration } from "../../config/server.js";
import { SESSION_PROTOCOL, sessionFence, assertSessionFence, type SessionSnapshot } from "../../session/protocol.js";
import { parseControllerGrantResponse, parseRegistrationResponse } from "../../session/controller-protocol.js";
import { writeControllerCredential } from "../worker/backends/session-api.js";
import { controllerExecutionDirectory, controllerTicketPath, writeLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import { readControllerSnapshot, recordStoppedControllerGeneration } from "./lifecycle-store.js";
import { captureProcessProof, stopControllerProcesses, type ProcessProof } from "./process-proof.js";
import { requestController } from "./local-client.js";
import type { ResumeLease } from "./resume.js";
import type { IndependentControllerInput } from "./index.js";

const waitForExit = async (exited: Promise<void> | undefined, milliseconds: number): Promise<void> => {
  if (!exited) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
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
  let spawnAttempted = false, archived = false, nativeStopped = false, unstartedTicketRetired = true;
  let resume: ResumeLease | undefined;
  let processProof: ProcessProof | undefined;
  let childExit: Promise<void> | undefined;
  const request = async (target: string, body?: unknown, independent = false): Promise<unknown> => {
    if (!independent) cancellation.signal.throwIfAborted();
    const response = await fetch(`${config.serverUrl}${target}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${config.serverToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: independent ? AbortSignal.timeout(10_000) : AbortSignal.any([cancellation.signal, AbortSignal.timeout(15_000)]) });
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2_097_152) { await reader.cancel(); throw new Error("Test Session response exceeds its limit; the result is unconfirmed."); } chunks.push(value); } }
      finally { reader.releaseLock(); }
    }
    if (!response.ok) throw new Error(`Test Session request failed with HTTP ${response.status}; its original execution identity is retained.`);
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
    const endpointKey = createHash("sha256").update(`${home}:${launchId}`).digest("hex").slice(0, 20);
    const ipcEndpoint = process.platform === "win32" ? `\\\\.\\pipe\\daynight-${endpointKey}` : path.join(home, ".daynight", "c", `${endpointKey}.sock`);
    if (process.platform !== "win32") {
      if (Buffer.byteLength(ipcEndpoint) > (process.platform === "darwin" ? 103 : 107)) throw new Error("The controller IPC endpoint exceeds this platform's socket path limit.");
      await mkdir(path.dirname(ipcEndpoint), { recursive: true, mode: 0o700 });
    }
    const nativeHome = resume?.ticket.nativeHome ?? (input.provider === "codex" ? process.env.CODEX_HOME ?? path.join(home, ".codex") : input.provider === "claude" ? process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude") : process.env.COPILOT_HOME ?? path.join(home, ".copilot"));
    ticket = { schemaVersion: 1, launchId, executionId, controllerId, controllerInstanceId, sessionId: session.sessionId, executionGeneration: session.executionGeneration, testExecutionId: executionId, ownerUserId: session.identity.ownerUserId, initialInput: registration.initialInput, serverOrigin: config.serverUrl, provider: input.provider, cwd, nativeHome, configuration: { agent: input.provider, agentControlMode: "web", model: resume ? null : input.model, args: resume?.ticket.configuration.args ?? input.args, recoveryLimit: 0 }, initialOperationId: randomUUID(), initialPrompt: input.prompt ?? "", resumeNativeSessionId: resume?.nativeSessionId ?? null, credentialFile, ipcEndpoint, ipcSecret: randomBytes(32).toString("hex"), createdAt: new Date().toISOString() };
    await writeLaunchTicket(home, ticket);
    // Reconnect grants are valid for the first hello and survive a lost first connection.
    credential = await grant("reconnect"); await writeControllerCredential(credentialFile, credential);
    context.stdout(`Provider: ${input.provider}; starting in ${cwd}\nPress Ctrl+C to stop this Test Session.\n`);
    cancellation.signal.throwIfAborted();
    const log = await open(path.join(directory, "controller.log"), "a", 0o600);
    try {
      spawnAttempted = true;
      child = spawn(process.execPath, [path.join(context.packageDirectory, "dist", "main.js"), "controller", input.provider, "--launch-id", launchId], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, detached: process.platform !== "win32", stdio: ["ignore", log.fd, log.fd], windowsHide: true });
      childExit = new Promise<void>(resolve => { child!.once("exit", () => resolve()); child!.once("error", () => resolve()); });
      await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
    } finally { await log.close(); }
    if (!child.pid) throw new Error("Test controller process identity is unknown.");
    processProof = await captureProcessProof(child.pid);
    await persist("process.json", processProof);
    let submitted = input.prompt === null, connected = false;
    const startupDeadline = Date.now() + 60_000;
    while (!requestedStop) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Test controller exited; inspect its private controller.log. No replacement native session was created.");
      let observed;
      try { observed = await requestController(ticket, { kind: "observe" }, { timeoutMs: 2000, signal: cancellation.signal }); }
      catch (error) { if (connected || Date.now() >= startupDeadline || requestedStop) throw error; await new Promise(resolve => setTimeout(resolve, 100)); continue; }
      if (["paused", "failed", "stopping", "stopped"].includes(observed.snapshot.lifecycle)) throw new Error("Test controller is unavailable; its native outcome is retained in the private journal.");
      if (observed.snapshot.lifecycle === "ready" && !connected) { connected = true; context.stdout(`Provider ready: ${input.provider}; native session ${observed.snapshot.nativeSessionId ?? "awaiting first input confirmation"}\n`); }
      if (!connected && Date.now() >= startupDeadline) throw new Error("Test controller startup timed out; its original execution is retained.");
      if (!submitted && observed.snapshot.lifecycle === "ready") {
        const initial = await requestController(ticket, { kind: "submit_initial", operationId: ticket.initialOperationId }, { timeoutMs: 65_000, signal: cancellation.signal });
        if (initial.operation) {
          submitted = true;
          context.stdout(`Initial input: ${initial.operation.state}\n`);
          if (["failed", "rejected", "expired"].includes(initial.operation.state)) throw new Error("Initial input failed; the same operation remains recorded.");
        }
      }
      if (Date.parse(credential.expiresAt) - Date.now() <= 60_000) { credential = await grant("reconnect"); await writeControllerCredential(credentialFile, credential); }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) { if (!requestedStop) failed = error; }
  finally {
    // Credential revocation and network failure must never prevent local stop.
    if (child && ticket && directory) {
      try {
        await requestController(ticket, { kind: "stop", deadline: Date.now() + 15_000 }, { timeoutMs: 2000 }).catch(() => {});
        await waitForExit(childExit, 2500);
        const journal = path.join(directory, "journal.sqlite");
        let snapshot = null; try { snapshot = readControllerSnapshot(journal); } catch { /* Startup may fail before journal creation. */ }
        const proof = snapshot?.controllerProcess ?? processProof;
        if (proof) await stopControllerProcesses(proof, snapshot?.nativeProcesses ?? [], Date.now() + 10_000);
        else if (child.pid && child.exitCode === null && child.signalCode === null) {
          // This ChildProcess handle belongs to the spawn above, even if proof
          // capture failed. Terminate it; do not infer descendants are stopped.
          child.kill("SIGTERM");
          await waitForExit(childExit, 2000);
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          throw new Error("Original controller process proof is unavailable; complete stopping remains unconfirmed.");
        }
        await childExit;
        const stopped = await recordStoppedControllerGeneration(journal, ticket);
        nativeStopped = true;
        const stopProof = { recordId: randomUUID(), previousControllerInstanceId: ticket.controllerInstanceId, stoppedAt: stopped.stoppedAt! };
        const body = { protocol: SESSION_PROTOCOL, ...sessionFence(ticket), controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, stopProof };
        await persist("stop-proof.json", body);
        try {
          const result: SessionSnapshot = parseRegistrationResponse(await request(`/api/v1/test-sessions/${ticket.sessionId}/stop`, body, true)).session;
          assertSessionFence(result, ticket);
          if (result.lifecycle !== "archived") throw new Error("Test Session archival was not confirmed.");
          await persist("stop-result.json", { session: result }); archived = true; context.stdout("Test Session stopped and archived.\n");
        } catch { context.stderr("Native execution stopped. Server archival is unconfirmed; the original stop proof is retained privately.\n"); }
      } catch (error) { failed ??= error; context.stderr(`Test Session stop could not be fully confirmed; execution evidence: ${directory}. Inspect controller.log and the original journal.\n`); }
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
    if (resume && (!spawnAttempted && unstartedTicketRetired || nativeStopped)) { try { await resume.release(); } catch (error) { failed ??= error; } }
    process.off("SIGINT", signal); process.off("SIGTERM", signal);
  }
  if (failed) throw failed;
};
