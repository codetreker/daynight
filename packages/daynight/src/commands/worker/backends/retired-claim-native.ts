import { lstat, readFile, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { Operation } from "../../../api/operation.js";
import { replaceFileAtomically } from "../../../platform/files.js";
import { controllerPayloadHash, controllerTicketPath, readLaunchTicket } from "../../controller/launch-ticket.js";
import { readCurrentControllerInventorySnapshot, readHistoricalStoppedControllerGeneration, recordStoppedControllerGeneration, validateWindowsControllerStopProof, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { isProcessBirth } from "../../controller/linux-process-proof.js";
import { resolveControllerIpcEndpoint, resolveControllerStateDirectory } from "../../controller/paths.js";
import { confirmControllerProcessesStopped, ControllerProcessIdentityConflictError, inspectBootstrapProcessProof, stopControllerProcesses, type ControllerProcessProof, type ProcessProof } from "../../controller/process-proof.js";
import { isLinuxControllerLaunch } from "../../controller/linux-controller-launch.js";
import { readUnreleasedLaunch } from "../../controller/unreleased-launch.js";
import { ControllerIpcOutcomeUnknownError, requestController } from "../../controller/local-client.js";
import type { CleanupTarget } from "../execution-stop.js";
import type { ResourceOwner } from "../types.js";
import { hasLegacyUnreleasedControllerGateProof, isDurableLegacyResource, readLegacyWorkerResources, type LegacyWorkerIdentity } from "./legacy-retired-evidence.js";
import type { ControllerJobLeases } from "./controller-job-leases.js";
import { preservesControllerProcessProof } from "./orchestration.js";
import { locateRetiredClaimControllers, type LocatedClaimController, type LocatedClaimNative } from "./retired-claim-tickets.js";
export type { ClaimNativeLocation, LocatedClaimNative } from "./retired-claim-tickets.js";

export type ClaimNativeClearance = {
  target: CleanupTarget; owners: readonly ResourceOwner[]; observedAt: number; inventoryComplete: true; resourcesCleared: true;
  stoppedExecutions: readonly { launchId: string; executionId: string; executionGeneration: string; controllerInstanceId: string; journalFile: string }[];
};
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const confirmDurableBoundaryProcesses = async (proofs: readonly ControllerProcessProof[], deadline: number): Promise<void> => {
  for (const proof of proofs) {
    if (Date.now() >= deadline) throw new Error("Retired claim native cleanup exceeded its deadline.");
    let conflict: ConstructorParameters<typeof ControllerProcessIdentityConflictError>[1] | undefined;
    const state = await inspectBootstrapProcessProof(proof, Math.max(1, Math.min(5000, deadline - Date.now())), evidence => { conflict = evidence; });
    if (state === "replaced" && isLinuxControllerLaunch(proof)) throw new Error("Original Controller identity conflicts with its durable boundary stop receipt.");
    if (state === "replaced" && conflict?.sameBirth === true) throw new ControllerProcessIdentityConflictError(proof.pid, conflict);
    if (state === "running" || state === "exiting") throw new Error("Original native process conflicts with its durable boundary stop receipt.");
  }
};
const processProof = (value: unknown): ProcessProof => {
  const proof = value as unknown as ProcessProof;
  if (proof === null || typeof proof !== "object" || !Number.isSafeInteger(proof.pid) || proof.pid < 1 || proof.pid > 2_147_483_647
    || !Number.isSafeInteger(proof.parentPid) || proof.parentPid < 0 || !(proof.processGroupId === null || Number.isSafeInteger(proof.processGroupId) && proof.processGroupId > 0)
    || !isProcessBirth(proof.startedAt) || typeof proof.commandHash !== "string" || !/^[a-f0-9]{64}$/.test(proof.commandHash)
    || !(proof.jobObjectName === undefined || typeof proof.jobObjectName === "string" && proof.jobObjectName.length > 0 && !proof.jobObjectName.includes("\0")))
    throw new Error("Original lifecycle Controller process proof is invalid.");
  return proof;
};
const ordinaryFileExists = async (file: string): Promise<boolean> => {
  try {
    if (!(await lstat(file)).isFile()) throw new Error(`Original Controller evidence must be an ordinary file: ${file}`);
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
};
const currentSnapshot = async (located: LocatedClaimController, controllers: readonly LocatedClaimController[], deadline: number): Promise<ControllerSnapshot | null> => {
  const files = [located.journalFile, `${located.journalFile}-wal`, `${located.journalFile}-journal`, `${located.journalFile}-shm`];
  const present = await Promise.all(files.map(ordinaryFileExists));
  if (!present[0]) {
    if (present.slice(1).some(Boolean)) throw new Error("Original Controller journal sidecar has no journal.");
    return null;
  }
  const current = readCurrentControllerInventorySnapshot(located.journalFile, controllers.filter(controller => controller.journalFile === located.journalFile).map(controller => controller.ticket), deadline);
  if (current === null) return null;
  const { snapshot } = current;
  const ticket = located.ticket;
  if (snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.claimId !== ticket.claimId || snapshot.testExecutionId !== undefined)
    throw new Error("Original retired claim journal has conflicting execution ownership.");
  if (current.ticket.launchId === ticket.launchId) return snapshot;
  // Generations share one journal. An older ticket never rewrites another generation's receipt.
  return null;
};

export const createRetiredClaimNativeCleanup = (options: {
  homeDirectory: string; identity: LegacyWorkerIdentity; jobLeases: ControllerJobLeases; storageStateDirectory?: string;
}) => {
  const validateEndpoint = (located: LocatedClaimController): void => {
    const ticket = located.ticket, root = located.storageStateDirectory;
    const endpoints = [resolveControllerIpcEndpoint(options.homeDirectory, ticket.launchId, process.platform, root)];
    if (root === resolveControllerStateDirectory(options.homeDirectory)) endpoints.push(resolveControllerIpcEndpoint(options.homeDirectory, ticket.launchId));
    if (!endpoints.includes(ticket.ipcEndpoint)) throw new Error("Original Controller endpoint conflicts with its storage root.");
  };
  const removeEndpoint = async (endpoint: string): Promise<void> => {
    if (process.platform === "win32") return;
    try { await unlink(endpoint); } catch (error) { if (!missing(error)) throw error; }
    try { await lstat(endpoint); } catch (error) { if (missing(error)) return; throw error; }
    throw new Error("Original Controller endpoint remains after retired claim cleanup.");
  };
  const boundaryReceipt = (located: LocatedClaimController, controllerProcess: ProcessProof, nativeProcesses: readonly ProcessProof[]) => {
    const { ticket } = located;
    return { kind: "retired_claim_controller_boundary", launchId: ticket.launchId, executionId: ticket.executionId,
      executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, ticketHash: controllerPayloadHash(ticket),
      controllerProcess, nativeProcesses, boundaryEmpty: true, windowsJobStopped: true };
  };
  const receiptProcesses = (located: LocatedClaimController, proof: ProcessProof, value: unknown): ProcessProof[] | null => {
    if (value === null || typeof value !== "object" || !("nativeProcesses" in value) || !Array.isArray(value.nativeProcesses)) return null;
    const native = value.nativeProcesses.map(processProof);
    return isDeepStrictEqual(value, boundaryReceipt(located, proof, native)) ? native : null;
  };
  const readDetachedReceipt = async (file: string): Promise<unknown> => {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Retired Controller stop receipt is invalid.");
      return JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch (error) { if (missing(error)) return undefined; throw error; }
  };
  const stopController = async (located: LocatedClaimController, controllers: readonly LocatedClaimController[], request: { deadline: number; signal: AbortSignal }): Promise<boolean> => {
    const check = () => { request.signal.throwIfAborted(); if (Date.now() >= request.deadline) throw new Error("Retired claim native cleanup exceeded its deadline."); };
    check();
    const ticket = await readLaunchTicket(options.homeDirectory, located.ticket.launchId, located.storageStateDirectory);
    if (controllerPayloadHash(ticket) !== controllerPayloadHash(located.ticket)) throw new Error("Original Controller launch ticket changed during cleanup.");
    validateEndpoint(located);
    await options.jobLeases.cleanupBirth(ticket.launchId, request.deadline);
    check();
    const ticketFile = controllerTicketPath(options.homeDirectory, ticket.launchId, located.storageStateDirectory);
    const submissionMarker = `${ticketFile}.submitted`;
    const submitted = await ordinaryFileExists(submissionMarker);
    const snapshot = await currentSnapshot(located, controllers, request.deadline);
    const historical = snapshot === null || isLinuxControllerLaunch(snapshot.controllerProcess)
      ? readHistoricalStoppedControllerGeneration(located.journalFile, ticket, request.deadline) : null;
    const unreleased = await readUnreleasedLaunch(options.homeDirectory, ticket, located.storageStateDirectory);
    if (unreleased !== undefined) {
      if (snapshot !== null || historical !== null || located.resources.some(resource => resource.identity.kind === "provider" && resource.processProof !== null
        || resource.identity.kind === "launch" && resource.processProof !== null && processProof(resource.processProof).pid !== unreleased.pid))
        throw new Error("Unreleased retired Controller conflicts with its journal or process evidence.");
      try {
        await requestController(ticket, { kind: "observe" }, { signal: request.signal, timeoutMs: Math.max(1, Math.min(2000, request.deadline - Date.now())) });
      } catch (error) {
        check();
        if (!(error instanceof ControllerIpcOutcomeUnknownError)) throw error;
        const cause = error.cause;
        if (!(cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ECONNREFUSED"))) throw error;
        if (await currentSnapshot(located, controllers, request.deadline) !== null) throw new Error("Unreleased retired Controller gained journal evidence.");
        await options.jobLeases.release(ticket.launchId);
        await removeEndpoint(ticket.ipcEndpoint);
        check();
        return false;
      }
      throw new Error("Unreleased retired Controller conflicts with an authenticated Controller.");
    }
    const launches = located.resources.flatMap(resource => {
      if (resource.identity.kind !== "launch" || resource.processProof === null) return [];
      const launch = processProof(resource.processProof);
      if (submitted && hasLegacyUnreleasedControllerGateProof(ticket, resource, launch)) return [];
      return [launch];
    });
    const journalProof = snapshot?.controllerProcess ?? historical?.controllerProcess ?? null;
    const proof = journalProof ?? (submitted ? null : launches[0] ?? null);
    if (proof !== null && launches.some(launch => !preservesControllerProcessProof(launch, proof, ticket.launchId)))
      throw new Error("Original Controller has conflicting lifecycle and journal process proofs.");
    const native = [...(snapshot?.nativeProcesses ?? historical?.nativeProcesses ?? [])];
    const addNative = (provider: ProcessProof): void => {
      if (!native.some(existing => isDeepStrictEqual(existing, provider))) native.push(provider);
    };
    for (const resource of located.resources) {
      if (resource.identity.kind === "provider" && resource.processProof !== null) addNative(processProof(resource.processProof));
    }
    if (proof !== null) {
      if (process.platform === "win32" && (isLinuxControllerLaunch(proof) || proof.jobObjectName !== `Local\\Daynight-${located.ticket.launchId}`)) throw new Error("Original Controller Windows Job conflicts with its launch identity.");
      const receiptFile = `${ticketFile}.retired-stop`;
      let lease = await options.jobLeases.get(ticket.launchId);
      let durableBoundary = false;
      if (!submitted && options.jobLeases.enabled && lease === undefined) {
        if (isLinuxControllerLaunch(proof)) throw new Error("Linux Controller identity cannot own a Windows Job.");
        const detached = await readDetachedReceipt(receiptFile);
        if (detached !== undefined) {
          const processes = receiptProcesses(located, proof, detached);
          if (processes === null) throw new Error("Retired Controller stop receipt conflicts with its original boundary.");
          processes.forEach(addNative);
          durableBoundary = true;
        }
        for (const resource of located.resources) {
          if (resource.stage !== "stopped" || !isDurableLegacyResource(resource) || resource.stopProof === null
            || typeof resource.stopProof !== "object" || Array.isArray(resource.stopProof)
            || resource.stopProof.kind !== "retired_claim_controller_boundary") continue;
          const processes = receiptProcesses(located, proof, resource.stopProof);
          if (processes === null) continue;
          processes.forEach(addNative);
          durableBoundary = true;
        }
      }
      if (historical !== null && isLinuxControllerLaunch(historical.controllerProcess)) {
        if (!preservesControllerProcessProof(proof, historical.controllerProcess, ticket.launchId)
          || snapshot !== null && (snapshot.executionId !== historical.executionId || snapshot.executionGeneration !== historical.executionGeneration
            || snapshot.controllerInstanceId !== historical.controllerInstanceId || snapshot.nativeSessionId !== historical.nativeSessionId)
          || !isDeepStrictEqual(native, historical.nativeProcesses)) throw new Error("Retired Controller stopped history conflicts with its original boundary.");
      } else if (lease === undefined && historical !== null) {
        await confirmDurableBoundaryProcesses([proof, ...native], request.deadline);
      } else if (!submitted && lease === undefined && snapshot === null && native.length === 0 && !isLinuxControllerLaunch(proof) && located.resources.some(resource => hasLegacyUnreleasedControllerGateProof(located.ticket, resource, proof))) {
        await confirmDurableBoundaryProcesses([proof], request.deadline);
      } else if (options.jobLeases.enabled && lease === undefined && snapshot?.lifecycle === "stopped" && snapshot.nativeStopped) {
        validateWindowsControllerStopProof(snapshot, located.ticket, controllerPayloadHash(located.ticket));
        await confirmDurableBoundaryProcesses([proof, ...native], request.deadline);
        await recordStoppedControllerGeneration(located.journalFile, located.ticket, { deadline: request.deadline, signal: request.signal });
      } else if (lease === undefined && durableBoundary) {
        await confirmDurableBoundaryProcesses([proof, ...native], request.deadline);
      } else {
        if (options.jobLeases.enabled && lease === undefined) {
          if (isLinuxControllerLaunch(proof)) throw new Error("Linux Controller identity cannot own a Windows Job.");
          lease = await options.jobLeases.retain(located.ticket.launchId, proof, request.deadline);
        }
        await stopControllerProcesses(proof, native, request.deadline, lease);
        check();
        if (!await confirmControllerProcessesStopped(proof, native, request.deadline, lease)) throw new Error("Original retired claim Controller boundary remains running.");
        if (snapshot !== null && snapshot.controllerProcess !== null) {
          await recordStoppedControllerGeneration(located.journalFile, ticket, { deadline: request.deadline, signal: request.signal, ...(lease === undefined ? {} : { jobLease: lease }) });
        } else if (lease !== undefined && historical === null) {
          if (isLinuxControllerLaunch(proof)) throw new Error("Linux Controller identity cannot own a Windows Job.");
          // A legacy launch can have an original native boundary without owning
          // the current journal. Persist its stop before releasing the Job.
          await replaceFileAtomically(receiptFile, JSON.stringify(boundaryReceipt(located, proof, native)), 0o600);
        }
      }
    } else {
      const neverSubmitted = !submitted && snapshot === null && located.resources.some(resource => resource.identity.kind === "launch" && isDurableLegacyResource(resource)
        && (resource.stage === "not_dispatched" || hasLegacyUnreleasedControllerGateProof(ticket, resource, null)));
      if (!neverSubmitted || native.length > 0 || await options.jobLeases.get(ticket.launchId) !== undefined
        || located.resources.some(resource => !isDurableLegacyResource(resource))) {
        throw new Error("Original retired claim native resources have no Controller boundary proof or authoritative non-submission evidence.");
      }
    }
    check();
    if (!submitted && await ordinaryFileExists(submissionMarker)) throw new Error("Original Controller submission changed during retired claim cleanup.");
    await options.jobLeases.release(located.ticket.launchId);
    await removeEndpoint(ticket.ipcEndpoint);
    check();
    return proof !== null;
  };
  return {
    locate: (targets: readonly CleanupTarget[], operation: Operation) => locateRetiredClaimControllers(options, targets, operation),
    stop: async (located: LocatedClaimNative, request: { deadline: number; signal: AbortSignal }): Promise<ClaimNativeClearance> => {
      request.signal.throwIfAborted();
      if (Date.now() >= request.deadline) throw new Error("Retired claim native cleanup exceeded its deadline.");
      const resources = readLegacyWorkerResources(options.homeDirectory, options.identity, "controller").filter(({ identity }) =>
        identity.projectId === located.target.projectId && identity.taskId === located.target.taskId && identity.claimId === located.target.claimId);
      const original = located.controllers.flatMap(controller => controller.resources).sort((a, b) => a.resourceId.localeCompare(b.resourceId));
      if (!isDeepStrictEqual(resources, original)) throw new Error("Original retired claim lifecycle evidence changed during cleanup.");
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
