import { readFileSync } from 'node:fs';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCompletedTaskSession } from '../src/features/task-agent-session/automatic-task-session';
import { createSessionApi } from '../src/api/sessions';
import type { TerminalSessionApi } from '../src/api/terminal-sessions';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { createLocaleRender } from './helpers/renderWithLocale';
import type { TaskSessionSnapshot } from './helpers/session';

vi.mock('../src/api/sessions', () => ({ createSessionApi: vi.fn() }));
const render = createLocaleRender('en');
const userId = '00000009-1111-4111-8111-111111111111';
const scopes: TaskCacheScope[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); vi.restoreAllMocks(); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(mode: 'web' | 'herdr') {
  const s: TaskSessionSnapshot = { ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), lifecycle: 'archived' };
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const ready = vi.spyOn(scope, 'ready').mockResolvedValue(undefined);
  const native = { current: vi.fn(async (_signal: AbortSignal) => ({ status: 'registered' as const, session: s })) };
  const terminal = { current: vi.fn(async (_signal: AbortSignal) => ({ status: 'registered' as const, sessionId: s.sessionId, claimId: s.claimId, executionGeneration: s.executionGeneration })) };
  vi.mocked(createSessionApi).mockReturnValue(native as never);
  function Probe({ active, claimId }: { active: boolean; claimId: string }) {
    const result = useCompletedTaskSession({ projectId: s.identity.projectId, taskId: s.identity.taskId, claimId, mode, api: terminal as unknown as TerminalSessionApi, active });
    return <output>{result.item === null ? result.availability === null ? 'loading' : result.availability : result.item.claimId}</output>;
  }
  const element = (active = true, claimId = s.claimId) => <TaskCacheProvider scope={scope}><Probe active={active} claimId={claimId} /></TaskCacheProvider>;
  return { s, scope, ready, native, terminal, current: mode === 'web' ? native.current : terminal.current, element };
}

it.each(['web', 'herdr'] as const)('does not discover a hidden completed %s tab or hidden document', async mode => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const f = fixture(mode); const view = render(f.element(false)); await act(async () => {});
  expect(f.current).not.toHaveBeenCalled();
  visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange')));
  view.rerender(f.element(true)); await act(async () => {}); expect(f.current).not.toHaveBeenCalled();
  visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(f.current).toHaveBeenCalledOnce());
  expect(screen.getByRole('status')).toHaveTextContent(f.s.claimId);
});

it.each(['web', 'herdr'] as const)('rechecks visibility after scope.ready before completed %s current', async mode => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const f = fixture(mode), admission = deferred<void>(); f.ready.mockReturnValueOnce(admission.promise);
  render(f.element()); expect(f.current).not.toHaveBeenCalled();
  visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => admission.resolve()); expect(f.current).not.toHaveBeenCalled();
  visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(f.current).toHaveBeenCalledOnce());
});

it('retains a cancelled completed current flight until it settles across document reopening', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const f = fixture('web'), pending = deferred<{ status: 'registered'; session: TaskSessionSnapshot }>();
  f.native.current.mockReturnValueOnce(pending.promise); render(f.element());
  await waitFor(() => expect(f.native.current).toHaveBeenCalledOnce());
  const signal = f.native.current.mock.calls[0]![0] as AbortSignal;
  visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(signal.aborted).toBe(true);
  visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => {}); expect(f.native.current).toHaveBeenCalledOnce();
  await act(async () => pending.resolve({ status: 'registered', session: f.s }));
  await waitFor(() => expect(f.native.current).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('status')).toHaveTextContent(f.s.claimId);
});

it('does not publish a completed current response that arrives while hidden', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const f = fixture('web'), pending = deferred<{ status: 'registered'; session: TaskSessionSnapshot }>();
  f.native.current.mockReturnValueOnce(pending.promise); render(f.element()); await waitFor(() => expect(f.native.current).toHaveBeenCalledOnce());
  visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => pending.resolve({ status: 'registered', session: f.s }));
  expect(screen.getByRole('status')).toHaveTextContent('loading');
  visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(f.s.claimId));
});

it('starts the replacement claim after a cancelled completed read settles', async () => {
  const f = fixture('web'), pending = deferred<{ status: 'registered'; session: TaskSessionSnapshot }>();
  f.native.current.mockReturnValueOnce(pending.promise); const view = render(f.element()); await waitFor(() => expect(f.native.current).toHaveBeenCalledOnce());
  const claimId = '00000010-1111-4111-8111-111111111111';
  f.native.current.mockResolvedValue({ status: 'registered', session: { ...f.s, claimId } }); view.rerender(f.element(true, claimId));
  await act(async () => {}); expect(f.native.current).toHaveBeenCalledOnce();
  await act(async () => pending.resolve({ status: 'registered', session: f.s }));
  await waitFor(() => expect(f.native.current).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('status')).toHaveTextContent(claimId);
});


it('rechecks the completed current after response identity waiting is cancelled by hiding', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const f = fixture('web'), admission = deferred<void>();
  f.ready.mockResolvedValueOnce(undefined).mockReturnValueOnce(admission.promise);
  render(f.element()); await waitFor(() => expect(f.native.current).toHaveBeenCalledOnce());
  visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange')));
  visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => {}); expect(f.native.current).toHaveBeenCalledOnce();
  expect(screen.getByRole('status')).toHaveTextContent('loading');
  await act(async () => admission.resolve());
  await waitFor(() => expect(f.native.current).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('status')).toHaveTextContent(f.s.claimId);
});
