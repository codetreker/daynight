import { randomBytes } from "node:crypto";
import { AssistantTaskApiError, assistantTaskClaimFingerprint, type AssistantTaskClient, type AssistantTaskClaim, type AssistantTaskClaimKind, type AssistantTaskClaimResult, type AssistantTaskClaimInput } from "../../api/assistant-task.js";
import { ClaimStateError, withClaimStorage, type ClaimScope, type ClaimStorage, type SavedClaimOperation, type SavedCredential } from "./state.js";

type Context = ClaimScope & { api: Pick<AssistantTaskClient, "getTask" | "claim" | "getClaimOperation"> };
export type RunClaimOptions = Context & { kind: AssistantTaskClaimKind; operationId: string; ifVersion?: string; expectedGeneration?: string; targetBotId?: string };
const matches = (claim: AssistantTaskClaim, credential: SavedCredential, botId: string | undefined): boolean => claim.claimState === "active" && claim.holderBotId === botId && claim.claimGeneration === credential.claimGeneration && claim.credentialOperationId === credential.credentialOperationId && claim.leaseUntil !== null && Date.parse(claim.leaseUntil) > Math.max(Date.now(), Date.parse(claim.observedAt));
const missing = (): never => { throw new ClaimStateError("No usable assistant-task credential. Read the task and recover its original claim operation; do not generate a replacement token."); };
const uncertain = (id: string, taskId: string): Error => new ClaimStateError(`Claim operation ${id} is unconfirmed. Run daynight assistant-task claim-operation show ${taskId} ${id}; do not repeat the write.`, true);

const withClaimOutcome = async <T>(options: Context, action: (storage: ClaimStorage, confirmed: () => void) => Promise<T>): Promise<T> => {
  let confirmed = false;
  let originalFailure: ClaimStateError | undefined;
  try { return await withClaimStorage(options, async storage => {
    try { return await action(storage, () => { confirmed = true; }); }
    catch (error) { if (error instanceof ClaimStateError && error.outcomeUnconfirmed) originalFailure = error; throw error; }
  }); }
  catch (error) {
    if (confirmed) throw new ClaimStateError("The original claim operation is confirmed, but local state persistence or cleanup failed. Preserve private state and use claim-operation show to reconcile it.", false, true);
    if (originalFailure) throw originalFailure;
    throw error;
  }
};

const confirm = async (storage: ClaimStorage, options: Context, saved: SavedClaimOperation, result: AssistantTaskClaimResult): Promise<void> => {
  const op = result.operation;
  if (op.operationId !== saved.input.operationId || op.taskId !== options.taskId || op.kind !== saved.kind || op.actorBotId !== (options.botId ?? null) || op.requestFingerprint !== saved.fingerprint) throw uncertain(saved.input.operationId, options.taskId);
  let credential = storage.state.credential;
  if ((saved.kind === "claim" || saved.kind === "bind") && saved.input.claimToken !== undefined) {
    const candidate: SavedCredential = { claimToken: saved.input.claimToken, claimGeneration: op.resultingGeneration, credentialOperationId: saved.input.operationId, requiresRenew: saved.kind === "bind" };
    if (matches(result.currentClaim, candidate, options.botId)) credential = candidate;
  }
  if (saved.kind === "renew" && credential && saved.input.claimToken === credential.claimToken && saved.input.claimGeneration === credential.claimGeneration && matches(result.currentClaim, credential, options.botId)) credential.requiresRenew = false;
  if (credential && !matches(result.currentClaim, credential, options.botId)) credential = null;
  storage.state.credential = credential;
  saved.phase = "confirmed";
  await storage.saveOperation(saved);
  if (storage.state.pending === saved.input.operationId) storage.state.pending = null;
  await storage.save();
};

/** A recovery is a read of the original receipt; it never resubmits the saved request. */
export const recoverClaimOperation = async (options: Context & { operationId: string }): Promise<AssistantTaskClaimResult> => options.stateDirectory === undefined ? options.api.getClaimOperation(options.taskId, options.operationId) : withClaimOutcome(options, async (storage, confirmed) => {
  const saved = await storage.readOperation(options.operationId);
  const result = await options.api.getClaimOperation(options.taskId, options.operationId, saved ? { kind: saved.kind, actorBotId: options.botId ?? null, requestFingerprint: saved.fingerprint } : undefined);
  if (saved) { confirmed(); await confirm(storage, options, saved, result); }
  return result;
});

export const runClaimOperation = async (options: RunClaimOptions): Promise<AssistantTaskClaimResult> => withClaimOutcome(options, async (storage, confirmed) => {
  if (!options.botId && (options.kind === "claim" || options.kind === "bind" || options.kind === "renew")) throw new ClaimStateError("This operation requires DAYNIGHT_BOT_ID.");
  if (await storage.readOperation(options.operationId)) throw new ClaimStateError(`Operation ${options.operationId} already exists locally. Use claim-operation show to inspect its original result.`);
  if (storage.state.pending) {
    const pending = await storage.readOperation(storage.state.pending);
    if (pending?.phase === "refused") {
      storage.state.pending = null;
      await storage.save();
    } else if (pending?.phase === "confirmed") {
      const receipt = await options.api.getClaimOperation(options.taskId, pending.input.operationId, { kind: pending.kind, actorBotId: options.botId ?? null, requestFingerprint: pending.fingerprint });
      await confirm(storage, options, pending, receipt);
    } else {
      const current = await options.api.getTask(options.taskId);
      // A later generation or expiry of the possible resulting generation makes an old credential unusable.
      const inputGeneration = pending?.input.expectedGeneration ?? pending?.input.claimGeneration;
      const possibleGeneration = inputGeneration === undefined ? undefined : BigInt(inputGeneration) + (pending?.kind === "claim" || pending?.kind === "transfer" || pending?.kind === "release" ? 1n : 0n);
      if (possibleGeneration === undefined || !(BigInt(current.claimGeneration) > possibleGeneration || BigInt(current.claimGeneration) === possibleGeneration && (current.claimState === "expired" || current.claimState === "unowned"))) throw uncertain(storage.state.pending, options.taskId);
      storage.state.pending = null;
      storage.state.credential = null;
      await storage.save();
    }
  }
  const credential = storage.state.credential;
  if (options.botId && (options.kind === "renew" || options.kind === "transfer" || options.kind === "release")) {
    const current = await options.api.getTask(options.taskId);
    if (!credential || !matches(current, credential, options.botId)) return missing();
  }
  const input: AssistantTaskClaimInput = { operationId: options.operationId,
    ...(options.ifVersion === undefined ? {} : { ifVersion: options.ifVersion }),
    ...(options.expectedGeneration === undefined ? {} : { expectedGeneration: options.expectedGeneration }),
    ...(options.targetBotId === undefined ? {} : { targetBotId: options.targetBotId }),
  };
  if (options.kind === "claim" || options.kind === "bind") input.claimToken = randomBytes(32).toString("base64url");
  else if (options.botId && credential) {
    input.claimToken = credential.claimToken;
    if (options.kind === "renew") input.claimGeneration = credential.claimGeneration;
    else input.expectedGeneration ??= credential.claimGeneration;
  }
  const saved: SavedClaimOperation = { kind: options.kind, input, fingerprint: assistantTaskClaimFingerprint({ ...input, kind: options.kind, ownerUserId: options.ownerUserId, taskId: options.taskId, actorBotId: options.botId ?? null }), phase: "prepared" };
  await storage.saveOperation(saved);
  storage.state.pending = options.operationId;
  await storage.save();
  let result: AssistantTaskClaimResult;
  try { result = await options.api.claim(options.taskId, options.kind, input); }
  catch (error) {
    if (error instanceof AssistantTaskApiError && error.confirmedRefusal) {
      saved.phase = "refused";
      await storage.saveOperation(saved);
      storage.state.pending = null;
      await storage.save();
      throw error;
    }
    throw uncertain(options.operationId, options.taskId);
  }
  confirmed();
  await confirm(storage, options, saved, result);
  return result;
});

export const readClaimCredential = async (options: Context): Promise<{ claimToken: string; claimGeneration: string }> => withClaimStorage(options, async storage => {
  if (!options.botId) throw new ClaimStateError("This operation requires DAYNIGHT_BOT_ID.");
  if (storage.state.pending) throw uncertain(storage.state.pending, options.taskId);
  const credential = storage.state.credential;
  if (!credential || credential.requiresRenew || !matches(await options.api.getTask(options.taskId), credential, options.botId)) return missing();
  return { claimToken: credential.claimToken, claimGeneration: credential.claimGeneration };
});
