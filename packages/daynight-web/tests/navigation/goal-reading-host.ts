import '../../src/main';
import { browserNavigation } from '../../src/app/navigation';
import type { GoalChildren, PageHistoryState } from '../../src/app/page-history';

// Removed list controls no longer create these selections. Restored reading-state
// tests supply their input through the real owner and exercise its admission gate.
window.selectGoalReading = (goalId, patch) => {
  const navigation = browserNavigation();
  const current = navigation.snapshot().view as PageHistoryState;
  if (current === undefined) throw new Error('The browser fixture requires an initialized reading owner.');
  const children = (value: GoalChildren | null): GoalChildren => ({ graphRootId: null, task: null, ...value, ...patch });
  if (current.pageKey.startsWith('project:') && 'detail' in current.selection && current.selection.detail?.id === goalId) {
    navigation.setView({ ...current, selection: { ...current.selection, detail: { ...current.selection.detail, goalChildren: children(current.selection.detail.goalChildren) } } } as PageHistoryState, { replace: true });
  } else if (current.pageKey.startsWith('resource:') && 'externalGoal' in current.selection) {
    const target = current.selection.externalGoal;
    navigation.setView(target?.id === goalId
      ? { ...current, selection: { ...current.selection, externalGoal: { ...target, goalChildren: children(target.goalChildren) } } } as PageHistoryState
      : { ...current, selection: { ...current.selection, goalChildren: children(current.selection.goalChildren) } } as PageHistoryState, { replace: true });
  } else throw new Error('The selected Goal is not owned by this reading state.');
};

declare global {
  interface Window { selectGoalReading: (goalId: string, patch: Partial<GoalChildren>) => void; }
}
