import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskAssigneeDemand } from '../task-assignees/TaskAssignees';
import { AssigneePicker } from './AssigneePicker';
import { personName } from './TaskAssigneeIdentity';

export type AssigneeFilter = { readonly kind: 'all' } | { readonly kind: 'me' } | { readonly kind: 'unassigned' } | { readonly kind: 'user'; readonly userId: string };
export const matchesAssignee = (assignedTo: string | null, filter: AssigneeFilter, userId: string): boolean => filter.kind === 'all' || (filter.kind === 'unassigned' ? assignedTo === null : assignedTo === (filter.kind === 'me' ? userId : filter.userId));

export const TaskAssigneeFilter = ({ projectId, filter, onChange }: { readonly projectId: string; readonly filter: AssigneeFilter; readonly onChange: (filter: AssigneeFilter) => void }) => {
  const { messages: { assignment: m } } = useI18n();
  const { people } = useTaskAssigneeDemand(projectId, [filter.kind === 'user' ? filter.userId : null]);
  const label = filter.kind === 'all' ? m.all : filter.kind === 'me' ? m.me : filter.kind === 'unassigned' ? m.unassigned : personName(people.get(filter.userId), filter.userId);
  return <div className="task-assignee-filter"><span>{m.filter}</span><AssigneePicker projectId={projectId} label={m.filter} triggerLabel={`${m.filter}: ${label}`} includeFormer value={filter.kind === 'user' ? filter.userId : filter.kind}
    choices={[{ value: 'all', label: m.all }, { value: 'me', label: m.me }, { value: 'unassigned', label: m.unassigned }]}
    onSelect={(value) => onChange(value === 'all' || value === 'me' || value === 'unassigned' ? { kind: value } : { kind: 'user', userId: value })}><span className="task-assignee-filter-value">{label}</span></AssigneePicker></div>;
};
