import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionApi } from '../src/api/sessions';
import type { SessionStartupReport } from '../../daynight/src/session/startup';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import { SessionView } from '../src/features/task-agent-session/SessionView';
import { renderWithLocale } from './helpers/renderWithLocale';
import type { TaskSessionSnapshot } from './helpers/session';
const clients: TaskSessionClient[] = [];
afterEach(() => clients.splice(0).forEach(client => client.close()));
const s = (): TaskSessionSnapshot => ({ ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), connectionState: 'disconnected', synchronized: false, activity: 'initializing' });
async function mount(locale: 'en' | 'zh-CN', failed = false) {
  const snapshot = s();
  const report: SessionStartupReport = { schemaVersion: 1, source: 'worker', sessionId: snapshot.sessionId, claimId: snapshot.claimId, executionGeneration: snapshot.executionGeneration, controllerInstanceId: snapshot.identity.controllerInstanceId, revision: '1', observedAt: new Date().toISOString(), startup: failed ? { state: 'failed', reasonCode: 'native_rejected' } : { state: 'unknown', reasonCode: 'native_timeout' }, recovery: { state: 'blocked', reasonCode: 'native_identity_missing' } };
  const api: SessionApi = { current: vi.fn(async () => ({ status: 'registered' as const, session: snapshot, startupReport: report })), channel: vi.fn(() => ({ close: vi.fn() })), timeline: vi.fn(), archive: vi.fn(), archiveContent: vi.fn(), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/unused' };
  const client = new TaskSessionClient({ api, userId: '00000009-1111-4111-8111-111111111111', projectId: snapshot.identity.projectId, taskId: snapshot.identity.taskId, claimId: snapshot.claimId, ownerUserId: '00000009-1111-4111-8111-111111111111', isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: null });
  client.setCurrentReadVisible(true); clients.push(client);
  await act(() => client.start());
  const view = renderWithLocale(<SessionView client={client} userId="viewer" active current />, { locale });
  return { api, client, ...view };
}
it.each(['en', 'zh-CN'] as const)('shows a single blocked-startup status and safe localized reasons in %s', async locale => {
  const f = await mount(locale);
  const label = locale === 'en' ? 'Startup unconfirmed; recovery blocked' : '启动未确认，恢复受阻';
  expect(screen.getAllByText(label)).toHaveLength(1);
  expect(screen.queryByText('Disconnected')).toBeNull();
  expect(screen.queryByText('正在恢复会话')).toBeNull();
  expect(screen.queryByText('Restoring session')).toBeNull();
  expect(f.api.timeline).not.toHaveBeenCalled();
  const input = screen.getByRole('textbox'); input.focus(); fireEvent.change(input, { target: { value: 'retain draft' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(f.api.command).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(input).toHaveFocus(); expect(input).toHaveValue('retain draft');
  const details = screen.getByText(locale === 'en' ? 'View reason' : '查看原因').closest('details')!;
  fireEvent.click(details.querySelector('summary')!); details.open = true;
  expect(screen.getByText(locale === 'en' ? 'Native initialization timed out; its result is unknown.' : '原生初始化响应超时，结果未知。')).toBeVisible();
});
it('does not hide an explicit failed startup behind recovery blockage', async () => {
  await mount('zh-CN', true);
  await waitFor(() => expect(screen.getByText('启动失败，恢复受阻')).toBeVisible());
});
