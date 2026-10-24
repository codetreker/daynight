import { canonicalId, project, record, timestamp } from "../../api/parse";
import { TaskCacheError, type ProjectRecord, type UserScopeRecord } from "./database";

const uuid = (value: unknown): string => {
  if (typeof value !== "string" || canonicalId(value) !== value) throw new Error("Invalid cache lifecycle identifier.");
  return value;
};
const count = (value: unknown, maximum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error("Invalid cache manifest count.");
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
    const taskCount = count(data.taskCount, 1000);
    const edgeCount = count(data.edgeCount, 5000);
    if (data.state === "invalidated") {
      if (data.invalidatedBy !== "access" && data.invalidatedBy !== "corrupt" && data.invalidatedBy !== "user" ||
        data.epoch !== null || data.project !== null || data.maxUpdatedAt !== null || taskCount !== 0 || edgeCount !== 0) throw new Error("Invalid invalidated cache baseline.");
      return { userId, projectId, userFence, cacheGeneration, state: "invalidated", invalidatedBy: data.invalidatedBy,
        epoch: null, project: null, maxUpdatedAt: null, taskCount, edgeCount };
    }
    if (data.state !== "active" || data.invalidatedBy !== null) throw new Error("Invalid active cache baseline.");
    const epoch = uuid(data.epoch);
    const parsedProject = project(data.project);
    const maxUpdatedAt = data.maxUpdatedAt === null ? null : timestamp(data.maxUpdatedAt);
    if (parsedProject.id !== projectId || (taskCount === 0) !== (maxUpdatedAt === null)) throw new Error("Invalid active cache manifest.");
    return { userId, projectId, userFence, cacheGeneration, state: "active", invalidatedBy: null,
      epoch, project: parsedProject, maxUpdatedAt, taskCount, edgeCount };
  } catch (error) { throw new TaskCacheError("corrupt", error); }
};
