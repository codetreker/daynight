import { useSyncExternalStore } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotDeletionStatus } from '../src/features/bots/BotDeletionStatus';
import { BotDeletionCoordinator } from '../src/features/bots/deletion-coordinator';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { BotsPage } from '../src/features/bots/BotsPage';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_USER, botDefaults, botId, botResponse } from './helpers/bots';
import { recoveryBot, recoveryResource } from './helpers/bot-deletion-recovery';
import type { BotDeletionRecovery } from '../src/api/bot-deletion-recovery';

vi.mock('../src/features/bots/BotSessionHost', () => ({ useBotSessionCache: () => cache, BotSessionHost: () => null }));
const emptyPanes = Object.freeze([]);
const cache = { snapshot: () => emptyPanes, invalidateBot: vi.fn(), blockBot: vi.fn(), unblockBot: vi.fn(), isBlocked: () => false, isRevoked: () => false, subscribe: () => () => {}, guardSnapshot: () => 0 };
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); sessionStorage.clear(); });
function scope() { const value = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(value); return value; }

it('requires acknowledgement and a reason, preserves reviewed version, and does not offer the invalid original delete retry', async () => {
  const owner = scope(), coordinator = new BotDeletionCoordinator(owner); coordinator.observeRecovery(recoveryResource());
  const resolve = vi.spyOn(coordinator, 'resolveRecovery').mockResolvedValue();
  function Harness() { const record = useSyncExternalStore(coordinator.subscribe, coordinator.snapshot)[0]!; return record ? <BotDeletionStatus record={record} coordinator={coordinator} onCheck={async () => {}} enabled /> : null; }
  renderWithLocale(<Harness />, { locale: 'zh-CN' });
  expect(screen.queryByRole('button', { name: '重试原删除请求' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '恢复删除' }));
  const dialog = screen.getByRole('dialog'), confirm = within(dialog).getByRole('button', { name: '确认服务端收尾' });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByRole('textbox', { name: '收尾原因' }), { target: { value: '原始执行记录已丢失' } });
  expect(confirm).toBeDisabled(); fireEvent.click(within(dialog).getByRole('checkbox')); expect(confirm).toBeEnabled();
  fireEvent.change(within(dialog).getByRole('textbox', { name: '收尾原因' }), { target: { value: '长'.repeat(1001) } });
  expect(confirm).toBeDisabled(); expect(within(dialog).getByRole('alert')).toHaveTextContent('1,000');
  fireEvent.change(within(dialog).getByRole('textbox', { name: '收尾原因' }), { target: { value: '原始执行记录已丢失' } });
  act(() => coordinator.observeRecovery(recoveryResource(false, 'pending', '7')));
  fireEvent.click(confirm); expect(resolve).toHaveBeenCalledWith(botId(), '原始执行记录已丢失', '5');
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('shows a truthful settled record without a cleanup action or pending status', () => {
  const coordinator = new BotDeletionCoordinator(scope()); coordinator.observeRecovery(recoveryResource(true, 'completed'));
  renderWithLocale(<BotDeletionStatus record={coordinator.snapshot()[0]!} coordinator={coordinator} onCheck={async () => {}} enabled />, { locale: 'zh-CN' });
  expect(screen.getByRole('status')).toHaveTextContent('服务端删除完成，本机未核实');
  expect(screen.queryByRole('button', { name: '核对删除结果' })).toBeNull();
  fireEvent.click(screen.getByText('查看收尾记录')); expect(screen.getByText('Original records lost')).toBeVisible();
});
it('discovers recovery from the server on a cold device and reads settlement after another device resolves it', async () => {
  let value: BotDeletionRecovery = recoveryResource();
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes('/bot-deletion-recoveries?')) return botResponse({ items: [value], nextCursor: null });
    if (url.endsWith('/deletion-recovery')) return botResponse(value);
    if (url.endsWith(`/bots/${botId()}`)) return botResponse(recoveryBot(value));
    if (url.includes('/defaults')) return botResponse(botDefaults());
    if (url.includes('/assistant-tasks?')) return botResponse({ items: [], nextCursor: null, observedAt: '2026-11-13T00:00:00Z' });
    if (url.includes('/bots?')) return botResponse({ items: [], nextCursor: null });
    throw new Error(`Unexpected route ${url}`);
  }); vi.stubGlobal('fetch', fetcher);
  const first = renderWithLocale(<TaskCacheProvider scope={scope()}><BotsPage botId={null} readEnabled /></TaskCacheProvider>, { locale: 'zh-CN' });
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复删除' })).toBeEnabled());
  first.unmount(); sessionStorage.clear(); value = recoveryResource(true, 'completed');
  renderWithLocale(<TaskCacheProvider scope={scope()}><BotsPage botId={null} readEnabled /></TaskCacheProvider>, { locale: 'zh-CN' });
  expect(await screen.findByText('服务端删除完成，本机未核实')).toBeVisible();
  expect(screen.queryByRole('button', { name: '恢复删除' })).toBeNull();
  expect(fetcher.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
});
