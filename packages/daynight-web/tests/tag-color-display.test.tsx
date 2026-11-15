import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { ProjectTagColor } from '../src/api/task-tags';
import { TaskTagList } from '../src/features/task-tags/TaskTagList';
import { renderWithLocale } from './helpers/renderWithLocale';

const state = vi.hoisted(() => ({ items: new Map<string, ProjectTagColor>(), loading: true, error: null as unknown, retry: vi.fn() }));
vi.mock('../src/features/task-tags/useTagColors', () => ({ useTagColors: () => state }));
const tags = [{ id: 'one', name: 'First' }, { id: 'two', name: 'Second' }];
const view = () => <TaskTagList projectId="project" tags={tags} />;
beforeEach(() => { state.items = new Map(); state.loading = true; state.error = null; state.retry.mockReset(); });

it('retains names through loading and failures, and retries without inventing a color', () => {
  const rendered = renderWithLocale(view(), { locale: 'en' });
  expect(screen.getByText('First')).toBeVisible();
  expect(screen.getByText('Second')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Loading tag colors');
  expect(rendered.container.querySelector('.task-tag-dot')).toBeNull();
  state.loading = false; state.error = new ApiError('network');
  rendered.rerender(view());
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load tag colors');
  expect(rendered.container.querySelector('.task-tag-dot')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(state.retry).toHaveBeenCalledOnce();
});

it('shows missing separately while retaining a valid color and a retryable stale result', () => {
  state.items = new Map([['one', { id: 'one', state: 'missing' }], ['two', { id: 'two', state: 'found', version: 3n, color: '#AABBCC' }]]);
  state.loading = false;
  const rendered = renderWithLocale(view(), { locale: 'en' });
  expect(screen.getByText('First · unavailable')).toBeVisible();
  expect(screen.getByText('Second').parentElement?.querySelector('.task-tag-dot')).toHaveStyle({ backgroundColor: '#AABBCC' });
  expect(screen.getByRole('alert')).toHaveTextContent('Some tags are unavailable');
  state.error = new ApiError('network'); rendered.rerender(view());
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load tag colors');
  expect(screen.getByText('Second').parentElement?.querySelector('.task-tag-dot')).toHaveStyle({ backgroundColor: '#AABBCC' });
  state.error = new ApiError('server', 403, 'permission_denied'); rendered.rerender(view());
  expect(screen.getByRole('alert')).toHaveTextContent('Tag colors are inaccessible');
});
