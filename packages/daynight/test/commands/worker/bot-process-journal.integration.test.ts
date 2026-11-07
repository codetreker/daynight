import { afterEach, expect, test } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { cleanupBotProcesses, fixture } from "./bot-process.fixtures.js";

afterEach(cleanupBotProcesses);

test("recovers a native initialization rejection from the original journal after IPC closes",async()=>{
  const f=fixture(), signal=new AbortController().signal;
  f.launch.mockImplementationOnce(async options=>{
    await options.onSubmitting();
    const journal=openControllerLifecycleStore(f.current().intent!.journalPath,options.ticket);
    journal.patchSnapshot({lifecycle:"failed",startup:{state:"failed",reasonCode:"native_rejected"},error:"native rejected"});journal.close();
    throw new Error("IPC closed before observation");
  });
  await expect(f.process.advance(f.current(),signal)).rejects.toThrow("IPC closed");f.observe.mockRejectedValue(new Error("unreachable"));
  expect(await f.createProcess().advance(f.current(),signal)).toMatchObject({startup:{state:"failed",reasonCode:"native_rejected"}});
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
