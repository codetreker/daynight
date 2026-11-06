import type { RefObject } from 'react';
import type { TaskDetail } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { AssigneePicker } from './AssigneePicker';
import { personName, TaskAssigneeIdentity } from './TaskAssigneeIdentity';
import { useDirectAssigneeCatalogue } from './useDirectAssigneeCatalogue';
import { useTaskAssigneeDemand } from '../task-assignees/TaskAssignees';

const DirectPicker = ({ taskId, ...props }: React.ComponentProps<typeof AssigneePicker> & { readonly taskId: string }) => {
  const catalogue = useDirectAssigneeCatalogue(props.projectId, taskId, true, props.resetKey ?? '');
  return <AssigneePicker {...props} directCatalogue={catalogue} />;
};

export const TaskAssigneeSelect = ({ projectId, detail, disabled, owner, resetKey, direct = false, onSelect }: {
  readonly projectId: string;
  readonly detail: TaskDetail;
  readonly disabled: boolean;
  readonly direct?: boolean;
  readonly owner: RefObject<HTMLElement | null>;
  readonly resetKey: string;
  readonly onSelect: (assignedTo: string | null) => void;
}) => {
  const { messages: { assignment: m } } = useI18n();
  const { people } = useTaskAssigneeDemand(projectId, [detail.assignedTo]);
  const person = detail.assignedTo === null ? undefined : people.get(detail.assignedTo);
  const name = detail.assignedTo === null ? m.unassigned : personName(person, detail.assignedTo);
  const triggerLabel = `${m.personLabel({ name })}${person?.hasProjectAccess === false ? ` · ${m.formerMember}` : ""}`;
  const Picker = direct ? DirectPicker : AssigneePicker;
  return <span className="task-assignee-field"><span className="assignee-field-label">{m.label}</span>
    <Picker taskId={detail.id} projectId={projectId} label={m.label} triggerLabel={triggerLabel} value={detail.assignedTo === null ? '' : detail.assignedTo} choices={[{ value: '', label: m.unassigned }]} disabled={disabled} owner={owner} resetKey={resetKey}
      onSelect={(value) => { const assignedTo = value === '' ? null : value; if (assignedTo !== detail.assignedTo) onSelect(assignedTo); }}>
      <TaskAssigneeIdentity projectId={projectId} assignedTo={detail.assignedTo} compact />
    </Picker>
  </span>;
};
