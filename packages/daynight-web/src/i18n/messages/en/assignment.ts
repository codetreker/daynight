import type { AssignmentMessages } from '../assignment';
export const assignment: AssignmentMessages = {
  label: 'Assignee', unassigned: 'Unassigned', formerMember: 'No project access',
  personLabel: ({ name }) => `Assignee: ${name}`,
  search: 'Search people', loading: 'Loading people…', loadFailed: 'People could not be loaded.',
  retry: 'Retry', noPeople: 'No matching people', all: 'Everyone', me: 'Assigned to me',
  filter: 'Assignee', noMatches: 'No tasks match this assignee',
  matchingChildren: ({ count }) => `${count} matching child tasks`,
  uncertain: 'Pending verification', checking: 'Checking…', checkState: 'Check current state',
  saveFailed: 'The assignee could not be updated.', versionConflict: 'The task changed. Refresh it before assigning again.',
  assigneeUnavailable: 'This person no longer has project access.',
};
