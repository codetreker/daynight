import { spawn } from "node:child_process";
import { open, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { controllerExecutionDirectory, controllerTicketPath, readLaunchTicket, writeLaunchTicket, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { readControllerSnapshot } from "../../controller/lifecycle-store.js";
import { requestController } from "../../controller/local-client.js";
import { captureProcessProof } from "../../controller/process-proof.js";
import type { WebExecutionStore } from "./web-store.js";
import type { LocalTask } from "./web-types.js";
import type { WorkerSessionApi } from "./session-api.js";
import { writeControllerCredential } from "./session-api.js";
export const createWebControllerLauncher = (options: { homeDirectory: string; packageDirectory: string; store: WebExecutionStore; sessionApi: WorkerSessionApi; now: () => number }) => {
  const current = (task: LocalTask) => { const latest = options.store.getTask(task); if (latest?.webExecution == null) throw new Error("The web execution identity disappeared."); return latest; };
  const tails = new Map<string, Promise<void>>();
  const serialize = async <T>(task: LocalTask, action: () => Promise<T>): Promise<T> => {
    const key = task.webExecution?.executionId ?? task.claimId;
    const previous = tails.get(key) ?? Promise.resolve(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    tails.set(key, tail); await previous;
    try { return await action(); } finally { release(); if (tails.get(key) === tail) tails.delete(key); }
  };
  const methods = {
    prepare: async (input: LocalTask, prompt: string, signal: AbortSignal): Promise<ControllerLaunchTicket> => {
      let task = current(input); let execution = task.webExecution!;
      if (execution.ticketPath !== null) { const ticket = await readLaunchTicket(options.homeDirectory, execution.launchId); if (execution.nativeHome === null) options.store.updateWebExecution(task,{nativeHome:ticket.nativeHome},options.now()); return ticket; }
      try {
        const existing = await readLaunchTicket(options.homeDirectory, execution.launchId);
        if (existing.executionId !== execution.executionId || existing.claimId !== task.claimId || existing.executionGeneration !== execution.executionGeneration || existing.controllerInstanceId !== execution.controllerInstanceId || existing.initialOperationId !== execution.initialOperationId || existing.sessionId !== execution.sessionId || existing.initialPrompt !== execution.initialPrompt) throw new Error("An existing launch ticket does not match the durable execution intent.");
        options.store.updateWebExecution(task, { ticketPath: controllerTicketPath(options.homeDirectory, execution.launchId), nativeHome: existing.nativeHome }, options.now()); return existing;
      } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      if (execution.initialPrompt === null) { task = options.store.updateWebExecution(task, { initialPrompt: prompt }, options.now()); execution = task.webExecution!; }
      if (task.resources.worktree === null || task.configuration === null || task.userId === null) throw new Error("Controller launch requires its original worktree, provider and owner.");
      if (execution.sessionId === null) { const registered = await options.sessionApi.register(task, execution, signal); task = options.store.updateWebExecution(task, { sessionId: registered.sessionId }, options.now()); execution = task.webExecution!; }
      const directory = controllerExecutionDirectory(options.homeDirectory, execution.executionId); await mkdir(directory, { recursive: true, mode: 0o700 });
      const credentialFile = path.join(directory, "credential.json");
      const previous = readControllerSnapshot(path.join(directory, "journal.sqlite"));
      const stop = previous !== null && previous.executionGeneration !== execution.executionGeneration && previous.nativeStopped && previous.stoppedAt !== null ? { generation: previous.executionGeneration, instanceId: previous.controllerInstanceId, recordId: execution.launchId, stoppedAt: previous.stoppedAt } : undefined;
      const grant = await options.sessionApi.grant(task, execution, signal, stop); await writeControllerCredential(credentialFile, grant);
      const endpointKey = createHash("sha256").update(`${options.homeDirectory}:${execution.launchId}`).digest("hex").slice(0, 20);
      const ipcEndpoint = process.platform === "win32" ? `\\\\.\\pipe\\daynight-${endpointKey}` : path.join(options.homeDirectory, ".daynight", "c", `${endpointKey}.sock`);
      if (process.platform !== "win32" && Buffer.byteLength(ipcEndpoint) > (process.platform === "darwin" ? 103 : 107)) throw new Error("The controller IPC endpoint exceeds this platform's socket path limit.");
      if (process.platform !== "win32") await mkdir(path.dirname(ipcEndpoint), { recursive: true, mode: 0o700 });
      if (task.resources.worktree === null || task.configuration === null || task.userId === null) throw new Error("The frozen launch binding disappeared.");
      const nativeHome = execution.nativeHome ?? (task.configuration.agent === "codex" ? process.env.CODEX_HOME ?? path.join(options.homeDirectory, ".codex")
        : task.configuration.agent === "claude" ? process.env.CLAUDE_CONFIG_DIR ?? path.join(options.homeDirectory, ".claude")
        : process.env.COPILOT_HOME ?? path.join(options.homeDirectory, ".copilot"));
      if (execution.nativeHome === null) execution = options.store.updateWebExecution(task,{nativeHome},options.now()).webExecution!;
      const initialPrompt = execution.initialPrompt ?? prompt;
      const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId, provider: task.configuration.agent, cwd: task.resources.worktree.worktreePath, nativeHome, configuration: task.configuration, initialOperationId: execution.initialOperationId, initialPrompt, resumeNativeSessionId: task.resources.nativeSession?.sessionId ?? null, credentialFile, ipcEndpoint, ipcSecret: randomBytes(32).toString("hex"), createdAt: new Date(options.now()).toISOString() };
      const ticketPath = await writeLaunchTicket(options.homeDirectory, ticket);
      options.store.updateWebExecution(task, { ticketPath, initialPrompt }, options.now());
      return ticket;
    },
    launch: async (input: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal): Promise<void> => {
      let task = current(input); if (task.webExecution!.launchSubmission !== "not-submitted") return;
      // A reusable grant also supports the first hello, including a lost bootstrap handshake.
      await writeControllerCredential(ticket.credentialFile, await options.sessionApi.grant(task, { ...task.webExecution!, launchSubmission: "unknown" }, signal));
      const directory = controllerExecutionDirectory(options.homeDirectory, ticket.executionId);
      const log = await open(path.join(directory, "controller.log"), "a", 0o600);
      try {
        signal.throwIfAborted();
        task = options.store.updateWebExecution(task, { launchSubmission: "unknown" }, options.now());
        const child = spawn(process.execPath, [path.join(options.packageDirectory, "dist", "main.js"), "controller", ticket.provider, "--launch-id", ticket.launchId], { cwd: ticket.cwd, env: { ...process.env, HOME: options.homeDirectory, USERPROFILE: options.homeDirectory }, detached: process.platform !== "win32", stdio: ["ignore", log.fd, log.fd], windowsHide: true });
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        child.unref();
        if (child.pid === undefined) throw new Error("Controller spawn did not establish its process identity.");
        const proof = await captureProcessProof(child.pid);
        task = options.store.updateWebExecution(task, { controllerProcess: proof }, options.now());
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          let response: Awaited<ReturnType<typeof requestController>> | undefined;
          try { response = await requestController(ticket, { kind: "observe" }, { signal, timeoutMs: 1000 }); }
          catch { if (child.exitCode !== null || child.signalCode !== null) throw new Error("Controller exited before its authenticated initialization; inspect its private log."); }
          if (response !== undefined) {
            options.store.updateWebExecution(task, { launchSubmission: "acknowledged", nativeProcesses: response.snapshot.nativeProcesses }, options.now());
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error("Controller startup outcome is unknown; the original process and launch intent are retained.");
      } finally { await log.close(); }
    },
    refreshGrant: async (input: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal): Promise<void> => {
      const task = current(input);
      if (task.webExecution!.launchId !== ticket.launchId || task.cleanup?.agentStopped) return;
      let expiresAt: unknown; try { expiresAt = (JSON.parse(await readFile(ticket.credentialFile, "utf8")) as { expiresAt: unknown }).expiresAt; } catch { throw new Error("Controller credential state is unavailable; it cannot be silently replaced."); }
      if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) throw new Error("Controller credential expiry is invalid.");
      if (Date.parse(expiresAt) - options.now() > 120_000) return;
      const grant = await options.sessionApi.grant(task, task.webExecution!, signal);
      const latest = current(task);
      if (latest.webExecution!.launchId !== ticket.launchId || latest.cleanup?.agentStopped) return;
      signal.throwIfAborted();
      await writeControllerCredential(ticket.credentialFile, grant);
    },
  };
  return {
    prepare: (...args: Parameters<typeof methods.prepare>) => serialize(args[0], () => methods.prepare(...args)),
    launch: (...args: Parameters<typeof methods.launch>) => serialize(args[0], () => methods.launch(...args)),
    refreshGrant: (...args: Parameters<typeof methods.refreshGrant>) => serialize(args[0], () => methods.refreshGrant(...args)),
  };
};
