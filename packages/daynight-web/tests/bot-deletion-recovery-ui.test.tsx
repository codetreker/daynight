import { fireEvent, screen, waitFor } from '@testing-library/react';
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
async function recoveryCoordinator(value: BotDeletionRecovery) {
  const coordinator = new BotDeletionCoordinator(scope()); coordinator.observe(recoveryBot(value));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => botResponse(url.endsWith('/deletion-recovery') ? value : recoveryBot(value))));
  await coordinator.check(botId(), new AbortController().signal);
  return coordinator;
}

it('shows original-machine CLI instructions and never offers a recovery write or invalid original DELETE', async () => {
  const coordinator = await recoveryCoordinator({ ...recoveryResource(), hostingWorkerId: botId(88) });
  renderWithLocale(<BotDeletionStatus record={coordinator.snapshot()[0]!} coordinator={coordinator} onCheck={async () => {}} enabled workerName="Original laptop" />, { locale: 'zh-CN' });
  fireEvent.click(screen.getByText('查看恢复步骤'));
  expect(screen.getByText('Original laptop')).toBeVisible(); expect(screen.getByText(botId(88))).toBeVisible();
  expect(screen.getByText(`daynight bot deletion inspect ${botId()}`)).toBeVisible();
  expect(screen.getByText(`daynight bot deletion recover ${botId()} --deletion-id ${botId(90)}`)).toBeVisible();
  expect(screen.getByText('daynight bot deletion resolve --help')).toBeVisible();
  expect(screen.getByText(/使用原来的 DN_CONFIG_DIR/)).toBeVisible();
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['核对删除结果']);
});
it.each(['pending', 'failed'] as const)('shows CLI cleanup retry instructions for an accepted %s decision', async state => {
  const coordinator = await recoveryCoordinator(recoveryResource(true, state));
  renderWithLocale(<BotDeletionStatus record={coordinator.snapshot()[0]!} coordinator={coordinator} onCheck={async () => {}} enabled />, { locale: 'zh-CN' });
  fireEvent.click(screen.getByText('查看恢复步骤'));
  expect(screen.getByText(`daynight bot deletion retry-cleanup ${botId()} --if-version <version> --deletion-id ${botId(90)} --operation-id ${botId(91)}`)).toBeVisible();
  expect(screen.queryByText('daynight bot deletion resolve --help')).toBeNull();
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['核对删除结果']);
});
it('shows a truthful settled record without a cleanup action or pending status', async () => {
  const coordinator = await recoveryCoordinator(recoveryResource(true, 'completed'));
  renderWithLocale(<BotDeletionStatus record={coordinator.snapshot()[0]!} coordinator={coordinator} onCheck={async () => {}} enabled />, { locale: 'zh-CN' });
  expect(screen.getByRole('status')).toHaveTextContent('服务端删除完成，本机未核实');
  expect(screen.queryByRole('button', { name: '核对删除结果' })).toBeNull();
  fireEvent.click(screen.getByText('查看收尾记录')); expect(screen.getByText('Original records lost')).toBeVisible();
});
it('reads recovery from a known Bot URL and observes a CLI settlement after reload', async () => {
  let value: BotDeletionRecovery = recoveryResource();
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/deletion-recovery')) return botResponse(value);
    if (url.endsWith(`/bots/${botId()}`)) return botResponse(recoveryBot(value));
    if (url.includes('/defaults')) return botResponse(botDefaults());
    if (url.includes('/assistant-tasks?')) return botResponse({ items: [], nextCursor: null, observedAt: '2026-11-13T00:00:00Z' });
    if (url.includes('/bots?')) return botResponse({ items: [], nextCursor: null });
    throw new Error(`Unexpected route ${url}`);
  }); vi.stubGlobal('fetch', fetcher);
  const first = renderWithLocale(<TaskCacheProvider scope={scope()}><BotsPage botId={botId()} readEnabled /></TaskCacheProvider>, { locale: 'zh-CN' });
  await waitFor(() => expect(screen.getByText('缺少执行记录，需要在原机器恢复')).toBeVisible());
  expect(screen.getByRole('heading', { level: 2, name: '助手' })).toBeVisible();
  expect(screen.queryByRole('heading', { level: 2, name: '正在加载…' })).toBeNull();
  first.unmount(); sessionStorage.clear(); value = recoveryResource(true, 'completed');
  renderWithLocale(<TaskCacheProvider scope={scope()}><BotsPage botId={botId()} readEnabled /></TaskCacheProvider>, { locale: 'zh-CN' });
  expect(await screen.findByText('服务端删除完成，本机未核实')).toBeVisible();
  expect(screen.queryByText('查看恢复步骤')).toBeNull();
  expect(fetcher.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
});
