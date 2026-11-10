import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { BotDirectoryBrowser } from '../src/features/bots/BotDirectoryBrowser';
import { renderWithLocale } from './helpers/renderWithLocale';

const owner = '11111111-1111-4111-8111-111111111111';
const worker = '22222222-2222-4222-8222-222222222222';
const connectionId = '44444444-4444-4444-8444-444444444444';
const capabilityGeneration = '55555555-5555-4555-8555-555555555555';
type Query = { path: string; showHidden: boolean; limit: number; cursor?: string };
const directory = (path = '/worker') => ({ path, parentPath: '/', entries: [{ name: 'project', path: `${path}/project` }], nextCursor: null as string | null });
function fixture(reply: (input: Query) => unknown | Promise<unknown> = input => ({ result: directory(input.path) })) {
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const data = await reply(request.input);
    return new Response(JSON.stringify({ type: 'result', protocol: 'daynight.worker-readonly.v1', ownerUserId: owner, workerId: worker, connectionId, capabilityGeneration, requestId: request.requestId, ...data as object }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': owner } });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function mount(enabled = true) {
  const onCancel = vi.fn(), onSelect = vi.fn();
  const props = { workerId: worker, workerName: 'Remote machine', initialPath: '/worker', defaultPath: '/default', enabled, onCancel, onSelect };
  const view = renderWithLocale(<BotDirectoryBrowser {...props} />, { locale: 'en', taskCache: { viewerId: owner } });
  return { ...view, onCancel, onSelect, update: (next: Partial<typeof props>) => view.rerender(<BotDirectoryBrowser {...props} {...next} />) };
}
const button = (name: string) => screen.getByRole('button', { name });
const path = () => screen.getByRole('textbox', { name: 'Browse path' });
const loaded = () => screen.findByRole('button', { name: 'project' });
afterEach(() => invalidateAuthRequests());

it('reads the bound Worker and only confirms its normalized path on explicit selection', async () => {
  const fetch = fixture(() => ({ result: directory('/normalized') }));
  const view = mount();
  expect(path()).toHaveFocus();
  await loaded();
  expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/me/workers/${worker}/readonly/requests`);
  expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toMatchObject({ operation: 'directory.list', input: { path: '/worker', showHidden: false, limit: 100 } });
  expect(screen.getByText('Remote machine')).toBeVisible();
  expect(path()).toHaveValue('/normalized');
  expect(view.onSelect).not.toHaveBeenCalled();
  fireEvent.click(button('Select this directory'));
  expect(view.onSelect).toHaveBeenCalledWith('/normalized');
});

it('enters a directory, follows the Worker parent, and navigates to the supplied default without confirming', async () => {
  const fetch = fixture(); const view = mount(); await loaded();
  fireEvent.click(button('project')); await waitFor(() => expect(path()).toHaveValue('/worker/project'));
  fireEvent.click(button('Parent directory')); await waitFor(() => expect(path()).toHaveValue('/'));
  fireEvent.click(button('Default directory')); await waitFor(() => expect(path()).toHaveValue('/default'));
  expect(fetch).toHaveBeenCalledTimes(4); expect(view.onSelect).not.toHaveBeenCalled();
});

it.each(['Cancel', 'Close directory browser', 'Escape'])('cancels without a selection and aborts the pending request: %s', async action => {
  let finish!: (value: unknown) => void;
  const fetch = fixture(() => new Promise(resolve => { finish = resolve; }));
  const view = mount(); await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  if (action === 'Escape') fireEvent.keyDown(path(), { key: 'Escape' }); else fireEvent.click(button(action));
  expect(view.onCancel).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
  await act(async () => finish({ result: directory() }));
  expect(screen.queryByRole('button', { name: 'project' })).toBeNull();
  expect(view.onSelect).not.toHaveBeenCalled();
});

it('ignores composition Escape and Enter, and Enter only browses the typed remote path', async () => {
  const fetch = fixture(); const view = mount(); await loaded();
  fireEvent.keyDown(path(), { key: 'Escape', isComposing: true });
  fireEvent.change(path(), { target: { value: 'Z:\\remote' } });
  expect(button('Select this directory')).toHaveAttribute('aria-disabled', 'true');
  fireEvent.keyDown(path(), { key: 'Enter', isComposing: true });
  expect(fetch).toHaveBeenCalledOnce(); expect(view.onCancel).not.toHaveBeenCalled();
  fireEvent.keyDown(path(), { key: 'Enter' });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetch.mock.calls[1]![1].body)).input.path).toBe('Z:\\remote');
  expect(view.onSelect).not.toHaveBeenCalled();
});

it('filters only loaded entries without a request and reloads hidden-directory visibility', async () => {
  const fetch = fixture(input => ({ result: { ...directory(input.path), entries: [{ name: input.showHidden ? '.config' : 'project', path: '/worker/entry' }] } }));
  mount(); await loaded();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter loaded folders' }), { target: { value: 'missing' } });
  expect(screen.queryByRole('button', { name: 'project' })).toBeNull();
  expect(screen.getByText('No matching loaded folders.')).toBeVisible(); expect(fetch).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter loaded folders' }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show hidden folders' }));
  await screen.findByRole('button', { name: '.config' });
  expect(JSON.parse(String(fetch.mock.calls[1]![1].body)).input.showHidden).toBe(true);
});

it('appends a bounded next page from the same directory snapshot', async () => {
  const fetch = fixture(input => ({ result: input.cursor ? { ...directory(), entries: [{ name: 'second', path: '/worker/second' }] } : { ...directory(), nextCursor: 'page-2' } }));
  mount(); await loaded(); fireEvent.click(button('Load more folders'));
  await screen.findByRole('button', { name: 'second' });
  expect(button('project')).toBeVisible(); expect(screen.queryByRole('button', { name: 'Load more folders' })).toBeNull();
  expect(JSON.parse(String(fetch.mock.calls[1]![1].body)).input).toEqual({ path: '/worker', showHidden: false, limit: 100, cursor: 'page-2' });
});

it.each(['connection', 'path', 'cursor', 'entry'])('rejects a mixed or repeated pagination snapshot: %s', async kind => {
  fixture(input => !input.cursor ? { result: { ...directory(), nextCursor: 'page-2' } } : {
    ...(kind === 'connection' ? { connectionId: capabilityGeneration } : {}),
    result: { ...directory(kind === 'path' ? '/other' : '/worker'), entries: [{ name: kind === 'entry' ? 'project' : 'second', path: '/worker/second' }], nextCursor: kind === 'cursor' ? 'page-2' : null },
  });
  mount(); await loaded(); fireEvent.click(button('Load more folders'));
  expect(await screen.findByRole('alert')).toHaveTextContent('The directory changed or returned an invalid response. Reload it.');
  expect(screen.queryByRole('button', { name: 'second' })).toBeNull();
  expect(button('Select this directory')).toHaveAttribute('aria-disabled', 'true');
});

it.each(['unsupported', 'offline', 'permission_denied', 'not_found', 'timeout'])('shows %s distinctly from an empty directory and can retry', async code => {
  let failed = true;
  fixture(() => failed ? { error: { code, message: 'Worker diagnostic' } } : { result: { ...directory(), entries: [] } });
  mount(); const alert = await screen.findByRole('alert');
  expect(alert).not.toHaveTextContent('Worker diagnostic');
  expect(screen.queryByText('This directory has no subfolders.')).toBeNull();
  expect(button('Select this directory')).toHaveAttribute('aria-disabled', 'true');
  failed = false; fireEvent.click(button('Retry'));
  expect(await screen.findByText('This directory has no subfolders.')).toBeVisible();
  expect(button('Select this directory')).toHaveAttribute('aria-disabled', 'false');
});

it('discards late navigation data after switching to another path', async () => {
  let finish!: (value: unknown) => void;
  fixture(input => input.path === '/slow' ? new Promise(resolve => { finish = resolve; }) : { result: directory(input.path) });
  mount(); await loaded();
  fireEvent.change(path(), { target: { value: '/slow' } }); fireEvent.click(button('Go'));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.change(path(), { target: { value: '/new' } }); fireEvent.click(button('Go'));
  await waitFor(() => expect(path()).toHaveValue('/new'));
  await act(async () => finish({ result: directory('/slow') }));
  expect(path()).toHaveValue('/new');
});

it('prevents reads and selection while disabled and reloads on re-enable', async () => {
  const fetch = fixture(); const view = mount(false);
  expect(button('Select this directory')).toHaveAttribute('aria-disabled', 'true'); expect(fetch).not.toHaveBeenCalled();
  view.update({ enabled: true }); await loaded();
  view.update({ enabled: false }); fireEvent.click(button('Select this directory'));
  expect(view.onSelect).not.toHaveBeenCalled(); expect(button('Go')).toHaveAttribute('aria-disabled', 'true');
});

it('disables selection immediately during an authentication pause and restores fresh reads on resume', async () => {
  const fetch = fixture(); const view = mount(); await loaded();
  let resume!: () => void;
  act(() => { resume = pauseAuthRequests(); });
  expect(button('Select this directory')).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(button('Select this directory'));
  expect(view.onSelect).not.toHaveBeenCalled();
  await act(async () => resume());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(button('Select this directory')).toHaveAttribute('aria-disabled', 'false'));
});

it('aborts work on unmount and retains the same directory while changing language', async () => {
  const fetch = fixture(); const view = mount(); await loaded();
  view.setLocale('zh-CN');
  expect(screen.getByRole('textbox', { name: '浏览路径' })).toHaveValue('/worker');
  expect(screen.getByRole('button', { name: '选择此目录' })).toHaveAttribute('aria-disabled', 'false');
  expect(fetch).toHaveBeenCalledOnce();
  view.unmount();
  expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
});

it('keeps an edited path while an earlier directory read finishes', async () => {
  let finish!: (value: unknown) => void;
  const fetch = fixture(() => new Promise(resolve => { finish = resolve; }));
  mount(); await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  fireEvent.change(path(), { target: { value: '/next-draft' } });
  await act(async () => finish({ result: directory('/normalized') }));
  expect(path()).toHaveValue('/next-draft');
  expect(button('Select this directory')).toHaveAttribute('aria-disabled', 'true');
  expect(button('project')).toBeVisible();
});

it.each(['authentication', 'enabled'])('retains loaded pages, nodes, scroll and the path draft during %s revalidation', async mode => {
  let refreshing = false, finish!: (value: unknown) => void;
  const secondPage = { result: { ...directory(), entries: [{ name: 'second', path: '/worker/second' }] } };
  const fetch = fixture(input => input.cursor ? refreshing ? new Promise(resolve => { finish = resolve; }) : secondPage : { result: { ...directory(), nextCursor: refreshing ? 'fresh-page-2' : 'page-2' } });
  const view = mount(); await loaded(); fireEvent.click(button('Load more folders'));
  const second = await screen.findByRole('button', { name: 'second' });
  const list = second.parentElement!;
  list.scrollTop = 73; second.focus();
  fireEvent.change(path(), { target: { value: '/path-draft' } });
  refreshing = true;
  if (mode === 'authentication') {
    let resume!: () => void;
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => resume());
  } else { view.update({ enabled: false }); view.update({ enabled: true }); }
  await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(2));
  expect(button('second')).toBe(second);
  expect(list.scrollTop).toBe(73); expect(second).toHaveFocus();
  expect(path()).toHaveValue('/path-draft');
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  await act(async () => finish(secondPage));
  await waitFor(() => expect(button('second')).toHaveAttribute('aria-disabled', 'false'));
  expect(button('second')).toBe(second); expect(second).toHaveFocus(); expect(list.scrollTop).toBe(73);
  expect(path()).toHaveValue('/path-draft'); expect(button('Select this directory')).toHaveAttribute('aria-disabled', 'true');
  expect(JSON.parse(String(fetch.mock.calls[3]![1].body)).input.cursor).toBe('fresh-page-2');
});

it('keeps the previous complete listing when a resumed page changes connection and retries atomically', async () => {
  let refreshing = false, mixed = true;
  fixture(input => input.cursor ? {
    ...(refreshing && mixed ? { connectionId: capabilityGeneration } : {}),
    result: { ...directory(), entries: [{ name: 'second', path: '/worker/second' }] },
  } : { result: { ...directory(), entries: [{ name: refreshing ? 'replacement' : 'project', path: refreshing ? '/worker/replacement' : '/worker/project' }], nextCursor: 'page-2' } });
  const view = mount(); await loaded(); fireEvent.click(button('Load more folders'));
  const second = await screen.findByRole('button', { name: 'second' });
  refreshing = true; view.update({ enabled: false }); view.update({ enabled: true });
  await screen.findByRole('alert');
  expect(button('project')).toBeVisible(); expect(button('second')).toBe(second);
  expect(screen.queryByRole('button', { name: 'replacement' })).toBeNull();
  expect(button('Select this directory')).toHaveAttribute('aria-disabled', 'true');
  mixed = false; fireEvent.click(button('Retry'));
  await screen.findByRole('button', { name: 'replacement' });
  expect(button('second')).toBe(second); expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'project' })).toBeNull();
});

it('keeps paused controls focusable while rejecting every directory interaction', async () => {
  const fetch = fixture(() => ({ result: { ...directory(), nextCursor: 'page-2' } }));
  const view = mount(); await loaded();
  const filter = screen.getByRole('searchbox', { name: 'Filter loaded folders' });
  filter.focus(); view.update({ enabled: false });
  expect(path()).toHaveProperty('readOnly', true); expect(filter).toHaveProperty('readOnly', true);
  expect(path()).not.toBeDisabled(); expect(filter).not.toBeDisabled();
  for (const name of ['Go', 'Parent directory', 'Default directory', 'project', 'Load more folders', 'Select this directory']) {
    const control = button(name);
    expect(control).not.toBeDisabled(); expect(control).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(control);
  }
  fireEvent.change(path(), { target: { value: '/forbidden-edit' } });
  fireEvent.change(filter, { target: { value: 'forbidden-filter' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show hidden folders' }));
  expect(path()).toHaveValue('/worker'); expect(filter).toHaveValue('');
  expect(screen.getByRole('checkbox', { name: 'Show hidden folders' })).not.toBeChecked();
  expect(fetch).toHaveBeenCalledOnce(); expect(view.onSelect).not.toHaveBeenCalled();
  expect(filter).toHaveFocus();
});
