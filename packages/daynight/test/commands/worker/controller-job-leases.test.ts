import { afterEach, expect, it, vi } from "vitest";
import { createControllerJobLeases } from "../../../src/commands/worker/backends/controller-job-leases.js";
import * as jobs from "../../../src/commands/controller/windows-job.js";

const proof = { pid: 123, parentPid: 12, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64) };
const launchId = "00000000-0000-4000-8000-000000000001";
afterEach(() => vi.restoreAllMocks());

it("retains one authenticated Job handle across repeated observations until release", async () => {
  const lease = {} as jobs.ControllerJobLease;
  const acquire = vi.spyOn(jobs, "acquireControllerJobLease").mockResolvedValue(lease);
  const release = vi.spyOn(jobs, "releaseControllerJobLease").mockImplementation(() => {});
  const owner = createControllerJobLeases("win32"), deadline = Date.now() + 5000;
  expect(await owner.retain(launchId, proof, deadline)).toBe(lease);
  expect(await owner.retain(launchId, { ...proof, jobObjectName: `Local\\Daynight-${launchId}` }, deadline)).toBe(lease);
  expect(acquire).toHaveBeenCalledOnce(); expect(await owner.get(launchId)).toBe(lease);
  await expect(owner.retain(launchId, { ...proof, startedAt: "replacement" }, deadline)).rejects.toThrow(/conflicts/);
  await owner.release(launchId); expect(release).toHaveBeenCalledExactlyOnceWith(lease);
  expect(await owner.get(launchId)).toBeUndefined();
});

it("retains other responsibilities and reports a handle release failure on Worker close", async () => {
  const lease = {} as jobs.ControllerJobLease, failure = new Error("close failed");
  vi.spyOn(jobs, "acquireControllerJobLease").mockResolvedValue(lease);
  vi.spyOn(jobs, "releaseControllerJobLease").mockImplementation(() => { throw failure; });
  const owner = createControllerJobLeases("win32"); await owner.retain(launchId, proof, Date.now() + 5000);
  const error = await owner.close().catch(error => error);
  expect(error.errors).toEqual([failure]); expect(await owner.get(launchId)).toBeUndefined();
});
