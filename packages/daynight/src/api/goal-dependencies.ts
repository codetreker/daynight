import { array, bool, fields, id, malformed, text } from "./validation.js";

export type GoalDependencyTarget = { readonly projectId: string; readonly projectName: string; readonly goalId: string; readonly title: string; readonly status: "todo" | "in_progress" | "done" | "cancelled"; readonly kind: "internal" | "external" };
export type GoalDependencyReference = { readonly projectId: string; readonly goalId: string } | { readonly edgeId: string };
export type GoalDependencies = { readonly goalId: string; readonly canEdit: boolean; readonly revision?: string; readonly completionBlocked: boolean; readonly prerequisites: readonly { readonly edgeId?: string; readonly target: GoalDependencyTarget | null }[]; readonly successors: readonly GoalDependencyTarget[]; readonly nextCursor: string | null };
export type GoalDependencyReceipt = { readonly goalId: string; readonly revision: string; readonly changed: boolean };
export type GoalDependencyEdit = { readonly ifRevision: string; readonly mode: "edit"; readonly add?: readonly { readonly projectId: string; readonly goalId: string }[]; readonly remove?: readonly string[] } | { readonly ifRevision: string; readonly mode: "replace"; readonly prerequisites: readonly GoalDependencyReference[] };

export const validGoalRevision = (value: string): boolean => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const revision = (value: unknown): string => typeof value === "string" && validGoalRevision(value) ? value : malformed();
const target = (value: unknown): GoalDependencyTarget => {
  const data = fields(value, ["projectId", "projectName", "goalId", "title", "status", "kind"]);
  if (data.status !== "todo" && data.status !== "in_progress" && data.status !== "done" && data.status !== "cancelled") return malformed();
  if (data.kind !== "internal" && data.kind !== "external") return malformed();
  return { projectId: id(data.projectId), projectName: text(data.projectName), goalId: id(data.goalId), title: text(data.title), status: data.status, kind: data.kind };
};
export const parseGoalDependencies = (value: unknown, goalId: string, limit: number): GoalDependencies => {
  const data = fields(value, ["goalId", "canEdit", "revision", "completionBlocked", "prerequisites", "successors", "nextCursor"]);
  const actualGoal = id(data.goalId), canEdit = bool(data.canEdit);
  if (actualGoal !== goalId || canEdit !== Object.hasOwn(data, "revision")) return malformed();
  const prerequisites = array(data.prerequisites, item => {
    const entry = fields(item, ["edgeId", "target"]);
    if (canEdit !== Object.hasOwn(entry, "edgeId") || !Object.hasOwn(entry, "target")) return malformed();
    return { ...(canEdit ? { edgeId: id(entry.edgeId) } : {}), target: entry.target === null ? null : target(entry.target) };
  });
  const successors = array(data.successors, target);
  const nextCursor = data.nextCursor === null ? null : text(data.nextCursor, true);
  if (prerequisites.length > 30 || successors.length > limit || nextCursor !== null && successors.length === 0) return malformed();
  return { goalId: actualGoal, canEdit, ...(canEdit ? { revision: revision(data.revision) } : {}), completionBlocked: bool(data.completionBlocked), prerequisites, successors, nextCursor };
};
export const parseGoalDependencyReceipt = (value: unknown, goalId: string, expected: string): GoalDependencyReceipt => {
  const data = fields(value, ["goalId", "revision", "changed"]);
  const actualGoal = id(data.goalId), actual = revision(data.revision), changed = bool(data.changed);
  if (actualGoal !== goalId || BigInt(actual) !== BigInt(expected) + (changed ? 1n : 0n)) return malformed();
  return { goalId: actualGoal, revision: actual, changed };
};
