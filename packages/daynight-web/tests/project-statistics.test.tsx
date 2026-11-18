import { screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ProjectStatistics } from '../src/features/project-statistics/ProjectStatistics';
import { createLocaleRender } from './helpers/renderWithLocale';

vi.mock('../src/features/project-statistics/TaskStatistics', () => ({ TaskStatistics: () => null }));
vi.mock('../src/features/project-statistics/useDateWindow', () => ({ useDateWindow: () => ({ dates: Array.from({ length: 30 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`), endDate: '2026-03-30', encoded: 'window' }) }));
vi.mock('../src/features/project-statistics/pr-statistics', () => ({ usePRStatistics: () => ({ data: { projectTotal: '4', availability: 'ready', hasAuthors: true, daily: Array(30).fill('4'), authorId: '8', author: null, authorDaily: Array(30).fill('0') }, error: null, loading: false, author: null, refresh: () => {}, setAuthor: () => {}, authors: { items: [], query: '', loaded: false, loading: false, error: null, nextCursor: null, rebuilding: false, open: () => {}, close: () => {}, setQuery: () => {}, loadMore: () => {}, retry: () => {} } }) }));

it('renders the whole-project series when a missing author is cleared', () => {
  createLocaleRender('en')(<ProjectStatistics userId="user" projectId="project" canRead active snapshot={null} taskError={null} onTaskRetry={() => {}} onPrincipalMismatch={() => {}} onAccessError={() => {}} refreshRevision={0} />);
  expect(screen.getByRole('button', { name: 'Creator: All' })).toBeInTheDocument();
  const chart = screen.getByRole('listbox', { name: 'PRs created daily' });
  expect(within(chart).getAllByRole('option')[0]).toHaveAccessibleName(/: 4$/);
});
