import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { WorkerDirectoryInput } from "../../../../src/commands/worker/read-only/directory.js";
import { startWorkerReadonlyPeers, WorkerReadonlyCleanupError, type WorkerReadonlyFrame } from "../../../fixtures/worker-readonly-peer.js";

const childrenDrained = (error: unknown): boolean => {
  if (error instanceof WorkerReadonlyCleanupError && !error.childrenDrained) return false;
  return !(error instanceof AggregateError) || error.errors.every(childrenDrained);
};
const digest = (content: Uint8Array): string => createHash("sha256").update(content).digest("hex");

test("real Worker processes browse their own directories and close their channels", async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../../.tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "worker-readonly-"));
  let peers: Awaited<ReturnType<typeof startWorkerReadonlyPeers>> | undefined;
  let primary: unknown;
  let requests: Promise<void> | undefined;
  try {
    const targets = [];
    for (const [index, prefix] of ["alpha", "beta"].entries()) {
      const directory = path.join(root, prefix);
      await mkdir(directory, { mode: 0o700 });
      const defaultCwd = await realpath(directory);
      const names = ["a", "b", "c"].map(suffix => `${prefix}-${suffix}`);
      for (const name of [...names, ".hidden"]) await mkdir(path.join(defaultCwd, name), { mode: 0o700 });
      const file = path.join(defaultCwd, "private.txt");
      await writeFile(file, `unchanged content for target ${index}`, { mode: 0o600 });
      targets.push({ ownerUserId: randomUUID(), workerId: randomUUID(), serverToken: `dnpat_${Buffer.alloc(32, index + 1).toString("base64url")}`, defaultCwd, names, file, before: digest(await readFile(file)) });
    }
    peers = await startWorkerReadonlyPeers(targets);
    let timer: NodeJS.Timeout | undefined;
    try {
      requests = (async () => {
        let pages = 0;
        for (const target of targets) {
          const names: string[] = [];
          let cursor: string | null = null, fence: WorkerReadonlyFrame | undefined;
          do {
            const input: WorkerDirectoryInput = cursor === null ? { limit: 1 } : { limit: 1, cursor };
            const requestId = randomUUID();
            const { message, raw } = await peers!.request(target.workerId, requestId, input);
            expect(JSON.parse(raw.toString("utf8"))).toEqual(message);
            expect(message).toMatchObject({ type: "result", protocol: "daynight.worker-readonly.v1", ownerUserId: target.ownerUserId, workerId: target.workerId, requestId });
            expect(message.error).toBeUndefined();
            const current: WorkerReadonlyFrame = { protocol: message.protocol, ownerUserId: message.ownerUserId, workerId: message.workerId, connectionId: message.connectionId, capabilityGeneration: message.capabilityGeneration };
            expect(current.connectionId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
            expect(current.capabilityGeneration).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
            if (fence) expect(current).toEqual(fence); else fence = current;
            expect(message.result).toBeDefined();
            const result = message.result!;
            expect(result.path).toBe(target.defaultCwd);
            expect(result.entries).toHaveLength(1);
            const entry = result.entries[0]!;
            expect(entry.path).toBe(path.join(target.defaultCwd, entry.name));
            names.push(entry.name); pages++;
            cursor = result.nextCursor;
            expect(names.length).toBeLessThanOrEqual(10);
          } while (cursor !== null);
          expect(names).toEqual(target.names);
          expect(names).toHaveLength(3);
        }
        expect(pages).toBe(6);
        for (const target of targets) expect(digest(await readFile(target.file))).toBe(target.before);
      })();
      await Promise.race([requests, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Directory request group exceeded twenty seconds.")), 20_000); })]);
    } finally { if (timer) clearTimeout(timer); }
  } catch (error) { primary = error; }
  const errors: unknown[] = [];
  try { await peers?.close(); } catch (error) { errors.push(error); }
  if (requests) await requests.catch(() => {});
  if (errors.every(childrenDrained) && childrenDrained(primary)) {
    try { await rm(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  } else errors.push(new Error(`Worker fixture directory retained because child shutdown was not confirmed: ${root}`));
  if (primary !== undefined) errors.unshift(primary);
  if (errors.length) throw new AggregateError(errors, "Worker directory process test failed.");
}, 90_000);
