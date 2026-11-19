import { ApiError, assertResponsePrincipal, json, request, requestId, responseSignal } from './client';
import { array, boolean, id, malformed, nonemptyString, record, string } from './parse';

export type RelatedGoal = {
  readonly projectId: string; readonly projectName: string; readonly goalId: string; readonly title: string;
  readonly status: 'todo' | 'in_progress' | 'done' | 'cancelled'; readonly kind: 'internal' | 'external';
};
export type GoalDependencies = {
  readonly goalId: string; readonly canEdit: boolean; readonly revision?: string; readonly completionBlocked: boolean;
  readonly prerequisites: readonly { readonly edgeId?: string; readonly target: RelatedGoal | null }[];
  readonly successors: readonly RelatedGoal[]; readonly nextCursor: string | null;
};
export type GoalDependenciesRead = { readonly kind: 'available'; readonly page: GoalDependencies } | { readonly kind: 'unavailable' };

const fields = (data: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) return malformed();
};
const revision = (value: unknown): string => {
  const text = string(value);
  if (!/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > 9_223_372_036_854_775_807n) return malformed();
  return text;
};
export const parseGoalDependencies = (value: unknown, projectId: string, goalId: string): GoalDependencies => {
  const data = record(value);
  fields(data, ['goalId', 'canEdit', 'completionBlocked', 'prerequisites', 'successors', 'nextCursor'], ['revision']);
  if (id(data.goalId) !== goalId) return malformed();
  const canEdit = boolean(data.canEdit);
  if (canEdit !== Object.hasOwn(data, 'revision')) return malformed();
  const target = (value: unknown): RelatedGoal => {
    const item = record(value);
    fields(item, ['projectId', 'projectName', 'goalId', 'title', 'status', 'kind']);
    const targetProject = id(item.projectId), targetGoal = id(item.goalId), status = item.status, kind = item.kind;
    if (!['todo', 'in_progress', 'done', 'cancelled'].includes(String(status)) || !['internal', 'external'].includes(String(kind)) ||
      (kind === 'internal') !== (targetProject === projectId) || targetGoal === goalId) return malformed();
    return { projectId: targetProject, projectName: nonemptyString(item.projectName), goalId: targetGoal, title: nonemptyString(item.title), status: status as RelatedGoal['status'], kind: kind as RelatedGoal['kind'] };
  };
  const prerequisites = array(data.prerequisites, value => {
    const item = record(value); fields(item, ['target'], canEdit ? ['edgeId'] : []);
    if (canEdit !== Object.hasOwn(item, 'edgeId')) return malformed();
    return { ...(canEdit ? { edgeId: id(item.edgeId) } : {}), target: item.target === null ? null : target(item.target) };
  });
  const successors = array(data.successors, target);
  const visible = prerequisites.flatMap(item => item.target === null ? [] : [item.target.goalId]);
  const edges = prerequisites.flatMap(item => item.edgeId === undefined ? [] : [item.edgeId]);
  if (prerequisites.length > 30 || successors.length > 50 || new Set(visible).size !== visible.length || new Set(edges).size !== edges.length ||
    new Set(successors.map(item => item.goalId)).size !== successors.length) return malformed();
  return { goalId, canEdit, ...(canEdit ? { revision: revision(data.revision) } : {}), completionBlocked: boolean(data.completionBlocked), prerequisites, successors,
    nextCursor: data.nextCursor === null ? null : nonemptyString(data.nextCursor) };
};

export const getGoalDependencies = async (projectId: string, goalId: string, cursor: string | null, signal: AbortSignal,
  admission: { readonly userId: string; readonly onPrincipalMismatch: () => void; readonly onDispatch?: () => void }): Promise<GoalDependenciesRead> => {
  const project = requestId(projectId), goal = requestId(goalId);
  const parameters = new URLSearchParams({ limit: '20' });
  if (cursor !== null) parameters.set('cursor', cursor);
  const response = await request(`/api/v1/projects/${project}/tasks/${goal}/goal-dependencies?${parameters}`, signal,
    { headers: { Accept: 'application/json' }, cache: 'no-store' }, admission.onDispatch);
  // The old router returns a JSON 404 before authenticated middleware runs.
  // This branch admits no relation data and must precede principal validation.
  if (response.status === 404 && response.headers.get('Daynight-User-ID') === null) {
    try { await json(response, signal, () => malformed()); }
    catch (error) {
      responseSignal(response, signal).throwIfAborted();
      if (error instanceof ApiError && error.kind === 'server' && error.code === 'not_found') return { kind: 'unavailable' };
      throw error;
    }
  }
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  if (response.ok && response.status !== 200) throw new ApiError('protocol', response.status);
  const page = await json(response, signal, value => parseGoalDependencies(value, project, goal));
  return { kind: 'available', page };
};
