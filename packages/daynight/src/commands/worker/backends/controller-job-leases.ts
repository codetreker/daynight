import type { ProcessProof } from "../../controller/process-proof.js";
import { acquireControllerJobLease, releaseControllerJobLease, type ControllerJobLease } from "../../controller/windows-job.js";

/** Hold authenticated Job handles for the lifetime of the Worker responsibility. */
export const createControllerJobLeases = (platform: NodeJS.Platform = process.platform) => {
  const entries = new Map<string, { proof: ProcessProof; lease: Promise<ControllerJobLease>; closeHandles?: () => void }>();
  const births = new Map<string, { cleanup(deadline: number): Promise<void>; running?: Promise<void> }>();
  const cleanupBirth = async (launchId: string, deadline: number): Promise<void> => {
    const birth = births.get(launchId); if (birth === undefined) return;
    if (birth.running === undefined) {
      const work = Promise.resolve().then(() => birth.cleanup(deadline)); birth.running = work;
      void work.catch(() => { if (birth.running === work) delete birth.running; });
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([birth.running, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Original Controller birth cleanup remains pending.")), Math.max(1, deadline - Date.now())); })]);
      if (births.get(launchId) === birth) births.delete(launchId);
    } finally { clearTimeout(timer); }
  };
  const same = (a: ProcessProof, b: ProcessProof, launchId: string) => a.pid === b.pid && a.parentPid === b.parentPid && a.processGroupId === b.processGroupId && a.startedAt === b.startedAt && a.commandHash === b.commandHash && [a.jobObjectName, b.jobObjectName].every(name => name === undefined || name === `Local\\Daynight-${launchId}`);
  return {
    enabled: platform === "win32",
    retainBirthCleanup: (launchId: string, cleanup: (deadline: number) => Promise<void>): (() => void) => {
      if (births.has(launchId)) throw new Error("Original Controller birth cleanup is already retained.");
      const birth = { cleanup }; births.set(launchId, birth);
      return () => { if (births.get(launchId) === birth) births.delete(launchId); };
    },
    cleanupBirth,
    adopt: (launchId: string, proof: ProcessProof, lease: ControllerJobLease, closeHandles: () => void): void => {
      if (platform !== "win32" || entries.has(launchId)) throw new Error("Controller launch ownership cannot replace an existing Job lease.");
      entries.set(launchId, { proof: { ...proof }, lease: Promise.resolve(lease), closeHandles });
    },
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
      const lease = await entry.lease; entry.closeHandles?.(); releaseControllerJobLease(lease); entries.delete(launchId);
    },
    close: async (): Promise<void> => {
      const failures: unknown[] = [];
      for (const id of births.keys()) try { await cleanupBirth(id, Date.now() + 5000); } catch (error) { failures.push(error); }
      for (const [id, entry] of entries) {
        try { const lease = await entry.lease; entry.closeHandles?.(); releaseControllerJobLease(lease); entries.delete(id); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Controller Job lease release failed.");
    },
  };
};
export type ControllerJobLeases = ReturnType<typeof createControllerJobLeases>;
