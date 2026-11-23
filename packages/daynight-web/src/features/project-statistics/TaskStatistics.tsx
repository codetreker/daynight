import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import type { GraphSnapshot } from '../projects/useTaskGraph';
import { useProjectAccessSession } from '../projects/ProjectAccess';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useTaskAssigneeDemand } from '../task-assignees/TaskAssignees';
import { personName } from '../task-assignment/TaskAssigneeIdentity';
import { NativeSelect } from '../../ui/native-select/NativeSelect';
import { BarChart } from '../../ui/bar-chart';
import { useI18n } from '../../i18n/LocaleProvider';
import { dateIndexAt, type DateWindow } from './date-window';
import { chartPoints, chartMaximum, statisticsText } from './presentation';

export function TaskStatistics({ projectId, snapshot, error, onRetry, window }: {
  readonly projectId: string; readonly snapshot: GraphSnapshot | null; readonly error: unknown;
  readonly onRetry: () => void; readonly window: DateWindow;
}) {
  const { locale } = useI18n();
  const scope = useTaskCacheScope();
  const access = useProjectAccessSession(projectId);
  const m = statisticsText(locale);
  const tasks = snapshot?.graph.tasks ?? [];
  const ids = useMemo(() => [...new Set(tasks.flatMap(task => task.assignedTo === null ? [] : [task.assignedTo]))].sort(), [tasks]);
  const { people } = useTaskAssigneeDemand(projectId, ids);
  const [selected, setSelected] = useState('');
  useEffect(() => { if (snapshot !== null && selected !== '' && !ids.includes(selected)) setSelected(''); }, [snapshot, ids, selected]);
  useEffect(() => {
    const unsubscribe = scope.subscribe(event => {
      if (event.projectId !== projectId) return;
      const error = event.error;
      const missing = error instanceof ApiError && error.kind === 'server' && error.status === 404 && error.code === 'not_found';
      if (missing && (event.directAccessRecheck || event.accessRevoked && !event.directAccessUncertain && !event.peerHintWithdrawal)) setSelected('');
    });
    const unsubscribeWithdrawal = access?.subscribeProjectReadWithdrawal(() => setSelected(''));
    return () => { unsubscribe(); unsubscribeWithdrawal?.(); };
  }, [scope, access, projectId]);
  const effective = ids.includes(selected) ? selected : '';
  const all = Array<bigint>(30).fill(0n), filtered = Array<bigint>(30).fill(0n);
  for (const task of tasks) {
    const index = dateIndexAt(window, Date.parse(task.createdAt));
    if (index !== null) {
      all[index] = all[index]! + 1n;
      if (effective === '' || task.assignedTo === effective) filtered[index] = filtered[index]! + 1n;
    }
  }
  const names = ids.map(id => ({ id, name: personName(people.get(id), id) }));
  const duplicates = new Map<string, number>();
  for (const entry of names) duplicates.set(entry.name, (duplicates.get(entry.name) ?? 0) + 1);
  return <section className="statistics-card" aria-labelledby="task-statistics-title">
    <header className="statistics-header"><h2 id="task-statistics-title">{m.tasks}</h2>{snapshot !== null && <div className="statistics-total"><span>{m.total}</span><strong>{new Intl.NumberFormat(locale).format(tasks.length)}</strong></div>}</header>
    {snapshot === null ? error !== null ? <div className="statistics-state error" role="alert">{m.taskError}<button type="button" className="button" onClick={onRetry}>{m.retry}</button></div> : <div className="statistics-state" role="status"><span className="spinner" aria-hidden="true" />{m.loading}</div> : <>
      {error !== null && <div className="statistics-state error" role="alert">{m.taskError}<button type="button" className="button" onClick={onRetry}>{m.retry}</button></div>}
      <div className="statistics-chart"><div className="statistics-chart-heading"><h3>{m.dailyTasks}</h3><NativeSelect density="filter" touchMode="responsive" focusTone="task" aria-label={m.taskFilter} value={effective} disabled={ids.length === 0} onChange={event => setSelected(event.currentTarget.value)}><option value="">{m.all}</option>{names.map(({id, name}) => <option key={id} value={id}>{name}{duplicates.get(name)! > 1 ? ` · ${id}` : ''}</option>)}</NativeSelect></div>
        <BarChart label={m.dailyTasks} points={chartPoints(window.dates, filtered, locale)} domainMax={chartMaximum(all)} formatValue={value => new Intl.NumberFormat(locale).format(value)} />
      </div>
    </>}
  </section>;
}
