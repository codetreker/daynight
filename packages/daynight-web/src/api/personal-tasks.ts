import { parseTaskSessionObservation, type TaskSessionObservation } from '../../../daynight/src/api/task-observation';
import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { array, boolean, id, malformed, nonemptyString, record, string, timestamp } from './parse';
import { count, nullableTimestamp } from './validation';

export type PersonalTaskProject = {
  readonly id: string; readonly name: string;
  readonly ownerTeam: { readonly id: string; readonly kind: 'personal' | 'ordinary'; readonly name: string | null };
  readonly executionWarningMinutes: number; readonly matchedTaskCount: number;
};
export type PersonalTaskItem = {
  readonly project: PersonalTaskProject;
  readonly task: { readonly id: string; readonly version: string; readonly title: string; readonly status: 'in_progress'; readonly startedAt: string | null; readonly allowAgents: boolean; readonly paused: boolean; readonly goal: { readonly id: string; readonly title: string } | null; readonly worker: { readonly workerId: string; readonly machine: { readonly id: string; readonly name: string } } | null };
  readonly session: TaskSessionObservation;
  readonly observedAt: string; readonly receivedMonotonic: number;
};
export type PersonalTaskPage = {
  readonly observedAt: string; readonly inventoryRevision: string; readonly totalTaskCount: number; readonly totalProjectCount: number;
  readonly sessionPartial: boolean; readonly items: readonly Omit<PersonalTaskItem, 'observedAt' | 'receivedMonotonic'>[]; readonly nextCursor: string | null;
};
const fields = (value: unknown, names: readonly string[]) => {
  const data = record(value);
  if (Object.keys(data).length !== names.length || names.some(name => !Object.hasOwn(data, name))) return malformed();
  return data;
};
const title = (value: unknown) => {
  const result = nonemptyString(value);
  if (!result.isWellFormed()) return malformed();
  return result;
};
export const parsePersonalTaskPage = (value: unknown): PersonalTaskPage => {
  const data = fields(value, ['observedAt', 'inventoryRevision', 'totalTaskCount', 'totalProjectCount', 'sessionPartial', 'items', 'nextCursor']);
  const inventoryRevision = string(data.inventoryRevision);
  if (!/^[0-9a-f]{64}$/.test(inventoryRevision)) return malformed();
  const items = array(data.items, value => {
    const item = fields(value, ['project', 'task', 'session']);
    const project = fields(item.project, ['id', 'name', 'ownerTeam', 'executionWarningMinutes', 'matchedTaskCount']);
    const team = fields(project.ownerTeam, ['id', 'kind', 'name']);
    if (team.kind !== 'personal' && team.kind !== 'ordinary') return malformed();
    const kind: 'personal' | 'ordinary' = team.kind;
    const name = team.name === null ? null : title(team.name);
    if ((kind === 'personal') !== (name === null)) return malformed();
    const warning = count(project.executionWarningMinutes), matchedTaskCount = count(project.matchedTaskCount);
    if (warning < 1 || warning > 2_147_483_647 || matchedTaskCount < 1) return malformed();
    const task = fields(item.task, ['id', 'version', 'title', 'status', 'startedAt', 'allowAgents', 'paused', 'goal', 'worker']);
    const version = string(task.version);
    if (!/^[1-9][0-9]*$/.test(version) || BigInt(version) > 9_223_372_036_854_775_807n || task.status !== 'in_progress') return malformed();
    const goal = task.goal === null ? null : fields(task.goal, ['id', 'title']);
    const worker = task.worker === null ? null : fields(task.worker, ['workerId', 'machine']);
    const machine = worker === null ? null : fields(worker.machine, ['id', 'name']);
    const machineName = machine === null ? null : string(machine.name);
    if (machineName !== null && (machineName.length === 0 || !machineName.isWellFormed())) return malformed();
    return { project: { id: id(project.id), name: title(project.name), ownerTeam: { id: id(team.id), kind, name }, executionWarningMinutes: warning, matchedTaskCount },
      task: { id: id(task.id), version, title: title(task.title), status: 'in_progress' as const, startedAt: nullableTimestamp(task.startedAt), allowAgents: boolean(task.allowAgents), paused: boolean(task.paused), goal: goal === null ? null : { id: id(goal.id), title: title(goal.title) }, worker: worker === null || machine === null ? null : { workerId: id(worker.workerId), machine: { id: id(machine.id), name: machineName! } } },
      session: parseTaskSessionObservation(item.session) };
  });
  if (items.length > 100) return malformed();
  const nextCursor = data.nextCursor === null ? null : nonemptyString(data.nextCursor);
  if (nextCursor !== null && (new TextEncoder().encode(nextCursor).length > 16_384 || /[\u0000-\u001f\u007f]/u.test(nextCursor))) return malformed();
  return { observedAt: timestamp(data.observedAt), inventoryRevision, totalTaskCount: count(data.totalTaskCount), totalProjectCount: count(data.totalProjectCount), sessionPartial: boolean(data.sessionPartial), items, nextCursor };
};

export const listPersonalTasks = async (cursor: string | null, signal: AbortSignal, admission: { readonly userId: string; readonly onPrincipalMismatch: () => void }): Promise<PersonalTaskPage> => {
  const params = new URLSearchParams({ limit: '100' });
  if (cursor !== null) params.set('cursor', cursor);
  const response = await request(`/api/v1/me/in-progress-tasks?${params}`, signal, { headers: { Accept: 'application/json' } });
  assertResponsePrincipal(response, requestId(admission.userId), admission.onPrincipalMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) throw new ApiError('protocol', response.status);
    return parsePersonalTaskPage(value);
  });
};
