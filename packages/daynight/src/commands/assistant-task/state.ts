import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadOperationFiles, type PrivateOperationDirectory } from "../task/session/private-files.js";
import { assistantTaskClaimFingerprint, assistantTaskId, assistantTaskInteger } from "../../api/assistant-task-parse.js";
import type { AssistantTaskClaimInput, AssistantTaskClaimKind } from "../../api/assistant-task-types.js";

export class ClaimStateError extends Error {
  constructor(message: string, readonly outcomeUnconfirmed = false, readonly confirmed = false) { super(message); this.name = "ClaimStateError"; }
}

export type ClaimScope = { serverOrigin: string; ownerUserId: string; botId?: string; stateDirectory?: string; taskId: string };
export type SavedCredential = { claimToken: string; claimGeneration: string; credentialOperationId: string; requiresRenew: boolean };
export type SavedClaimOperation = { kind: AssistantTaskClaimKind; input: AssistantTaskClaimInput; fingerprint: string; phase: "prepared" | "confirmed" | "refused" };
export type ClaimState = { schemaVersion: 1; serverOrigin: string; ownerUserId: string; botId: string | null; taskId: string; credential: SavedCredential | null; pending: string | null };
export type ClaimStorage = { state: ClaimState; save(): Promise<void>; readOperation(id: string): Promise<SavedClaimOperation | undefined>; saveOperation(operation: SavedClaimOperation): Promise<void> };
const invalid = (): never => { throw new ClaimStateError("Assistant-task private state is invalid; preserve it and inspect the original claim operation."); };
const token = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, "base64url").toString("base64url") !== value) return invalid();
  return value;
};
const readJSON = async (directory: PrivateOperationDirectory, name: string): Promise<Record<string, unknown> | undefined> => {
  const bytes = await directory.read(name);
  if (!bytes) return undefined;
  try { const data: unknown = JSON.parse(bytes.toString("utf8")); if (!data || typeof data !== "object" || Array.isArray(data)) return invalid(); return data as Record<string, unknown>; }
  catch { return invalid(); }
};

/** CLI and bot host share this task lock and durable state format. No network write may precede saveOperation and save. */
export const withClaimStorage = async <T>(scope: ClaimScope, action: (storage: ClaimStorage) => Promise<T>): Promise<T> => {
  const taskId = assistantTaskId(scope.taskId), ownerUserId = assistantTaskId(scope.ownerUserId), botId = scope.botId === undefined ? null : assistantTaskId(scope.botId);
  const origin = new URL(scope.serverOrigin).origin;
  if (!scope.stateDirectory || !path.isAbsolute(scope.stateDirectory)) throw new ClaimStateError("DAYNIGHT_BOT_STATE_DIR must identify an absolute private state directory.");
  const root = scope.stateDirectory;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || (process.platform !== "win32" && (rootStat.uid !== process.getuid!() || (rootStat.mode & 0o777) !== 0o700))) throw new ClaimStateError("Assistant-task state directory must be owned by this user with mode 0700.");
  const directory = await (await loadOperationFiles()).open(path.join(root, "assistant-claims", createHash("sha256").update(origin).digest("hex"), `${ownerUserId}.${botId ?? "user"}`), true);
  if (!directory) throw new ClaimStateError("Assistant-task private state directory is unavailable.");
  let unlock: (() => Promise<void>) | undefined;
  try {
    unlock = await directory.lock(`${taskId}.lock`);
    const parsed = await readJSON(directory, `${taskId}.json`);
    const state: ClaimState = { schemaVersion: 1, serverOrigin: origin, ownerUserId, botId, taskId, credential: null, pending: null };
    if (parsed) {
      if (Object.keys(parsed).some(k => !(k in state)) || parsed.schemaVersion !== 1 || parsed.serverOrigin !== origin || parsed.ownerUserId !== ownerUserId || parsed.botId !== botId || parsed.taskId !== taskId) return invalid();
      state.pending = parsed.pending === null ? null : assistantTaskId(parsed.pending);
      if (parsed.credential !== null) {
        const c = parsed.credential as SavedCredential;
        if (!c || Object.keys(c).sort().join() !== "claimGeneration,claimToken,credentialOperationId,requiresRenew" || typeof c.requiresRenew !== "boolean") return invalid();
        state.credential = { claimToken: token(c.claimToken), claimGeneration: assistantTaskInteger(c.claimGeneration), credentialOperationId: assistantTaskId(c.credentialOperationId), requiresRenew: c.requiresRenew };
      }
    }
    const readOperation = async (operationId: string): Promise<SavedClaimOperation | undefined> => {
      const p = await readJSON(directory, `${taskId}.${assistantTaskId(operationId)}.json`);
      if (!p) return undefined;
      if (Object.keys(p).sort().join() !== "fingerprint,input,kind,phase" || !["claim", "transfer", "bind", "renew", "release"].includes(p.kind as string) || !["prepared", "confirmed", "refused"].includes(p.phase as string)) return invalid();
      const op = p as unknown as SavedClaimOperation;
      if (!op.input || op.input.operationId !== operationId || Object.keys(op.input).some(k => !["operationId", "ifVersion", "expectedGeneration", "claimGeneration", "claimToken", "targetBotId"].includes(k))) return invalid();
      if (op.input.claimToken !== undefined) token(op.input.claimToken);
      if (op.fingerprint !== assistantTaskClaimFingerprint({ ...op.input, kind: op.kind, ownerUserId, taskId, actorBotId: botId })) return invalid();
      return op;
    };
    return await action({ state, readOperation,
      save: () => directory.replace(`${taskId}.json`, Buffer.from(JSON.stringify(state))),
      saveOperation: op => directory.replace(`${taskId}.${assistantTaskId(op.input.operationId)}.json`, Buffer.from(JSON.stringify(op))),
    });
  } finally { try { await unlock?.(); } finally { await directory.close(); } }
};
