import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeDurableJson } from "../../platform/durable-json.js";
import { SqliteAccessError, type SqliteOutcome } from "../../platform/sqlite-error.js";
import { sqliteTransactionOutcome } from "../../platform/sqlite-access.js";
import { readWindowsBootIdentity } from "../../platform/windows-boot.js";
import { controllerJournalFormat } from "./journal-format.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "./launch-ticket.js";
import { readCurrentControllerSnapshot, readProvenWindowsStoppedControllerGeneration, recordStoppedControllerGeneration } from "./lifecycle-store.js";
import { parseWindowsRebootWitness, proveWindowsReboot } from "./reboot-proof.js";
import { acquireControllerStoragePermit, controllerStorageConnectionIsOpen } from "./storage-lock.js";

export const recoverControllerAfterWindowsReboot = async (options: {
  file: string; ticket: ControllerLaunchTicket; prepare: boolean; deadline: number; beforeWrite(): Promise<void>;
}): Promise<"prepared" | "stopped"> => {
  if (process.platform !== "win32") throw new Error("Reboot recovery is supported only on Windows.");
  const { file, ticket, deadline } = options;
  const permit = acquireControllerStoragePermit(file, deadline, { fileMustExist: true });
  let failed = false, failure: unknown, outcome: SqliteOutcome = "not-started";
  try {
    const snapshot = readCurrentControllerSnapshot(file, ticket, deadline);
    if (snapshot.windowsJobStopProof !== undefined) {
      readProvenWindowsStoppedControllerGeneration(file, ticket, deadline);
      return "stopped";
    }
    if (snapshot.controllerProcess?.jobObjectName !== `Local\\Daynight-${ticket.launchId}` || snapshot.nativeSessionId === null
      || snapshot.initialInputState !== "confirmed") throw new Error("Reboot recovery requires the original Job identity, native Session and confirmed initial input.");
    const checkpoint = path.join(path.dirname(file), `reboot-recovery-${ticket.launchId}.json`);
    const ticketHash = controllerPayloadHash(ticket), snapshotHash = controllerPayloadHash(snapshot);
    if (options.prepare) {
      const current = await readWindowsBootIdentity(deadline);
      if (existsSync(checkpoint)) {
        const saved = parseWindowsRebootWitness(JSON.parse(readFileSync(checkpoint, "utf8")));
        if (saved.machineHash !== current.machineHash || saved.bootId !== current.bootId || saved.ticketHash !== ticketHash || saved.snapshotHash !== snapshotHash) throw new Error("An existing reboot checkpoint differs; do not overwrite original recovery evidence.");
      }
      await options.beforeWrite();
      if (controllerPayloadHash(readCurrentControllerSnapshot(file, ticket, deadline)) !== snapshotHash) throw new Error("The original controller changed during reboot preparation.");
      writeDurableJson(checkpoint, { version: 1, ...current, ticketHash, snapshotHash });
      return "prepared";
    }
    const witness = parseWindowsRebootWitness(JSON.parse(readFileSync(checkpoint, "utf8")));
    const rebootProof = await proveWindowsReboot(witness, ticketHash, snapshotHash, deadline);
    await options.beforeWrite();
    await recordStoppedControllerGeneration(file, ticket, { permit, deadline, rebootProof });
    outcome = "committed";
    return "stopped";
  } catch (error) {
    failed = true; failure = error; outcome = sqliteTransactionOutcome(error); throw error;
  } finally {
    if (!failed || !controllerStorageConnectionIsOpen(failure)) {
      try { permit.release(); }
      catch (close) { throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file, phase: "close" }, {
        cause: failed ? new AggregateError([failure, close], "Reboot recovery and storage permit release failed.") : close, outcome, connectionClosed: true,
      }); }
    }
  }
};
