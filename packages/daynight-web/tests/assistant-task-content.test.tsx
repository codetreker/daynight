import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AssistantTask, AssistantTaskAppendix, AssistantTaskManual as Manual, AssistantTaskProposal, AssistantTaskRecord } from '../src/api/assistant-tasks';
import { listAssistantTaskItems, listAssistantTaskRecords, parseAssistantTaskJson, stringifyAssistantTaskJson } from '../src/api/assistant-tasks';
import { AssistantTaskManual } from '../src/features/bots/AssistantTaskManual';
import { AssistantTaskProposalPanel, type AssistantTaskDecision } from '../src/features/bots/AssistantTaskProposalPanel';
import { AssistantTaskRecords } from '../src/features/bots/AssistantTaskRecords';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_TIME, BOT_USER, botDefinition, botId } from './helpers/bots';

vi.mock(import('../src/api/assistant-tasks'), async importOriginal => ({ ...await importOriginal(), listAssistantTaskItems: vi.fn(), listAssistantTaskRecords: vi.fn() }));
const taskId = botId(30);
const task: AssistantTask = { id: taskId, ownerUserId: BOT_USER, name: 'Coordination', purpose: '', scope: '', application: '', kind: 'once', state: 'active', takeover: 'manual', trigger: null, version: '7', manualVersion: '2', claimGeneration: '0', claimState: 'unowned', holderBotId: null, credentialOperationId: null, claimedAt: null, renewedAt: null, leaseUntil: null, observedAt: BOT_TIME, createdAt: BOT_TIME, updatedAt: BOT_TIME };
const manual: Manual = { taskId, version: '2', body: 'Current **manual**', rules: [], source: 'revision', proposalId: botId(31), createdAt: BOT_TIME };
const initial: Manual = { ...manual, version: '1', body: 'Original manual', source: 'initial', proposalId: null };
const appendix: AssistantTaskAppendix = { id: botId(32), taskId, text: 'Reference note', sourceRecords: [botId(40)], authorBotId: botId(1), state: 'active', version: '1', createdAt: BOT_TIME, updatedAt: BOT_TIME };
const proposal: AssistantTaskProposal = { id: botId(33), taskId, baseVersion: '2', body: 'New manual', rules: [], reason: 'Two observed successes', evidenceRecords: [botId(40)], authorBotId: botId(1), widens: true, status: 'pending', decisionNote: '', createdAt: BOT_TIME, decidedAt: null };
const record = (n: number, itemId: string | null, kind: AssistantTaskRecord['kind']): AssistantTaskRecord => ({ id: botId(n), taskId, itemId, kind, author: 'bot', authorBotId: botId(1), text: `Evidence ${n}`, refs: [], createdAt: BOT_TIME });
beforeEach(() => { vi.mocked(listAssistantTaskItems).mockReset(); vi.mocked(listAssistantTaskRecords).mockReset(); });

it('retains the appendix draft after a refused write and background read while rendering the current note', async () => {
  const edit = vi.fn(async () => false);
  const props = { task, manual, appendices: [appendix], histories: [manual, initial], proposals: [], disabled: false, onAppendixEdit: edit, onAppendixDelete: vi.fn(), onRollback: vi.fn() };
  const view = renderWithLocale(<AssistantTaskManual {...props} />, { locale: 'en' });
  fireEvent.click(screen.getByRole('button', { name: /Notes \/ appendix/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'My retained draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(edit).toHaveBeenCalledWith(appendix, 'My retained draft', '7'));
  view.rerender(<AssistantTaskManual {...props} task={{ ...task, version: '8' }} appendices={[{ ...appendix, text: 'Concurrent note' }]} />);
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('My retained draft');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(edit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText('Concurrent note')).toBeVisible();
});

it('requires a separate delete confirmation and generates a new rollback through the selected historical version', async () => {
  const remove = vi.fn(async () => true), rollback = vi.fn(async () => true);
  renderWithLocale(<AssistantTaskManual task={task} manual={manual} appendices={[appendix]} histories={[manual, initial]} proposals={[{ ...proposal, status: 'rejected', decisionNote: 'Insufficient evidence', decidedAt: BOT_TIME }]} disabled={false} onAppendixEdit={vi.fn()} onAppendixDelete={remove} onRollback={rollback} />, { locale: 'en' });
  fireEvent.click(screen.getByRole('button', { name: /Notes \/ appendix/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('group', { name: 'Delete this appendix note?' })).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(appendix, '7'));
  fireEvent.click(screen.getByRole('button', { name: /Revision history/ }));
  expect(screen.getByText('Insufficient evidence')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Roll back to v2' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Roll back to v1' }));
  expect(rollback).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm rollback' }));
  await waitFor(() => expect(rollback).toHaveBeenCalledWith('1', '7'));
});

it('labels widened actions, retains edits after failure and rejects invalid rule JSON before dispatch', async () => {
  const decide = vi.fn(async () => false), follow = vi.fn();
  const view = renderWithLocale(<AssistantTaskProposalPanel taskVersion="7" proposals={[proposal]} disabled={false} onDecide={decide} onRecords={follow} />, { locale: 'en' });
  expect(screen.getByText('Expands direct actions')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: `Record ${botId(40)}` })); expect(follow).toHaveBeenCalledWith(botId(40));
  fireEvent.click(screen.getByRole('button', { name: 'Edit and approve' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Proposed structured rules' }), { target: { value: '{' } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit and approve' }));
  expect(screen.getByRole('alert')).toHaveTextContent('valid JSON'); expect(decide).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Proposed structured rules' }), { target: { value: '[]' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Proposed manual' }), { target: { value: 'Reviewed manual' } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit and approve' }));
  await waitFor(() => expect(decide).toHaveBeenCalledWith(proposal, { decision: 'edited', body: 'Reviewed manual', rules: [], note: '' }, '7'));
  view.rerender(<AssistantTaskProposalPanel taskVersion="7" proposals={[{ ...proposal }]} disabled={true} onDecide={decide} />);
  expect(screen.getByRole('textbox', { name: 'Proposed manual' })).toHaveValue('Reviewed manual');
  expect(screen.getByRole('button', { name: 'Edit and approve' })).toBeDisabled();
});

it('preserves omitted proposal rules when editing only the body and submits newly supplied rules', async () => {
  const withoutRules = { ...proposal, rules: null };
  const decide = vi.fn(async () => false);
  renderWithLocale(<AssistantTaskProposalPanel taskVersion="7" proposals={[withoutRules]} disabled={false} onDecide={decide} />, { locale: 'en' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit and approve' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Proposed manual' }), { target: { value: 'Reviewed manual' } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit and approve' }));
  await waitFor(() => expect(decide).toHaveBeenCalledWith(withoutRules, { decision: 'edited', body: 'Reviewed manual', note: '' }, '7'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit and approve' })).toBeEnabled());
  fireEvent.change(screen.getByRole('textbox', { name: 'Proposed structured rules' }), { target: { value: '[]' } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit and approve' }));
  await waitFor(() => expect(decide).toHaveBeenLastCalledWith(withoutRules, { decision: 'edited', body: 'Reviewed manual', rules: [], note: '' }, '7'));
});

it('preserves exact rule numbers when approving an edited manual body', async () => {
  const source = '{"limit":9223372036854775807,"ratio":0.12345678901234567890123456789}';
  const preciseProposal = { ...proposal, rules: parseAssistantTaskJson(source) };
  const decide = vi.fn<(proposal: AssistantTaskProposal, decision: AssistantTaskDecision, ifVersion: string) => Promise<boolean>>(async () => true);
  renderWithLocale(<AssistantTaskProposalPanel taskVersion="7" proposals={[preciseProposal]} disabled={false} onDecide={decide} />, { locale: 'en' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit and approve' }));
  const rules = screen.getByRole('textbox', { name: 'Proposed structured rules' });
  expect(rules).toHaveValue('{\n  "limit": 9223372036854775807,\n  "ratio": 0.12345678901234567890123456789\n}');
  fireEvent.change(screen.getByRole('textbox', { name: 'Proposed manual' }), { target: { value: 'Reviewed manual' } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit and approve' }));
  await waitFor(() => expect(decide).toHaveBeenCalledOnce());
  const decision = vi.mocked(decide).mock.calls[0]?.[1];
  expect(stringifyAssistantTaskJson(decision?.rules)).toBe(source);
});

it('requires a rejection reason and prevents duplicate decisions while the original request is pending', async () => {
  let finish!: (value: boolean) => void;
  const decide = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  renderWithLocale(<AssistantTaskProposalPanel taskVersion="7" proposals={[proposal]} disabled={false} onDecide={decide} />, { locale: 'en' });
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason for rejection' }), { target: { value: 'Need stronger evidence' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  expect(decide).toHaveBeenCalledTimes(1);
  expect(decide).toHaveBeenCalledWith(proposal, { decision: 'rejected', note: 'Need stronger evidence' }, '7');
  await act(async () => finish(true));
});

it('loads record pages without losing earlier records, groups by item and distinguishes guesses and unknown results', async () => {
  vi.mocked(listAssistantTaskItems).mockResolvedValue({ items: [{ id: botId(50), taskId, key: 'A stopped session', episode: '1', state: 'open', category: 'stalled', followerBotId: botId(1), appState: {}, version: '1', createdAt: BOT_TIME, updatedAt: BOT_TIME }], nextCursor: null, observedAt: BOT_TIME });
  vi.mocked(listAssistantTaskRecords).mockImplementation(async (_id, query) => query.cursor ? { items: [record(42, botId(50), 'unknown')], nextCursor: null, observedAt: BOT_TIME } : { items: [record(40, botId(50), 'fact'), record(41, botId(50), 'guess')], nextCursor: 'second', observedAt: BOT_TIME });
  renderWithLocale(<AssistantTaskRecords taskId={taskId} enabled bots={[botDefinition(1)]} />, { locale: 'en', taskCache: true });
  await screen.findByText('Evidence 40');
  fireEvent.click(screen.getByRole('button', { name: 'Load more records' }));
  await screen.findByText('Evidence 42');
  expect(screen.getByText('Evidence 40')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'A stopped session' })).toBeVisible();
  fireEvent.change(screen.getByRole('combobox', { name: 'Record type' }), { target: { value: 'unknown' } });
  expect(screen.queryByText('Evidence 40')).toBeNull(); expect(screen.getByText('Evidence 42')).toBeVisible();
  fireEvent.change(screen.getByRole('combobox', { name: 'Record type' }), { target: { value: 'guess' } });
  expect(screen.getByText('Evidence 41')).toBeVisible(); expect(screen.queryByText('Evidence 42')).toBeNull();
});

it('distinguishes empty records from failed reads and resolves an evidence link across pages', async () => {
  vi.mocked(listAssistantTaskItems).mockResolvedValue({ items: [], nextCursor: null, observedAt: BOT_TIME });
  vi.mocked(listAssistantTaskRecords).mockRejectedValueOnce(new Error('offline'));
  const view = renderWithLocale(<AssistantTaskRecords taskId={taskId} enabled />, { locale: 'en', taskCache: true });
  await screen.findByRole('alert'); expect(screen.queryByText('No work records yet')).toBeNull();
  vi.mocked(listAssistantTaskRecords).mockResolvedValueOnce({ items: [], nextCursor: null, observedAt: BOT_TIME });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('No work records yet');
  vi.mocked(listAssistantTaskRecords).mockImplementation(async (_id, query) => query.cursor ? { items: [record(44, null, 'note')], nextCursor: null, observedAt: BOT_TIME } : { items: [record(43, null, 'note')], nextCursor: 'next', observedAt: BOT_TIME });
  view.rerender(<AssistantTaskRecords taskId={taskId} enabled recordId={botId(44)} />);
  const target = await screen.findByText('Evidence 44');
  await waitFor(() => expect(target.closest('li')).toHaveFocus());
});

it('does not replace a proposal edit version when a background read advances the task', async () => {
  const decide = vi.fn(async () => true);
  const view = renderWithLocale(<AssistantTaskProposalPanel taskVersion="7" proposals={[proposal]} disabled={false} onDecide={decide} />, { locale: 'en' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit and approve' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Proposed manual' }), { target: { value: 'Draft based on version 7' } });
  view.rerender(<AssistantTaskProposalPanel taskVersion="8" proposals={[proposal]} disabled={false} onDecide={decide} />);
  expect(screen.getByRole('textbox', { name: 'Proposed manual' })).toHaveValue('Draft based on version 7');
  expect(screen.getByRole('button', { name: 'Edit and approve' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('Your draft is kept');
  expect(decide).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit and approve' }));
  expect(screen.getByRole('textbox', { name: 'Proposed manual' })).toHaveValue(proposal.body);
  fireEvent.click(screen.getByRole('button', { name: 'Edit and approve' }));
  await waitFor(() => expect(decide).toHaveBeenCalledWith(proposal, { decision: 'edited', body: proposal.body, rules: [], note: '' }, '8'));
});

it('keeps delete and rollback confirmations bound to the task version originally reviewed', async () => {
  const remove = vi.fn(async () => false), rollback = vi.fn(async () => false);
  const props = { task, manual, appendices: [appendix], histories: [manual, initial], proposals: [], disabled: false, onAppendixEdit: vi.fn(), onAppendixDelete: remove, onRollback: rollback };
  const view = renderWithLocale(<AssistantTaskManual {...props} />, { locale: 'en' });
  fireEvent.click(screen.getByRole('button', { name: /Notes \/ appendix/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  view.rerender(<AssistantTaskManual {...props} task={{ ...task, version: '8' }} />);
  fireEvent.click(within(screen.getByRole('group', { name: 'Delete this appendix note?' })).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(appendix, '7'));
  fireEvent.click(screen.getByRole('button', { name: /Revision history/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Roll back to v1' }));
  view.rerender(<AssistantTaskManual {...props} task={{ ...task, version: '9' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm rollback' }));
  await waitFor(() => expect(rollback).toHaveBeenCalledWith('1', '8'));
});

it('clears retained filters for a new evidence link while preserving filters during ordinary refreshes', async () => {
  const firstItem = botId(50), secondItem = botId(51);
  const items = [firstItem, secondItem].map((id, index) => ({ id, taskId, key: `Item ${index + 1}`, episode: '1', state: 'open' as const, category: 'stalled', followerBotId: botId(1), appState: {}, version: '1', createdAt: BOT_TIME, updatedAt: BOT_TIME }));
  vi.mocked(listAssistantTaskItems).mockResolvedValue({ items, nextCursor: null, observedAt: BOT_TIME });
  const first = record(40, firstItem, 'fact'), second = { ...record(41, secondItem, 'unknown'), authorBotId: botId(2) };
  vi.mocked(listAssistantTaskRecords).mockImplementation(async (_id, query) => ({ items: query.itemId === firstItem ? [first] : [first, second], nextCursor: null, observedAt: BOT_TIME }));
  const view = renderWithLocale(<AssistantTaskRecords taskId={taskId} enabled bots={[botDefinition(1), botDefinition(2)]} />, { locale: 'en', taskCache: true });
  await screen.findByText('Evidence 40');
  fireEvent.change(screen.getByRole('combobox', { name: 'Item' }), { target: { value: firstItem } });
  await waitFor(() => expect(screen.queryByText('Evidence 41')).toBeNull());
  fireEvent.change(screen.getByRole('combobox', { name: 'Record type' }), { target: { value: 'fact' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Author' }), { target: { value: botId(1) } });
  const before = vi.mocked(listAssistantTaskRecords).mock.calls.length;
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(vi.mocked(listAssistantTaskRecords).mock.calls.length).toBeGreaterThan(before));
  expect(screen.getByRole('combobox', { name: 'Item' })).toHaveValue(firstItem);
  expect(screen.getByRole('combobox', { name: 'Record type' })).toHaveValue('fact');
  view.rerender(<AssistantTaskRecords taskId={taskId} enabled bots={[botDefinition(1), botDefinition(2)]} recordId={second.id} />);
  const target = await screen.findByText('Evidence 41');
  await waitFor(() => expect(target.closest('li')).toHaveFocus());
  for (const name of ['Item', 'Record type', 'Author']) expect(screen.getByRole('combobox', { name })).toHaveValue('');
});
