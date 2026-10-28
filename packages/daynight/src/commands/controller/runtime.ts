import { createNativeCommandQueue, assertControlCommand } from "./command-controls.js";
import { createServer, type Socket } from "node:net";
import { chmod, mkdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { SessionCommand } from "../../session/protocol.js";
import { controllerExecutionDirectory, readLaunchTicket } from "./launch-ticket.js";
import { openControllerLifecycleStore, type ControllerOperation } from "./lifecycle-store.js";
import { validateControllerLocalRequest, type ControllerLocalResponse } from "./local-client.js";
import { captureProcessProof, captureControllerProcessProof } from "./process-proof.js";
import { createControllerRelay } from "./relay.js";
import { isCleaningGeneration, observeNativeInput, observeNativeInteraction } from "./recovery.js";
import { NativeRpcError } from "./providers/native-rpc.js";
import type { NativeProvider, ProviderOptions } from "./providers/types.js";

export const runController = async (options: { homeDirectory: string; provider: "codex" | "claude" | "copilot"; launchId: string }): Promise<void> => {
  const ticket = await readLaunchTicket(options.homeDirectory, options.launchId);
  if (ticket.provider !== options.provider || await realpath(ticket.cwd) !== await realpath(process.cwd())) throw new Error("Controller launch provider or working directory mismatch.");
  const directory = controllerExecutionDirectory(options.homeDirectory, ticket.executionId); await mkdir(directory, { recursive: true, mode: 0o700 });
  const journal = openControllerLifecycleStore(path.join(directory, "journal.sqlite"), ticket);
  let provider: NativeProvider | null = null, stopping = false, synchronized = false;
  let projectionFailure: string | null = null, providerFailure: string | null = null;
  let startup: Promise<void> | null = null, shutdownPromise: Promise<void> | null = null;
  const knownInteractions = new Set<string>(), cleanupInteractions = new Set<string>();
  let cleanupInputStarted = false;
  let cleaning = isCleaningGeneration(journal.listOperations(), ticket.executionGeneration);
  let complete!: () => void; const finished = new Promise<void>(resolve => { complete = resolve; });
  const queueNative = createNativeCommandQueue();
  const sockets = new Set<Socket>(), active = new Map<string, Promise<ControllerOperation>>();
  const processCaptures: Promise<void>[] = [];
  const diagnostic = (message: string) => { process.stderr.write(`${new Date().toISOString()} ${message.slice(0, 4096)}\n`); };
  const publishState = () => {
    const s = journal.getSnapshot();
    if (!stopping && !["failed", "paused", "stopped", "stopping"].includes(s.lifecycle)) {
      // Initial native input needs both the completed provider startup and a
      // synchronized relay. Provider state can arrive before its handle does.
      const waiting = !provider || s.activity === "initializing" || s.initialInputState === "not_submitted" && !synchronized;
      journal.patchSnapshot({ lifecycle: waiting ? "starting" : s.activity === "idle" ? "ready" : "working" });
    }
    journal.appendEvent({ kind: "state", payload: { nativeSessionId: s.nativeSessionId, initialInputState: s.initialInputState, synchronized, activity: !provider ? "initializing" : stopping ? "stopped" : s.activity, currentTurnId: s.currentTurnId, ...(provider && !stopping && s.controls ? { controls: s.controls } : {}), ...(s.turnStartedAt !== undefined ? { turnStartedAt: s.turnStartedAt } : {}), ...(cleaning ? { cleanupInteractionIds: [...cleanupInteractions] } : {}), capabilities: !provider || stopping ? { send: false, steer: false, cancel: false, respond: false } : cleaning ? { ...s.capabilities, send: false, steer: false, cancel: false } : s.capabilities } });
  };
  const fail = (error: unknown) => { const message = error instanceof Error ? error.message : String(error); diagnostic(message); try { journal.patchSnapshot({ lifecycle: "paused", error: message }); } catch { /* The private log retains a journal failure when disk writes fail. */ } };
  const dispatch = (operation: ControllerOperation, invoke: () => Promise<unknown>): Promise<ControllerOperation> => {
    const running = active.get(operation.operationId); if (running) return running;
    if (operation.state !== "accepted") return Promise.resolve(operation);
    const execute = (async () => {
      if (["initial", "send_message", "interaction_response", "execute_command", "update_setting"].includes(operation.kind)) journal.assertInputCapacity();
      journal.markDispatching(operation.operationId); nativeEvent(publishState);
      try { const result = await invoke(); const saved = journal.recordOperation(operation.operationId, "confirmed", result); nativeEvent(publishState); return saved; }
      catch (error) {
        const observed = journal.getOperation(operation.operationId);
        if (observed && (["confirmed", "failed", "rejected", "expired"].includes(observed.state) || ["initial", "send_message", "execute_command"].includes(operation.kind) && observed.state === "provider_accepted")) { nativeEvent(publishState); return observed; }
        const saved = journal.recordOperation(operation.operationId, error instanceof NativeRpcError ? "rejected" : "unknown", null, error instanceof Error ? error.message : String(error)); nativeEvent(publishState); return saved;
      }
    })();
    active.set(operation.operationId, execute); void execute.finally(() => active.delete(operation.operationId)).catch(fail); return execute;
  };
  const relay = createControllerRelay(ticket, journal, {
    onConnection: connected => { synchronized = connected; if (!stopping) { try { publishState(); } catch (error) { fail(error); } } },
    onError: diagnostic,
    onCommand: async command => {
      if (command.sessionId !== ticket.sessionId || command.claimId !== ticket.claimId || command.testExecutionId !== ticket.testExecutionId || command.executionGeneration !== ticket.executionGeneration) throw new Error("Stale session command.");
      const operation = journal.prepareOperation({ operationId: command.operationId, kind: command.kind, payload: command.payload });
      if (operation.state !== "accepted") { relay.receipt(operation); return; }
      if (!provider || stopping || !synchronized) throw new Error("Native provider is not available.");
      await queueNative(command.kind, async () => {
        const current = journal.getOperation(command.operationId);
        if (current && current.state !== "accepted") { relay.receipt(current); return; }
        if (!provider || stopping || !synchronized) throw new Error("Native provider is not available.");
        await relay.authorize(command.operationId);
        if (!relay.connected() || stopping) throw new Error("Relay authorization lost before native dispatch.");
        const result = await dispatch(operation, () => executeCommand(command)); relay.receipt(result);
      });
    },
  });
  const executeCommand = async (command: SessionCommand) => {
    if (!provider || stopping) throw new NativeRpcError(-32602, "Native provider is unavailable.");
    if (cleaning && command.kind !== "interaction_response") throw new NativeRpcError(-32602, "The controller is cleaning this execution.");
    assertControlCommand(command, journal.getSnapshot());
    if (command.kind === "update_setting") {
      if (!provider.setSetting) throw new NativeRpcError(-32602, "Native settings are unavailable.");
      return provider.setSetting(command.payload.settingId, command.payload.value, command.operationId, command.payload.expectedControlsRevision);
    }
    if (command.kind === "execute_command") {
      if (!provider.executeCommand || !["not_required", "provider_accepted", "confirmed"].includes(journal.getSnapshot().initialInputState)) throw new NativeRpcError(-32602, "Native commands are unavailable.");
      return provider.executeCommand(command.payload.commandId, command.payload.arguments, command.operationId, command.payload.expectedControlsRevision, command.payload.expectedTurnId);
    }
    if (command.kind === "refresh_controls") {
      if (!provider.refreshControls) throw new NativeRpcError(-32602, "Native controls are unavailable.");
      return provider.refreshControls();
    }
    if (command.kind === "send_message") {
      if (!["not_required", "provider_accepted", "confirmed"].includes(journal.getSnapshot().initialInputState)) throw new NativeRpcError(-32602, "Initial task input is not confirmed.");
      if (ticket.initialInput === "none" && journal.getSnapshot().nativeSessionId === null && journal.listOperations().some(operation => operation.operationId !== command.operationId && operation.kind === "send_message" && ["dispatching", "provider_accepted", "confirmed", "unknown"].includes(operation.state))) throw new NativeRpcError(-32602, "The first native input is still unconfirmed; its original operation must be reconciled.");
      return provider.send(command.payload.content.map(part => part.text).join("\n"), command.operationId, command.payload.expectedTurnId);
    }
    if (command.kind === "cancel") return provider.cancel(command.payload.expectedTurnId);
    if (cleaning && !cleanupInteractions.has(command.payload.interactionId)) throw new NativeRpcError(-32602, "Only the current cleanup interaction may be answered.");
    return provider.respond(command.payload.interactionId, command.payload.interactionRevision, command.payload.response);
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
    try {
      await startup?.catch(() => {});
      journal.patchSnapshot({ lifecycle: "stopping" });
      await provider?.close(); await Promise.all(processCaptures);
      journal.patchSnapshot({ activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false } });
      if (projectionFailure) {
        // Drain committed events before recording a visible gap. Never discard an
        // earlier outbox row to make room for a later native callback.
        await relay.flush();
        journal.drainProjectionGap();
      }
      publishState(); await relay.flush().catch(fail);
    }
    catch (error) { fail(error); }
    finally { relay.close(); for (const socket of sockets) socket.destroy(); server.close(); journal.close(); if (process.platform !== "win32") await unlink(ticket.ipcEndpoint).catch(() => {}); complete(); }
    })();
    return shutdownPromise;
  };
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.setTimeout(30_000, () => socket.destroy()); socket.setEncoding("utf8"); let buffer = "", handled = false;
    socket.on("data", (text: string) => {
      if (handled) return; buffer += text; if (Buffer.byteLength(buffer) > 5 * 1024 * 1024) { socket.destroy(); return; }
      const newline = buffer.indexOf("\n"); if (newline < 0) return; handled = true;
      void (async () => {
        let requestId = "";
        try {
          const request = validateControllerLocalRequest(JSON.parse(buffer.slice(0, newline)), ticket); requestId = request.requestId;
          let operation: ControllerOperation | undefined;
          if (request.action.kind === "stop") {
            socket.end(JSON.stringify({ requestId, ok: true, snapshot: journal.getSnapshot() } satisfies ControllerLocalResponse) + "\n", () => { void shutdown(); }); return;
          }
          if (request.action.kind !== "observe") {
            if (!stopping && request.action.kind === "submit_initial" && (!provider || !synchronized)) {
              // No dispatch intent exists yet. The worker may observe again
              // after startup/reconnection without treating this as a failure.
              journal.patchSnapshot({ lifecycle: "starting" });
              socket.end(JSON.stringify({ requestId, ok: true, snapshot: journal.getSnapshot() } satisfies ControllerLocalResponse) + "\n"); return;
            }
            if (!provider || stopping || request.action.kind === "submit_initial" && !synchronized) throw new Error("Controller is still initializing or disconnected.");
            if (request.action.kind === "submit_initial") {
              const prepared = journal.prepareOperation({ operationId: ticket.initialOperationId, kind: "initial", payload: { text: ticket.initialPrompt } });
              operation = await dispatch(prepared, () => provider!.send(ticket.initialPrompt, ticket.initialOperationId, null));
            } else {
              const action = request.action;
              cleaning = true; cleanupInputStarted = false; cleanupInteractions.clear(); nativeEvent(publishState);
              if (stopping) throw new Error("Controller stopped after a durable event failure.");
              if (Date.now() >= action.deadline) throw new Error("Cleanup deadline expired.");
              const prepared = journal.prepareOperation({ operationId: action.operationId, kind: "cleanup", payload: { text: action.prompt, deadline: action.deadline } });
              operation = await dispatch(prepared, async () => {
                const turn = journal.getSnapshot().currentTurnId;
                if (turn !== null) {
                  await provider!.cancel(turn);
                  while (journal.getSnapshot().currentTurnId !== null && Date.now() < action.deadline) await new Promise(resolve => setTimeout(resolve, 25));
                }
                if (Date.now() >= action.deadline) throw new Error("Cleanup deadline expired before input submission.");
                journal.assertInputCapacity();
                cleanupInputStarted = true;
                const receipt = await provider!.send(action.prompt, action.operationId, null);
                journal.recordOperation(action.operationId, "provider_accepted", receipt);
                if (!receipt.turnId) throw new Error("Native cleanup turn identity is unknown.");
                await provider!.waitForTurn(receipt.turnId, action.deadline);
                return receipt;
              });
            }
          }
          socket.end(JSON.stringify({ requestId, ok: true, snapshot: journal.getSnapshot(), ...(operation ? { operation } : {}) } satisfies ControllerLocalResponse) + "\n");
        } catch (error) { socket.end(JSON.stringify({ requestId, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ControllerLocalResponse) + "\n"); }
      })().catch(fail);
    });
  });
  const nativeEvent = (write: () => void) => {
    if (projectionFailure) return;
    try { write(); }
    catch (error) {
      projectionFailure = error instanceof Error ? error.message : String(error); fail(error);
      try { journal.markProjectionGap("Native projection stopped after a durable event failure. Resume must reload native history."); } catch (failure) { fail(failure); }
      // Initialization must acquire the provider handle before it can close it.
      if (provider) void shutdown();
    }
  };
  const signal = () => { void shutdown(); };
  process.once("SIGINT", signal); process.once("SIGTERM", signal);
  startup = (async () => {
    journal.patchSnapshot({ controllerProcess: await captureControllerProcessProof(ticket.launchId) });
    if (stopping) return;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(ticket.ipcEndpoint, () => { server.off("error", reject); resolve(); }); });
    if (process.platform !== "win32") await chmod(ticket.ipcEndpoint, 0o600);
    if (stopping) return;
    const env = { ...process.env };
    for (const key of ["CODEX_THREAD_ID", "CODEX_TURN_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "DAYNIGHT_CONTROLLER_TOKEN"]) delete env[key];
    if (ticket.provider === "codex") env.CODEX_HOME = ticket.nativeHome;
    else if (ticket.provider === "claude") env.CLAUDE_CONFIG_DIR = ticket.nativeHome;
    else env.COPILOT_HOME = ticket.nativeHome;
    const nativeOptions: ProviderOptions = {
      ...(journal.getSnapshot().controlsRevisionFloor ? { controlsRevisionFloor: journal.getSnapshot().controlsRevisionFloor! } : {}),
      cwd: ticket.cwd, model: ticket.configuration.model, args: ticket.configuration.args, resumeNativeSessionId: ticket.resumeNativeSessionId, unattended: ticket.claimId !== undefined, env,
      onDiagnostic: diagnostic,
      onFatalError: error => {
        if (providerFailure) return;
        providerFailure = error.message; fail(error);
        // Startup must first acquire the provider handle. Awaiting shutdown from
        // an opening callback would make startup wait for its own completion.
        if (provider) void shutdown();
      },
      onInputObserved: operationId => nativeEvent(() => {
        if (!observeNativeInput(journal, operationId)) return;
        publishState();
        const receipt = journal.getOperation(operationId);
        if (receipt?.kind === "send_message" || receipt?.kind === "execute_command") { try { relay.receipt(receipt); } catch (error) { diagnostic(String(error)); } }
      }),
      onControlConfirmed: operationId => nativeEvent(() => {
        const operation = journal.getOperation(operationId);
        if (!operation || !["update_setting", "execute_command"].includes(operation.kind) || !["dispatching", "provider_accepted", "unknown"].includes(operation.state)) return;
        const receipt = journal.recordOperation(operationId, "confirmed", { disposition: "handled" });
        publishState(); try { relay.receipt(receipt); } catch (error) { diagnostic(String(error)); }
      }),
      onTimeline: entry => nativeEvent(() => {
        journal.projectTimeline(entry);
        if (entry.kind === "interaction") {
          const id = entry.interaction.interactionId;
          if (cleaning && cleanupInputStarted && !knownInteractions.has(id) && entry.interaction.state === "pending") cleanupInteractions.add(id);
          knownInteractions.add(id);
          if (entry.interaction.state !== "pending") cleanupInteractions.delete(id);
          if (cleaning) publishState();
        }
        if (entry.kind === "interaction" && entry.interaction.state === "resolved") {
          for (const receipt of observeNativeInteraction(journal, entry.interaction.interactionId, ticket.executionGeneration)) {
            try { relay.receipt(receipt); } catch (error) { diagnostic(String(error)); }
          }
        }
      }),
      onState: state => nativeEvent(() => { const { nativeSessionId, ...status } = state; journal.patchSnapshot({ ...status, ...(nativeSessionId !== null ? { nativeSessionId } : {}), lifecycle: state.activity === "idle" ? "ready" : state.activity === "stopped" ? "stopping" : "working" }); publishState(); }),
      onSpawn: child => { if (!child.pid) throw new Error("Native process identity is unavailable."); const capture = captureProcessProof(child.pid).then(proof => { const s = journal.getSnapshot(); journal.patchSnapshot({ nativeProcesses: [...s.nativeProcesses, proof] }); }); processCaptures.push(capture); void capture.catch(fail); },
    };
    provider = await (ticket.provider === "codex" ? (await import("./providers/codex.js")).openCodexProvider(nativeOptions)
      : ticket.provider === "claude" ? (await import("./providers/claude.js")).openClaudeProvider(nativeOptions)
      : (await import("./providers/copilot.js")).openCopilotProvider(nativeOptions));
    await Promise.all(processCaptures);
    if (projectionFailure) throw new Error(projectionFailure);
    if (providerFailure) throw new Error(providerFailure);
    if (stopping) return;
    journal.patchSnapshot({ lifecycle: "ready" }); publishState();
  })();
  try {
    await startup;
    await finished;
  } catch (error) { fail(error); await shutdown(); throw error; }
  finally { process.off("SIGINT", signal); process.off("SIGTERM", signal); }
};
