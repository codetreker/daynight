const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type RecoverySnapshot = { epoch: string; observedAt: string; tasks: string[] };

// The response is the service's complete snapshot, not an inferred cache state.
export function recoverySnapshot(value: unknown, project: string, goal: string, child: string, pending: string): RecoverySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recovery task sync response is invalid.');
  const data = value as { mode?: unknown; epoch?: unknown; observedAt?: unknown; project?: { id?: unknown }; tasks?: unknown };
  if (data.mode !== 'snapshot' || typeof data.epoch !== 'string' || !uuid.test(data.epoch) || typeof data.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(data.observedAt) || !Number.isFinite(Date.parse(data.observedAt)) || data.project?.id !== project || !Array.isArray(data.tasks)) throw new Error('Recovery task sync is not the expected complete snapshot.');
  const tasks = data.tasks as { id?: unknown; type?: unknown; parentId?: unknown }[];
  const ids = tasks.map(task => task && typeof task === 'object' ? task.id : undefined);
  if (ids.some(id => typeof id !== 'string' || !uuid.test(id)) || new Set(ids).size !== ids.length) throw new Error('Recovery task sync contains invalid Task identities.');
  const expected = [goal, child, pending].sort(), actual = (ids as string[]).sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) throw new Error('Recovery task sync does not contain the original visible Tasks.');
  if (!tasks.some(task => task.id === goal && task.type === 'goal') || !tasks.some(task => task.id === child && task.parentId === goal)) throw new Error('Recovery task sync lost the original Goal relationship.');
  return { epoch: data.epoch, observedAt: data.observedAt, tasks: actual };
}
