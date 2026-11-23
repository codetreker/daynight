import { describe, expect, it } from 'vitest';
import { configurationDraftsEqual, configurationFieldChanges, configurationValuesEqual, draftFromValue, emptyProjectDraft, mergeConfigurationResources, parseConfigurationDraft, resolvedProjectNative } from '../src/features/workers/configuration/model';
import { configurationResource, configurationValue } from './helpers/worker-configuration';
import { workerId } from './helpers/workers';

describe('Worker configuration draft', () => {
  it.each([
    ['pollIntervalMs', '999', false], ['pollIntervalMs', '1000', true], ['pollIntervalMs', '60000', true], ['pollIntervalMs', '60001', false], ['pollIntervalMs', '100000', false],
    ['maxConcurrent', '0', false], ['maxConcurrent', '1', true], ['maxConcurrent', '64', true], ['maxConcurrent', '65', false],
    ['recoveryLimit', '-1', false], ['recoveryLimit', '0', true], ['recoveryLimit', '10', true], ['recoveryLimit', '11', false],
  ] as const)('validates %s=%s against its write range', (key, raw, valid) => {
    const draft = { ...draftFromValue(configurationValue()), [key]: raw };
    const parsed = parseConfigurationDraft(draft);
    expect(parsed.errors).toEqual(valid ? {} : { [key]: 'integer' });
    expect(parsed.value?.[key] ?? null).toBe(valid ? Number(raw) : null);
    expect(draft[key]).toBe(raw);
  });
  it.each(['maxConcurrent', 'pollIntervalMs', 'recoveryLimit'] as const)('rejects malformed %s without rewriting it', key => {
    for (const raw of ['', ' ', '1.5', 'abc', '1e3', '9007199254740992']) {
      const draft = { ...draftFromValue(configurationValue()), [key]: raw };
      expect(parseConfigurationDraft(draft)).toEqual({ value: null, errors: { [key]: 'integer' } });
      expect(draft[key]).toBe(raw);
    }
  });
  it('keeps native feedback independent of out-of-range historical numbers', () => {
    const value = { ...configurationValue(), maxConcurrent: 65, pollIntervalMs: 100_000, recoveryLimit: 11, projects: [{ projectId: workerId(3), nativeOverrides: {} }] };
    const draft = draftFromValue(value), parsed = parseConfigurationDraft(draft);
    expect(parsed.errors).toEqual({ maxConcurrent: 'integer', pollIntervalMs: 'integer', recoveryLimit: 'integer' });
    const changes = configurationFieldChanges(draft, value, parsed.errors);
    expect(changes.native).toBe(false); expect(changes.projects.get(workerId(3))).toBe(false);
    expect(draft).toMatchObject({ maxConcurrent: '65', pollIntervalMs: '100000', recoveryLimit: '11' });
  });
  it('includes valid pending tag input and compares normalized filter semantics', () => {
    const value = { ...configurationValue(), taskTagFilter: { names: ['Backend', 'urgent'], match: 'all' as const } };
    const base = draftFromValue(value);
    const equivalent = { ...base, taskTagFilter: { names: ['URGENT', 'backend'], match: 'all' as const, input: ' BACKEND ' } };
    expect(configurationDraftsEqual(base, equivalent)).toBe(true);
    expect(configurationValuesEqual(value, { ...value, taskTagFilter: { names: ['urgent', 'backend'], match: 'all' } })).toBe(true);
    const pending = { ...base, taskTagFilter: { ...base.taskTagFilter!, input: ' a,b ' } };
    expect(parseConfigurationDraft(pending).value?.taskTagFilter).toEqual({ names: ['a,b', 'Backend', 'urgent'], match: 'all' });
    expect(configurationFieldChanges(pending, value, {}).taskTagFilter).toBe(true);
    expect(parseConfigurationDraft({ ...pending, taskTagFilter: { ...pending.taskTagFilter, input: '   ' } }).value?.taskTagFilter).toEqual(value.taskTagFilter);
    expect(parseConfigurationDraft({ ...pending, taskTagFilter: { ...pending.taskTagFilter, input: 'a\nb' } }).errors.taskTagFilter).toBe('tagName');
    expect(parseConfigurationDraft({ ...pending, taskTagFilter: { names: [], match: 'all', input: '' } }).value?.taskTagFilter).toEqual({ names: [], match: 'any' });
  });
  it('round-trips explicit clears, inherited fields and arbitrary arguments', () => {
    const value = { ...configurationValue(), native: { agent: 'codex' as const, model: '模型', args: ['--model', 'quotes" \\ backslash', '日本語'] }, projects: [
      { projectId: workerId(3), nativeOverrides: {} },
      { projectId: workerId(4), nativeOverrides: { model: null, args: [] } },
      { projectId: workerId(5), nativeOverrides: { agent: 'claude' as const, args: ['--verbose'] } },
    ] };
    const draft = draftFromValue(value), parsed = parseConfigurationDraft(draft);
    expect(parsed.errors).toEqual({}); expect(parsed.value).toEqual(value);
    expect(draft.projects[0]!.native).toMatchObject({ agent: 'inherit', modelMode: 'inherit', argsMode: 'inherit' });
    expect(draft.projects[1]!.native).toMatchObject({ modelMode: 'default', argsMode: 'clear' });
    expect(emptyProjectDraft(workerId(8)).native).toMatchObject({ agent: 'inherit', modelMode: 'inherit', argsMode: 'inherit' });
  });
  it('keeps invalid raw numeric/model/argument input and identifies exact fields', () => {
    const source = draftFromValue(configurationValue());
    const draft = { ...source, maxConcurrent: '2e3', pollIntervalMs: '2147483648', recoveryLimit: '-1', native: { ...source.native, model: ' ', args: '["valid", ""]' }, projects: [{ ...emptyProjectDraft(workerId(3)), native: { ...emptyProjectDraft(workerId(3)).native, modelMode: 'custom' as const, model: '', argsMode: 'custom' as const, args: 'not JSON' } }] };
    expect(parseConfigurationDraft(draft)).toEqual({ value: null, errors: { maxConcurrent: 'integer', pollIntervalMs: 'integer', recoveryLimit: 'integer', 'native.model': 'model', 'native.args': 'args', [`projects.${workerId(3)}.model`]: 'model', [`projects.${workerId(3)}.args`]: 'args' } });
    expect(draft.native.args).toBe('["valid", ""]'); expect(configurationDraftsEqual(source, { ...source, maxConcurrent: '02' })).toBe(false);
  });
  it('uses tool defaults for cross-agent missing overrides and global values for same agent', () => {
    const global = { agent: 'codex' as const, model: 'model', args: ['--global'] };
    expect(resolvedProjectNative(global, {})).toEqual(global);
    expect(resolvedProjectNative(global, { agent: 'codex' })).toEqual(global);
    expect(resolvedProjectNative(global, { agent: 'claude' })).toEqual({ agent: 'claude', model: null, args: [] });
    expect(resolvedProjectNative(global, { model: null, args: [] })).toEqual({ agent: 'codex', model: null, args: [] });
    expect(resolvedProjectNative(global, { agent: 'claude', model: 'other', args: ['--project'] })).toEqual({ agent: 'claude', model: 'other', args: ['--project'] });
  });
  it('compares canonical values while preserving missing override fields', () => {
    const first = { ...configurationValue(), projects: [{ projectId: workerId(9), nativeOverrides: { model: 'm', args: ['a'] } }, { projectId: workerId(3), nativeOverrides: {} }] };
    const reversed = { ...first, projects: [{ projectId: workerId(3), nativeOverrides: {} }, { projectId: workerId(9), nativeOverrides: { args: ['a'], model: 'm' } }] };
    expect(configurationValuesEqual(first, reversed)).toBe(true);
    expect(configurationValuesEqual(configurationValue(), { ...configurationValue(), projects: [{ projectId: workerId(3), nativeOverrides: { args: [] } }] })).toBe(false);
  });
  it('compares each valid field independently and preserves override intent', () => {
    const value = { ...configurationValue(), projects: [{ projectId: workerId(3), nativeOverrides: { args: [] } }, { projectId: workerId(4), nativeOverrides: {} }] };
    const base = draftFromValue(value), project = base.projects[0]!;
    const draft = { ...base, maxConcurrent: '002', recoveryLimit: '-', native: { ...base.native, args: '[ \n ]' }, projects: [
      { ...project, native: { ...project.native, argsMode: 'custom' as const, args: '[ ]' } },
      { ...base.projects[1]!, native: { ...base.projects[1]!.native, argsMode: 'clear' as const } },
    ] };
    const changes = configurationFieldChanges(draft, value, parseConfigurationDraft(draft).errors);
    expect(changes).toMatchObject({ maxConcurrent: false, pollIntervalMs: false, recoveryLimit: true, native: false });
    expect(changes.projects.get(workerId(3))).toBe(false); expect(changes.projects.get(workerId(4))).toBe(true);
    const invalid = { ...draft, native: { ...draft.native, args: '[bad' }, projects: [{ ...project, native: { ...project.native, argsMode: 'custom' as const, args: '[bad' } }] };
    const invalidChanges = configurationFieldChanges(invalid, value, parseConfigurationDraft(invalid).errors);
    expect(invalidChanges.native).toBe(true); expect(invalidChanges.projects.get(workerId(3))).toBe(true);
  });
  it('merges target and observation revisions independently against late reads', () => {
    const current = { ...configurationResource('3'), observationRevision: '1' };
    const incoming = { ...configurationResource('2'), observationRevision: '2' };
    expect(mergeConfigurationResources(current, incoming)).toEqual({ ...incoming, desired: current.desired });
    expect(mergeConfigurationResources(incoming, current)).toEqual({ ...incoming, desired: current.desired });
    expect(mergeConfigurationResources(null, current)).toBe(current);
  });
});


describe('legacy control mode in draft state', () => {
  it('does not make the unsupported mode editable or include it in a candidate', () => {
    const value = { ...configurationValue(), agentControlMode: 'herdr' as const };
    const draft = draftFromValue(value);
    expect(draft.agentControlMode).toBeUndefined();
    const candidate = parseConfigurationDraft(draft).value!;
    expect(candidate).not.toHaveProperty('agentControlMode');
    expect(candidate.toolPaths).toEqual({ codex: null, copilot: null });
    expect(candidate.native).toEqual(value.native);
  });
});
