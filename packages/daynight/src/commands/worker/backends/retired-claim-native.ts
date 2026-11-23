import { lstat, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { Operation } from "../../../api/operation.js";
import { controllerPayloadHash } from "../../controller/launch-ticket.js";
import { readControllerSnapshot, readCurrentControllerSnapshot, readProvenWindowsStoppedControllerGeneration, recordStoppedControllerGeneration, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { isProcessBirth } from "../../controller/linux-process-proof.js";
import { resolveControllerIpcEndpoint, resolveControllerStateDirectory } from "../../controller/paths.js";
import { confirmControllerProcessesStopped, ControllerProcessIdentityConflictError, inspectBootstrapProcessProof, stopControllerProcesses, type ProcessProof } from "../../controller/process-proof.js";
import type { CleanupTarget } from "../execution-stop.js";
import type { LifecycleIdentity, LifecycleJson, LifecycleStore } from "../lifecycle-store.js";
import type { ResourceOwner } from "../types.js";
import { hasLifecycleUnreleasedControllerGateProof, readLifecycleControllerTicket } from "../lifecycle-controller-ticket.js";
import type { ControllerJobLeases } from "./controller-job-leases.js";
import { locateRetiredClaimControllers, type LocatedClaimController, type LocatedClaimNative } from "./retired-claim-tickets.js";
export type { ClaimNativeLocation, LocatedClaimNative } from "./retired-claim-tickets.js";

export type ClaimNativeClearance = {
  target: CleanupTarget; owners: readonly ResourceOwner[]; observedAt: number; inventoryComplete: true; resourcesCleared: true;
  stoppedExecutions: readonly { launchId: string; executionId: string; executionGeneration: string; controllerInstanceId: string; journalFile: string }[];
};
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const confirmDurableBoundaryProcesses = async (proofs: readonly ProcessProof[], deadline: number): Promise<void> => {
  for (const proof of proofs) {
    if (Date.now() >= deadline) throw new Error("Retired claim native cleanup exceeded its deadline.");
    let conflict: ConstructorParameters<typeof ControllerProcessIdentityConflictError>[1] | undefined;
    const state = await inspectBootstrapProcessProof(proof, Math.max(1, Math.min(5000, deadline - Date.now())), evidence => { conflict = evidence; });
    if (state === "replaced" && conflict?.sameBirth === true) throw new ControllerProcessIdentityConflictError(proof.pid, conflict);
    if (state === "running" || state === "exiting") throw new Error("Original native process conflicts with its durable boundary stop receipt.");
  }
};
const processProof = (value: LifecycleJson): ProcessProof => {
  const proof = value as unknown as ProcessProof;
  if (proof === null || typeof proof !== "object" || !Number.isSafeInteger(proof.pid) || proof.pid < 1 || proof.pid > 2_147_483_647
    || !Number.isSafeInteger(proof.parentPid) || proof.parentPid < 0 || !(proof.processGroupId === null || Number.isSafeInteger(proof.processGroupId) && proof.processGroupId > 0)
    || !isProcessBirth(proof.startedAt) || typeof proof.commandHash !== "string" || !/^[a-f0-9]{64}$/.test(proof.commandHash)
    || !(proof.jobObjectName === undefined || typeof proof.jobObjectName === "string" && proof.jobObjectName.length > 0 && !proof.jobObjectName.includes("\0")))
    throw new Error("Original lifecycle Controller process proof is invalid.");
  return proof;
};
const currentSnapshot = async (located: LocatedClaimController, controllers: readonly LocatedClaimController[], deadline: number): Promise<ControllerSnapshot | null> => {
  try { const stat = await lstat(located.journalFile); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Original Controller journal must be an ordinary file."); }
  catch (error) { if (missing(error)) return null; throw error; }
  const snapshot = readControllerSnapshot(located.journalFile);
  if (snapshot === null) return null;
  const ticket = located.ticket;
  if (snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.claimId !== ticket.claimId || snapshot.testExecutionId !== undefined)
    throw new Error("Original retired claim journal has conflicting execution ownership.");
  if (snapshot.executionGeneration === ticket.executionGeneration) return readCurrentControllerSnapshot(located.journalFile, ticket, deadline);
  const current = controllers.find(controller => controller.journalFile === located.journalFile && controller.ticket.executionGeneration === snapshot.executionGeneration);
  if (current === undefined) throw new Error("Original Controller journal generation has no matching inventory ticket.");
  readCurrentControllerSnapshot(located.journalFile, current.ticket, deadline);
  // Generations share one journal. An older ticket never rewrites another generation's receipt.
  return null;
};

export const createRetiredClaimNativeCleanup = (options: {
  homeDirectory: string; identity: LifecycleIdentity; jobLeases: ControllerJobLeases; storageStateDirectory?: string;
  lifecycle?: Pick<LifecycleStore, "listResources" | "recordResource">;
}) => {
  const removeEndpoint = async (located: LocatedClaimController): Promise<void> => {
    const ticket = located.ticket, root = located.storageStateDirectory;
    const endpoints = [resolveControllerIpcEndpoint(options.homeDirectory, ticket.launchId, process.platform, root)];
    if (root === resolveControllerStateDirectory(options.homeDirectory)) endpoints.push(resolveControllerIpcEndpoint(options.homeDirectory, ticket.launchId));
    if (!endpoints.includes(ticket.ipcEndpoint)) throw new Error("Original Controller endpoint conflicts with its storage root.");
    if (process.platform === "win32") return;
    try { await unlink(ticket.ipcEndpoint); } catch (error) { if (!missing(error)) throw error; }
    try { await lstat(ticket.ipcEndpoint); } catch (error) { if (missing(error)) return; throw error; }
    throw new Error("Original Controller endpoint remains after retired claim cleanup.");
  };
  const recordBoundary = (located: LocatedClaimController, proof: ProcessProof | null, native: readonly ProcessProof[]): void => {
    if (options.lifecycle === undefined) return;
    const ticket = located.ticket;
    const stopProof = JSON.parse(JSON.stringify({ kind: "retired_claim_controller_boundary", launchId: ticket.launchId, executionId: ticket.executionId,
      executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, ticketHash: controllerPayloadHash(ticket),
      controllerProcess: proof, nativeProcesses: native, boundaryEmpty: true, windowsJobStopped: process.platform === "win32" && proof !== null })) as LifecycleJson;
    located.resources = located.resources.map(resource => ["stopped", "not_dispatched", "confirmed"].includes(resource.stage) && resource.saveState === "durable"
      ? resource : options.lifecycle!.recordResource({ resourceId: resource.resourceId, stage: "stopped", stopProof, saveState: "durable", error: null }));
  };
  const durableBoundary = (located: LocatedClaimController, proof: ProcessProof): boolean => located.resources.some(resource => {
    const saved = resource.stopProof;
    return resource.stage === "stopped" && resource.saveState === "durable" && saved !== null && typeof saved === "object" && !Array.isArray(saved)
      && saved.kind === "retired_claim_controller_boundary" && saved.launchId === located.ticket.launchId && saved.executionId === located.ticket.executionId
      && saved.executionGeneration === located.ticket.executionGeneration && saved.controllerInstanceId === located.ticket.controllerInstanceId
      && saved.ticketHash === controllerPayloadHash(located.ticket) && saved.boundaryEmpty === true && saved.windowsJobStopped === true
      && isDeepStrictEqual(saved.controllerProcess, proof);
  });
  const stopController = async (located: LocatedClaimController, controllers: readonly LocatedClaimController[], request: { deadline: number; signal: AbortSignal }): Promise<boolean> => {
    const check = () => { request.signal.throwIfAborted(); if (Date.now() >= request.deadline) throw new Error("Retired claim native cleanup exceeded its deadline."); };
    check();
    await options.jobLeases.cleanupBirth(located.ticket.launchId, request.deadline);
    check();
    if (options.lifecycle !== undefined && located.resources.length > 0) {
      const current = new Map(options.lifecycle.listResources().map(resource => [resource.resourceId, resource]));
      for (let index = 0; index < located.resources.length; index++) {
        const resource = current.get(located.resources[index]!.resourceId);
        if (resource === undefined) throw new Error("Original Controller lifecycle resource disappeared during cleanup.");
        const ticket = await readLifecycleControllerTicket(options.homeDirectory, options.identity, resource);
        if (controllerPayloadHash(ticket) !== controllerPayloadHash(located.ticket)) throw new Error("Original Controller lifecycle ticket changed during cleanup.");
        located.resources[index] = resource;
      }
    }
    const snapshot = await currentSnapshot(located, controllers, request.deadline);
    const launches = located.resources.filter(resource => resource.identity.kind === "launch" && resource.processProof !== null).map(resource => processProof(resource.processProof));
    const proof = snapshot?.controllerProcess ?? launches[0] ?? null;
    if (launches.some(launch => !isDeepStrictEqual(launch, proof))) throw new Error("Original Controller has conflicting lifecycle and journal process proofs.");
    const native = [...(snapshot?.nativeProcesses ?? [])];
    for (const resource of located.resources) {
      if (resource.identity.kind !== "provider" || resource.processProof === null) continue;
      const provider = processProof(resource.processProof);
      if (!native.some(existing => isDeepStrictEqual(existing, provider))) native.push(provider);
    }
    if (proof !== null) {
      if (process.platform === "win32" && proof.jobObjectName !== `Local\\Daynight-${located.ticket.launchId}`) throw new Error("Original Controller Windows Job conflicts with its launch identity.");
      let lease = await options.jobLeases.get(located.ticket.launchId);
      if (lease === undefined && snapshot === null && native.length === 0 && located.resources.some(resource => hasLifecycleUnreleasedControllerGateProof(located.ticket, resource, proof))) {
        await confirmDurableBoundaryProcesses([proof], request.deadline);
      } else if (options.jobLeases.enabled && lease === undefined && snapshot?.lifecycle === "stopped" && snapshot.nativeStopped) {
        readProvenWindowsStoppedControllerGeneration(located.journalFile, located.ticket, request.deadline);
        await confirmDurableBoundaryProcesses([proof, ...native], request.deadline);
      } else if (options.jobLeases.enabled && lease === undefined && durableBoundary(located, proof)) {
        await confirmDurableBoundaryProcesses([proof, ...native], request.deadline);
      } else {
        if (options.jobLeases.enabled && lease === undefined) lease = await options.jobLeases.retain(located.ticket.launchId, proof, request.deadline);
        await stopControllerProcesses(proof, native, request.deadline, lease);
        check();
        if (!await confirmControllerProcessesStopped(proof, native, request.deadline, lease)) throw new Error("Original retired claim Controller boundary remains running.");
        if (snapshot !== null && snapshot.controllerProcess !== null) await recordStoppedControllerGeneration(located.journalFile, located.ticket, { deadline: request.deadline, signal: request.signal, ...(lease === undefined ? {} : { jobLease: lease }) });
      }
    } else if (native.length > 0 || await options.jobLeases.get(located.ticket.launchId) !== undefined) {
      throw new Error("Original retired claim native resources have no Controller boundary proof.");
    }
    check();
    recordBoundary(located, proof, native);
    await options.jobLeases.release(located.ticket.launchId);
    await removeEndpoint(located);
    check();
    return proof !== null;
  };
  return {
    locate: (targets: readonly CleanupTarget[], operation: Operation) => locateRetiredClaimControllers(options, targets, operation),
    stop: async (located: LocatedClaimNative, request: { deadline: number; signal: AbortSignal }): Promise<ClaimNativeClearance> => {
      const owners = new Map<string, ResourceOwner>();
      const stoppedExecutions: ClaimNativeClearance["stoppedExecutions"][number][] = [];
      for (const controller of located.controllers) {
        const stopped = await stopController(controller, located.controllers, request);
        const ticket = controller.ticket;
        if (ticket.claimId === undefined) throw new Error("A Test Session cannot belong to retired Task cleanup.");
        owners.set(ticket.worktreeId, { ...located.target, worktreeId: ticket.worktreeId });
        if (stopped) stoppedExecutions.push({ launchId: ticket.launchId, executionId: ticket.executionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, journalFile: controller.journalFile });
      }
      request.signal.throwIfAborted();
      if (Date.now() >= request.deadline) throw new Error("Retired claim native cleanup exceeded its deadline.");
      return { target: located.target, owners: [...owners.values()], observedAt: Date.now(), inventoryComplete: true, resourcesCleared: true, stoppedExecutions };
    },
  };
};
export type RetiredClaimNativeCleanup = ReturnType<typeof createRetiredClaimNativeCleanup>;
