import { useState } from 'react';
import type { Project } from '../../../api/types';
import type { WorkerTaskSnapshot } from '../../../api/workers';
import { taskDetailUrl } from '../../../app/router';
import { useI18n } from '../../../i18n/LocaleProvider';
import { ManagementDialog } from '../../management/ManagementDialog';
import { followWorkerLink } from '../presentation';

export const ConfigurationProjectsDialog = ({ projects, selected, loading, error, refresh, onClose, onApply }: {
  readonly projects: readonly Project[];
  readonly selected: readonly string[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
  readonly onClose: () => void;
  readonly onApply: (projectIds: readonly string[]) => void;
}) => {
  const { messages: { workers: { configuration: m }, workers } } = useI18n();
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState(() => new Set(selected));
  const metadata = new Map(projects.map(project => [project.id, project]));
  const choices = [...new Set([...projects.map(project => project.id), ...selected])].filter(id => {
    const project = metadata.get(id), search = query.toLocaleLowerCase();
    return `${project?.name ?? ''} ${project?.repoUrl ?? ''} ${id}`.toLocaleLowerCase().includes(search);
  });
  return <ManagementDialog title={m.chooseProjects} onClose={onClose} footer={<><button className="button" type="button" onClick={onClose}>{m.cancel}</button><button className="button primary" type="button" disabled={loading || error !== null} onClick={() => onApply([...selection])}>{m.done}</button></>}>
    <div className="field"><label htmlFor="configuration-project-search">{m.projectSearch}</label><input id="configuration-project-search" type="search" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" /></div>
    {loading && <div className="configuration-project-loading" role="status"><span className="spinner" aria-hidden="true" /></div>}
    {error !== null && <div className="notice error" role="alert"><p>{m.projectsFailed}</p><button className="button" type="button" onClick={refresh}>{workers.retry}</button></div>}
    <div className="project-choices">{choices.map(id => {
      const project = metadata.get(id);
      return <label className="project-choice" key={id}><input type="checkbox" checked={selection.has(id)} onChange={event => setSelection(old => { const next = new Set(old); if (event.target.checked) next.add(id); else next.delete(id); return next; })} /><span><strong>{project?.name ?? id}</strong><small>{project?.repoUrl ?? m.inaccessible}</small></span></label>;
    })}{!loading && error === null && choices.length === 0 && <p className="empty-projects">{m.noMatchingProjects}</p>}</div>
  </ManagementDialog>;
};

export const ConfigurationRemovalDialog = ({ projects, tasks, onClose, onConfirm }: {
  readonly projects: readonly { readonly projectId: string; readonly name: string }[];
  readonly tasks: readonly WorkerTaskSnapshot[];
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) => {
  const { messages: { workers: { configuration: m }, common } } = useI18n();
  const affected = new Set(projects.map(project => project.projectId));
  const observedTasks = tasks.filter(task => affected.has(task.projectId));
  return <ManagementDialog title={m.removalConfirm} onClose={onClose} footer={<><button className="button" type="button" onClick={onClose}>{m.cancel}</button><button className="button primary" type="button" onClick={onConfirm}>{m.save}</button></>}>
    <p>{m.removalImpact}</p>
    <h3 className="configuration-dialog-subtitle">{m.affectedProjects}</h3><ul className="affected-tasks">{projects.map(project => <li key={project.projectId}>{project.name}<small>{project.projectId}</small></li>)}</ul>
    <h3 className="configuration-dialog-subtitle">{m.affectedTasks}</h3>
    {observedTasks.length === 0 ? <p className="hint">{m.noObservedTasks}</p> : <ul className="affected-tasks">{observedTasks.map(task => <li key={`${task.projectId}/${task.taskId}/${task.claimId}`}><a href={taskDetailUrl(task.projectId, task.taskId, { tab: 'overview', path: null })} onClick={followWorkerLink}>{task.title}</a><small>{task.projectName} · {common.status[task.status]}</small></li>)}</ul>}
  </ManagementDialog>;
};
