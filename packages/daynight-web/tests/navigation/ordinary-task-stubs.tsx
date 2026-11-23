import type { ReactNode } from 'react';
const scope = { userId: '30000000-0000-4000-8000-000000000001', signal: new AbortController().signal, isInvalidated: false, hasIdentityMismatch: false, isProjectSuspended: () => false, principalMismatch: () => {}, getHistoryGeneration: () => 1, getProjectRevision: () => 1, ready: async () => {}, subscribe: () => () => {}, beginTaskRead: async () => ({}), observeHistory: async () => 'current', verifyTaskRead: async () => true, isTaskReadCurrent: () => true, isTaskHistoryPossiblyCurrent: () => true, isTaskHistoryConfirmedCurrent: () => true };
const sessions = { captureDirectQualification: () => ({}), verifyDirectQualificationHistory: async () => true, isDirectQualificationHistoryCurrent: () => true, verifyDirectQualification: async () => true };
export const useTaskCacheScope = () => scope;
export const useTaskDetailSessions = () => sessions;
export const useProjectAccess = () => ({ ready: true, status: 'ready', session: { waitForFreshAccess: async () => ({}) } });
export const AssigneePicker = ({ children }: { children: ReactNode }) => <button type="button">{children}</button>;
export const TaskAssigneeIdentity = () => <span>Current user</span>;
export const TagPicker = () => null;
