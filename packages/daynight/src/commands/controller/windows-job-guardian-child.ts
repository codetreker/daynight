import { controllerPayloadHash, parseLaunchTicket } from "./launch-ticket.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
import { assignWindowsJobSource, prepareWindowsJobSource, readWindowsJobReceipt, readWindowsJobSource } from "./lifecycle-store.js";
import { createGuardianErrorReporter, createWindowsJobGuardian } from "./windows-job-guardian.js";
import type { ProcessProof } from "./process-proof.js";

// The inherited IPC is only a one-time bootstrap. The guardian owns the Job
// after its Controller or launcher disconnects.
const report = createGuardianErrorReporter(message => console.error("Windows Job guardian:", message));
const send = (message: unknown): void => {
  if (!process.connected || process.send === undefined) return;
  try { process.send(message, error => { if (error) report(error); }); } catch (error) { report(error); }
};
process.on("error", report);
process.once("message", (value: unknown) => {
  void (async () => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Windows guardian bootstrap.");
    const input = value as { ticket?: unknown; journalPath?: unknown; controller?: unknown };
    const ticket: ControllerLaunchTicket = parseLaunchTicket(input.ticket);
    if (typeof input.journalPath !== "string" || typeof input.controller !== "object" || input.controller === null) throw new Error("Incomplete Windows guardian bootstrap.");
    const file = input.journalPath, controller = input.controller as ProcessProof;
    const guardian = await createWindowsJobGuardian({ identity: {
      launchId: ticket.launchId, executionId: ticket.executionId, executionGeneration: ticket.executionGeneration,
      controllerInstanceId: ticket.controllerInstanceId, ticketHash: controllerPayloadHash(ticket), controller,
    }, journal: {
      prepare: source => prepareWindowsJobSource(file, ticket, source),
      assign: (prepared, assigned) => assignWindowsJobSource(file, ticket, prepared, assigned),
      readSource: () => readWindowsJobSource(file, ticket),
      readReceipt: () => readWindowsJobReceipt(file, ticket),
    } });
    try {
      const source = await guardian.start();
      send({ kind: "ready", source });
    } catch (error) {
      send({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    }
    try { if (process.connected) process.disconnect?.(); } catch (error) { report(error); }
    await guardian.runUntilReleased(report);
  })().catch(error => { report(error); process.exitCode = 1; });
});
