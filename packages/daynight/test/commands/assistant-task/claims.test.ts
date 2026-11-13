import { mkdtemp, readdir, readFile, rm, stat, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaimOperation, readClaimCredential, recoverClaimOperation } from "../../../src/commands/assistant-task/claims.js";
import * as stateModule from "../../../src/commands/assistant-task/state.js";
import { withClaimStorage } from "../../../src/commands/assistant-task/state.js";
import { assistantTaskClaimFingerprint, type AssistantTaskClaimInput, type AssistantTaskClaimResult } from "../../../src/api/assistant-task.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "assistant-claims-")); roots.push(stateDirectory);
  const scope = { stateDirectory, serverOrigin: "https://daynight.example", ownerUserId: randomUUID(), botId: randomUUID(), taskId: randomUUID() };
  const api = { claim: vi.fn(), getClaimOperation: vi.fn(), getTask: vi.fn() };
  const options = { ...scope, api };
  const result = (input: AssistantTaskClaimInput, kind: "claim" | "bind" | "renew" = "claim", binding = input.operationId): AssistantTaskClaimResult => {
    const now = new Date().toISOString(), until = new Date(Date.now() + 300_000).toISOString();
    return { operation: { operationId: input.operationId, kind, taskId: scope.taskId, actorBotId: scope.botId, requestFingerprint: assistantTaskClaimFingerprint({ ...input, kind, ownerUserId: scope.ownerUserId, taskId: scope.taskId, actorBotId: scope.botId }), admittedAt: now, resultingVersion: "2", resultingGeneration: "1", holderBotId: scope.botId, credentialOperationId: binding, leaseUntil: until }, currentClaim: { holderBotId: scope.botId, credentialOperationId: binding, claimGeneration: "1", claimState: "active", claimedAt: now, renewedAt: now, leaseUntil: until, observedAt: now } };
  };
  return { scope, api, options, result };
};

describe("assistant task durable claim lifecycle", () => {
  it("persists a private intent before dispatch and shares a single-writer task lock", async () => {
    const { options, api, result } = await fixture();
    const operationId = randomUUID();
    api.claim.mockImplementation(async (_task, _kind, input: AssistantTaskClaimInput) => {
      const files: string[] = [];
      const walk = async (dir: string): Promise<void> => { if (process.platform !== "win32") expect((await stat(dir)).mode & 0o777).toBe(0o700); for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else { files.push(file); if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600); } } };
      await walk(options.stateDirectory);
      const saved = JSON.parse(await readFile(files.find(f => f.endsWith(`.${operationId}.json`))!, "utf8"));
      expect(saved.input.claimToken).toBe(input.claimToken);
      expect(saved.phase).toBe("prepared");
      await expect(withClaimStorage(options, async () => undefined)).rejects.toThrow();
      return result(input);
    });
    const response = await runClaimOperation({ ...options, kind: "claim", operationId, ifVersion: "1", expectedGeneration: "0" });
    expect(JSON.stringify(response)).not.toContain(api.claim.mock.calls[0]![2].claimToken);
    api.getTask.mockResolvedValue(response.currentClaim);
    expect(await readClaimCredential(options)).toEqual({ claimToken: api.claim.mock.calls[0]![2].claimToken, claimGeneration: "1" });
    await expect(runClaimOperation({ ...options, kind: "claim", operationId, ifVersion: "1", expectedGeneration: "0" })).rejects.toThrow(/already exists/);
    expect(api.claim).toHaveBeenCalledTimes(1);
  });

  it("retains unknown submissions and recovers only the original receipt without replay", async () => {
    const { options, api, result } = await fixture();
    const operationId = randomUUID();
    api.claim.mockRejectedValue(new Error("transport failure with secret body"));
    await expect(runClaimOperation({ ...options, kind: "claim", operationId, ifVersion: "1", expectedGeneration: "0" })).rejects.toThrow(/unconfirmed/);
    await expect(readClaimCredential(options)).rejects.toThrow(/unconfirmed/);
    const input = api.claim.mock.calls[0]![2];
    const receipt = result(input);
    api.getClaimOperation.mockResolvedValue(receipt);
    expect(await recoverClaimOperation({ ...options, operationId })).toEqual(receipt);
    api.getTask.mockResolvedValue(receipt.currentClaim);
    expect((await readClaimCredential(options)).claimToken).toBe(input.claimToken);
    expect(api.claim).toHaveBeenCalledTimes(1);
  });

  it("does not recover expired or transferred credentials from a historical success", async () => {
    const { options, api, result } = await fixture();
    const operationId = randomUUID();
    api.claim.mockImplementation(async (_task, _kind, input) => result(input));
    const response = await runClaimOperation({ ...options, kind: "claim", operationId, ifVersion: "1", expectedGeneration: "0" });
    api.getClaimOperation.mockResolvedValue({ ...response, currentClaim: { ...response.currentClaim, claimState: "expired" } });
    await recoverClaimOperation({ ...options, operationId });
    await expect(readClaimCredential(options)).rejects.toThrow(/No usable/);
  });

  it("requires renewal after target binding and retains the bound token", async () => {
    const { options, api, result } = await fixture();
    const binding = randomUUID();
    api.claim.mockImplementation(async (_task, kind, input) => result(input, kind, binding));
    const bound = await runClaimOperation({ ...options, kind: "bind", operationId: binding, expectedGeneration: "1" });
    api.getTask.mockResolvedValue(bound.currentClaim);
    await expect(readClaimCredential(options)).rejects.toThrow(/No usable/);
    await runClaimOperation({ ...options, kind: "renew", operationId: randomUUID() });
    expect(api.claim.mock.calls[1]![2].claimToken).toBe(api.claim.mock.calls[0]![2].claimToken);
    expect((await readClaimCredential(options)).claimGeneration).toBe("1");
  });

  it("preserves a confirmed receipt when local saving or cleanup fails", async () => {
    const { options, api, result } = await fixture();
    const original = stateModule.withClaimStorage;
    const operationId = randomUUID();
    api.claim.mockImplementation(async (_task, _kind, input) => result(input));
    vi.spyOn(stateModule, "withClaimStorage").mockImplementation(async (scope, action) => original(scope, async storage => {
      const save = storage.save;
      storage.save = async () => { if (api.claim.mock.calls.length) throw new Error("local fsync failed"); await save(); };
      return action(storage);
    }));
    await expect(runClaimOperation({ ...options, kind: "claim", operationId, ifVersion: "1", expectedGeneration: "0" })).rejects.toMatchObject({ confirmed: true, outcomeUnconfirmed: false });
    expect(api.claim).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    api.getClaimOperation.mockResolvedValue(result(api.claim.mock.calls[0]![2]));
    vi.spyOn(stateModule, "withClaimStorage").mockImplementation(async (scope, action) => {
      await original(scope, action);
      throw new Error("local directory close failed");
    });
    await expect(recoverClaimOperation({ ...options, operationId })).rejects.toMatchObject({ confirmed: true, outcomeUnconfirmed: false });
    expect(api.claim).toHaveBeenCalledTimes(1);
  });

  it("preserves an unknown submission when cleanup also fails", async () => {
    const { options, api } = await fixture();
    const original = stateModule.withClaimStorage;
    api.claim.mockRejectedValue(new Error("connection closed after dispatch"));
    vi.spyOn(stateModule, "withClaimStorage").mockImplementation(async (scope, action) => {
      try { return await original(scope, action); }
      finally { throw new Error("local cleanup failed"); }
    });
    await expect(runClaimOperation({ ...options, kind: "claim", operationId: randomUUID(), ifVersion: "1", expectedGeneration: "0" })).rejects.toMatchObject({ confirmed: false, outcomeUnconfirmed: true });
    expect(api.claim).toHaveBeenCalledTimes(1);
  });

  it("reconciles an interrupted refusal before a new independent claim", async () => {
    const { options, api, result } = await fixture();
    const input = { operationId: randomUUID(), ifVersion: "1", expectedGeneration: "0", claimToken: Buffer.alloc(32, 1).toString("base64url") };
    await withClaimStorage(options, async storage => {
      await storage.saveOperation({ kind: "claim", input, phase: "refused", fingerprint: assistantTaskClaimFingerprint({ ...input, kind: "claim", ownerUserId: options.ownerUserId, taskId: options.taskId, actorBotId: options.botId }) });
      storage.state.pending = input.operationId;
      await storage.save();
    });
    api.claim.mockImplementation(async (_task, _kind, request) => result(request));
    await runClaimOperation({ ...options, kind: "claim", operationId: randomUUID(), ifVersion: "1", expectedGeneration: "0" });
    expect(api.getClaimOperation).not.toHaveBeenCalled();
    expect(api.claim).toHaveBeenCalledTimes(1);
    expect(api.claim.mock.calls[0]![2].operationId).not.toBe(input.operationId);
  });

  it("keeps origin, owner and Bot states separate and refuses insecure directories", async () => {
    const { options, api, result } = await fixture();
    api.claim.mockImplementation(async (_task, _kind, input) => result(input));
    await runClaimOperation({ ...options, kind: "claim", operationId: randomUUID(), ifVersion: "1", expectedGeneration: "0" });
    for (const other of [{ serverOrigin: "https://other.example" }, { ownerUserId: randomUUID() }, { botId: randomUUID() }]) await expect(readClaimCredential({ ...options, ...other })).rejects.toThrow(/No usable/);
    if (process.platform !== "win32") {
      await chmod(options.stateDirectory, 0o755);
      await expect(readClaimCredential(options)).rejects.toThrow(/0700/);
    }
  });
});
