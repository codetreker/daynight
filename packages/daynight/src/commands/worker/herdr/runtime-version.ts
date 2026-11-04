import { stat } from "node:fs/promises";
import path from "node:path";
import type { Operation } from "../../../api/operation.js";
import type { TaskPlatform } from "../../../api/types.js";
import type { WorkerPaths } from "../paths.js";
import { createHerdrVersionObserver, resolveHerdrInstancePaths } from "./instance.js";
import { readHerdrLifecycleRecords } from "./lifecycle-store.js";
import type { MacProcessIdentity } from "./lifecycle-types.js";
import { createMacProcessControl } from "./native-macos.js";
import type { MacProcessControl } from "./native-macos.js";

export class HerdrVersionUnavailableError extends Error {
  constructor() { super("The current private Herdr version cannot be established."); this.name = "HerdrVersionUnavailableError"; }
}

/** Observes original daemons without acquiring lifecycle recovery or execution ownership. */
export const createHerdrRuntimeVersionObserver = (options: {
  paths: WorkerPaths; platform: TaskPlatform; workerId: string; serverOrigin: string;
}) => {
  const legacy = createHerdrVersionObserver(options.paths);
  let native: Pick<MacProcessControl, "observe" | "peer"> | undefined;
  return {
    observe: async (operation: Operation): Promise<string | null> => {
      operation.check();
      if (options.platform !== "macos") return legacy.observe(operation);
      const journal = path.join(options.paths.workerDirectory, "herdr-executions.sqlite");
      try { await stat(journal); }
      catch (error) {
        operation.check();
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return legacy.observe(operation);
        throw error;
      }
      operation.check();
      const records = readHerdrLifecycleRecords(journal);
      operation.check();
      const candidates: { instanceDirectory: string; daemon: MacProcessIdentity | null }[] = [];
      for (const record of records) {
        if (record.owner.workerId !== options.workerId || record.owner.serverOrigin !== options.serverOrigin) continue;
        const run = record.runs.at(-1);
        if (run !== undefined && run.phase !== "stopped_confirmed") candidates.push(run);
        if (record.preparation !== null && (record.preparation.daemon !== null || record.preparation.phase === "launch_requested")) candidates.push(record.preparation);
      }
      const versions = new Set<string>();
      for (const candidate of candidates) {
        operation.check();
        const original = candidate.daemon;
        if (original === null) throw new HerdrVersionUnavailableError();
        native ??= createMacProcessControl();
        const state = await native.observe(original);
        operation.check();
        if (state === "exited") continue;
        if (state !== "same") throw new HerdrVersionUnavailableError();
        const paths = { herdrDirectory: candidate.instanceDirectory, logsDirectory: path.join(candidate.instanceDirectory, "logs") };
        const endpoint = resolveHerdrInstancePaths(paths).apiEndpoint;
        const verify = async (): Promise<void> => {
          const peer = await native!.peer(endpoint);
          operation.check();
          if (peer.pid !== original.pid || peer.bootId !== original.bootId || peer.birthToken !== original.birthToken || JSON.stringify(peer.auditToken) !== JSON.stringify(original.auditToken)) throw new HerdrVersionUnavailableError();
        };
        await verify();
        const version = await createHerdrVersionObserver(paths).observe(operation);
        operation.check();
        // A live recorded process with an absent socket is unavailable, not proof of no daemon.
        if (version === null) throw new HerdrVersionUnavailableError();
        await verify();
        versions.add(version);
      }
      if (versions.size > 1) throw new HerdrVersionUnavailableError();
      return versions.values().next().value ?? null;
    },
  };
};
