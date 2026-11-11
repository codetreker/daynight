import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskSummary } from '../src/api/types';
import { projectSummaries } from '../src/features/task-cache/projection';
import { GoalList } from '../src/features/projects/GoalList';
import { createLocaleRender } from './helpers/renderWithLocale';
import { statesForSummaries } from './helpers/taskSync';

const time = '2026-10-20T12:00:00Z';
const projectId = '00000000-0000-4000-8000-000000000101';
const project = { id: projectId, name: 'Project', repoUrl: 'https://example.test/project', ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const summary = (id: string, type: 'task' | 'goal', parentId: string | null, status: TaskSummary['status']): TaskSummary => ({
  id, type, parentId, status, titlePreview: id, titleTruncated: false, assignedTo: null, requiredPlatform: null, allowAgents: false,
  dependsOn: [], externalDependsOn: [], properties: {}, version: 1n, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time,
});

describe('Goal list', () => {
  it('displays empty goals and real scope progress, with Goal status independent of Task status', () => {
    const goal = summary('goal', 'goal', null, 'done');
    const empty = summary('empty', 'goal', null, 'todo');
    const tasks = [goal, empty, summary('one', 'task', goal.id, 'done'), summary('two', 'task', goal.id, 'cancelled'), summary('outside', 'task', null, 'todo')];
    const { index } = projectSummaries(project, tasks, statesForSummaries(tasks), time);
    const onOpenGoal = vi.fn();
    createLocaleRender('zh-CN', { taskCache: true })(<GoalList projectId={projectId} index={index} goals={[goal, empty]} total={2} onOpenGoal={onOpenGoal} />);
    const button = screen.getByRole('button', { name: /goal/ });
    expect(button).toHaveTextContent('1 完成 · 1 取消');
    expect(button).toHaveTextContent('已完成');
    expect(screen.getByRole('button', { name: /empty/ })).toHaveTextContent('0/0 已完成');
    fireEvent.click(button);
    expect(onOpenGoal).toHaveBeenCalledWith(goal.id, button);
  });
});
