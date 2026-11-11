import { readFileSync } from 'node:fs';
import { createRef } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotConversationHeader, type BotConversationTarget } from '../src/features/bots/BotConversationHeader';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import { SessionView } from '../src/features/task-agent-session/SessionView';
import type { SessionPresentationSlots } from '../src/features/task-agent-session/session-presentation-slots';
import type { TaskSessionSnapshot } from './helpers/session';
import { botFixture, botOwner } from './helpers/bot-session';
import { botDefinition, botWorkerDefaults } from './helpers/bots';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const clients: TaskSessionClient[] = [];
beforeEach(() => {
  // JSDOM has no layout; browser acceptance owns popover placement and top-layer behavior.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { clients.splice(0).forEach(client => client.close()); });

type Consumer = 'task' | 'test' | 'assistant';
function fixture(consumer: Consumer = 'assistant') {
  const session = botFixture();
  let paused = false;
  const options = { api: session.api, userId: botOwner, isCurrent: () => true, isPaused: () => paused, onPrincipalMismatch: vi.fn(), storage: null };
  let client: TaskSessionClient;
  if (consumer === 'task') {
    const snapshot: TaskSessionSnapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
    session.change({ ...snapshot, sessionId: session.binding.sessionId, lastEventSeq: '0' });
    client = new TaskSessionClient({ ...options, projectId: snapshot.identity.projectId, taskId: snapshot.identity.taskId, claimId: snapshot.claimId, ownerUserId: botOwner });
  } else {
    client = new TaskSessionClient({ ...options, testSessionId: session.binding.sessionId, ...(consumer === 'assistant' ? { bot: session.binding } : {}) });
  }
  client.setCurrentReadVisible(true);
  clients.push(client);
  const bot = { ...botDefinition(), id: session.binding.botId, ownerUserId: botOwner, sessionId: session.binding.sessionId, testExecutionId: session.binding.testExecutionId, startupResult: { state: 'ready' as const, code: null } };
  const target: BotConversationTarget = { bot, name: bot.name, worker: botWorkerDefaults(), stale: false, detailsId: 'current-assistant-details', detailsOpen: false, detailsOpener: createRef(), onDetails: vi.fn(), follow: vi.fn(event => event.preventDefault()) };
  const presentation: SessionPresentationSlots = { variant: 'assistant', renderHeader: slot => <BotConversationHeader target={target} session={slot} /> };
  const element = (active = true) => <SessionView client={client} userId={botOwner} active={active} current {...(consumer === 'assistant' ? { presentation } : {})} />;
  return {
    session, client, target, element,
    start: () => act(async () => { await client.start(); }),
    pause: (next: boolean) => act(() => { paused = next; client.syncAvailability(); }),
  };
}

it.each(['task', 'test', 'assistant'] as const)('keeps one functional set of shared controls for the %s consumer', async consumer => {
  const f = fixture(consumer), view = render(f.element());
  await f.start();
  const input = await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(input).toBeEnabled());
  await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
  fireEvent.change(input, { target: { value: 'Retained header draft' } });
  const header = view.container.querySelector<HTMLElement>('.session-header')!, timeline = view.container.querySelector('.session-timeline');
  expect(view.container.querySelectorAll('.session-header')).toHaveLength(1);
  expect(header).toHaveClass('session-header');
  expect(header.classList.contains('session-header-default')).toBe(consumer !== 'assistant');
  expect(within(header).getAllByText('Codex')).toHaveLength(1);
  const status = within(header).getByRole('status');
  expect(status).toHaveTextContent('Ready');
  expect(status.id).not.toBe('');
  expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(status.id);
  expect(screen.getAllByRole('button', { name: 'Display' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Enter Session fullscreen' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Display' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Standard' }));
  expect(screen.getByRole('menuitemradio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Standard' }), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
  expect(input.closest('.task-agent-session')).toHaveClass('session-fullscreen');
  fireEvent.click(screen.getByRole('button', { name: 'Exit Session fullscreen' }));
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
  expect(input).toHaveValue('Retained header draft');
  expect(view.container.querySelector('.session-timeline')).toBe(timeline);
  if (consumer === 'assistant') {
    expect(within(header).getAllByRole('heading', { name: f.target.name })).toHaveLength(1);
    const details = screen.getByRole('button', { name: 'Assistant details' });
    expect(f.target.detailsOpener.current).toBe(details);
    fireEvent.click(details);
    expect(f.target.onDetails).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(within(screen.getByRole('group', { name: 'More actions' })).getByRole('link', { name: 'Close conversation' })).toHaveAttribute('href', '/bots');
  }
  const refresh = screen.getByRole('button', { name: 'Refresh' });
  expect(screen.getAllByRole('button', { name: 'Refresh' })).toHaveLength(1);
  expect(refresh).toBeEnabled();
  fireEvent.click(refresh);
  await waitFor(() => expect(f.session.api.current).toHaveBeenCalledTimes(2));
  expect(f.session.api.command).not.toHaveBeenCalled();
});

it('retains the open action group and draft while identity verification disables refresh', async () => {
  const f = fixture(), view = render(f.element());
  await f.start();
  const input = await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(input).toBeEnabled());
  await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
  fireEvent.change(input, { target: { value: 'Local draft during verification' } });
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const actions = screen.getByRole('group', { name: 'More actions' }), refresh = within(actions).getByRole('button', { name: 'Refresh' });
  const currentReads = vi.mocked(f.session.api.current).mock.calls.length, channels = vi.mocked(f.session.api.channel).mock.calls.length;
  f.pause(true);
  expect(screen.getByRole('group', { name: 'More actions' })).toBe(actions);
  expect(refresh).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
  expect(input).toHaveValue('Local draft during verification');
  fireEvent.click(refresh);
  expect(f.session.api.current).toHaveBeenCalledTimes(currentReads);
  expect(f.session.api.command).not.toHaveBeenCalled();
  f.pause(false);
  await waitFor(() => expect(refresh).toBeEnabled());
  expect(screen.getByRole('group', { name: 'More actions' })).toBe(actions);
  expect(f.session.api.channel).toHaveBeenCalledTimes(channels);
  view.setLocale('zh-CN');
  expect(screen.getByRole('button', { name: '刷新' })).toBe(refresh);
  expect(screen.getByRole('textbox', { name: '消息' })).toBe(input);
});

it.each(['Escape', 'Tab'])('closes More actions on %s without replacing the Session or issuing commands', async key => {
  const f = fixture(), outerEscape = vi.fn();
  const view = render(<div onKeyDown={event => { if (event.key === 'Escape') outerEscape(); }}>{f.element()}</div>);
  await f.start();
  const input = await screen.findByRole('textbox', { name: 'Message' });
  fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
  const trigger = screen.getByRole('button', { name: 'More actions' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const actions = screen.getByRole('group', { name: 'More actions' });
  expect(within(actions).getByRole('button', { name: 'Refresh' })).toHaveFocus();
  expect(input.closest('.task-agent-session')).toContainElement(actions);
  fireEvent.keyDown(document.activeElement!, { key });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
  expect(input.closest('.task-agent-session')).toHaveClass('session-fullscreen');
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
  expect(view.container.querySelectorAll('.session-header')).toHaveLength(1);
  expect(outerEscape).not.toHaveBeenCalled();
  expect(f.session.api.command).not.toHaveBeenCalled();
  expect(f.session.api.current).toHaveBeenCalledOnce();
});

it('shows safe target controls before a Session snapshot and clears Session content on invalidation', async () => {
  const f = fixture(), view = render(f.element());
  expect(view.container.querySelectorAll('.session-header')).toHaveLength(1);
  expect(screen.getByRole('heading', { name: f.target.name })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Display' })).toBeNull();
  expect(screen.queryByText('Connected')).toBeNull();
  expect(screen.getByRole('button', { name: 'Assistant details' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Enter Session fullscreen' })).toBeEnabled();
  await f.start();
  const input = await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
  fireEvent.change(input, { target: { value: 'Private draft' } });
  await screen.findByText(`Message ${f.session.binding.botId}`);
  act(() => f.client.invalidate());
  expect(screen.queryByText(`Message ${f.session.binding.botId}`)).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Display' })).toBeNull();
  expect(screen.queryByText('Connected')).toBeNull();
  expect(view.container.querySelectorAll('.session-header')).toHaveLength(1);
  expect(f.session.api.command).not.toHaveBeenCalled();
});
