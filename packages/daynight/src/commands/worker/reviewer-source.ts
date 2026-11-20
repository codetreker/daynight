import { createApiClient, ApiError } from "../../api/client.js";
import { createOperation } from "../../api/operation.js";
import { ProtocolError } from "../../api/parse.js";
import type { WorkerPromptKey, WorkerPromptResource } from "../../api/worker-configuration.js";
import type { WorkerPromptTuple } from "./prompt-source.js";
import type { AssignedPullRequest } from "../../api/reviewer.js";
import type { AssignmentObservation, AssignmentSource } from "../review/assignment.js";

type Entry = { generation: number; value: WorkerPromptResource | null };
const limits = { totalMs: 30_000, requestMs: 10_000, responseBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 };

export const createReviewerSource = (identity: { serverOrigin: string; userId: string; workerId: string; serverToken: string }) => {
  let observation: AssignmentObservation = { kind: "unavailable" };
  const listeners = new Set<() => void>();
  const entries = new Map<string, Entry>();
  let generation = 0;
  const entry = (key: string): Entry => {
    let value = entries.get(key);
    if (value === undefined) { value = { generation: ++generation, value: null }; entries.set(key, value); }
    return value;
  };
  const invalidate = (key: string): void => { entries.delete(key); generation++; };
  const invalidateAll = (): void => { entries.clear(); generation++; };
  const notify = (): void => { for (const listener of listeners) listener(); };
  const client = (operation: ReturnType<typeof createOperation>) => createApiClient({ serverUrl: identity.serverOrigin, serverToken: identity.serverToken, expectedUserId: identity.userId, operation });
  const publish = (next: AssignmentObservation): void => {
    const projects = new Set(next.kind === "enabled" ? next.pullRequests.map(item => item.projectId) : []);
    for (const key of entries.keys()) if (key.startsWith("project:") && !projects.has(key.slice(8)) && next.kind !== "unavailable") invalidate(key);
    if (next.kind === "disabled") invalidateAll();
    observation = next; notify();
  };
  const poll = async (signal: AbortSignal): Promise<void> => {
    const operation = createOperation({ signal, limits });
    const candidates: AssignedPullRequest[] = [], cursors = new Set<string>(), seen = new Set<string>();
    let cursor: string | undefined;
    try {
      do {
        const page = await client(operation).listReviewerPage(identity.workerId, cursor);
        if (!page.reviewEnabled) { publish({ kind: "disabled" }); return; }
        for (const candidate of page.pullRequests) {
          const key = `${candidate.projectId}/${candidate.repositoryId}/${candidate.number}`;
          if (seen.has(key)) throw new ProtocolError("Duplicate reviewer candidate across pages.");
          seen.add(key); candidates.push(candidate);
        }
        if (page.nextCursor !== null && cursors.has(page.nextCursor)) throw new ProtocolError("Repeated reviewer pagination cursor.");
        if (page.nextCursor !== null) cursors.add(page.nextCursor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      operation.check();
      publish({ kind: "enabled", pullRequests: candidates });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404 || error.phase === "protocol")) invalidateAll();
      if (error instanceof ApiError && error.status === 404 && error.code === "not_found") publish({ kind: "disabled" });
      else publish({ kind: "unavailable", error });
      throw error;
    } finally { operation.dispose(); }
  };
  const capturePrompt = async (projectId: string, signal: AbortSignal): Promise<{ values: WorkerPromptTuple; isCurrent(): boolean }> => {
    const keys: readonly WorkerPromptKey[] = [{ scope: "user" }, { scope: "project", projectId }, { scope: "worker" }];
    const names = ["user", `project:${projectId}`, "worker"];
    const captured = names.map(name => entry(name));
    const operation = createOperation({ signal, limits });
    try {
      await Promise.all(keys.map(async (key, index) => {
        const current = captured[index]!;
        try {
          const value = await client(operation).getReviewerPrompt(key, identity.userId, identity.workerId);
          if (entries.get(names[index]!) !== current) return;
          if (current.value !== null && (BigInt(value.revision) < BigInt(current.value.revision) || value.revision === current.value.revision && (value.text !== current.value.text || value.updatedAt !== current.value.updatedAt))) throw new ProtocolError("Reviewer prompt revision is inconsistent.");
          current.value = value;
        } catch (error) {
          if (error instanceof ApiError && (error.status === 401 || error.phase === "protocol")) invalidateAll();
          else if (error instanceof ProtocolError || error instanceof ApiError && (error.status === 403 || error.status === 404)) {
            if (entries.get(names[index]!) === current) invalidate(names[index]!);
          }
          if (entries.get(names[index]!) !== current || current.value === null || signal.aborted) throw error;
        }
      }));
      operation.check();
      const valid = (): boolean => observation.kind === "enabled" && observation.pullRequests.some(item => item.projectId === projectId) && captured.every((item, index) => entries.get(names[index]!) === item && item.value !== null);
      if (!valid()) throw new Error("Reviewer prompt eligibility changed.");
      const values = { user: captured[0]!.value!, project: captured[1]!.value!, worker: captured[2]!.value! };
      return { values, isCurrent: valid };
    } finally { operation.dispose(); }
  };
  const source: AssignmentSource = { snapshot: () => observation, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, capturePrompt };
  return { source, poll };
};
