import type { TaskSummary } from '../../api/types';

export type TaskQualification = {
  readonly baselineState: "absent" | "active" | "user" | "access" | "corrupt";
  readonly epoch: string | null;
  readonly cacheGeneration: string | null;
  readonly syncRevision: string | null;
  readonly rebuildRevision: string | null;
  readonly removed: boolean;
  readonly inBaseline: boolean;
  readonly summaryVersion: bigint | null;
};

export const taskResourceKey = (projectId: string, taskId: string): string => `${projectId}/${taskId}`;

export class TaskReadAdmission {
  private readonly revisions = new Map<string, number>();
  private readonly projectRevisions = new Map<string, number>();
  private readonly hints = new Map<string, { epoch: string | null; historyGeneration: number }>();
  private readonly active = new Map<string, Set<string>>();
  private readonly projects = new Map<string, number>();

  revision(projectId: string, taskId: string): number { return this.revisions.get(taskResourceKey(projectId, taskId)) ?? 0; }
  projectRevision(projectId: string): number { return this.projectRevisions.get(projectId) ?? 0; }
  taskSnapshot(): ReadonlyMap<string, number> { return new Map(this.revisions); }
  snapshot(): ReadonlyMap<string, number> { return new Map(this.projectRevisions); }
  observedProjects(): readonly string[] { return [...this.projects.keys()]; }
  observeTask(projectId: string, taskId: string): void {
    let ids = this.active.get(projectId);
    if (ids === undefined) { ids = new Set(); this.active.set(projectId, ids); }
    ids.add(taskId);
  }
  registerProjects(projectIds: readonly string[]): () => void {
    for (const id of new Set(projectIds)) this.projects.set(id, (this.projects.get(id) ?? 0) + 1);
    return () => {
      for (const id of new Set(projectIds)) {
        const count = this.projects.get(id)!;
        if (count === 1) this.projects.delete(id); else this.projects.set(id, count - 1);
      }
    };
  }
  hinted(projectId: string, taskId: string, epoch: string | null, historyGeneration: number): boolean {
    const hint = this.hints.get(taskResourceKey(projectId, taskId));
    return hint !== undefined && hint.historyGeneration === historyGeneration && (hint.epoch === null || epoch === null || hint.epoch === epoch);
  }
  taskIds(projectId: string): readonly string[] { return [...this.active.get(projectId) ?? []]; }
  report(projectId: string, taskId: string, epoch: string | null, historyGeneration: number, pending: readonly string[]): readonly string[] {
    this.hints.set(taskResourceKey(projectId, taskId), { epoch, historyGeneration });
    this.projectRevisions.set(projectId, this.projectRevision(projectId) + 1);
    const ids = new Set([...pending, taskId]);
    for (const id of ids) this.revisions.set(taskResourceKey(projectId, id), this.revision(projectId, id) + 1);
    return [...ids].filter(id => id !== taskId);
  }
}

export const survivesBaselineChange = (before: Pick<TaskQualification, 'cacheGeneration' | 'rebuildRevision'>, after: TaskQualification): boolean =>
  !after.removed && before.rebuildRevision === after.rebuildRevision &&
  (before.cacheGeneration === after.cacheGeneration || after.inBaseline);

export const deletionCandidates = (taskId: string, summaries: ReadonlyMap<string, TaskSummary>, observedIds: readonly string[]): readonly string[] => {
  const root = summaries.get(taskId);
  return [...new Set([...summaries.keys(), ...observedIds])].filter(id => {
    if (id === taskId || root === undefined) return true;
    const candidate = summaries.get(id);
    if (candidate === undefined) return true;
    if (candidate.type === 'goal') return false;
    if (root.type === 'goal') return true;
    let current = candidate;
    const seen = new Set<string>();
    for (;;) {
      if (current.id === taskId) return true;
      if (seen.has(current.id) || current.parentTaskId === undefined) return true;
      seen.add(current.id);
      if (current.parentTaskId === null) return false;
      const parent = summaries.get(current.parentTaskId);
      if (parent === undefined) return true;
      current = parent;
    }
  });
};
