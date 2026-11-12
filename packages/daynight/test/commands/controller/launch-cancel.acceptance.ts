import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createAcceptanceCli } from "../../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../../fixtures/installed-cli.js";
import { inspectProcessProof, stopControllerProcesses, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { stopControllerBootstrap } from "../../../src/commands/controller/launch-observation.js";
import { readControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { parseControllerMessage, RELAY_LIMITS } from "../../../src/session/controller-protocol.js";

it.skipIf(process.platform === "win32")("cancels the original installed Test Controller after its spawn proof is durable", async () => {
  const installed = await createAcceptanceCli(), root = installed.receipt.root;
  const state = path.join(root, "state"), home = path.join(root, "home"), bin = path.join(root, "bin");
  await Promise.all([mkdir(state), mkdir(home), mkdir(bin)]);
  const sessionId = randomUUID(), userId = randomUUID();
  let registration: Record<string, string> | undefined, session: Record<string, unknown> | undefined;
  let registrations = 0, grants = 0, stops = 0;
  const relayErrors: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string> : {};
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/test-session-capabilities") response.end(JSON.stringify({ protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, providers: ["codex"] }));
      else if (request.url === "/api/v1/test-sessions") {
        registrations++; registration = body;
        session = { protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, sessionId, testExecutionId: body.testExecutionId, executionGeneration: "1", connectionEpoch: "0", identity: { ownerUserId: userId, controllerId: body.controllerId, controllerInstanceId: body.controllerInstanceId, agentControlMode: "web", provider: "codex", nativeSessionId: null }, sessionRevision: "1", historyEpoch: randomUUID(), lastEventSeq: "0", lastTimelineSeq: "0", initialInputState: "not_required", synchronized: false, lifecycle: "active", connectionState: "disconnected", activity: "initializing", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, operations: { canSend: false, canCancel: false, canRespond: false } };
        response.end(JSON.stringify({ session }));
      } else if (request.url?.endsWith("/controller-grant") && registration) {
        grants++; response.end(JSON.stringify({ token: "controlled-grant", expiresAt: new Date(Date.now() + 900_000).toISOString(), sessionId, testExecutionId: registration.testExecutionId, executionGeneration: "1", controllerId: registration.controllerId, controllerInstanceId: registration.controllerInstanceId }));
      } else if (request.url?.endsWith("/stop") && session) { stops++; response.end(JSON.stringify({ session: { ...session, lifecycle: "archived" } })); }
      else if (request.url?.endsWith("/archive")) response.end(JSON.stringify({ archive: { state: "pending", sha256: null, byteLength: null, errorCode: null } }));
      else { response.writeHead(404); response.end("{}"); }
    });
  });
  const relay = new WebSocketServer({ server });
  relay.on("connection", socket => socket.on("message", raw => {
    try {
      if (!session || !registration) throw new Error("Controller connected before registration.");
      const message = parseControllerMessage(JSON.parse(raw.toString()));
      const fence = { protocol: "daynight.session.v1", sessionId, testExecutionId: registration.testExecutionId, executionGeneration: "1", connectionEpoch: "1" };
      if (message.type === "hello") socket.send(JSON.stringify({ type: "welcome", protocol: "daynight.session.v1", connectionEpoch: "1", session: { ...session, connectionEpoch: "1", connectionState: "connected", synchronized: true, activity: "idle" }, lastAckedSourceSeq: "0", limits: RELAY_LIMITS, requiresLiveSync: true }));
      else if (message.type === "reconcile") socket.send(JSON.stringify({ ...fence, type: "reconcile_result", operations: [] }));
      else if (message.type === "events") socket.send(JSON.stringify({ ...fence, type: "events_ack", sourceEpoch: message.sourceEpoch, batchId: message.batchId, lastAckedSourceSeq: message.events.at(-1)!.sourceSeq, lastEventSeq: message.events.at(-1)!.sourceSeq }));
      else if (message.type === "sync_state") socket.send(JSON.stringify({ ...fence, type: "sync_ack" }));
    } catch (error) { relayErrors.push(error); socket.close(1008); }
  }));
  let child: ChildProcess | undefined, closed: Promise<number | null> | undefined;
  let proof: ProcessProof | undefined, directory = "";
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Fixture address is unavailable.");
    await writeFile(path.join(state, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: controlled-token\n`);
    const native = path.join(root, "native.mjs"), requestLog = path.join(root, "native-requests.jsonl");
    const nativeSource = (await readFile(new URL("./fixtures/codex-native.mjs", import.meta.url), "utf8")).replace("from 'better-sqlite3'", `from ${JSON.stringify(import.meta.resolve("better-sqlite3"))}`);
    await writeFile(native, nativeSource);
    await writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(native)} "$@"\n`, { mode: 0o755 });
    const environment = { ...process.env, HOME: home, USERPROFILE: home, DN_CONFIG_DIR: state, CODEX_HOME: path.join(home, ".codex"), CODEX_TEST_REQUEST_LOG: requestLog, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
    child = spawn(installed.receipt.launcherPath, ["controller", "codex"], { cwd: home, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.on("data", chunk => { output += String(chunk); });
    closed = new Promise(resolve => child!.once("close", code => resolve(code)));
    await vi.waitFor(async () => {
      expect(registration).toBeDefined();
      directory = path.join(state, "controller", "executions", registration!.testExecutionId!);
      proof = JSON.parse(await readFile(path.join(directory, "process.json"), "utf8")) as ProcessProof;
      expect(proof.pid).toBeGreaterThan(0);
    }, { timeout: 30_000, interval: 25 });
    await vi.waitFor(() => { expect(output).toContain("Provider ready: codex"); }, { timeout: 30_000, interval: 50 });
    const before = readControllerSnapshot(path.join(directory, "journal.sqlite"));
    expect(before).toMatchObject({ lifecycle: "ready", controllerProcess: { pid: proof!.pid }, nativeStopped: false });
    expect(before!.nativeProcesses.length).toBeGreaterThan(0);
    child.kill("SIGINT");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { expect(await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Installed Controller cleanup timed out: ${output}`)), 30_000); })])).toBe(0); }
    finally { if (timer) clearTimeout(timer); }
    expect(await inspectProcessProof(proof!)).toBe("stopped");
    expect(registrations).toBe(1); expect(grants).toBe(2); expect(stops).toBe(1);
    expect(relayErrors).toEqual([]);
    expect(readControllerSnapshot(path.join(directory, "journal.sqlite"))).toMatchObject({ lifecycle: "stopped", nativeStopped: true });
    expect(JSON.parse(await readFile(path.join(directory, "stop-proof.json"), "utf8"))).toMatchObject({ sessionId, testExecutionId: registration!.testExecutionId });
    const requests = (await readFile(requestLog, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string });
    expect(requests.filter(request => request.method === "thread/start")).toHaveLength(1);
    expect(requests.some(request => request.method === "turn/start")).toBe(false);
    const launches = await readdir(path.join(state, "controller", "launches")); expect(launches).toHaveLength(1);

  } finally {
    const failures: unknown[] = [];
    try { if (child && closed && child.exitCode === null && child.signalCode === null) await terminateInstalledProcess(child, closed); } catch (error) { failures.push(error); }
    try {
      if (!proof && directory) { try { proof = JSON.parse(await readFile(path.join(directory, "process.json"), "utf8")) as ProcessProof; } catch { /* No durable process proof exists. */ } }
      if (proof && await inspectProcessProof(proof) !== "stopped") await stopControllerBootstrap(proof, Date.now() + 10_000);
      if (directory) { const snapshot = readControllerSnapshot(path.join(directory, "journal.sqlite")); if (snapshot?.controllerProcess) await stopControllerProcesses(snapshot.controllerProcess, snapshot.nativeProcesses, Date.now() + 10_000); }
    } catch (error) { failures.push(error); }
    try { for (const socket of relay.clients) socket.terminate(); await new Promise<void>(resolve => relay.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } catch (error) { failures.push(error); }
    try {
      const rootKey = createHash("sha256").update(state).digest("hex").slice(0, 24);
      await rm(`/tmp/daynight-${process.getuid!()}-${rootKey}`, { recursive: true, force: true });
      await installed.cleanup();
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Installed Controller fixture cleanup failed.");
  }
}, 90_000);
