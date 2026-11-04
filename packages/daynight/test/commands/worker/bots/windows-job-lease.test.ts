import { describe, expect, it, vi } from "vitest";
import { createWindowsBotJobLease, WindowsBotJobError, WindowsBotJobSetupError, type WindowsBotJobKernel } from "../../../../src/commands/worker/bots/windows-job-lease.js";

const launch = "11111111-1111-4111-8111-111111111111";
const fixture = () => {
  const handle = {}, events: string[] = [];
  let members: number[] = [];
  const kernel: WindowsBotJobKernel = {
    create: () => { events.push("create"); return handle; },
    killOnClose: observed => { expect(observed).toBe(handle); events.push("kill-on-close"); },
    assign: (observed, pid) => { expect(observed).toBe(handle); members.push(pid); events.push("assign"); },
    inspect: observed => { expect(observed).toBe(handle); return [...members]; },
    terminate: observed => { expect(observed).toBe(handle); members = []; events.push("terminate"); },
    close: observed => { expect(observed).toBe(handle); events.push("close"); },
  };
  return { kernel, events };
};

describe("Windows Bot Job Object handle lease", () => {
  it("retains its original handle until the complete job becomes empty", async () => {
    const f = fixture(); const lease = await createWindowsBotJobLease(launch, f.kernel);
    lease.assign(42);
    expect(f.events).toEqual(["create", "kill-on-close", "assign"]);
    expect(lease.inspect()).toEqual([42]);
    expect(() => lease.close()).toThrow(/members remain/);
    expect(f.events).not.toContain("close");
    lease.terminate(); expect(lease.inspect()).toEqual([]);
    lease.close(); lease.close();
    expect(f.events).toEqual(["create", "kill-on-close", "assign", "terminate", "close"]);
    expect(() => lease.assign(43)).toThrow(/closed/);
  });

  it("preserves the handle when query, termination or close cannot be confirmed", async () => {
    const f = fixture(); const lease = await createWindowsBotJobLease(launch, f.kernel);
    lease.assign(42);
    const inspect = vi.spyOn(f.kernel, "inspect").mockImplementationOnce(() => { throw new WindowsBotJobError("query-members", 5); });
    expect(() => lease.close()).toThrow(/Win32 5/); expect(f.events).not.toContain("close");
    inspect.mockRestore();
    const terminate = vi.spyOn(f.kernel, "terminate").mockImplementationOnce(() => { throw new WindowsBotJobError("terminate-members", 5); });
    expect(() => lease.terminate()).toThrow(/Win32 5/); expect(lease.inspect()).toEqual([42]);
    terminate.mockRestore(); lease.terminate();
    const close = vi.spyOn(f.kernel, "close").mockImplementationOnce(() => { throw new WindowsBotJobError("close-job-handle", 5); });
    expect(() => lease.close()).toThrow(/Win32 5/);
    close.mockRestore(); lease.close(); expect(f.events.at(-1)).toBe("close");
  });

  it("releases a new empty handle when kill-on-close configuration fails", async () => {
    const f = fixture(); f.kernel.killOnClose = () => { throw new WindowsBotJobError("configure-kill-on-close", 5); };
    await expect(createWindowsBotJobLease(launch, f.kernel)).rejects.toMatchObject({ stage: "configure-kill-on-close", win32Code: 5 });
    expect(f.events).toEqual(["create", "close"]);
  });

  it("returns the original lease if setup cleanup also fails", async () => {
    const f = fixture(); f.kernel.killOnClose = () => { throw new WindowsBotJobError("configure-kill-on-close", 5); };
    const close = vi.spyOn(f.kernel, "close").mockImplementationOnce(() => { throw new WindowsBotJobError("close-job-handle", 5); });
    let failure: WindowsBotJobSetupError | undefined;
    try { await createWindowsBotJobLease(launch, f.kernel); } catch (error) { failure = error as WindowsBotJobSetupError; }
    expect(failure).toBeInstanceOf(WindowsBotJobSetupError);
    close.mockRestore(); failure!.lease.close(); expect(f.events).toEqual(["create", "close"]);
  });

  it("validates job and process identities before native calls", async () => {
    const f = fixture();
    await expect(createWindowsBotJobLease("invalid", f.kernel)).rejects.toThrow(/identity/);
    expect(f.events).toEqual([]);
    const lease = await createWindowsBotJobLease(launch, f.kernel);
    expect(() => lease.assign(-1)).toThrow(/process ID/);
    lease.close(); expect(f.events).not.toContain("assign");
  });
});
