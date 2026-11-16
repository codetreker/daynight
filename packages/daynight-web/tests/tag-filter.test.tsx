import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { registerOverlay } from '../src/app/overlay';
import { resolveProjectTags } from '../src/api/task-tags';
import { emptyTagFilter, matchesTagFilter, TagFilter, useTagFilter } from '../src/features/task-tags/TagFilter';
import { LocaleProvider } from '../src/i18n/LocaleProvider';

const data = vi.hoisted(() => ({
  catalogActive: vi.fn(),
  listeners: new Set<(event: { projectId: string; directAccessUncertain?: boolean; accessRevoked?: boolean; accessRestored?: boolean }) => void>(),
  scope: { userId: 'user', signal: new AbortController().signal, isInvalidated: false, principalMismatch: vi.fn(), markProjectReadable: vi.fn(), isProjectSuspended: vi.fn().mockReturnValue(false), ready: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn(), subscribeTagColors: vi.fn(() => () => {}) },
  page: { items: [{ id: 'a', name: 'bug' }, { id: 'b', name: 'backend' }], catalogEpoch: 'one', nextCursor: null as string | null },
}));
vi.mock('../src/features/task-cache/TaskCacheProvider', () => ({ useTaskCacheScope: () => data.scope }));
vi.mock('../src/api/task-tags', async original => ({ ...await original<typeof import('../src/api/task-tags')>(), resolveProjectTags: vi.fn(), resolveProjectTagColors: vi.fn(async (_project: string, ids: string[]) => ({ catalogEpoch: '00000000-0000-4000-8000-000000000051', items: ids.map(id => ({ id, state: 'found', version: 1n, color: '#AABBCC' })) })) }));
vi.mock('../src/features/task-tags/useProjectTags', async () => {
  const { useState } = await import('react');
  return { useProjectTags: (_project: string, active: boolean) => {
    data.catalogActive(active);
    const [query, setQuery] = useState('');
    const [cursor, setCursor] = useState<string | null>(null);
    return { page: { ...data.page, items: data.page.items.filter(tag => tag.name.includes(query)) }, cursor, query, loading: false, refreshing: false, error: null, setQuery, refresh: vi.fn(), first: () => setCursor(null), next: () => setCursor(data.page.nextCursor) };
  } };
});
const Harness = ({ child = false, onManage }: { child?: boolean; onManage?: () => void }) => {
  const filter = useTagFilter('project');
  return <><TagFilter controller={filter} child={child} {...(onManage === undefined ? {} : { onManage })} /><output data-testid="value">{JSON.stringify(filter.value)}</output><output data-testid="invalid">{String(filter.invalid)}</output><button type="button" onClick={filter.markInvalid}>Server invalid</button></>;
};
const setup = (child = false) => render(<LocaleProvider initial={{ locale: 'en', issue: null }}><Harness child={child} /></LocaleProvider>);
beforeEach(() => {
  data.listeners.clear(); data.catalogActive.mockClear(); data.scope.isProjectSuspended.mockReturnValue(false); data.scope.ready.mockReset().mockResolvedValue(undefined);
  data.scope.subscribe.mockImplementation(listener => { data.listeners.add(listener); return () => data.listeners.delete(listener); });
  data.page = { items: [{ id: 'a', name: 'bug' }, { id: 'b', name: 'backend' }], catalogEpoch: 'one', nextCursor: null };
  vi.mocked(resolveProjectTags).mockReset().mockImplementation(async (_project, ids) => ids.map(id => ({ id, name: id === 'a' ? 'bug' : 'backend' })));
});

it('matches only the selected IDs and implements all, any and untagged', () => {
  const bug = [{ id: 'a', name: 'bug' }], both = [...bug, { id: 'b', name: 'backend' }];
  expect(matchesTagFilter([], emptyTagFilter)).toBe(true);
  expect(matchesTagFilter(bug, { tagIds: ['a', 'b'], tagMatch: 'all', untagged: false })).toBe(false);
  expect(matchesTagFilter(both, { tagIds: ['a', 'b'], tagMatch: 'all', untagged: false })).toBe(true);
  expect(matchesTagFilter(bug, { tagIds: ['a', 'b'], tagMatch: 'any', untagged: false })).toBe(true);
  expect(matchesTagFilter([], { tagIds: [], tagMatch: 'all', untagged: true })).toBe(true);
  expect(matchesTagFilter(bug, { tagIds: [], tagMatch: 'all', untagged: true })).toBe(false);
});

it('keeps the picker open and query while choosing tags, switches modes and clears only tags', async () => {
  setup(); fireEvent.click(screen.getByText('Tag filter', { selector: 'summary' }));
  const picker = screen.getByText('Tag filter', { selector: 'summary' }).closest('details')!;
  fireEvent.click(within(picker).getByLabelText('bug'));
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
  fireEvent.change(within(picker).getByLabelText('Tag filter: AND / OR'), { target: { value: 'any' } });
  fireEvent.change(within(picker).getByLabelText('Tag filter: Search tags'), { target: { value: 'back' } });
  fireEvent.click(within(picker).getByLabelText('backend'));
  expect(picker).toHaveAttribute('open');
  expect(within(picker).getByLabelText('Tag filter: Search tags')).toHaveValue('back');
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":["a","b"]');
  fireEvent.click(within(picker).getByLabelText('No tags'));
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":[]');
  expect(screen.getByTestId('value')).toHaveTextContent('"untagged":true');
  fireEvent.click(within(picker).getByLabelText('backend'));
  expect(screen.getByTestId('value')).toHaveTextContent('"untagged":false');
  fireEvent.click(within(picker).getByRole('button', { name: 'Clear' }));
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":[]');
  expect(screen.getByTestId('value')).toHaveTextContent('"tagMatch":"any"');
});

it('preserves the panel for prevented, composing and open native popup Escape events', () => {
  setup();
  const summary = screen.getByText('Tag filter', { selector: 'summary' });
  fireEvent.click(summary);
  const picker = summary.closest('details')!;
  const select = within(picker).getByLabelText('Tag filter: AND / OR');
  const composing = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
  fireEvent(select, composing);
  expect(picker).toHaveAttribute('open');
  fireEvent.keyDown(select, { key: 'Escape', keyCode: 229 });
  expect(picker).toHaveAttribute('open');
  const prevented = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  prevented.preventDefault(); fireEvent(select, prevented);
  expect(picker).toHaveAttribute('open');
  const matches = vi.spyOn(select, 'matches').mockReturnValue(true);
  const popup = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  fireEvent(select, popup);
  expect(popup.defaultPrevented).toBe(false);
  expect(picker).toHaveAttribute('open');
  matches.mockRestore();
  fireEvent.keyDown(select, { key: 'Escape' });
  expect(picker).not.toHaveAttribute('open');
  expect(summary).toHaveFocus();
});

it('closes on an outside pointer without consuming it and retains the filter when reopened', async () => {
  setup();
  const summary = screen.getByText('Tag filter', { selector: 'summary' });
  const picker = summary.closest('details')!;
  fireEvent.click(summary);
  fireEvent.click(within(picker).getByLabelText('bug'));
  fireEvent.change(within(picker).getByLabelText('Tag filter: AND / OR'), { target: { value: 'any' } });
  fireEvent.change(within(picker).getByLabelText('Tag filter: Search tags'), { target: { value: 'bug' } });
  fireEvent.pointerDown(within(picker).getByLabelText('Tag filter: Search tags'));
  expect(picker).toHaveAttribute('open');
  const outside = screen.getByRole('button', { name: 'Server invalid' });
  outside.focus();
  const pointer = new Event('pointerdown', { bubbles: true, cancelable: true });
  fireEvent(outside, pointer);
  expect(pointer.defaultPrevented).toBe(false);
  expect(outside).toHaveFocus();
  expect(picker).not.toHaveAttribute('open');
  fireEvent.click(summary);
  expect(within(picker).getByLabelText('Tag filter: Search tags')).toHaveValue('bug');
  expect(within(picker).getByLabelText('bug')).toBeChecked();
  expect(within(picker).getByLabelText('Tag filter: AND / OR')).toHaveValue('any');
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
});

it('keeps the panel open for paging and clearing controls', () => {
  data.page.nextCursor = 'next'; setup();
  const summary = screen.getByText('Tag filter', { selector: 'summary' });
  const picker = summary.closest('details')!; fireEvent.click(summary);
  for (const name of ['Next', 'First page', 'Clear']) {
    const button = within(picker).getByRole('button', { name });
    fireEvent.pointerDown(button); fireEvent.click(button);
    expect(picker).toHaveAttribute('open');
  }
});

it('handles outside Escape only while open, respecting prevented and composition events', () => {
  const view = setup();
  const summary = screen.getByText('Tag filter', { selector: 'summary' });
  const picker = summary.closest('details')!;
  const outside = screen.getByRole('button', { name: 'Server invalid' });
  fireEvent.click(summary); outside.focus();
  const prevented = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  prevented.preventDefault(); fireEvent(outside, prevented);
  fireEvent.keyDown(outside, { key: 'Escape', isComposing: true });
  fireEvent.keyDown(outside, { key: 'Escape', keyCode: 229 });
  expect(picker).toHaveAttribute('open');
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  fireEvent(outside, escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(picker).not.toHaveAttribute('open');
  expect(summary).toHaveFocus();
  const closedEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  fireEvent(outside, closedEscape);
  expect(closedEscape.defaultPrevented).toBe(false);
  fireEvent.click(summary);
  view.unmount();
  const unmountedEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  fireEvent(document.body, unmountedEscape);
  expect(unmountedEscape.defaultPrevented).toBe(false);
});

it('opens only one of two filters while retaining their independent conditions and queries', () => {
  const Pair = () => {
    const main = useTagFilter('project'); const child = useTagFilter('project');
    return <><TagFilter controller={main} /><TagFilter controller={child} child /></>;
  };
  render(<LocaleProvider initial={{ locale: 'en', issue: null }}><Pair /></LocaleProvider>);
  const mainSummary = screen.getByText('Tag filter', { selector: 'summary' });
  const childSummary = screen.getByText('Child task tag filter', { selector: 'summary' });
  const main = mainSummary.closest('details')!, child = childSummary.closest('details')!;
  fireEvent.click(mainSummary);
  fireEvent.click(within(main).getByLabelText('bug'));
  fireEvent.change(within(main).getByLabelText('Tag filter: Search tags'), { target: { value: 'bug' } });
  fireEvent.click(childSummary);
  expect(main).not.toHaveAttribute('open'); expect(child).toHaveAttribute('open');
  fireEvent.click(within(child).getByLabelText('backend'));
  fireEvent.change(within(child).getByLabelText('Child task tag filter: Search tags'), { target: { value: 'back' } });
  fireEvent.click(mainSummary);
  expect(child).not.toHaveAttribute('open'); expect(main).toHaveAttribute('open');
  expect(within(main).getByLabelText('Tag filter: Search tags')).toHaveValue('bug');
  expect(within(main).getByLabelText('bug')).toBeChecked();
  fireEvent.click(childSummary);
  expect(within(child).getByLabelText('Child task tag filter: Search tags')).toHaveValue('back');
  expect(within(child).getByLabelText('backend')).toBeChecked();
});

it('does not consume Escape for hidden or inert filters or over an active overlay', () => {
  const content = (hidden: boolean, inert: boolean) => <LocaleProvider initial={{ locale: 'en', issue: null }}><div hidden={hidden} inert={inert}><Harness /></div><button type="button">Outside</button></LocaleProvider>;
  const view = render(content(false, false));
  const summary = screen.getByText('Tag filter', { selector: 'summary' });
  const picker = summary.closest('details')!;
  const outside = screen.getByRole('button', { name: 'Outside' });
  fireEvent.click(summary);
  for (const [hidden, inert] of [[true, false], [false, true]] as const) {
    view.rerender(content(hidden, inert)); outside.focus();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(outside, escape);
    expect(escape.defaultPrevented).toBe(false); expect(picker).toHaveAttribute('open'); expect(outside).toHaveFocus();
  }
  view.rerender(content(false, false));
  const overlay = document.createElement('div'); document.body.appendChild(overlay);
  const release = registerOverlay(overlay, null);
  try {
    outside.focus();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(outside, escape);
    expect(escape.defaultPrevented).toBe(false); expect(picker).toHaveAttribute('open'); expect(outside).toHaveFocus();
  } finally { release(); overlay.remove(); }
  fireEvent.keyDown(outside, { key: 'Escape' });
  expect(picker).not.toHaveAttribute('open'); expect(summary).toHaveFocus();
});

it('retains the selected name and condition when a later catalog epoch reports deletion', async () => {
  const view = setup(true); fireEvent.click(screen.getByText('Child task tag filter', { selector: 'summary' }));
  fireEvent.click(screen.getByLabelText('bug'));
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
  vi.mocked(resolveProjectTags).mockRejectedValue(new ApiError('server', 404, 'tag_not_found'));
  data.page = { ...data.page, items: [data.page.items[1]!], catalogEpoch: 'two' };
  view.rerender(<LocaleProvider initial={{ locale: 'en', issue: null }}><Harness child /></LocaleProvider>);
  await screen.findByText('A selected tag is unavailable. Remove it to search again.');
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":["a"]');
  expect(screen.getByRole('button', { name: 'Remove bug' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Remove bug' }));
  expect(screen.getByTestId('invalid')).toHaveTextContent('false');
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":[]');
});

it('keeps a server invalid condition until explicitly removed, including while checks wait', async () => {
  setup(); fireEvent.click(screen.getByText('Tag filter', { selector: 'summary' })); fireEvent.click(screen.getByLabelText('bug'));
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
  const pending = Promise.withResolvers<readonly { id: string; name: string }[]>();
  vi.mocked(resolveProjectTags).mockReturnValue(pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Server invalid' }));
  expect(screen.getByTestId('invalid')).toHaveTextContent('true');
  expect(screen.getByRole('button', { name: 'Remove bug' })).toBeVisible();
  await act(async () => { pending.resolve([{ id: 'a', name: 'bug' }]); await pending.promise; });
  expect(screen.getByTestId('invalid')).toHaveTextContent('true');
  fireEvent.click(screen.getByRole('button', { name: 'Remove bug' }));
  expect(screen.getByTestId('invalid')).toHaveTextContent('false');
});

it('identifies the missing ID without clearing other selected tags', async () => {
  const view = setup(); fireEvent.click(screen.getByText('Tag filter', { selector: 'summary' }));
  fireEvent.click(screen.getByLabelText('bug')); fireEvent.click(screen.getByLabelText('backend'));
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
  vi.mocked(resolveProjectTags).mockImplementation(async (_project, ids) => {
    if (ids.includes('a')) throw new ApiError('server', 404, 'tag_not_found');
    return ids.map(id => ({ id, name: 'backend' }));
  });
  data.page = { ...data.page, items: [data.page.items[1]!], catalogEpoch: 'two' };
  view.rerender(<LocaleProvider initial={{ locale: 'en', issue: null }}><Harness /></LocaleProvider>);
  await screen.findByText('A selected tag is unavailable. Remove it to search again.');
  fireEvent.click(screen.getByRole('button', { name: 'Remove backend' }));
  expect(screen.getByTestId('invalid')).toHaveTextContent('true');
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":["a"]');
  fireEvent.click(screen.getByRole('button', { name: 'Remove bug' }));
  expect(screen.getByTestId('invalid')).toHaveTextContent('false');
});

it('unlocks an unidentified server error only after removal and successful resolution of the remainder', async () => {
  setup(); fireEvent.click(screen.getByText('Tag filter', { selector: 'summary' }));
  fireEvent.click(screen.getByLabelText('bug')); fireEvent.click(screen.getByLabelText('backend'));
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
  const first = Promise.withResolvers<readonly { id: string; name: string }[]>();
  const remaining = Promise.withResolvers<readonly { id: string; name: string }[]>();
  vi.mocked(resolveProjectTags).mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(remaining.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Server invalid' }));
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Remove bug' }));
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId('invalid')).toHaveTextContent('true');
  await act(async () => { first.resolve([{ id: 'a', name: 'bug' }, { id: 'b', name: 'backend' }]); await first.promise; });
  expect(screen.getByTestId('invalid')).toHaveTextContent('true');
  await act(async () => { remaining.resolve([{ id: 'b', name: 'backend' }]); await remaining.promise; });
  expect(screen.getByTestId('invalid')).toHaveTextContent('false');
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":["b"]');
});


it('preserves the filter through uncertain access, retires old reads and rechecks on restoration', async () => {
  setup(); fireEvent.click(screen.getByText('Tag filter', { selector: 'summary' }));
  fireEvent.click(screen.getByLabelText('bug'));
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
  const pending = Promise.withResolvers<readonly { id: string; name: string }[]>();
  vi.mocked(resolveProjectTags).mockReset().mockReturnValueOnce(pending.promise).mockResolvedValue([{ id: 'a', name: 'renamed' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Server invalid' }));
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(resolveProjectTags).mock.calls[0]![2];
  act(() => { for (const listener of data.listeners) listener({ projectId: 'project', directAccessUncertain: true }); });
  expect(signal.aborted).toBe(true);
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":["a"]');
  expect(screen.getByRole('button', { name: 'Remove bug' })).toBeVisible();
  await act(async () => { pending.resolve([{ id: 'a', name: 'obsolete' }]); await pending.promise; });
  expect(screen.queryByRole('button', { name: 'Remove obsolete' })).not.toBeInTheDocument();
  expect(resolveProjectTags).toHaveBeenCalledTimes(1);
  act(() => { for (const listener of data.listeners) listener({ projectId: 'project', accessRestored: true }); });
  await screen.findByRole('button', { name: 'Remove renamed' });
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":["a"]');
  act(() => { for (const listener of data.listeners) listener({ projectId: 'project', accessRevoked: true }); });
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":[]');
  expect(screen.queryByRole('button', { name: 'Remove renamed' })).not.toBeInTheDocument();
});

it('re-admits individual resolve results before publishing and retires them when access becomes uncertain', async () => {
  const view = setup(); fireEvent.click(screen.getByText('Tag filter', { selector: 'summary' }));
  fireEvent.click(screen.getByLabelText('bug')); await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
  const admission = Promise.withResolvers<void>();
  data.scope.ready.mockReset().mockResolvedValueOnce(undefined).mockReturnValueOnce(admission.promise);
  vi.mocked(resolveProjectTags).mockReset().mockRejectedValue(new ApiError('server', 404, 'tag_not_found'));
  data.page = { ...data.page, catalogEpoch: 'two' };
  view.rerender(<LocaleProvider initial={{ locale: 'en', issue: null }}><Harness /></LocaleProvider>);
  await waitFor(() => expect(data.scope.ready).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId('invalid')).toHaveTextContent('false');
  act(() => { for (const listener of data.listeners) listener({ projectId: 'project', directAccessUncertain: true }); });
  await act(async () => { admission.resolve(); await admission.promise; });
  expect(screen.getByTestId('invalid')).toHaveTextContent('false');
  expect(screen.getByRole('button', { name: 'Remove bug' })).toBeVisible();
});


it('loads the catalog only while open or while a selection needs revalidation', async () => {
  setup(); expect(data.catalogActive).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByText('Tag filter', { selector: 'summary' }));
  await waitFor(() => expect(data.catalogActive).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByLabelText('bug'));
  fireEvent.keyDown(screen.getByLabelText('bug'), { key: 'Escape' });
  expect(data.catalogActive).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Remove bug' }));
  await waitFor(() => expect(data.catalogActive).toHaveBeenLastCalledWith(false));
});

it('publishes individual missing IDs only after admission completes', async () => {
  const view = setup(); fireEvent.click(screen.getByText('Tag filter', { selector: 'summary' }));
  fireEvent.click(screen.getByLabelText('bug')); await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
  const admission = Promise.withResolvers<void>();
  data.scope.ready.mockReset().mockResolvedValueOnce(undefined).mockReturnValueOnce(admission.promise);
  vi.mocked(resolveProjectTags).mockReset().mockRejectedValue(new ApiError('server', 404, 'tag_not_found'));
  data.page = { ...data.page, catalogEpoch: 'two' };
  view.rerender(<LocaleProvider initial={{ locale: 'en', issue: null }}><Harness /></LocaleProvider>);
  await waitFor(() => expect(data.scope.ready).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId('invalid')).toHaveTextContent('false');
  await act(async () => { admission.resolve(); await admission.promise; });
  await waitFor(() => expect(screen.getByTestId('invalid')).toHaveTextContent('true'));
});


it('offers tag management only in the main filter when a navigation action is supplied', () => {
  const manage = vi.fn();
  const view = render(<LocaleProvider initial={{ locale: 'en', issue: null }}><Harness onManage={manage} /></LocaleProvider>);
  fireEvent.click(screen.getByText('Tag filter', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('button', { name: 'Manage tags' }));
  expect(manage).toHaveBeenCalledOnce();
  view.rerender(<LocaleProvider initial={{ locale: 'en', issue: null }}><Harness child onManage={manage} /></LocaleProvider>);
  expect(screen.queryByRole('button', { name: 'Manage tags' })).not.toBeInTheDocument();
});


it('retains the removal decision across a failed resolve and unlocks after Retry confirms the remainder', async () => {
  setup(); fireEvent.click(screen.getByText('Tag filter', { selector: 'summary' }));
  fireEvent.click(screen.getByLabelText('bug')); fireEvent.click(screen.getByLabelText('backend'));
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalled());
  const pending = Promise.withResolvers<readonly { id: string; name: string }[]>();
  vi.mocked(resolveProjectTags).mockReset().mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce([{ id: 'b', name: 'backend' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Server invalid' }));
  await waitFor(() => expect(resolveProjectTags).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Remove bug' }));
  await screen.findByText('Could not check selected tags.');
  expect(screen.getByTestId('invalid')).toHaveTextContent('true');
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":["b"]');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByTestId('invalid')).toHaveTextContent('false'));
  expect(screen.getByRole('button', { name: 'Remove backend' })).toBeVisible();
  await act(async () => { pending.resolve([{ id: 'a', name: 'bug' }, { id: 'b', name: 'backend' }]); await pending.promise; });
  expect(screen.getByTestId('value')).toHaveTextContent('"tagIds":["b"]');
});
