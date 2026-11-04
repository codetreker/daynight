import { describe, expect, it } from 'vitest';
import type { MessagePart, SessionInteraction, TimelineEntry } from '../src/api/types';
import { DEFAULT_SESSION_DISPLAY_MODE, selectSessionDisplayEntries } from '../src/features/task-agent-session/display-mode';
import { legacySubagentActivity } from '../src/features/task-agent-session/legacy-subagent-activity';

const identity = { entryId: 'entry', entrySeq: '1', revision: '1' };
const parts: readonly MessagePart[] = [
  { type: 'text', text: 'Before **image**\n' },
  { type: 'resource', resourceId: 'image', label: 'Image' },
  { type: 'text', text: 'After image' },
  { type: 'resource', resourceId: 'file', label: 'File' },
];
const tool = (name: string): TimelineEntry => ({ ...identity, kind: 'tool_call', callId: 'call', name, input: 'update_plan TodoWrite', output: parts, status: 'failed', truncated: true });
const prefix = 'Unsupported native timeline item: subAgentActivity. ';
const legacy = (message: string, code = 'unsupported_native_item'): Extract<TimelineEntry, { kind: 'error' }> => ({ ...identity, kind: 'error', code, message });
const nativeActivity = { type: 'subAgentActivity', id: 'native', kind: 'started', agentPath: '/root/child', agentThreadId: 'child-thread' };
const activity = legacy(prefix + JSON.stringify(nativeActivity));

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe('Session display selection', () => {
  const entries: readonly TimelineEntry[] = freeze(([
    { ...identity, kind: 'user_message', content: parts },
    { ...identity, kind: 'reasoning', text: '' },
    tool('commandExecution'),
    { ...identity, kind: 'assistant_message', content: parts },
    { ...identity, kind: 'reasoning', text: ' \n\t' },
    { ...identity, kind: 'reasoning', text: 'Thinking' },
    { ...identity, kind: 'todo', items: [{ id: 'todo', text: 'Next', status: 'in_progress' }] },
    { ...identity, kind: 'compaction', summary: 'Compacted' },
    { ...identity, kind: 'interaction', interaction: { interactionId: 'approval', revision: '2', state: 'pending', title: 'Approve', kind: 'approval', detail: 'Details', actions: ['allow_once'] } },
    legacy('Real failure', 'provider_error'),
    activity,
    tool('functions.update_plan'),
    legacy('Cancelled', 'input_cancelled'),
    legacy('Interrupted', 'turn_interrupted'),
  ] satisfies TimelineEntry[]).map((entry, index) => ({ ...entry, entryId: String(index), entrySeq: String(index + 1), revision: '7' })));

  it('keeps Standard order and references while omitting only empty reasoning', () => {
    const result = selectSessionDisplayEntries(entries, 'standard');
    expect(result.map(entry => entry.entryId)).toEqual(['0', '2', '3', '5', '6', '7', '8', '9', '10', '11', '12', '13']);
    result.forEach(entry => expect(entry).toBe(entries[Number(entry.entryId)]));
  });

  it('selects communication, plans, interactions and real errors in the default mode without mutating content', () => {
    const before = JSON.stringify(entries);
    const result = selectSessionDisplayEntries(entries, DEFAULT_SESSION_DISPLAY_MODE);
    expect(result.map(entry => entry.entryId)).toEqual(['0', '3', '6', '8', '9', '11', '12', '13']);
    result.forEach(entry => expect(entry).toBe(entries[Number(entry.entryId)]));
    expect(JSON.stringify(entries)).toBe(before);
    expect(result[0]).toMatchObject({ content: parts, revision: '7' });
    expect(result[1]).toMatchObject({ content: parts, revision: '7' });
    expect(selectSessionDisplayEntries([], 'standard')).toEqual([]);
    expect(selectSessionDisplayEntries([], 'conversation')).toEqual([]);
  });

  it.each(['update_plan', 'TodoWrite', 'todo_write', 'EnterPlanMode', 'ExitPlanMode', 'enter_plan_mode', 'exit_plan_mode', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])('retains the exact plan tool %s with any dot namespace', name => {
    for (const qualified of [name, `functions.${name}`, `provider.tools.${name}`]) {
      const entry = freeze(tool(qualified));
      expect(selectSessionDisplayEntries([entry], 'conversation')).toEqual([entry]);
      expect(selectSessionDisplayEntries([entry], 'conversation')[0]).toBe(entry);
    }
  });

  it.each(['update_plan_extra', 'preupdate_plan', 'Update_plan', 'todowrite', 'Task', 'TaskCreateMore', 'functions.update_plan.', 'functions.update_plan.extra', 'functions/update_plan', 'functions:update_plan', ' update_plan', 'update_plan ', 'run update_plan now', '', 'Start subagent'])('hides ordinary tool %j even when failed or its text mentions a plan', name => {
    const entry = tool(name);
    expect(selectSessionDisplayEntries([entry], 'conversation')).toEqual([]);
    expect(selectSessionDisplayEntries([entry], 'standard')).toEqual([entry]);
  });

  it.each(['pending', 'resolved', 'expired'] as const)('preserves every interaction kind in state %s', state => {
    const common = { interactionId: 'interaction', revision: '2', state, title: 'Interaction' };
    const interactions: SessionInteraction[] = [
      { ...common, kind: 'approval', detail: 'Details', actions: ['reject'] },
      { ...common, kind: 'question', questions: [], canDismiss: true },
      { ...common, kind: 'form', fields: [], canDismiss: true },
    ];
    const values: TimelineEntry[] = freeze(interactions.map(interaction => ({ ...identity, kind: 'interaction', interaction })));
    expect(selectSessionDisplayEntries(values, 'conversation')).toEqual(values);
  });

  it('recomputes visibility from revised entries without changing earlier revisions', () => {
    const original: readonly TimelineEntry[] = freeze([{ ...identity, kind: 'reasoning', text: '' }, tool('shell'), activity]);
    const revised: readonly TimelineEntry[] = freeze([
      { ...identity, kind: 'reasoning', text: 'Now public', revision: '2' },
      { ...tool('TaskUpdate'), revision: '2' },
      { ...legacy('Actual error'), revision: '2' },
    ]);
    expect(selectSessionDisplayEntries(original, 'conversation')).toEqual([]);
    expect(selectSessionDisplayEntries(revised, 'conversation')).toEqual([revised[1], revised[2]]);
    expect(selectSessionDisplayEntries(original, 'standard')).toEqual([original[1], original[2]]);
    expect(selectSessionDisplayEntries(revised, 'standard')).toEqual(revised);
  });
});

describe('shared legacy subagent recognition', () => {
  it.each([
    [nativeActivity, 'Start subagent'],
    [{ ...nativeActivity, kind: 'interacted' }, 'Interact with subagent'],
    [{ ...nativeActivity, kind: 'interrupted' }, 'Interrupt subagent'],
    [{ ...nativeActivity, kind: 'future-kind' }, 'Subagent activity'],
    [{ type: 'subAgentActivity', id: 'minimal' }, 'Subagent activity'],
  ])('recognizes valid native activity %j without inventing state', (native, name) => {
    const entry = freeze(legacy(prefix + JSON.stringify(native)));
    expect(legacySubagentActivity(entry)?.name).toBe(name);
    expect(selectSessionDisplayEntries([entry], 'conversation')).toEqual([]);
    expect(selectSessionDisplayEntries([entry], 'standard')[0]).toBe(entry);
  });

  it.each([
    legacy(prefix + '{broken'),
    ...[null, [], 'text', 1, {}, { id: 'native' }, { ...nativeActivity, type: 'other' }, { type: 'subAgentActivity' }, { ...nativeActivity, id: '' }, { ...nativeActivity, id: 7 }].map(native => legacy(prefix + JSON.stringify(native))),
    legacy('Unsupported native timeline item: other. ' + JSON.stringify(nativeActivity)),
    legacy(prefix.trimEnd() + JSON.stringify(nativeActivity)),
    legacy(prefix + JSON.stringify(nativeActivity), 'provider_error'),
  ])('preserves malformed or unrelated errors: $message ($code)', entry => {
    freeze(entry);
    expect(legacySubagentActivity(entry)).toBeNull();
    expect(selectSessionDisplayEntries([entry], 'conversation')[0]).toBe(entry);
    expect(selectSessionDisplayEntries([entry], 'standard')[0]).toBe(entry);
  });
});
