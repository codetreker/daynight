import { afterEach, expect, test } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { ControllerIpcOutcomeUnknownError } from "../../../src/commands/controller/local-client.js";
import { cleanupBotProcesses, fixture } from "./bot-process.fixtures.js";

afterEach(cleanupBotProcesses);

test("blocks journal recovery when the original spawn proof is missing",async()=>{
  const f=fixture(), signal=new AbortController().signal;
  f.launch.mockImplementationOnce(async options=>{
    await options.onSubmitting();
    const journal=openControllerLifecycleStore(f.current().intent!.journalPath,options.ticket);
    journal.patchSnapshot({lifecycle:"failed",startup:{state:"failed",reasonCode:"native_rejected"},error:"native rejected"});journal.close();
    throw new Error("IPC closed before observation");
  });
  await expect(f.process.advance(f.current(),signal)).rejects.toThrow("IPC closed");f.observe.mockRejectedValue(new ControllerIpcOutcomeUnknownError("unreachable"));
  await expect(f.createProcess().advance(f.current(),signal)).rejects.toThrow(/spawn proof.*unavailable/);
  expect(f.executions.get(f.current())!.launchSubmission).toBe("unknown");
  expect(f.launch).toHaveBeenCalledTimes(1);
});

test("stopped process without native ID never obtains a recovery grant or a blank replacement", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => { await options.onSubmitting(); const ticket = options.ticket; const journal = openControllerLifecycleStore(f.current().intent!.journalPath, ticket); journal.close(); throw new Error("unknown launch"); });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("unknown launch");
  f.observe.mockRejectedValue(new Error("IPC unavailable"));
  await expect(f.createProcess({ confirmStopped: async () => true }).advance(f.current(), signal)).rejects.toThrow();
  expect(f.grant).toHaveBeenCalledTimes(1); expect(f.launch).toHaveBeenCalledTimes(1);
});
