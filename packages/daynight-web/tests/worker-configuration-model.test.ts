import { describe, expect, it } from 'vitest';
import { configurationDraftsEqual, configurationValuesEqual, draftFromValue, emptyProjectDraft, mergeConfigurationResources, parseConfigurationDraft, resolvedProjectNative } from '../src/features/workers/configuration/model';
import { configurationResource, configurationValue } from './helpers/worker-configuration';
import { workerId } from './helpers/workers';

describe('Worker configuration draft', () => {
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
  it('merges target and observation revisions independently against late reads', () => {
    const current = { ...configurationResource('3'), observationRevision: '1' };
    const incoming = { ...configurationResource('2'), observationRevision: '2' };
    expect(mergeConfigurationResources(current, incoming)).toEqual({ ...incoming, desired: current.desired });
    expect(mergeConfigurationResources(incoming, current)).toEqual({ ...incoming, desired: current.desired });
    expect(mergeConfigurationResources(null, current)).toBe(current);
  });
});
