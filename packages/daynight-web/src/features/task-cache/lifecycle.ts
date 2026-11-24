import { canonicalId, project, record, timestamp } from "../../api/parse";
import { TaskCacheError, type ProjectRecord, type UserScopeRecord } from "./database";

const uuid = (value: unknown): string => {
  if (typeof value !== "string" || canonicalId(value) !== value) throw new Error("Invalid cache lifecycle identifier.");
  return value;
};
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid cache manifest count.");
  return value;
};

export const validateUserScope = (value: unknown, userId: string): UserScopeRecord => {
  try {
    const data = record(value);
    if (data.userId !== userId) throw new Error("Invalid cache user ownership.");
    return { userId, userFence: uuid(data.userFence) };
  } catch (error) { throw new TaskCacheError("corrupt", error); }
};

export const validateProjectManifest = (value: unknown, userId: string, projectId: string, userFence: string): ProjectRecord => {
  try {
    const data = record(value);
    if (data.userId !== userId || data.projectId !== projectId || data.userFence !== userFence) throw new Error("Invalid cache project ownership.");
    const cacheGeneration = uuid(data.cacheGeneration);
    const syncRevision = uuid(data.syncRevision);
    const ancestors = data.generationAncestors === undefined ? undefined : (() => {
      if (!Array.isArray(data.generationAncestors)) throw new Error("Invalid generation history.");
      const values = data.generationAncestors.map(uuid);
      if (new Set(values).size !== values.length || values.includes(cacheGeneration)) throw new Error("Invalid generation history.");
      return values;
    })();
    if (data.unknownAncestors !== undefined && typeof data.unknownAncestors !== "boolean") throw new Error("Invalid generation history.");
    const history = { ...(ancestors === undefined ? {} : { generationAncestors: ancestors }), ...(data.unknownAncestors === undefined ? {} : { unknownAncestors: data.unknownAncestors as boolean }) };
    const taskCount = count(data.taskCount);
    const edgeCount = count(data.edgeCount);
    if (data.state === "invalidated") {
      if (data.invalidatedBy !== "access" && data.invalidatedBy !== "corrupt" && data.invalidatedBy !== "user" ||
        data.epoch !== null || data.project !== null || data.coverageUpdatedAt !== null || data.rebuildRevision !== undefined || taskCount !== 0 || edgeCount !== 0) throw new Error("Invalid invalidated cache baseline.");
      return { userId, projectId, userFence, cacheGeneration, syncRevision, ...history, state: "invalidated", invalidatedBy: data.invalidatedBy,
        epoch: null, project: null, coverageUpdatedAt: null, taskCount, edgeCount };
    }
    if (data.state !== "active" || data.invalidatedBy !== null) throw new Error("Invalid active cache baseline.");
    const epoch = uuid(data.epoch);
    const rebuild = data.rebuildRevision === undefined ? {} : { rebuildRevision: uuid(data.rebuildRevision) };
    const parsedProject = project(data.project);
    const coverageUpdatedAt = data.coverageUpdatedAt === null ? null : timestamp(data.coverageUpdatedAt);
    if (parsedProject.id !== projectId || taskCount !== 0 && coverageUpdatedAt === null || coverageUpdatedAt?.startsWith("0000-")) throw new Error("Invalid active cache manifest.");
    return { userId, projectId, userFence, cacheGeneration, syncRevision, ...rebuild, ...history, state: "active", invalidatedBy: null,
      epoch, project: parsedProject, coverageUpdatedAt, taskCount, edgeCount };
  } catch (error) { throw new TaskCacheError("corrupt", error); }
};

export class TaskCacheLifecycleChanged extends DOMException {
  constructor(readonly retryable = true) { super("The task cache lifecycle changed.", "AbortError"); }
}
export const isRetryableTaskCacheLifecycleChange = (error: unknown): error is TaskCacheLifecycleChanged =>
  error instanceof TaskCacheLifecycleChanged && error.retryable;
