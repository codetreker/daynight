import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, lstat, link, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalId } from "../../api/parse.js";
import { normalizeServerUrl } from "../../config/server.js";
import { sessionBinding, type SessionBinding } from "../../session/protocol.js";
import type { FrozenExecutionConfiguration } from "../worker/types.js";

type LaunchCommon = {
  readonly schemaVersion: 1;
  readonly launchId: string; readonly executionId: string; readonly controllerId: string; readonly controllerInstanceId: string;
  readonly sessionId: string; readonly executionGeneration: string; readonly serverOrigin: string;
  readonly provider: "codex" | "claude" | "copilot"; readonly cwd: string; readonly nativeHome: string;
  readonly configuration: FrozenExecutionConfiguration;
  readonly initialOperationId: string; readonly initialPrompt: string;
  readonly resumeNativeSessionId: string | null;
  readonly credentialFile: string; readonly ipcEndpoint: string; readonly ipcSecret: string;
  readonly createdAt: string;
};
export type ControllerLaunchTicket = LaunchCommon & SessionBinding & (
  | { readonly claimId: string; readonly projectId: string; readonly taskId: string; readonly workerId: string; readonly worktreeId: string; readonly userId: string; readonly ownerUserId?: never; readonly initialInput?: never }
  | { readonly testExecutionId: string; readonly ownerUserId: string; readonly initialInput: "none" | "prompt"; readonly projectId?: never; readonly taskId?: never; readonly workerId?: never; readonly worktreeId?: never; readonly userId?: never }
);
const uuid = (value: unknown): string => { if (typeof value !== "string" || canonicalId(value) !== value) throw new Error("Controller identity must be a canonical UUID."); return value; };
export const controllerExecutionDirectory = (home: string, executionId: string): string => path.join(home, ".daynight", "controller", "executions", uuid(executionId));
export const controllerTicketPath = (home: string, launchId: string): string => path.join(home, ".daynight", "controller", "launches", `${uuid(launchId)}.json`);
const canonicalPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalPayload);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left],[right])=>left<right?-1:left>right?1:0).map(([key,item])=>[key,canonicalPayload(item)]));
  return value;
};
export const controllerPayloadHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonicalPayload(value))).digest("hex");
export const parseLaunchTicket = (value: unknown): ControllerLaunchTicket => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Controller ticket must be an object.");
  const data = value as Record<string, unknown>;
  const binding = sessionBinding(data);
  const test = binding.testExecutionId !== undefined;
  const ids = ["launchId", "executionId", "controllerId", "controllerInstanceId", "sessionId", ...(test ? ["testExecutionId", "ownerUserId"] : ["projectId", "taskId", "claimId", "workerId", "worktreeId", "userId"]), "initialOperationId"];
  const keys = ["schemaVersion", ...ids, ...(test ? ["initialInput"] : []), "executionGeneration", "serverOrigin", "provider", "cwd", "nativeHome", "configuration", "initialPrompt", "resumeNativeSessionId", "credentialFile", "ipcEndpoint", "ipcSecret", "createdAt"];
  if (Object.keys(data).length !== keys.length || keys.some((key) => !Object.hasOwn(data, key))) throw new Error("Controller ticket has invalid fields.");
  for (const key of ids) uuid(data[key]);
  if (data.schemaVersion !== 1 || typeof data.executionGeneration !== "string" || !/^[1-9][0-9]{0,18}$/.test(data.executionGeneration) || BigInt(data.executionGeneration) > 9_223_372_036_854_775_807n) throw new Error("Controller ticket version or execution generation is invalid.");
  if (typeof data.serverOrigin !== "string" || normalizeServerUrl(data.serverOrigin) !== data.serverOrigin) throw new Error("Controller ticket server origin is invalid.");
  if (data.provider !== "codex" && data.provider !== "claude" && data.provider !== "copilot") throw new Error("Controller ticket provider is invalid.");
  for (const key of ["cwd", "nativeHome", "credentialFile"]) if (typeof data[key] !== "string" || !path.isAbsolute(data[key]) || /[\0\r\n]/.test(data[key])) throw new Error(`Controller ticket ${key} must be absolute.`);
  if (typeof data.ipcEndpoint !== "string" || /[\0\r\n]/.test(data.ipcEndpoint) || !(path.isAbsolute(data.ipcEndpoint) || data.ipcEndpoint.startsWith("\\\\.\\pipe\\"))) throw new Error("Controller IPC endpoint is invalid.");
  if (typeof data.ipcSecret !== "string" || !/^[a-f0-9]{64}$/.test(data.ipcSecret)) throw new Error("Controller IPC authentication is invalid.");
  if (typeof data.initialPrompt !== "string" || (!(test && data.initialInput === "none") && data.initialPrompt.trim() === "") || !data.initialPrompt.isWellFormed() || Buffer.byteLength(data.initialPrompt) > 4 * 1024 * 1024) throw new Error("Controller initial prompt is invalid or too large.");
  if (test && (data.initialInput !== "none" && data.initialInput !== "prompt" || data.initialInput === "none" && data.initialPrompt !== "" || data.resumeNativeSessionId !== null && data.initialInput !== "none")) throw new Error("Test controller initial input or resume binding is invalid.");
  if (data.resumeNativeSessionId !== null) uuid(data.resumeNativeSessionId);
  if (typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt))) throw new Error("Controller creation time is invalid.");
  const config = data.configuration;
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("Controller frozen configuration is missing.");
  const fields = config as Record<string, unknown>;
  if (Object.keys(fields).sort().join() !== ["agent", "agentControlMode", "args", "model", "recoveryLimit"].sort().join() || fields.agent !== data.provider || fields.agentControlMode !== "web" || !Array.isArray(fields.args) || fields.args.some((arg) => typeof arg !== "string" || /[\0\r\n]/.test(arg)) || !(fields.model === null || typeof fields.model === "string" && fields.model.trim() !== "") || !Number.isSafeInteger(fields.recoveryLimit) || (fields.recoveryLimit as number) < 0) throw new Error("Controller frozen configuration is invalid.");
  return value as ControllerLaunchTicket;
};
export const readLaunchTicket = async (home: string, launchId: string): Promise<ControllerLaunchTicket> => {
  const file = controllerTicketPath(home, launchId); const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 5 * 1024 * 1024 || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) throw new Error("Controller ticket must be a private regular file.");
  const ticket = parseLaunchTicket(JSON.parse(await readFile(file, "utf8")) as unknown);
  if (ticket.launchId !== launchId) throw new Error("Controller launch ticket identity mismatch.");
  return ticket;
};
export const writeLaunchTicket = async (home: string, ticket: ControllerLaunchTicket): Promise<string> => {
  parseLaunchTicket(ticket);
  const filename = controllerTicketPath(home, ticket.launchId); const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const temporary = `${filename}.${randomUUID()}.tmp`; const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(ticket)}\n`); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, filename); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if (JSON.stringify(await readLaunchTicket(home, ticket.launchId)) !== JSON.stringify(ticket)) throw new Error("The launch identity is already bound to a different ticket.");
  } finally { await unlink(temporary); }
  return filename;
};
