import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, lstat, link, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalId } from "../../api/parse.js";
import { resolveControllerStateDirectory } from "./paths.js";
import { normalizeServerUrl } from "../../config/server.js";
import { sessionBinding, type SessionBinding } from "../../session/protocol.js";
import type { FrozenExecutionConfiguration } from "../worker/types.js";
import { parseResolvedToolLaunch } from "../../platform/tool-launch-record.js";
import { parseFrozenToolObservation } from "../worker/tool-observation.js";

// Retain the legacy 5 MiB allowance plus room for a fully JSON-escaped 64 KiB role.
export const MAX_TICKET_BYTES = 6 * 1024 * 1024;
export const MAX_INITIAL_PROMPT_BYTES = 4 * 1024 * 1024;
export class LaunchTicketLimitError extends Error {
  constructor(readonly actualBytes: number, readonly maxBytes: number, message: string) { super(message); }
}

type HistoricalBinding = { readonly instanceId: string; readonly instanceEpoch?: string; readonly intentVersion: string; readonly localEpoch: string; readonly scopeGeneration: string; readonly serverOrigin: string; readonly userId: string; readonly workerId: string };

type LaunchCommon = {
  readonly schemaVersion: 1 | 2;
  readonly lifecycleBinding?: HistoricalBinding;
  readonly launchId: string; readonly executionId: string; readonly controllerId: string; readonly controllerInstanceId: string;
  readonly sessionId: string; readonly executionGeneration: string; readonly serverOrigin: string;
  readonly provider: "codex" | "claude" | "copilot"; readonly cwd: string; readonly nativeHome: string;
  readonly configuration: FrozenExecutionConfiguration;
  readonly initialOperationId: string; readonly initialPrompt: string;
  readonly instructions?: string;
  readonly botId?: string;
  readonly codexBotRecovery?: { readonly botId: string; readonly directory: string };
  readonly claudeBotRecovery?: { readonly botId: string; readonly directory: string };
  readonly copilotBotRecovery?: { readonly botId: string; readonly directory: string };
  readonly resumeNativeSessionId: string | null;
  readonly credentialFile: string; readonly ipcEndpoint: string; readonly ipcSecret: string;
  readonly createdAt: string;
};
export type ControllerLaunchTicket = LaunchCommon & SessionBinding & (
  | { readonly claimId: string; readonly projectId: string; readonly taskId: string; readonly workerId: string; readonly worktreeId: string; readonly userId: string; readonly ownerUserId?: never; readonly initialInput?: never; readonly usageScope?: never }
  | { readonly testExecutionId: string; readonly ownerUserId: string; readonly initialInput: "none" | "prompt"; readonly usageScope?: "standalone_test"; readonly projectId?: never; readonly taskId?: never; readonly workerId?: never; readonly worktreeId?: never; readonly userId?: never }
);
export const isBotHistoryTicket = (ticket: ControllerLaunchTicket): boolean => ticket.testExecutionId !== undefined
  && (ticket.botId !== undefined || ticket.codexBotRecovery !== undefined || ticket.claudeBotRecovery !== undefined || ticket.copilotBotRecovery !== undefined);
const uuid = (value: unknown): string => { if (typeof value !== "string" || canonicalId(value) !== value) throw new Error("Controller identity must be a canonical UUID."); return value; };
export const controllerExecutionDirectory = (home: string, executionId: string, storageStateDirectory?: string): string => path.join(resolveControllerStateDirectory(home, storageStateDirectory), "controller", "executions", uuid(executionId));
export const controllerTicketPath = (home: string, launchId: string, storageStateDirectory?: string): string => path.join(resolveControllerStateDirectory(home, storageStateDirectory), "controller", "launches", `${uuid(launchId)}.json`);
const canonicalPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalPayload);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left],[right])=>left<right?-1:left>right?1:0).map(([key,item])=>[key,canonicalPayload(item)]));
  return value;
};
export const controllerPayloadHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonicalPayload(value))).digest("hex");
// Shipped v2 tickets retain their full identity for the original launch.
const parseHistoricalBinding = (value: unknown): HistoricalBinding => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Controller lifecycle binding is missing.");
  const data = value as Record<string, unknown>;
  const hasEpoch = Object.hasOwn(data, "instanceEpoch");
  const fields = ["instanceId", "intentVersion", "localEpoch", "scopeGeneration", "serverOrigin", "userId", "workerId"];
  if (Object.keys(data).sort().join() !== [...(hasEpoch ? ["instanceEpoch"] : []), ...fields].join()) throw new Error("Controller lifecycle binding has invalid fields.");
  for (const key of ["instanceId", "userId", "workerId"]) uuid(data[key]);
  for (const key of [...(hasEpoch ? ["instanceEpoch"] : []), "intentVersion", "localEpoch", "scopeGeneration"]) {
    const number = data[key];
    if (typeof number !== "string" || !/^[1-9][0-9]{0,18}$/.test(number) || BigInt(number) > 9_223_372_036_854_775_807n) throw new Error("Controller lifecycle binding has an invalid version.");
  }
  if (typeof data.serverOrigin !== "string" || normalizeServerUrl(data.serverOrigin) !== data.serverOrigin) throw new Error("Controller lifecycle service is invalid.");
  return value as HistoricalBinding;
};
export const parseLaunchTicket = (value: unknown): ControllerLaunchTicket => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Controller ticket must be an object.");
  const data = value as Record<string, unknown>;
  const binding = sessionBinding(data);
  const test = binding.testExecutionId !== undefined;
  const ids = ["launchId", "executionId", "controllerId", "controllerInstanceId", "sessionId", ...(test ? ["testExecutionId", "ownerUserId"] : ["projectId", "taskId", "claimId", "workerId", "worktreeId", "userId"]), "initialOperationId"];
  const botFields = ["botId", "codexBotRecovery", "claudeBotRecovery", "copilotBotRecovery"].filter(key => Object.hasOwn(data, key));
  const keys = ["schemaVersion", ...ids, ...(Object.hasOwn(data, "lifecycleBinding") ? ["lifecycleBinding"] : []), ...(test ? ["initialInput"] : []), ...(Object.hasOwn(data, "usageScope") ? ["usageScope"] : []), ...(Object.hasOwn(data, "instructions") ? ["instructions"] : []), ...botFields, "executionGeneration", "serverOrigin", "provider", "cwd", "nativeHome", "configuration", "initialPrompt", "resumeNativeSessionId", "credentialFile", "ipcEndpoint", "ipcSecret", "createdAt"];
  if (Object.keys(data).length !== keys.length || keys.some((key) => !Object.hasOwn(data, key))) throw new Error("Controller ticket has invalid fields.");
  for (const key of ids) uuid(data[key]);
  if (Object.hasOwn(data, "usageScope") && (!test || data.usageScope !== "standalone_test" || botFields.length !== 0)) throw new Error("Controller usage scope is invalid.");
  if (Object.hasOwn(data, "botId")) {
    if (!test || data.testExecutionId !== data.executionId || data.initialInput !== "none") throw new Error("Controller Bot identity requires an assistant execution.");
    uuid(data.botId);
  }
  if ((data.schemaVersion !== 1 && data.schemaVersion !== 2) || typeof data.executionGeneration !== "string" || !/^[1-9][0-9]{0,18}$/.test(data.executionGeneration) || BigInt(data.executionGeneration) > 9_223_372_036_854_775_807n) throw new Error("Controller ticket version or execution generation is invalid.");
  if (data.schemaVersion === 2) {
    const lifecycle = parseHistoricalBinding(data.lifecycleBinding);
    if (lifecycle.serverOrigin !== data.serverOrigin || lifecycle.userId !== (test ? data.ownerUserId : data.userId)
      || !test && lifecycle.workerId !== data.workerId || data.usageScope === "standalone_test") throw new Error("Controller lifecycle binding conflicts with its execution owner.");
  } else if (Object.hasOwn(data, "lifecycleBinding")) throw new Error("Legacy Controller tickets cannot claim lifecycle fencing.");
  if (typeof data.serverOrigin !== "string" || normalizeServerUrl(data.serverOrigin) !== data.serverOrigin) throw new Error("Controller ticket server origin is invalid.");
  if (data.provider !== "codex" && data.provider !== "claude" && data.provider !== "copilot") throw new Error("Controller ticket provider is invalid.");
  if (Object.hasOwn(data, "copilotBotRecovery")) {
    const recovery = data.copilotBotRecovery as Record<string, unknown> | null;
    if (!test || data.provider !== "copilot" || !recovery || typeof recovery !== "object" || Object.keys(recovery).sort().join() !== "botId,directory"
      || typeof recovery.directory !== "string" || !path.isAbsolute(recovery.directory) || path.resolve(recovery.directory) !== recovery.directory || /[\0\r\n]/.test(recovery.directory)) throw new Error("Copilot Bot recovery binding is invalid.");
    uuid(recovery.botId);
    if (data.botId !== undefined && recovery.botId !== data.botId) throw new Error("Copilot recovery belongs to another Bot.");
  }
  if (Object.hasOwn(data, "codexBotRecovery")) {
    const recovery = data.codexBotRecovery as Record<string, unknown> | null;
    if (!test || data.provider !== "codex" || !recovery || typeof recovery !== "object" || Object.keys(recovery).sort().join() !== "botId,directory"
      || typeof recovery.directory !== "string" || !path.isAbsolute(recovery.directory) || path.resolve(recovery.directory) !== recovery.directory || /[\0\r\n]/.test(recovery.directory)) throw new Error("Codex Bot recovery binding is invalid.");
    uuid(recovery.botId);
    if (data.botId !== undefined && recovery.botId !== data.botId) throw new Error("Codex recovery belongs to another Bot.");
  }
  if (Object.hasOwn(data, "claudeBotRecovery")) {
    const recovery = data.claudeBotRecovery as Record<string, unknown> | null;
    if (!test || data.provider !== "claude" || !recovery || typeof recovery !== "object" || Object.keys(recovery).sort().join() !== "botId,directory"
      || typeof recovery.directory !== "string" || !path.isAbsolute(recovery.directory) || path.resolve(recovery.directory) !== recovery.directory || /[\0\r\n]/.test(recovery.directory)) throw new Error("Claude Bot recovery binding is invalid.");
    uuid(recovery.botId);
    if (data.botId !== undefined && recovery.botId !== data.botId) throw new Error("Claude recovery belongs to another Bot.");
  }
  for (const key of ["cwd", "nativeHome", "credentialFile"]) if (typeof data[key] !== "string" || !path.isAbsolute(data[key]) || /[\0\r\n]/.test(data[key])) throw new Error(`Controller ticket ${key} must be absolute.`);
  if (typeof data.ipcEndpoint !== "string" || /[\0\r\n]/.test(data.ipcEndpoint) || !(path.isAbsolute(data.ipcEndpoint) || data.ipcEndpoint.startsWith("\\\\.\\pipe\\"))) throw new Error("Controller IPC endpoint is invalid.");
  if (typeof data.ipcSecret !== "string" || !/^[a-f0-9]{64}$/.test(data.ipcSecret)) throw new Error("Controller IPC authentication is invalid.");
  if (typeof data.initialPrompt !== "string" || (!(test && data.initialInput === "none") && data.initialPrompt.trim() === "") || !data.initialPrompt.isWellFormed()) throw new Error("Controller initial prompt is invalid or too large.");
  const promptBytes = Buffer.byteLength(data.initialPrompt);
  if (promptBytes > MAX_INITIAL_PROMPT_BYTES) throw new LaunchTicketLimitError(promptBytes, MAX_INITIAL_PROMPT_BYTES, "Controller initial prompt is invalid or too large.");
  if (Object.hasOwn(data, "instructions") && (typeof data.instructions !== "string" || data.instructions.trim() === "" || !data.instructions.isWellFormed() || Buffer.byteLength(data.instructions, "utf8") > 64 * 1024)) throw new Error("Controller instructions must be nonempty well-formed Unicode text of at most 64 KiB UTF-8.");
  if (test && (data.initialInput !== "none" && data.initialInput !== "prompt" || data.initialInput === "none" && data.initialPrompt !== "" || data.resumeNativeSessionId !== null && data.initialInput !== "none")) throw new Error("Test controller initial input or resume binding is invalid.");
  if (data.resumeNativeSessionId !== null) uuid(data.resumeNativeSessionId);
  if (typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt))) throw new Error("Controller creation time is invalid.");
  const config = data.configuration;
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("Controller frozen configuration is missing.");
  const fields = config as Record<string, unknown>;
  const selection = Object.hasOwn(fields, "validateNativeSelection");
  const launch = Object.hasOwn(fields, "toolLaunch");
  const observation = Object.hasOwn(fields, "toolObservation");
  if (selection && fields.validateNativeSelection !== true || observation && !launch || Object.keys(fields).sort().join() !== ["agent", "agentControlMode", "args", "model", "recoveryLimit", ...(selection ? ["validateNativeSelection"] : []), ...(launch ? ["toolLaunch"] : []), ...(observation ? ["toolObservation"] : [])].sort().join() || fields.agent !== data.provider || fields.agentControlMode !== "web" || !Array.isArray(fields.args) || fields.args.some((arg) => typeof arg !== "string" || /[\0\r\n]/.test(arg)) || !(fields.model === null || typeof fields.model === "string" && fields.model.trim() !== "") || !Number.isSafeInteger(fields.recoveryLimit) || (fields.recoveryLimit as number) < 0) throw new Error("Controller frozen configuration is invalid.");
  if (launch) {
    if (data.provider === "claude") throw new Error("Claude cannot acquire a Worker tool launch.");
    parseResolvedToolLaunch(fields.toolLaunch, { tool: data.provider, context: "web" });
  }
  if (observation) parseFrozenToolObservation(fields.toolObservation);
  return value as ControllerLaunchTicket;
};
export const readLaunchTicket = async (home: string, launchId: string, storageStateDirectory?: string): Promise<ControllerLaunchTicket> => {
  const file = controllerTicketPath(home, launchId, storageStateDirectory); const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_TICKET_BYTES || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) throw new Error("Controller ticket must be a private regular file.");
  const ticket = parseLaunchTicket(JSON.parse(await readFile(file, "utf8")) as unknown);
  if (ticket.launchId !== launchId) throw new Error("Controller launch ticket identity mismatch.");
  return ticket;
};
export const serializeLaunchTicket = (ticket: ControllerLaunchTicket): string => {
  parseLaunchTicket(ticket);
  const serialized = `${JSON.stringify(ticket)}\n`;
  const actualBytes = Buffer.byteLength(serialized, "utf8");
  if (actualBytes > MAX_TICKET_BYTES) throw new LaunchTicketLimitError(actualBytes, MAX_TICKET_BYTES, "Controller serialized ticket exceeds 6 MiB.");
  return serialized;
};
export const writeLaunchTicket = async (home: string, ticket: ControllerLaunchTicket, storageStateDirectory?: string): Promise<string> => {
  const serialized = serializeLaunchTicket(ticket);
  const filename = controllerTicketPath(home, ticket.launchId, storageStateDirectory); const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const temporary = `${filename}.${randomUUID()}.tmp`; const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, filename); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if (JSON.stringify(await readLaunchTicket(home, ticket.launchId, storageStateDirectory)) !== JSON.stringify(ticket)) throw new Error("The launch identity is already bound to a different ticket.");
  } finally { await unlink(temporary); }
  return filename;
};
