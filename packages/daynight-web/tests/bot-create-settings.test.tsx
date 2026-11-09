import { useState } from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as bots from '../src/api/bots';
import { pauseAuthRequests } from '../src/api/client';
import * as readApi from '../src/api/worker-readonly';
import { BotCreateForm } from '../src/features/bots/BotCreateForm';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/api/bots', async original => ({ ...await original<typeof bots>(), getBotDefaults: vi.fn(), createBot: vi.fn(), getBot: vi.fn() }));
vi.mock('../src/api/worker-readonly', async original => ({ ...await original<typeof readApi>(), discoverWorkerModels: vi.fn(), browseWorkerDirectory: vi.fn() }));
const id = (n: number) => `0000000${n}-1111-4111-8111-111111111111`;
const owner = id(9), workerId = id(1);
const configuration = (worker = workerId): bots.BotConfiguration => ({ workerId: worker, cwd: '/work', provider: 'codex', model: 'model-a', args: [], reasoningEffort: 'high', selection: { schemaVersion: 1, modelSource: 'local', reasoningEffortSource: 'preference' } });
const defaults = (worker = workerId): bots.BotDefaults => ({ observedAt: '2026-11-06T00:00:00Z', workerId: worker, configuration: configuration(worker), reason: null, workers: [workerId, id(2)].map(wid => ({ workerId: wid, machine: { id: id(3), name: wid === workerId ? 'Machine A' : 'Machine B' }, platform: 'macos', state: 'available', reason: null, configuration: configuration(wid), providers: (['codex', 'claude'] as const).map(provider => ({ provider, available: true, reason: null, model: null, args: [] })) })) });
const catalog = (provider: 'codex' | 'claude' | 'copilot' = 'codex'): readApi.WorkerReadonlyResponse<'model.list'> => ({ type: 'result', protocol: readApi.WORKER_READONLY_PROTOCOL, ownerUserId: owner, workerId, requestId: id(4), connectionId: id(5), capabilityGeneration: id(6), result: { schemaVersion: 1, provider, cwd: '/work', configurationGeneration: 'a'.repeat(64), catalogGeneration: id(7), models: [{ id: 'model-a', label: 'Model A', aliases: [], hidden: false, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }, { id: 'model-b', label: 'Model B', aliases: [], hidden: false, reasoningEfforts: ['medium'], defaultReasoningEffort: null }, { id: 'plain', label: 'Plain model', aliases: [], hidden: false, reasoningEfforts: null, defaultReasoningEffort: null }], defaults: { model: { value: 'model-a', source: 'local' }, reasoningEffort: { value: 'low', source: 'native' } }, selectionError: null, nextCursor: null } });
const flush = () => act(async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); });
function Harness({ enabled = true }: { enabled?: boolean }) {
  const [unresolvedRequest, onUnresolvedRequestChange] = useState<bots.CreateBotInput | null>(null);
  return <BotCreateForm enabled={enabled} unresolvedRequest={unresolvedRequest} onUnresolvedRequestChange={onUnresolvedRequestChange} onClose={vi.fn()} onCreated={vi.fn()} />;
}
const mount = () => renderWithLocale(<Harness />, { locale: 'en', taskCache: { viewerId: owner } });
const expand = async () => { fireEvent.click(screen.getByText('Advanced settings')); await flush(); };
const choose = async (label: string, value: string) => { fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } }); await flush(); };
const submit = async () => { fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Helper' } }); fireEvent.click(screen.getByRole('button', { name: 'Create assistant' })); await flush(); };
beforeEach(() => {
  vi.mocked(bots.getBotDefaults).mockImplementation(async (worker, _signal, _admission, choices) => {
    const result = defaults(worker ?? workerId), base = result.configuration!;
    return { ...result, configuration: { ...base, ...choices, selection: { schemaVersion: 1, modelSource: choices?.model ? 'explicit' : 'local', reasoningEffortSource: choices?.reasoningEffort ? 'explicit' : 'preference' } } };
  });
  vi.mocked(readApi.discoverWorkerModels).mockImplementation(async (_worker, input) => catalog(input.provider));
  vi.mocked(bots.createBot).mockResolvedValue({ id: id(8), deletion: null } as bots.BotDefinition);
});

it('keeps the name editable without a status row while first defaults are pending', async () => {
  const pending = Promise.withResolvers<bots.BotDefaults>(); vi.mocked(bots.getBotDefaults).mockReturnValueOnce(pending.promise);
  mount(); await flush();
  const name = screen.getByRole('textbox', { name: 'Name' });
  fireEvent.change(name, { target: { value: 'Draft 名字' } });
  expect(name).toBeEnabled(); expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: 'Create assistant' })).toBeDisabled();
  pending.resolve(defaults()); await flush(); expect(name).toHaveValue('Draft 名字');
});
it('loads native model choices only on expansion and retains implicit name-only creation', async () => {
  mount(); await flush(); expect(readApi.discoverWorkerModels).not.toHaveBeenCalled();
  expect(screen.getByText(/Machine A.*Codex/)).toBeVisible();
  expect(screen.getByText(/Machine A.*Codex/)).toHaveTextContent('Local configuration');
  expect(screen.getByText(/Machine A.*Codex/)).toHaveTextContent('Successful preference');
  await expand(); expect(readApi.discoverWorkerModels).toHaveBeenCalledOnce();
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('');
  expect(screen.getByRole('option', { name: /Use default.*model-a/ })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /Use default.*high/ })).toBeInTheDocument();
  await submit(); expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper' });
});
function delegateNativeDefaults() {
  vi.mocked(bots.getBotDefaults).mockImplementation(async (worker, _signal, _admission, choices) => {
    const result = defaults(worker ?? workerId);
    const native: bots.BotConfiguration = { ...result.configuration!, model: choices?.model ?? null, reasoningEffort: choices?.reasoningEffort ?? null,
      selection: { schemaVersion: 1, modelSource: choices?.model ? 'explicit' : 'native', reasoningEffortSource: choices?.reasoningEffort ? 'explicit' : 'native' } };
    return { ...result, configuration: native, workers: result.workers.map(item => item.workerId === native.workerId ? { ...item, configuration: native } : item) };
  });
}

it('uses a discovered native default for effort-only creation without making the model explicit', async () => {
  delegateNativeDefaults();
  const original = catalog(); const native = { ...original, result: { ...original.result, defaults: { ...original.result.defaults, model: { value: 'model-a', source: 'native' as const } } } };
  vi.mocked(readApi.discoverWorkerModels).mockResolvedValue(native);
  mount(); await flush(); await expand();
  expect(screen.getByRole('option', { name: /Use default.*model-a.*Agent configuration/ })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /Use default.*low.*Agent configuration/ })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toBeEnabled();
  await choose('Reasoning effort', 'high'); await submit();
  expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper', overrides: { workerId, reasoningEffort: 'high' } });
});

it('keeps discovering and displaying native defaults separate from request overrides', async () => {
  delegateNativeDefaults(); mount(); await flush(); await expand();
  expect(screen.getByRole('option', { name: /Use default.*model-a/ })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('');
  await submit(); expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper' });
});

it('uses hidden native default capabilities without adding the hidden model to the menu', async () => {
  delegateNativeDefaults();
  const native = catalog();
  vi.mocked(readApi.discoverWorkerModels).mockResolvedValue({ ...native, result: { ...native.result,
    models: [{ ...native.result.models[0]!, hidden: true, aliases: ['native-alias'] }, ...native.result.models.slice(1)],
    defaults: { ...native.result.defaults, model: { value: 'native-alias', source: 'native' } } } });
  mount(); await flush(); await expand();
  expect(readApi.discoverWorkerModels).toHaveBeenLastCalledWith(workerId, { provider: 'codex', cwd: '/work', includeHidden: true, limit: 100 }, expect.any(AbortSignal), expect.any(Object), {});
  expect(screen.queryByRole('option', { name: 'Model A' })).toBeNull();
  expect(screen.getByRole('option', { name: /Use default.*native-alias/ })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toBeEnabled();
  await choose('Reasoning effort', 'high'); await submit();
  expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper', overrides: { workerId, reasoningEffort: 'high' } });
});

it('retains an explicit model that becomes hidden and can restore its implicit default', async () => {
  const visible = catalog();
  vi.mocked(readApi.discoverWorkerModels).mockResolvedValueOnce(visible).mockResolvedValue({ ...visible, result: { ...visible.result, models: visible.result.models.map(option => ({ ...option, hidden: true })) } });
  mount(); await flush(); await expand(); await choose('Model', 'model-a');
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('model-a');
  expect(screen.getByRole('option', { name: 'model-a' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Model B' })).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toBeEnabled();
  await choose('Model', ''); await submit();
  expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper', overrides: { workerId } });
});

it('keeps service-resolved model and effort preferences ahead of catalog defaults', async () => {
  const resolved = { ...configuration(), model: 'model-b', reasoningEffort: 'medium', selection: { schemaVersion: 1 as const, modelSource: 'preference' as const, reasoningEffortSource: 'preference' as const } };
  vi.mocked(bots.getBotDefaults).mockResolvedValue({ ...defaults(), configuration: resolved });
  mount(); await flush(); await expand();
  expect(screen.getByRole('option', { name: /Use default.*model-b.*Successful preference/ })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /Use default.*medium.*Successful preference/ })).toBeInTheDocument();
  expect(within(screen.getByRole('combobox', { name: 'Reasoning effort' })).queryByRole('option', { name: 'high' })).toBeNull();
  expect(within(screen.getByRole('combobox', { name: 'Reasoning effort' })).getByRole('option', { name: 'medium' })).toBeInTheDocument();
});

it('does not borrow a catalog default effort for a different service-resolved model', async () => {
  const resolved: bots.BotConfiguration = { ...configuration(), model: 'model-b', reasoningEffort: null, selection: { schemaVersion: 1, modelSource: 'preference', reasoningEffortSource: 'native' } };
  vi.mocked(bots.getBotDefaults).mockResolvedValue({ ...defaults(), configuration: resolved });
  mount(); await flush(); await expand();
  expect(screen.queryByRole('option', { name: /Use default.*low/ })).toBeNull();
  expect(within(screen.getByRole('combobox', { name: 'Reasoning effort' })).getByRole('option', { name: 'medium' })).toBeInTheDocument();
});

it.each(['unknown_default', 'unsupported_selection'] as const)('does not treat a catalog %s as a resolved native default', async code => {
  delegateNativeDefaults(); const native = catalog();
  vi.mocked(readApi.discoverWorkerModels).mockResolvedValue({ ...native, result: { ...native.result, selectionError: { code, message: 'Native default cannot be selected.' } } });
  mount(); await flush(); await expand();
  expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toBeDisabled();
  expect(screen.queryByRole('option', { name: /Use default.*model-a/ })).toBeNull();
  expect(screen.getByText('Native default cannot be selected.')).toBeVisible();
});

it('does not publish an old Worker native default after switching targets', async () => {
  delegateNativeDefaults(); const old = Promise.withResolvers<readApi.WorkerReadonlyResponse<'model.list'>>();
  vi.mocked(readApi.discoverWorkerModels).mockReturnValueOnce(old.promise);
  mount(); await flush(); await expand(); await choose('Worker', id(2));
  expect(screen.getByRole('option', { name: /Use default.*model-a/ })).toBeInTheDocument();
  const previous = catalog();
  old.resolve({ ...previous, result: { ...previous.result, defaults: { ...previous.result.defaults, model: { value: 'old-default', source: 'native' } } } }); await flush();
  expect(screen.queryByRole('option', { name: /old-default/ })).toBeNull();
  expect(screen.getByRole('option', { name: /Use default.*model-a/ })).toBeInTheDocument();
});

it('pins machine-dependent choices and clears effort on a model change', async () => {
  mount(); await flush(); await expand();
  await choose('Reasoning effort', 'low');
  expect(screen.getByRole('combobox', { name: 'Worker' })).toHaveValue(workerId);
  await choose('Model', 'model-b');
  expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('');
  expect(within(screen.getByRole('combobox', { name: 'Reasoning effort' })).queryByRole('option', { name: 'low' })).toBeNull();
  expect(bots.getBotDefaults).toHaveBeenLastCalledWith(workerId, expect.any(AbortSignal), expect.objectContaining({ userId: owner }), { model: 'model-b' });
  await choose('Reasoning effort', 'medium'); await submit();
  expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper', overrides: { workerId, model: 'model-b', reasoningEffort: 'medium' } });
});
it('resets model and effort when changing Agent and resets all machine fields on Worker change', async () => {
  mount(); await flush(); await expand();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/chosen' } }); await flush();
  await choose('Model', 'model-a'); await choose('Reasoning effort', 'low'); await choose('Agent', 'claude');
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('');
  expect(bots.getBotDefaults).toHaveBeenLastCalledWith(workerId, expect.any(AbortSignal), expect.any(Object), { cwd: '/chosen', provider: 'claude' });
  await choose('Worker', id(2));
  expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('');
  await submit(); expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper', overrides: { workerId: id(2) } });
});
it('restores all implicit defaults after explicit model and effort choices', async () => {
  mount(); await flush(); await expand(); await choose('Model', 'model-a'); await choose('Reasoning effort', 'low');
  fireEvent.click(screen.getByRole('button', { name: 'Restore all defaults' })); await flush();
  await submit(); expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper' });
});
it.each([false, true])('keeps creation available when restoring already-default settings after an explicit reset: %s', async afterExplicitReset => {
  mount(); await flush(); await expand();
  if (afterExplicitReset) {
    await choose('Model', 'model-a'); await choose('Reasoning effort', 'low');
    fireEvent.click(screen.getByRole('button', { name: 'Restore all defaults' })); await flush();
  }
  fireEvent.click(screen.getByRole('button', { name: 'Restore all defaults' })); await flush();
  expect(screen.getByRole('button', { name: 'Create assistant' })).toBeEnabled();
  await submit(); expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper' });
});
it('ignores a late defaults response after repeated resets with unchanged choices', async () => {
  mount(); await flush(); await expand();
  const first = Promise.withResolvers<bots.BotDefaults>(), latest = Promise.withResolvers<bots.BotDefaults>();
  vi.mocked(bots.getBotDefaults).mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Restore all defaults' })); await flush();
  const firstSignal = vi.mocked(bots.getBotDefaults).mock.lastCall![1]!;
  fireEvent.click(screen.getByRole('button', { name: 'Restore all defaults' })); await flush();
  expect(firstSignal.aborted).toBe(true);
  expect(screen.getByRole('button', { name: 'Create assistant' })).toBeDisabled();
  latest.resolve(defaults()); await flush();
  expect(screen.getByRole('button', { name: 'Create assistant' })).toBeEnabled();
  first.resolve({ ...defaults(), configuration: null, reason: 'unsupported_selection' }); await flush();
  expect(screen.getByRole('button', { name: 'Create assistant' })).toBeEnabled();
  expect(screen.queryByRole('alert')).toBeNull();
  await submit(); expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper' });
});
it('does not invent effort options for a model without supported efforts', async () => {
  mount(); await flush(); await expand(); await choose('Model', 'plain');
  const effort = screen.getByRole('combobox', { name: 'Reasoning effort' }); expect(effort).toBeDisabled();
  expect(within(effort).getAllByRole('option')).toHaveLength(1);
  expect(screen.getByText('This model does not expose reasoning effort choices.')).toBeVisible();
});
it('keeps the draft and exposes retry when capability discovery fails', async () => {
  vi.mocked(readApi.discoverWorkerModels).mockRejectedValueOnce(new readApi.WorkerReadonlyError('unsupported', 'Unsupported'));
  mount(); await flush(); fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Keep me' } }); await expand();
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
  const alert = screen.getByRole('alert'); expect(alert).toHaveTextContent('unsupported');
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })); await flush();
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled(); expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Keep me');
});
it('prevents an IME Enter key from submitting the form', async () => {
  mount(); await flush(); const name = screen.getByRole('textbox', { name: 'Name' });
  expect(fireEvent.keyDown(name, { key: 'Enter', isComposing: true })).toBe(false);
  expect(bots.createBot).not.toHaveBeenCalled();
});

it('pins catalog pagination to one connection and does not display partial model lists', async () => {
  const second = Promise.withResolvers<readApi.WorkerReadonlyResponse<'model.list'>>();
  const first = catalog();
  vi.mocked(readApi.discoverWorkerModels).mockResolvedValueOnce({ ...first, result: { ...first.result, models: [first.result.models[0]!], nextCursor: 'page-2' } }).mockReturnValueOnce(second.promise);
  mount(); await flush(); await expand();
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
  expect(readApi.discoverWorkerModels).toHaveBeenNthCalledWith(2, workerId, { provider: 'codex', cwd: '/work', includeHidden: true, limit: 100, cursor: 'page-2' }, expect.any(AbortSignal), expect.any(Object), { binding: { connectionId: id(5), capabilityGeneration: id(6) } });
  second.resolve({ ...first, result: { ...first.result, models: first.result.models.slice(1) } }); await flush();
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled(); expect(screen.getByRole('option', { name: 'Model B' })).toBeInTheDocument();
});
it('rejects a catalog generation change and a repeated cursor instead of mixing capability snapshots', async () => {
  const first = catalog();
  vi.mocked(readApi.discoverWorkerModels).mockResolvedValueOnce({ ...first, result: { ...first.result, models: [], nextCursor: 'page-2' } }).mockResolvedValueOnce({ ...first, result: { ...first.result, catalogGeneration: id(8) } });
  mount(); await flush(); await expand();
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('Could not read model capabilities.');
  vi.mocked(readApi.discoverWorkerModels).mockResolvedValue({ ...first, result: { ...first.result, models: [], nextCursor: 'page-2' } });
  fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' })); await flush();
  expect(readApi.discoverWorkerModels).toHaveBeenCalledTimes(4); expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
});
it('discards late capability results after changing the Worker', async () => {
  const old = Promise.withResolvers<readApi.WorkerReadonlyResponse<'model.list'>>();
  vi.mocked(readApi.discoverWorkerModels).mockReturnValueOnce(old.promise);
  mount(); await flush(); await expand();
  await choose('Worker', id(2));
  expect(screen.getByRole('option', { name: 'Model A' })).toBeInTheDocument();
  old.resolve({ ...catalog(), result: { ...catalog().result, models: [{ ...catalog().result.models[0]!, id: 'old', label: 'Old Worker model' }] } }); await flush();
  expect(screen.queryByRole('option', { name: 'Old Worker model' })).toBeNull();
  expect(vi.mocked(readApi.discoverWorkerModels).mock.calls[0]![2].aborted).toBe(true);
});
it('keeps defaults errors authoritative and allows an explicit effort to repair a rejected combination', async () => {
  const normal = vi.mocked(bots.getBotDefaults).getMockImplementation()!;
  vi.mocked(bots.getBotDefaults).mockImplementation(async (worker, signal, admission, choices) => choices?.model === 'model-b' && !choices.reasoningEffort ? { ...defaults(), configuration: null, reason: 'unsupported_selection' } : normal(worker, signal, admission, choices));
  vi.mocked(readApi.discoverWorkerModels).mockImplementation(async (_worker, input) => ({ ...catalog(input.provider), result: { ...catalog(input.provider).result, selectionError: input.model === 'model-b' ? { code: 'unsupported_selection', message: 'Worker effort is incompatible.' } : null } }));
  mount(); await flush(); await expand(); await choose('Model', 'model-b');
  expect(screen.getByRole('button', { name: 'Create assistant' })).toBeDisabled();
  expect(screen.getByText('Worker effort is incompatible.')).toBeVisible();
  await choose('Reasoning effort', 'medium');
  expect(screen.getByRole('button', { name: 'Create assistant' })).toBeEnabled();
  await submit(); expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toMatchObject({ overrides: { workerId, model: 'model-b', reasoningEffort: 'medium' } });
});
it('retains the name, loaded summary and settings during a defaults recheck', async () => {
  mount(); await flush(); await expand();
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Draft name' } });
  const pending = Promise.withResolvers<bots.BotDefaults>(); vi.mocked(bots.getBotDefaults).mockReturnValueOnce(pending.promise);
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/chosen' } }); await flush();
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft name');
  expect(screen.getByRole('textbox', { name: 'Working directory' })).toHaveValue('/chosen');
  expect(screen.getByText(/Machine A.*Codex/)).toBeVisible(); expect(screen.queryByRole('status')).toBeNull();
  pending.resolve({ ...defaults(), configuration: { ...configuration(), cwd: '/chosen' } }); await flush();
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft name');
});
it('returns from Browse without pinning a Worker and pins only a confirmed directory', async () => {
  vi.mocked(readApi.browseWorkerDirectory).mockResolvedValue({ ...catalog(), result: { path: '/canonical', parentPath: '/', entries: [], nextCursor: null } } as readApi.WorkerReadonlyResponse<'directory.list'>);
  mount(); await flush(); await expand();
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Directory draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Browse' })); await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); await flush();
  expect(screen.getByRole('button', { name: 'Browse' })).toHaveFocus();
  expect(screen.getByRole('combobox', { name: 'Worker' })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Directory draft');
  fireEvent.click(screen.getByRole('button', { name: 'Browse' })); await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Select this directory' })); await flush();
  expect(screen.getByRole('combobox', { name: 'Worker' })).toHaveValue(workerId);
  expect(screen.getByRole('textbox', { name: 'Working directory' })).toHaveValue('/canonical');
  fireEvent.click(screen.getByRole('button', { name: 'Browse' })); await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Select this directory' })); await flush();
  expect(screen.getByRole('button', { name: 'Create assistant' })).toBeEnabled();
  await submit(); expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toMatchObject({ overrides: { workerId, cwd: '/canonical' } });
});
it('can restore one explicit model after discovery fails without clearing the directory', async () => {
  mount(); await flush(); await expand();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/chosen' } }); await flush();
  vi.mocked(readApi.discoverWorkerModels).mockRejectedValueOnce(new readApi.WorkerReadonlyError('timeout', 'Timed out'));
  await choose('Model', 'model-b');
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled();
  await choose('Model', '');
  expect(screen.getByRole('textbox', { name: 'Working directory' })).toHaveValue('/chosen');
  await submit(); expect(vi.mocked(bots.createBot).mock.calls[0]![0]).toMatchObject({ overrides: { workerId, cwd: '/chosen' } });
});

it('checks an authentication pause at dispatch even before the form rerenders', async () => {
  mount(); await flush();
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Helper' } });
  const resume = pauseAuthRequests();
  try { fireEvent.click(screen.getByRole('button', { name: 'Create assistant' })); await flush(); expect(bots.createBot).not.toHaveBeenCalled(); }
  finally { resume(); }
  await flush(); expect(bots.createBot).not.toHaveBeenCalled();
});
