import { useState } from 'react';
import type { ProjectPerson } from '../../api/auth-types';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskAssigneeDemand } from '../task-assignees/TaskAssignees';
import '../../styles/task-assignment.css';

export const personName = (person: ProjectPerson | undefined, userId: string): string => person?.name ?? userId.slice(0, 8);

export const AssigneeAvatar = ({ person, name }: { readonly person?: ProjectPerson; readonly name: string | null }) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className={`assignee-avatar${name === null ? ' assignee-avatar-empty' : ''}`} aria-hidden="true">
    {person?.avatarUrl !== null && person?.avatarUrl !== undefined && person.avatarUrl !== failedUrl
      ? <img src={person.avatarUrl} alt="" onError={() => setFailedUrl(person.avatarUrl)} />
      : name === null ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"><circle cx="12" cy="8" r="3" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></svg> : Array.from(name).slice(0, 1).join('').toLocaleUpperCase()}
  </span>;
};

export const TaskAssigneeIdentity = ({ projectId, assignedTo, compact = false }: { readonly projectId: string; readonly assignedTo: string | null; readonly compact?: boolean }) => {
  const { messages: { assignment: m } } = useI18n();
  const { people } = useTaskAssigneeDemand(projectId, [assignedTo]);
  const person = assignedTo === null ? undefined : people.get(assignedTo);
  const name = assignedTo === null ? m.unassigned : personName(person, assignedTo);
  const fullName = `${m.personLabel({ name })}${person?.hasProjectAccess === false ? ` · ${m.formerMember}` : ''}`;
  return <span className={`task-assignee-identity${compact ? ' task-assignee-identity-compact' : ''}`} title={fullName} aria-label={fullName}>
    <AssigneeAvatar {...(person === undefined ? {} : { person })} name={assignedTo === null ? null : name} />
    <span className="assignee-name">{name}</span>
    {person?.hasProjectAccess === false && <span className="assignee-former" aria-hidden="true">{m.formerMember}</span>}
  </span>;
};
