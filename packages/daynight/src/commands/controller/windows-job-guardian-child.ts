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
// Error details stay in the private guardian log; bootstrap inputs can contain secrets.
const fail = (stage: string, error: unknown): void => {
  report(error);
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  const code = error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? `, code=${error.code}` : "";
  send({ kind: "failed", message: `Guardian ${stage} failed (${name}${code}); see the private guardian log.` });
};
process.on("error", report);
process.once("message", (value: unknown) => {
  let stage = "bootstrap";
  void (async () => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Windows guardian bootstrap.");
    const input = value as { ticket?: unknown; journalPath?: unknown; controller?: unknown };
    const ticket: ControllerLaunchTicket = parseLaunchTicket(input.ticket);
    if (typeof input.journalPath !== "string" || typeof input.controller !== "object" || input.controller === null) throw new Error("Incomplete Windows guardian bootstrap.");
    const file = input.journalPath, controller = input.controller as ProcessProof;
    stage = "setup";
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
      stage = "assignment";
      const source = await guardian.start();
      send({ kind: "ready", source });
    } catch (error) {
      fail(stage, error);
    }
    try { if (process.connected) process.disconnect?.(); } catch (error) { report(error); }
    stage = "retention";
    await guardian.runUntilReleased(report);
  })().catch(error => {
    if (stage === "retention") report(error); else fail(stage, error);
    try { if (process.connected) process.disconnect?.(); } catch (cause) { report(cause); }
    process.exitCode = 1;
  });
});
