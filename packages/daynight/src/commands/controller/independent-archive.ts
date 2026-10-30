import { readdir, readFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CliContext } from "../../cli/context.js";
import { resolveConfigurationPaths } from "../../config/paths.js";
import { loadServerConfiguration } from "../../config/server.js";
import { SESSION_PROTOCOL, assertSessionFence, sessionFence, type SessionProvider } from "../../session/protocol.js";
import { parseRegistrationResponse } from "../../session/controller-protocol.js";
import { controllerExecutionDirectory, readLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import { recordStoppedControllerGeneration } from "./lifecycle-store.js";
import { uploadStoppedControllerArchive } from "./archive-upload.js";
import { writeDurableJson } from "./pending-content.js";

/** Archive retry has no process launch, native resume, or business-input path. */
export const retryIndependentArchive = async (input: { provider: SessionProvider; sessionId: string }, context: CliContext): Promise<void> => {
  const home = context.homeDirectory(), paths = resolveConfigurationPaths(home);
  const config = await loadServerConfiguration(paths);
  if (!config.serverToken) throw new Error("Log in before retrying Test Session history upload.");
  const directory = path.join(paths.stateDirectory, "controller", "launches");
  const files = await readdir(directory);
  if (files.length > 20_000) throw new Error("Controller launch inventory exceeds its safe bound.");
  let ticket: ControllerLaunchTicket | undefined;
  for (const file of files) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const candidate = await readLaunchTicket(home, file.slice(0, -5));
    if (candidate.testExecutionId === undefined || candidate.sessionId !== input.sessionId || candidate.provider !== input.provider || candidate.serverOrigin !== config.serverUrl) continue;
    if (ticket) throw new Error("Conflicting local Test Session launch records require reconciliation.");
    ticket = candidate;
  }
  if (!ticket) throw new Error("No local Test Session matches this provider, session ID and configured server.");
  const execution = controllerExecutionDirectory(home, ticket.executionId), journalPath = path.join(execution, "journal.sqlite");
  const stopped = await recordStoppedControllerGeneration(journalPath, ticket);
  const proofPath = path.join(execution, "stop-proof.json");
  let body: unknown;
  if (existsSync(proofPath)) {
    const stat = await lstat(proofPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768 || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Test Session stop proof must be a private regular file.");
    body = JSON.parse(await readFile(proofPath, "utf8"));
    assertSessionFence(body as Parameters<typeof assertSessionFence>[0], ticket);
    const identity = body as { controllerId: string; controllerInstanceId: string; protocol: string };
    if (identity.controllerId !== ticket.controllerId || identity.controllerInstanceId !== ticket.controllerInstanceId || identity.protocol !== SESSION_PROTOCOL) throw new Error("Stop proof does not match the original controller.");
  } else {
    body = { protocol: SESSION_PROTOCOL, ...sessionFence(ticket), controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, stopProof: { recordId: randomUUID(), previousControllerInstanceId: ticket.controllerInstanceId, stoppedAt: stopped.stoppedAt } };
    writeDurableJson(proofPath, body);
  }
  // A retry may close a still-active server record after local stop was already proven.
  try {
    const pending = await fetch(`${config.serverUrl}/api/v1/test-sessions/${ticket.sessionId}/archive`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${config.serverToken}`, "content-type": "application/json" }, body: JSON.stringify({ ...sessionFence(ticket), controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, state: "pending", errorCode: null }), signal: AbortSignal.timeout(10_000) });
    await pending.body?.cancel();
  } catch { /* Metadata publication must not prevent stop reconciliation. */ }
  const response = await fetch(`${config.serverUrl}/api/v1/test-sessions/${ticket.sessionId}/stop`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${config.serverToken}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Native execution is stopped; server stop reconciliation failed (${response.status}).`);
  const result = parseRegistrationResponse(await response.json()).session;
  assertSessionFence(result, ticket);
  if (result.lifecycle !== "archived") throw new Error("Native execution is stopped; server session closure is unconfirmed.");
  writeDurableJson(path.join(execution, "stop-result.json"), { session: result });
  await uploadStoppedControllerArchive({ journalPath, ticket, serverToken: config.serverToken });
  context.stdout(`Test Session history archived: ${new URL(`/test-sessions/${ticket.sessionId}`, config.serverUrl).href}\n`);
};
