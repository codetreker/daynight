import type { ProcessProof } from "../../controller/process-proof.js";
import { acquireControllerJobLease, releaseControllerJobLease, type ControllerJobLease } from "../../controller/windows-job.js";

/** Hold authenticated Job handles for the lifetime of the Worker responsibility. */
export const createControllerJobLeases = (platform: NodeJS.Platform = process.platform) => {
  const entries = new Map<string, { proof: ProcessProof; lease: Promise<ControllerJobLease> }>();
  const same = (a: ProcessProof, b: ProcessProof, launchId: string) => a.pid === b.pid && a.parentPid === b.parentPid && a.processGroupId === b.processGroupId && a.startedAt === b.startedAt && a.commandHash === b.commandHash && [a.jobObjectName, b.jobObjectName].every(name => name === undefined || name === `Local\\Daynight-${launchId}`);
  return {
    enabled: platform === "win32",
    retain: async (launchId: string, proof: ProcessProof, deadline: number): Promise<ControllerJobLease | undefined> => {
      if (platform !== "win32") return undefined;
      let entry = entries.get(launchId);
      if (entry !== undefined && !same(entry.proof, proof, launchId)) throw new Error("Controller Job lease conflicts with the original spawn proof.");
      if (entry === undefined) {
        entry = { proof: { ...proof }, lease: acquireControllerJobLease(launchId, proof, deadline) };
        entries.set(launchId, entry);
        try { await entry.lease; } catch (error) { if (entries.get(launchId) === entry) entries.delete(launchId); throw error; }
      }
      return entry.lease;
    },
    get: async (launchId: string): Promise<ControllerJobLease | undefined> => entries.get(launchId)?.lease,
    release: async (launchId: string): Promise<void> => {
      const entry = entries.get(launchId); if (entry === undefined) return;
      const lease = await entry.lease; entries.delete(launchId); releaseControllerJobLease(lease);
    },
    close: async (): Promise<void> => {
      const failures: unknown[] = [];
      for (const [id, entry] of entries) {
        try { const lease = await entry.lease; entries.delete(id); releaseControllerJobLease(lease); }
        catch (error) { entries.delete(id); failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Controller Job lease release failed.");
    },
  };
};
export type ControllerJobLeases = ReturnType<typeof createControllerJobLeases>;
