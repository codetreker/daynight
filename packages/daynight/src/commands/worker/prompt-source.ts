import { workerPromptKeyId } from "../../api/worker-configuration.js";
import type { WorkerPromptKey, WorkerPromptResource, WorkerPromptResult, WorkerPromptSelector } from "../../api/worker-configuration.js";
import { canonicalId, ProtocolError } from "../../api/validation.js";

export type WorkerPromptTuple = Readonly<{ user: WorkerPromptResource; project: WorkerPromptResource; worker: WorkerPromptResource }>;
export type WorkerPromptCapture = Readonly<{ cycleId: number; selectors: readonly WorkerPromptSelector[]; generations: readonly number[] }>;
export type WorkerPromptIdentity = Readonly<{ serverOrigin: string; userId: string; workerId: string }>;

type Entry = { readonly key: WorkerPromptKey; generation: number; value: WorkerPromptResource | null; available: boolean };

// A source is strictly process-local. Only the reporter owns I/O and timing.
export const createWorkerPromptSource = (identity: WorkerPromptIdentity) => {
  if (canonicalId(identity.userId) !== identity.userId || canonicalId(identity.workerId) !== identity.workerId || new URL(identity.serverOrigin).origin !== identity.serverOrigin) throw new TypeError("Invalid Worker prompt identity.");
  const entries = new Map<string, Entry>();
  let generation = 0, cycleId = 0, active = false, closed = false;
  let fifo: string[] = [], fresh: string[] = [];
  const create = (key: WorkerPromptKey): Entry => {
    const entry: Entry = { key: Object.freeze(key), generation: ++generation, value: null, available: false };
    entries.set(workerPromptKeyId(key), entry);
    return entry;
  };
  create({ scope: "user" });
  create({ scope: "worker" });
  const setDemand = (projectIds: readonly string[]): boolean => {
    if (closed) return false;
    const requested = new Set(projectIds.map(projectId => {
      if (canonicalId(projectId) !== projectId) throw new TypeError("Invalid prompt Project ID.");
      return `project:${projectId}`;
    }));
    let changed = false;
    for (const [key, entry] of entries) if (entry.key.scope === "project" && !requested.has(key)) {
      entries.delete(key); fifo = fifo.filter(item => item !== key); fresh = fresh.filter(item => item !== key); changed = true;
    }
    for (const key of requested) if (!entries.has(key)) {
      create({ scope: "project", projectId: key.slice("project:".length) });
      if (active) fresh.push(key);
      changed = true;
    }
    return changed;
  };
  const beginCycle = (): boolean => {
    if (closed || active) return false;
    active = true; cycleId++; fifo = [...entries.keys()]; fresh = [];
    return true;
  };
  const captureBatch = (): WorkerPromptCapture | null => {
    if (closed || !active) return null;
    const selected: string[] = [];
    if (fresh.length !== 0) selected.push(fresh.shift()!);
    while (selected.length < 3 && fifo.length !== 0) selected.push(fifo.shift()!);
    while (selected.length < 3 && fresh.length !== 0) selected.push(fresh.shift()!);
    const captured = selected.map(key => entries.get(key)).filter((entry): entry is Entry => entry !== undefined);
    if (captured.length === 0) { active = false; return null; }
    return Object.freeze({ cycleId, selectors: Object.freeze(captured.map(entry => Object.freeze({ key: entry.key, knownRevision: entry.available && entry.value !== null ? entry.value.revision : null }))), generations: Object.freeze(captured.map(entry => entry.generation)) });
  };
  const failCycle = (): void => { active = false; fifo = []; fresh = []; };
  const accept = (capture: WorkerPromptCapture, results: readonly WorkerPromptResult[]): boolean => {
    if (closed || !active || capture.cycleId !== cycleId) return false;
    if (results.length !== capture.selectors.length) { failCycle(); throw new ProtocolError("Prompt batch does not match its capture."); }
    const updates: (() => void)[] = [];
    try {
      results.forEach((result, index) => {
        const selector = capture.selectors[index]!, key = workerPromptKeyId(selector.key);
        if (workerPromptKeyId(result.key) !== key) throw new ProtocolError("Prompt batch key does not match its capture.");
        const entry = entries.get(key);
        if (entry === undefined || entry.generation !== capture.generations[index]) return;
        if (result.status === "unchanged") {
          if (!entry.available || entry.value === null || selector.knownRevision !== result.revision || entry.value.revision !== result.revision) throw new ProtocolError("Prompt unchanged response has no matching value.");
        } else if (result.status === "value") {
          if (entry.value !== null && entry.available) {
            const previous = BigInt(entry.value.revision), next = BigInt(result.value.revision);
            if (next < previous || next === previous && (entry.value.text !== result.value.text || entry.value.updatedAt !== result.value.updatedAt)) throw new ProtocolError("Prompt revision is inconsistent with its previous value.");
          }
          const value = Object.freeze({ ...result.value });
          updates.push(() => { entry.value = value; entry.available = true; });
        } else if (result.status === "unavailable") {
          updates.push(() => { entry.value = null; entry.available = false; entry.generation = ++generation; });
        }
      });
    } catch (error) { failCycle(); throw error; }
    updates.forEach(update => update());
    if (fifo.length === 0 && fresh.length === 0) { active = false; return false; }
    return true;
  };
  const current = (projectId: string): WorkerPromptTuple | null => {
    if (closed) return null;
    const user = entries.get("user"), project = entries.get(`project:${projectId}`), worker = entries.get("worker");
    if (!user?.available || !project?.available || !worker?.available || user.value === null || project.value === null || worker.value === null) return null;
    return Object.freeze({ user: user.value, project: project.value, worker: worker.value });
  };
  const close = (): void => { closed = true; failCycle(); entries.clear(); };
  return Object.freeze({ identity: Object.freeze({ ...identity }), setDemand, beginCycle, captureBatch, accept, failCycle, current, close });
};
export type WorkerPromptSource = ReturnType<typeof createWorkerPromptSource>;
