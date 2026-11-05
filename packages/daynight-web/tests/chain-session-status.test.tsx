import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { ChainList } from '../src/features/task-graph/ChainList';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { renderWithLocale } from './helpers/renderWithLocale';

const summaries = vi.hoisted(() => ({
  tasks: new Map<string, { sessionId: string; claimId: string; indicator: 'working' | 'notice' | 'warning' | null }>(),
  indicator: null as 'working' | 'notice' | 'warning' | null,
  observedMembers: [] as string[],
}));
vi.mock('../src/features/task-session-summary/TaskSessionSummaryProvider', () => ({
  useTaskSessionSummary: (id: string) => summaries.tasks.get(id) ?? null,
  useChainSessionSummary: (ids: ReadonlySet<string>) => { summaries.observedMembers = [...ids]; return summaries.indicator; },
  useSessionChainVisibility: () => () => {},
}));
const time = '2026-11-04T10:00:00Z';
const task = (id: string, status: GraphTask['status'], dependsOn: string[] = [], externalDependsOn: string[] = []): GraphTask => ({
  id, titlePreview: id, titleTruncated: false, assignedTo: null, status, dependsOn, externalDependsOn,
  blockedBy: [], ready: false, requiredPlatform: null, allowAgents: true, startedAt: null, completedAt: null, createdAt: time, updatedAt: time,
});
const graph: TaskGraph = {
  observedAt: time,
  project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: '00000000-0000-4000-8000-000000000101', name: 'Project', repoUrl: 'https://github.com/example/repo', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time },
  tasks: [task('Goal', 'done'), task('Working', 'in_progress', ['Goal', 'External'], ['External']),
    task('Waiting', 'in_progress', ['Goal']), task('Idle', 'in_progress', ['Goal']), task('Initializing', 'in_progress', ['Goal']),
    task('Unknown', 'in_progress', ['Goal']), task('Completed', 'done', ['Goal']), task('External', 'done')],
  summary: { total: 8, todo: 0, inProgress: 5, done: 3, ready: 0, blocked: 0 },
};
const index = buildGraphIndex(graph);
const noop = () => {};
const content = (onOpenSession = vi.fn(), onOpenTask = vi.fn()) => <ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={index}
  representativeIds={['Goal']} allRepresentativeIds={['Goal']} openChainId={null} onOpenChain={noop} onCloseChain={noop}
  onOpenTask={onOpenTask} onOpenSession={onOpenSession} showAll onShowAllChange={noop} />;
const child = (id: string) => document.getElementById(`chain-task-Goal-${id}`)!.closest('.goal-task-row')!;
const expand = () => fireEvent.click(document.getElementById('task-root-Goal')!);
beforeEach(() => {
  summaries.tasks.clear(); summaries.observedMembers = []; summaries.indicator = 'warning';
  for (const [id, indicator] of [['Working', 'working'], ['Waiting', 'notice'], ['Idle', 'warning'], ['Initializing', null]] as const) {
    summaries.tasks.set(id, { sessionId: `session-${id}`, claimId: `claim-${id}`, indicator });
  }
});

describe('chain Session status controls', () => {
  it('keeps task titles and all accessible Session entries as sibling controls with uniform navigation', async () => {
    const user = userEvent.setup(); const session = vi.fn(); const overview = vi.fn();
    renderWithLocale(content(session, overview), { locale: 'zh-CN', taskCache: true }); expand();
    for (const id of ['Working', 'Waiting', 'Idle', 'Initializing']) {
      const button = within(child(id) as HTMLElement).getByRole('button', { name: /打开 Session/ });
      await user.click(button);
      expect(session).toHaveBeenLastCalledWith(id, button);
      expect(overview).not.toHaveBeenCalled();
      expect(button.querySelector('.session-status-annotation')?.textContent ?? null).toBe(summaries.tasks.get(id)!.indicator);
    }
    const title = document.getElementById('chain-task-Goal-Working')!;
    await user.click(title); expect(overview).toHaveBeenLastCalledWith('Working', title);
    expect(document.querySelector('button button, button a, a button')).toBeNull();
    expect(within(child('Unknown') as HTMLElement).queryByRole('button', { name: /打开 Session/ })).toBeNull();
    expect(within(child('Completed') as HTMLElement).queryByRole('button', { name: /打开 Session/ })).toBeNull();
  });

  it('exposes keyboard status hints and opens the working Session on Enter', async () => {
    const user = userEvent.setup(); const session = vi.fn();
    renderWithLocale(content(session), { locale: 'zh-CN', taskCache: true }); expand();
    const button = within(child('Working') as HTMLElement).getByRole('button', { name: /Working.*进行中.*会话工作中.*打开 Session/ });
    button.focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('会话工作中');
    await user.keyboard('{Enter}'); expect(session).toHaveBeenCalledWith('Working', button);
    await user.keyboard('{Escape}'); expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('uses the entire chain while collapsed and only expands from every aggregate status entry', () => {
    const session = vi.fn(); const view = renderWithLocale(content(session), { locale: 'zh-CN', taskCache: true });
    expect(summaries.observedMembers).toEqual(expect.arrayContaining(['Goal', 'Working', 'Waiting', 'Idle']));
    expect(summaries.observedMembers).not.toContain('External');
    const header = document.querySelector('.goal-header')!;
    for (const indicator of ['warning', 'notice', 'working'] as const) {
      summaries.indicator = indicator;
      view.rerender(content(session));
      const status = within(header as HTMLElement).getByRole('button', { name: /展开子任务/ });
      expect(status.querySelector('.session-status-annotation')).toHaveTextContent(indicator);
      fireEvent.click(status); fireEvent.click(status);
      expect(document.getElementById('task-root-Goal')).toHaveAttribute('aria-expanded', 'true');
      expect(session).not.toHaveBeenCalled();
      fireEvent.click(document.getElementById('task-root-Goal')!);
    }
    summaries.indicator = null; view.rerender(content(session));
    expect(within(header as HTMLElement).queryByRole('button', { name: /展开子任务/ })).toBeNull();
    expect(header.querySelector('.session-status-annotation')).toBeNull();
  });
});
