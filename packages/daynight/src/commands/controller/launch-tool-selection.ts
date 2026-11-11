import type { BigIntStats } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createOperation } from "../../api/operation.js";
import { withinOperation } from "../../platform/tool-io.js";
import { readToolRuntimeText } from "../../platform/tool-runtime-io.js";
import { ensureDurableDirectory, syncDurableDirectory } from "../../platform/durable-directory.js";
import { parseResolvedToolLaunch } from "../../platform/tool-launch-record.js";
import type { ResolvedToolLaunch } from "../../platform/tool-executables.js";
import type { ExecutionConfiguration } from "../worker/types.js";
import { controllerExecutionDirectory, controllerPayloadHash, parseLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";

const MAX_SELECTION_BYTES = 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const privateEntry = (entry: BigIntStats): boolean => process.platform === "win32" || entry.uid === BigInt(process.geteuid!()) && (entry.mode & 0o077n) === 0n;
const filename = (home: string, ticket: ControllerLaunchTicket): string => path.join(controllerExecutionDirectory(home, ticket.executionId), "tool-selections", `${ticket.launchId}.json`);
/** Legacy tickets retain their bytes after the Worker freezes a sidecar selection. */
export const matchesLaunchConfiguration = (ticket: ExecutionConfiguration, frozen: ExecutionConfiguration): boolean => {
  const { toolLaunch, toolObservation, ...configuration } = frozen;
  const { toolLaunch: ticketLaunch, toolObservation: ticketObservation, ...ticketConfiguration } = ticket;
  return controllerPayloadHash(configuration) === controllerPayloadHash(ticketConfiguration)
    && (ticketLaunch === undefined || toolLaunch !== undefined && controllerPayloadHash(ticketLaunch) === controllerPayloadHash(toolLaunch))
    && (ticketObservation === undefined || toolObservation !== undefined && controllerPayloadHash(ticketObservation) === controllerPayloadHash(toolObservation));
};
const checkDirectory = async (directory: string): Promise<void> => {
  const entry = await lstat(directory, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink() || !privateEntry(entry) || await realpath(directory) !== directory) throw new Error("Controller tool selections require an original private directory.");
};
const parseSelection = (value: unknown, ticket: ControllerLaunchTicket): ResolvedToolLaunch => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Controller tool selection must be an object.");
  const data = value as Record<string, unknown>;
  const fields = ["schemaVersion", "launchId", "executionId", "ticketHash", "toolLaunch"];
  if (Object.keys(data).length !== fields.length || fields.some(field => !Object.hasOwn(data, field)) || data.schemaVersion !== 1
    || data.launchId !== ticket.launchId || data.executionId !== ticket.executionId || data.ticketHash !== controllerPayloadHash(ticket)) throw new Error("Controller tool selection binding differs from the original ticket.");
  if (ticket.provider === "claude") throw new Error("Claude cannot acquire a Worker tool selection.");
  return parseResolvedToolLaunch(data.toolLaunch, { tool: ticket.provider, context: "web" });
};

/** Read the original selection only; Controllers never create sidecars or consult Worker targets. */
export const readLaunchToolSelection = async (home: string, ticket: ControllerLaunchTicket): Promise<ResolvedToolLaunch | undefined> => {
  parseLaunchTicket(ticket);
  if (ticket.configuration.toolLaunch !== undefined) return parseResolvedToolLaunch(ticket.configuration.toolLaunch, { tool: ticket.provider as "codex" | "copilot", context: "web" });
  const file = filename(home, ticket), directory = path.dirname(file);
  const operation = createOperation({ limits: { totalMs: 5000 } });
  try {
    try { await withinOperation(checkDirectory(directory), operation); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    await withinOperation(checkDirectory(path.dirname(directory)), operation);
    let content: string;
    try { content = await readToolRuntimeText(file, operation, { limit: MAX_SELECTION_BYTES, private: "owner" }); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    return parseSelection(JSON.parse(content) as unknown, ticket);
  } finally { operation.dispose(); }
};

/**
 * The Worker holds its instance lock and proves the original launch never submitted.
 * Recheck that proof before publication and after readback; an existing sidecar is
 * immutable and cannot be rebound even when the caller's current target changes.
 */
export const writeLaunchToolSelection = async (home: string, ticket: ControllerLaunchTicket, launch: ResolvedToolLaunch, assertUnsubmitted: () => void | Promise<void>): Promise<void> => {
  parseLaunchTicket(ticket);
  if (ticket.configuration.toolLaunch !== undefined) throw new Error("An inline tool selection cannot acquire a sidecar.");
  const value = { schemaVersion: 1, launchId: ticket.launchId, executionId: ticket.executionId, ticketHash: controllerPayloadHash(ticket), toolLaunch: launch };
  parseSelection(value, ticket);
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_SELECTION_BYTES) throw new Error("Controller tool selection exceeds its private record limit.");
  await assertUnsubmitted();
  const file = filename(home, ticket), directory = path.dirname(file);
  ensureDurableDirectory(directory);
  await checkDirectory(path.dirname(directory)); await checkDirectory(directory);
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(serialized); await handle.sync(); }
    finally { await handle.close(); }
    await assertUnsubmitted();
    await checkDirectory(directory);
    try { await link(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    syncDurableDirectory(directory);
    const saved = await readLaunchToolSelection(home, ticket);
    if (controllerPayloadHash(saved) !== controllerPayloadHash(launch)) throw new Error("The original launch is already bound to another tool selection.");
    await assertUnsubmitted();
  } finally {
    await unlink(temporary);
    syncDurableDirectory(directory);
  }
};
