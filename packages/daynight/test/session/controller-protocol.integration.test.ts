import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { openControllerLifecycleStore } from "../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../src/commands/controller/launch-ticket.js";
import { createControllerRelay, publicOperation } from "../../src/commands/controller/relay.js";
import { RELAY_LIMITS, parseControllerMessage } from "../../src/session/controller-protocol.js";
const id = "00000000-0000-4000-8000-000000000001";
describe("relay transport persistence", () => {
  it.each(["rejected", "expired"] as const)("persists an old-generation %s reconciliation through the real relay and SQLite journal", async (state) => {
    const base = path.resolve(import.meta.dirname, "../../../../.tmp/controller-tests");
    await mkdir(base, { recursive: true });
    const home = await mkdtemp(path.join(base, "reconcile-"));
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let journal: ReturnType<typeof openControllerLifecycleStore> | undefined;
    let relay: ReturnType<typeof createControllerRelay> | undefined;
    try {
      await once(server, "listening");
      const address = server.address();
      if (typeof address === "string" || !address) throw new Error("Missing relay listen address");
      const original: ControllerLaunchTicket = {
        schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(),
        sessionId: randomUUID(), executionGeneration: "1", serverOrigin: `http://127.0.0.1:${address.port}`,
        projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(),
        provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"),
        configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 },
        initialOperationId: randomUUID(), initialPrompt: "worker-managed task", resumeNativeSessionId: null,
        credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
      };
      const filename = path.join(home, "state.sqlite");
      journal = openControllerLifecycleStore(filename, original);
      const operation = journal.prepareOperation({ operationId: randomUUID(), kind: "send_message", payload: { text: "Do not replay" } });
      const nativeSessionId = randomUUID();
      journal.patchSnapshot({ lifecycle: "stopped", nativeStopped: true, nativeSessionId });
      journal.close(); journal = undefined;
      const ticket = { ...original, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: nativeSessionId };
      journal = openControllerLifecycleStore(filename, ticket);
      await writeFile(ticket.credentialFile, JSON.stringify({ token: "local-test-grant", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }), { mode: 0o600 });
      const fixture = JSON.parse(await readFile(new URL("./fixtures/snapshot.json", import.meta.url), "utf8"));
      const snapshot = { ...fixture, sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: "2", connectionEpoch: "1", identity: { ...fixture.identity, projectId: ticket.projectId, taskId: ticket.taskId, workerId: ticket.workerId, worktreeId: ticket.worktreeId, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, nativeSessionId } };
      const messages: ReturnType<typeof parseControllerMessage>[] = [];
      server.on("connection", socket => socket.on("message", data => {
        const message = parseControllerMessage(JSON.parse(data.toString()));
        messages.push(message);
        if (message.type === "hello") socket.send(JSON.stringify({ type: "welcome", protocol: fixture.protocol, connectionEpoch: "1", session: snapshot, lastAckedSourceSeq: "0", limits: RELAY_LIMITS }));
        if (message.type === "reconcile") socket.send(JSON.stringify({ type: "reconcile_result", protocol: fixture.protocol, sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: "2", connectionEpoch: "1", operations: [{ ...publicOperation(original, operation), state, error: { code: "permission_or_state_changed", message: "Refused before dispatch" } }] }));
      }));
      const callbacks = { onConnection: vi.fn(), onCommand: vi.fn(async () => {}), onError: vi.fn() };
      relay = createControllerRelay(ticket, journal, callbacks);
      await vi.waitFor(() => expect(relay!.connected()).toBe(true));
      expect(messages.find(message => message.type === "reconcile")).toMatchObject({ executionGeneration: "2", operations: [{ operationId: operation.operationId, state: "not_submitted" }] });
      expect(journal.getOperation(operation.operationId)).toMatchObject({ executionGeneration: "1", state, error: "Refused before dispatch" });
      expect(journal.listUnacknowledgedOperations()).toEqual([]);
      expect(callbacks.onCommand).not.toHaveBeenCalled();
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(messages.some(message => message.type === "operation_begin" || message.type === "operation_receipt")).toBe(false);
      relay.close(); relay = undefined;
      journal.close(); journal = undefined;
      journal = openControllerLifecycleStore(filename, ticket);
      expect(journal.getOperation(operation.operationId)).toMatchObject({ executionGeneration: "1", state });
      expect(journal.listUnacknowledgedOperations()).toEqual([]);
      expect(() => journal!.markDispatching(operation.operationId)).toThrow(/replay/);
    } finally {
      relay?.close();
      journal?.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
});
