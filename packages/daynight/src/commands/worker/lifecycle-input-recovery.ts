import { isDeepStrictEqual } from "node:util";
import { readControllerSnapshot, readProvenWindowsStoppedControllerGeneration, readStoppedRecoverableInitialInput } from "../controller/lifecycle-store.js";
import { confirmControllerProcessesStopped, type ProcessProof } from "../controller/process-proof.js";
import { assertRecoveredInitialReservation } from "../controller/worker-lifecycle.js";
import { preservesControllerProcessProof } from "./backends/orchestration.js";
import { readLifecycleControllerLocation } from "./lifecycle-controller-ticket.js";
import type { LifecycleIdentity, LifecycleResource, LifecycleStore } from "./lifecycle-store.js";

/** Close only the original prepared input responsibility after its entire native boundary stopped. */
export const reconcilePreparedInitialReservation = async (input: { homeDirectory: string; identity: LifecycleIdentity; lifecycle: LifecycleStore; resource: LifecycleResource; deadline: number }): Promise<void> => {
  const { homeDirectory, identity, lifecycle, resource, deadline } = input;
  const original = await readLifecycleControllerLocation(homeDirectory, identity, resource);
  const snapshot = readControllerSnapshot(original.journalFile);
  if (snapshot === null || BigInt(snapshot.executionGeneration) <= 1n) throw new Error("Recovered initial input has no current stopped generation.");
  const launches = lifecycle.listResources().filter(candidate => candidate.ownerKind === "controller" && candidate.identity.kind === "launch"
    && candidate.identity.executionId === snapshot.executionId && candidate.identity.controllerInstanceId === snapshot.controllerInstanceId
    && candidate.identity.executionGeneration === snapshot.executionGeneration);
  if (launches.length !== 1 || launches[0]!.processProof === null) throw new Error("Recovered initial input has no unique current Controller launch proof.");
  const launch = launches[0]!;
  const current = await readLifecycleControllerLocation(homeDirectory, identity, launch);
  if (current.journalFile !== original.journalFile || current.storageStateDirectory !== original.storageStateDirectory)
    throw new Error("Recovered initial input belongs to a different Controller journal.");
  assertRecoveredInitialReservation(homeDirectory, current.ticket, resource, original.ticket, current.storageStateDirectory);
  const evidence = await readStoppedRecoverableInitialInput(current.journalFile, current.ticket, homeDirectory, original.ticket, deadline, current.storageStateDirectory);
  if (evidence.snapshot.controllerProcess === null || !preservesControllerProcessProof(launch.processProof as ProcessProof, evidence.snapshot.controllerProcess, current.ticket.launchId))
    throw new Error("Recovered initial input conflicts with the original Controller process proof.");
  if (process.platform === "win32") readProvenWindowsStoppedControllerGeneration(current.journalFile, current.ticket, deadline);
  else if (!await confirmControllerProcessesStopped(evidence.snapshot.controllerProcess, evidence.snapshot.nativeProcesses, deadline))
    throw new Error("Recovered initial input native boundary is not stopped.");
  const reread = await readStoppedRecoverableInitialInput(current.journalFile, current.ticket, homeDirectory, original.ticket, deadline, current.storageStateDirectory);
  if (!isDeepStrictEqual(evidence.snapshot, reread.snapshot) || !isDeepStrictEqual(evidence.operation, reread.operation))
    throw new Error("Recovered initial input evidence changed during stop verification.");
  lifecycle.settlePreparedControllerInput(resource);
};
