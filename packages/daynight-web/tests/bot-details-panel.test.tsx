import { createRef, useRef, useState, type ComponentProps } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotDetailsPanel } from '../src/features/bots/BotDetailsPanel';
import { renderWithLocale } from './helpers/renderWithLocale';
import { botDefinition, botWorkerDefaults } from './helpers/bots';
import { mockWideAssistantWorkspace } from './helpers/assistant-ui';
import { BotSessionCache } from '../src/features/bots/session-cache';
import { botBinding, botFixture, botOwner } from './helpers/bot-session';
import { sessionFence } from '../../daynight/src/session/protocol';
import type { SessionOperation } from '../src/api/types';
import type { SessionControls } from '../../daynight/src/session/controls';

function Harness() {
  const opener = useRef<HTMLButtonElement>(null), [open, setOpen] = useState(false);
  return <><button ref={opener} onClick={() => setOpen(true)}>Assistant</button>{open && <BotDetailsPanel id="details" bot={botDefinition()} worker={botWorkerDefaults()} stale={false} opener={opener} onClose={() => setOpen(false)} />}</>;
}
it('keeps keyboard focus in the narrow drawer and closes only its own layer', () => {
  vi.stubGlobal('innerWidth',390);
  renderWithLocale(<Harness />,{locale:'en'});
  fireEvent.click(screen.getByRole('button',{name:'Assistant'}));
  const dialog = screen.getByRole('dialog',{name:'Assistant details'}), close = within(dialog).getByRole('button',{name:'Close assistant details'});
  expect(close).toHaveFocus();
  expect(fireEvent.keyDown(close,{key:'Tab'})).toBe(false);
  expect(close).toHaveFocus();
  expect(fireEvent.keyDown(close,{key:'Tab',shiftKey:true})).toBe(false);
  fireEvent.keyDown(close,{key:'Escape'});
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button',{name:'Assistant'})).toHaveFocus();
  expect(document.body.style.overflow).not.toBe('hidden');
});
it('changes responsive modality in place and releases the body lock on cancel',()=>{
  mockWideAssistantWorkspace();
  renderWithLocale(<Harness />,{locale:'en'});
  fireEvent.click(screen.getByRole('button',{name:'Assistant'}));
  const panel=screen.getByRole('complementary',{name:'Assistant details'});
  act(()=>{vi.stubGlobal('innerWidth',390);window.dispatchEvent(new Event('resize'));});
  expect(screen.getByRole('dialog',{name:'Assistant details'})).toBe(panel);
  expect(panel).toHaveAttribute('aria-modal','true');
  act(()=>{vi.stubGlobal('innerWidth',1440);window.dispatchEvent(new Event('resize'));});
  expect(screen.getByRole('complementary',{name:'Assistant details'})).toBe(panel);
  expect(panel).not.toHaveAttribute('aria-modal');
  fireEvent(panel,new Event('cancel',{bubbles:false,cancelable:true}));
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(document.body.style.overflow).not.toBe('hidden');
});


const caches: BotSessionCache[] = [];
afterEach(() => { caches.splice(0).forEach(cache => cache.close()); });
const nativeControls = (): SessionControls => ({
  revision: '4', settings: [
    { id: 'model', category: 'model', label: 'Model', description: null, value: 'native-a', mutable: true, scope: 'session', options: [{ value: 'native-a', label: 'Native A' }, { value: 'native-b', label: 'Native B' }] },
    { id: 'approval', category: 'permission', label: 'Approval policy', description: null, value: 'on-request', mutable: true, scope: 'next_turn', options: [{ value: 'on-request', label: 'On request' }, { value: 'never', label: 'Never ask' }] },
  ], commands: [], settingsError: null, commandsError: null,
});
async function sessionDetails() {
  const source = botFixture();
  source.change({ ...source.snapshot(), controls: nativeControls() });
  let paused = false, current = true;
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => current, isPaused: () => paused, storage: null, onPrincipalMismatch: vi.fn(), createApi: () => source.api });
  caches.push(cache);
  cache.select(source.binding);
  const pane = cache.snapshot()[0]!;
  await waitFor(() => expect(pane.client.snapshot().connected).toBe(true));
  const bot = { ...botDefinition(), id: source.binding.botId, ownerUserId: source.binding.ownerUserId, sessionId: source.binding.sessionId, testExecutionId: source.binding.testExecutionId };
  const props = { id: 'current-details', bot, worker: botWorkerDefaults(), stale: false, opener: createRef<HTMLButtonElement>(), onClose: vi.fn(), cache };
  const view = renderWithLocale(<BotDetailsPanel {...props} />, { locale: 'en' });
  const rerender = (change: Partial<ComponentProps<typeof BotDetailsPanel>>) => view.rerender(<BotDetailsPanel {...props} {...change} />);
  return { source, cache, pane, bot, props, view, rerender,
    pause: (value: boolean) => act(() => { paused = value; cache.syncAvailability(); }),
    invalidate: () => act(() => { current = false; cache.syncAvailability(); }),
  };
}

it.each([
  { id: 'model', next: 'native-b', before: 'Native A', after: 'Native B' },
  { id: 'approval', next: 'never', before: 'On request', after: 'Never ask' },
])('keeps confirmed $id distinct from pending, unknown and confirmed receipts', async ({ id, next, before, after }) => {
  const f = await sessionDetails();
  let reject!: (error: Error) => void;
  vi.mocked(f.source.api.command).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  let result!: Promise<unknown>;
  act(() => { result = f.pane.client.updateSetting(id, next, '4').catch(error => error); });
  expect(screen.getByText(before)).toBeVisible();
  expect(screen.queryByText(after)).toBeNull();
  expect(screen.getByText('Pending provider confirmation.')).toBeVisible();
  await act(async () => { reject(new Error('lost setting receipt')); await result; });
  expect(screen.getByText('Change outcome is unknown. Check the original operation.')).toBeVisible();
  expect(screen.getByText(before)).toBeVisible();
  expect(screen.queryByText(after)).toBeNull();
  const command = vi.mocked(f.source.api.command).mock.calls[0]![1];
  expect(command).toMatchObject({ ...sessionFence(f.source.snapshot()), kind: 'update_setting', payload: { settingId: id, value: next, expectedControlsRevision: '4' } });
  await act(async () => {
    await expect(f.pane.client.updateSetting(id, next, '4')).rejects.toThrow('This setting changed or is unavailable');
  });
  const receipt: SessionOperation = { protocol: command.protocol, ...sessionFence(command), operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: null, error: null };
  vi.mocked(f.source.api.operation).mockResolvedValue(receipt);
  await act(async () => f.pane.client.checkOperation(command.operationId));
  expect(screen.queryByText('Change outcome is unknown. Check the original operation.')).toBeNull();
  expect(screen.getByText(before)).toBeVisible();
  expect(screen.queryByText(after)).toBeNull();
  const updated = { ...f.source.snapshot(), sessionRevision: '20', controls: { ...nativeControls(), revision: '5', settings: nativeControls().settings.map(setting => setting.id === id ? { ...setting, value: next } : setting) } };
  act(() => f.source.receive({ protocol: updated.protocol, type: 'snapshot', userId: botOwner, snapshot: updated, cursor: 'confirmed-setting' }));
  expect(screen.getByText(after)).toBeVisible();
  expect(screen.queryByText(before)).toBeNull();
  expect(screen.getByText('Applies to the next turn.')).toBeVisible();
  expect(f.source.api.operation).toHaveBeenCalledExactlyOnceWith(f.bot.sessionId, command.operationId, expect.any(AbortSignal));
  expect(f.source.api.command).toHaveBeenCalledOnce();
  expect(f.cache.snapshot()[0]).toBe(f.pane);
});

it.each(['ownerUserId', 'id', 'sessionId', 'testExecutionId'] as const)('does not combine current Bot details with a cached Session whose %s differs', async field => {
  const f = await sessionDetails();
  expect(screen.getByText('Native A')).toBeVisible();
  const panel = screen.getByRole('dialog', { name: 'Assistant details' });
  f.rerender({ bot: { ...f.bot, [field]: botBinding(2).sessionId, name: 'Current target' } });
  expect(screen.getByText('Current target')).toBeVisible();
  expect(screen.queryByText('Native A')).toBeNull();
  expect(screen.queryByText('On request')).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Assistant details' })).toBe(panel);
  f.rerender({ bot: null });
  expect(screen.queryByText('Current target')).toBeNull();
  expect(screen.queryByText(f.bot.resolvedConfiguration.cwd)).toBeNull();
  f.rerender({ bot: f.bot });
  expect(screen.getByText('Native A')).toBeVisible();
  expect(f.cache.snapshot()[0]).toBe(f.pane);
  expect(f.source.api.current).toHaveBeenCalledOnce();
  expect(f.source.api.channel).toHaveBeenCalledOnce();
  expect(f.source.api.command).not.toHaveBeenCalled();
});

it('retains confirmed details and focus during identity checks, then removes the invalidated Session', async () => {
  const f = await sessionDetails();
  const panel = screen.getByRole('dialog', { name: 'Assistant details' }), close = screen.getByRole('button', { name: 'Close assistant details' });
  act(() => close.focus());
  f.pause(true);
  expect(f.pane.client.snapshot().authPaused).toBe(true);
  expect(screen.getByText('Native A')).toBeVisible();
  expect(screen.getByRole('dialog', { name: 'Assistant details' })).toBe(panel);
  expect(close).toHaveFocus();
  const changed = { ...f.source.snapshot(), sessionRevision: '21', controls: { ...nativeControls(), settingsError: 'Updated private setting diagnostic' } };
  act(() => f.source.receive({ protocol: changed.protocol, type: 'snapshot', userId: botOwner, snapshot: changed, cursor: 'paused-event' }));
  expect(screen.queryByText('Updated private setting diagnostic')).toBeNull();
  f.pause(false);
  expect(screen.getByText('Updated private setting diagnostic')).toBeVisible();
  expect(screen.getByRole('dialog', { name: 'Assistant details' })).toBe(panel);
  expect(close).toHaveFocus();
  f.invalidate();
  expect(screen.queryByText('Native A')).toBeNull();
  expect(screen.queryByText('On request')).toBeNull();
  expect(screen.queryByText('Updated private setting diagnostic')).toBeNull();
  expect(f.cache.snapshot()).toHaveLength(0);
  expect(f.source.api.current).toHaveBeenCalledOnce();
  expect(f.source.api.channel).toHaveBeenCalledOnce();
  expect(f.source.api.command).not.toHaveBeenCalled();
});

it('uses only the matching Worker observation and marks stale availability as unknown', () => {
  const props = { id: 'details', bot: botDefinition(), worker: botWorkerDefaults(), stale: false, opener: createRef<HTMLButtonElement>(), onClose: vi.fn() };
  const view = renderWithLocale(<BotDetailsPanel {...props} />, { locale: 'en' });
  expect(screen.getByText('Machine 20')).toBeVisible();
  expect(screen.getByText('Worker online')).toBeVisible();
  view.rerender(<BotDetailsPanel {...props} stale />);
  expect(screen.queryByText('Worker online')).toBeNull();
  expect(screen.getByText('Worker status unknown')).toBeVisible();
  view.rerender(<BotDetailsPanel {...props} worker={botWorkerDefaults(21)} />);
  expect(screen.queryByText('Machine 20')).toBeNull();
  expect(screen.queryByText('Machine 21')).toBeNull();
  expect(screen.getByText(props.bot.workerId)).toBeVisible();
  expect(screen.getByText('Worker status unknown')).toBeVisible();
  expect(screen.queryByText('Worker online')).toBeNull();
});

it.each([
  { viewport: 1279, available: 760, modal: true },
  { viewport: 1280, available: 759, modal: true },
  { viewport: 1280, available: 760, modal: false },
])('uses both inclusive layout thresholds at $viewport/$available', ({ viewport, available, modal }) => {
  vi.stubGlobal('innerWidth', viewport);
  // JSDOM supplies no layout; browser acceptance owns the resulting geometry.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(available);
  renderWithLocale(<Harness />, { locale: 'en' });
  fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
  const panel = screen.getByRole(modal ? 'dialog' : 'complementary', { name: 'Assistant details' });
  if (modal) {
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(document.body.style.overflow).toBe('hidden');
  } else {
    expect(panel).not.toHaveAttribute('aria-modal');
    expect(document.body.style.overflow).not.toBe('hidden');
  }
});

it('wraps Tab between the drawer controls and leaves dismissal to a blocking modal', () => {
  vi.stubGlobal('innerWidth', 390);
  const onClose = vi.fn(), onDelete = vi.fn(), parentKey = vi.fn();
  const props = { id: 'details', bot: botDefinition(), worker: botWorkerDefaults(), stale: false, opener: createRef<HTMLButtonElement>(), onClose, onDelete };
  const view = renderWithLocale(<div onKeyDown={parentKey}><BotDetailsPanel {...props} /></div>, { locale: 'en' });
  const panel = screen.getByRole('dialog', { name: 'Assistant details' }), close = screen.getByRole('button', { name: 'Close assistant details' }), remove = screen.getByRole('button', { name: 'Delete assistant' });
  act(() => remove.focus());
  fireEvent.keyDown(remove, { key: 'Tab' });
  expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(remove).toHaveFocus();
  expect(parentKey).not.toHaveBeenCalled();
  fireEvent.click(remove);
  expect(onDelete).toHaveBeenCalledExactlyOnceWith(props.bot, remove);
  view.rerender(<div onKeyDown={parentKey}><BotDetailsPanel {...props} modalBlocked /></div>);
  fireEvent(panel, new Event('cancel', { cancelable: true }));
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  view.rerender(<div onKeyDown={parentKey}><BotDetailsPanel {...props} /></div>);
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.body.style.overflow).not.toBe('hidden');
});
