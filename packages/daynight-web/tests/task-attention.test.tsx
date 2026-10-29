import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { StandaloneList } from '../src/features/projects/StandaloneList';
import { ChainList } from '../src/features/task-graph/ChainList';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { TaskAttentionNotice } from '../src/features/task-detail/TaskAttention';
import { renderWithLocale } from './helpers/renderWithLocale';

const time = '2026-10-29T00:00:00Z';
const task = (id: string, changes: Partial<GraphTask> = {}): GraphTask => ({
  id, titlePreview: id, titleTruncated: false, status: 'todo', dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true,
  allowAgents: false, workerNeedsAttention: false, requiredPlatform: null, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, ...changes,
});
const index = (tasks: readonly GraphTask[]) => buildGraphIndex({ observedAt: time,
  project: { id: 'project', name: 'Project', repoUrl: 'https://example.test/project', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time }, tasks,
  summary: { total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length, inProgress: tasks.filter((item) => item.status === 'in_progress').length,
    done: tasks.filter((item) => item.status === 'done').length, ready: tasks.filter((item) => item.ready).length, blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length },
} satisfies TaskGraph);

describe('human attention signals', () => {
  it('highlights a standalone task independently of permission or status and clears the same row', () => {
    const renderList = (workerNeedsAttention: boolean) => <StandaloneList index={index([task('Review', { status: 'done', ready: false, workerNeedsAttention })])}
      taskIds={['Review']} allTaskIds={['Review']} onSelectTask={vi.fn()} showAll onShowAllChange={vi.fn()} />;
    const view = renderWithLocale(renderList(true), { locale: 'zh-CN' });
    const row = screen.getByRole('button', { name: /Review/ });
    expect(row).toHaveClass('task-needs-attention');
    expect(within(row).getByText('需要处理')).toBeVisible();
    view.setLocale('en');
    expect(within(row).getByText('Needs attention')).toBeVisible();
    view.rerender(renderList(false));
    expect(screen.getByRole('button', { name: /Review/ })).toBe(row);
    expect(row).not.toHaveClass('task-needs-attention');
    expect(screen.queryByText('Needs attention')).toBeNull();
  });

  it('surfaces a signaled child in the collapsed Goal and clears its expanded child with the signal', () => {
    const renderList = (workerNeedsAttention: boolean) => <ChainList index={index([task('Goal', { status: 'done', ready: false }),
      task('Child', { dependsOn: ['Goal'], workerNeedsAttention })])} representativeIds={['Goal']} allRepresentativeIds={['Goal']}
      openChainId={null} onOpenChain={vi.fn()} onCloseChain={vi.fn()} onOpenTask={vi.fn()} showAll onShowAllChange={vi.fn()} />;
    const view = renderWithLocale(renderList(true), { locale: 'zh-CN' });
    const disclosure = document.getElementById('task-root-Goal')!;
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(within(disclosure).getByText('需要处理')).toBeVisible();
    expect(disclosure.parentElement).toHaveClass('task-needs-attention');
    fireEvent.click(disclosure);
    const child = screen.getByRole('button', { name: /Child/ });
    expect(child).toHaveClass('task-needs-attention');
    expect(within(child).getByText('需要处理')).toBeVisible();
    view.rerender(renderList(false));
    expect(screen.queryByText('需要处理')).toBeNull();
    expect(child).not.toHaveClass('task-needs-attention');
    expect(disclosure.parentElement).not.toHaveClass('task-needs-attention');
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  });

  it('preserves the full reason as plain text and treats only the empty string as cleared', () => {
    const signaling = '  <img src=x onerror=alert(1)>\n需要确认发布窗口。  ';
    const view = renderWithLocale(<TaskAttentionNotice signaling={signaling} />, { locale: 'zh-CN' });
    const notice = screen.getByRole('region', { name: '需要处理' });
    expect(notice.querySelector('p')!.textContent).toBe(signaling);
    expect(notice.querySelector('img')).toBeNull();
    view.rerender(<TaskAttentionNotice signaling=" " />);
    expect(screen.getByRole('region', { name: '需要处理' })).toBeVisible();
    view.rerender(<TaskAttentionNotice signaling="" />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});
