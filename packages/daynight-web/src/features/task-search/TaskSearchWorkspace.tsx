import { NativeSelect } from '../../ui/native-select/NativeSelect';
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import type { TaskStatus } from '../../api/types';
import { ApiError } from '../../api/client';
import { TaskSearchError, searchSelectionRange, type TaskSearchField } from '../../api/task-search';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskAssigneeFilter, type AssigneeFilter } from '../task-assignment/TaskAssigneeFilter';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import { TaskTagList } from '../task-tags/TaskTagList';
import type { TaskSearchController } from './useTaskSearch';
import '../../styles/task-search.css';
import '../../styles/task-status-rows.css';

export const assigneeValue = (filter: AssigneeFilter): string => filter.kind === 'all' ? '' : filter.kind === 'user' ? filter.userId : filter.kind;
const assigneeFilter = (value: string): AssigneeFilter => value === '' ? { kind: 'all' } : value === 'me' || value === 'unassigned' ? { kind: value } : { kind: 'user', userId: value };

export const TaskSearchWorkspace = ({ projectId, search, inputRef, onOpenTask, tagFilter }: {
  readonly projectId: string; readonly search: TaskSearchController; readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly tagFilter?: ReactNode;
}) => {
  const { messages: { workspace: { search: m, project, pagination, projects }, common }, format } = useI18n();
  const matchLabels: Readonly<Record<TaskSearchField, string>> = { id: m.idMatch, title: m.titleMatch, description: m.descriptionMatch };
  const [helpOpen, setHelpOpen] = useState(false);
  const pendingSubmission = useRef<string | null>(null);
  const syntax = search.error instanceof TaskSearchError ? search.error.syntax : undefined;
  useEffect(() => {
    const submitted = pendingSubmission.current;
    if (submitted === null || search.busy) return;
    pendingSubmission.current = null;
    if (syntax === undefined || search.errorQuery !== submitted || search.draft !== submitted) return;
    const { start, end } = searchSelectionRange(search.draft, syntax);
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(start, end);
  }, [syntax, search.busy, search.errorQuery, search.draft, inputRef]);
  const submit = (event: FormEvent) => { event.preventDefault(); pendingSubmission.current = search.draft.trim() === '' ? null : search.draft; search.submit(); };
  const clear = () => { pendingSubmission.current = null; search.clear(); inputRef.current?.focus(); };
  const error = search.error;
  const syntaxForDraft = syntax !== undefined && search.errorQuery === search.draft;
  return <div className="task-search-workspace">
    <form className="task-search-form" role="search" aria-label={m.form} onSubmit={submit}>
      <div className="task-search-input-wrap">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
        <input ref={inputRef} type="text" inputMode="search" value={search.draft} onChange={(event) => { const value = event.currentTarget.value; if (value === '') clear(); else search.setDraft(value); }} aria-label={m.input} placeholder={m.placeholder} autoComplete="off" spellCheck={false} aria-invalid={syntaxForDraft || undefined} aria-describedby={syntaxForDraft ? 'task-search-error' : undefined} />
        {search.draft !== '' && <button className="task-search-clear" type="button" onClick={clear} aria-label={m.clear} title={m.clear}>×</button>}
      </div>
      <button className="button primary" type="submit" disabled={search.busy}>{m.submit}</button>
      <button className="button task-search-help-button" type="button" aria-label={m.help} title={m.help} aria-expanded={helpOpen} aria-controls="task-search-help" onClick={() => setHelpOpen(!helpOpen)}>?</button>
    </form>
    {helpOpen && <div className="task-search-help" id="task-search-help"><h3>{m.help}</h3><p>{m.helpDescription}</p><p>{m.helpExamples}</p></div>}
    {error !== null && <div className="task-search-error" role="alert" id="task-search-error">
      <p>{syntax !== undefined ? m.syntax({ position: syntax.position, reason: m.reasons[syntax.reason] ?? m.failed }) : m.failed}</p>
      {syntax === undefined && <p>{error instanceof ApiError ? error.message : m.failed}{error instanceof ApiError && error.code !== error.kind ? ` (${error.code})` : ''}</p>}
      {search.items.length > 0 && <p>{m.stale}</p>}
      <button type="button" className="button" onClick={search.retry} disabled={search.busy}>{projects.retry}</button>
    </div>}
    {search.applied !== null && <>
      <div className="task-list-filters task-search-filters">
        <TaskAssigneeFilter projectId={projectId} filter={assigneeFilter(search.filters.assignedTo)} onChange={(filter) => search.setFilters({ ...search.filters, assignedTo: assigneeValue(filter) })} />
        <label className="task-status-filter">{project.statusFilter}<NativeSelect density="filter" focusTone="task" value={search.filters.status} onChange={(event) => search.setFilters({ ...search.filters, status: event.currentTarget.value as TaskStatus | '' })}><option value="">{project.allStatuses}</option><option value="proposed">{project.statusOptions.proposed}</option><option value="todo">{project.statusOptions.todo}</option><option value="in_progress">{project.statusOptions.in_progress}</option><option value="done">{project.statusOptions.done}</option><option value="cancelled">{project.statusOptions.cancelled}</option></NativeSelect></label>
        {tagFilter}
      </div>
      <section className="task-search-results" aria-busy={search.busy} aria-label={m.heading}>
        <div className="task-search-heading"><h2>{m.heading} {search.total !== null && <span>{format.number(search.total)}</span>}</h2><p>{m.applied({ query: search.applied })}</p></div>
        {search.busy && search.items.length === 0 && <p role="status">{m.loading}</p>}
        {!search.busy && error === null && search.items.length === 0 && <section className="state-box"><h3>{m.empty}</h3></section>}
        {search.items.length > 0 && <ul className="task-search-list">{search.items.map((item) => <li key={item.id}>
          <button type="button" className="task-search-result task-status-surface" data-task-status={item.status} aria-label={m.open({ title: item.title })} onClick={(event) => onOpenTask(item.id, event.currentTarget)}>
            <span className="task-search-result-body"><span className="task-search-title">{item.title}</span>
              {item.context !== null && <span className="task-search-context">◇ {item.context.title}</span>}
              <TaskTagList tags={item.tags} />
              <span className="task-search-match">{item.match.fields.length === 0 ? m.negativeMatch : item.match.fields.map(field => matchLabels[field]).join(' · ')}{item.match.descriptionSnippet === null ? '' : ` · ${item.match.descriptionSnippet}`}</span>
              <span className="task-search-meta"><span>{item.id}</span><TaskAssigneeIdentity projectId={projectId} assignedTo={item.assignedTo} /><time dateTime={item.updatedAt}>{m.updated({ date: format.dateTime(item.updatedAt) })}</time></span>
            </span><span className={`root-status graph-status-${item.status}`}>{common.status[item.status]}</span><span className="task-search-chevron" aria-hidden="true">›</span>
          </button></li>)}</ul>}
        {(search.page > 1 || (search.total ?? 0) > 15) && <nav className="list-pagination" aria-label={pagination.label({ list: m.heading })}><span className="list-pagination-page">{pagination.page({ page: search.page, pages: Math.max(1, Math.ceil((search.total ?? 0) / 15)) })}</span><div className="list-pagination-controls"><button className="button" type="button" aria-disabled={!search.canPrevious || search.busy} onClick={() => { if (search.canPrevious && !search.busy) search.previous(); }}>{pagination.previous}</button><button className="button" type="button" aria-disabled={!search.canNext || search.busy} onClick={() => { if (search.canNext && !search.busy) search.next(); }}>{pagination.next}</button></div></nav>}
      </section>
    </>}
  </div>;
};
