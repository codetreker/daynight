import type { RelatedGoal } from '../../api/goal-dependencies';
import type { GoalAcceptanceProjection } from './model';

export const isGraphExternalGoalRelation = (projectId: string, sourceProjectId: string, targetProjectId: string) =>
  sourceProjectId !== projectId || targetProjectId !== projectId;

export const canDiscoverGoalRelation = (projectId: string, baseline: GoalAcceptanceProjection, sourceProjectId: string,
  goal: RelatedGoal, direction: 'prerequisite' | 'successor') => {
  if (!isGraphExternalGoalRelation(projectId, sourceProjectId, goal.projectId) ||
    goal.projectId === projectId && !baseline.availableGoals.has(goal.goalId)) return false;
  if (direction === 'prerequisite') return true;
  const status = goal.projectId === projectId ? baseline.availableGoals.get(goal.goalId)!.status : goal.status;
  return status === 'todo' || status === 'in_progress';
};
