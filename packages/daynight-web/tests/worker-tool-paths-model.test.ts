import { describe, expect, it } from 'vitest';
import type { WorkerCloudToolPaths } from '../src/api/worker-tool-paths';
import { configurationDraftsEqual, configurationFieldChanges, configurationValuesEqual, draftFromValue, mergeConfigurationResources, parseConfigurationDraft } from '../src/features/workers/configuration/model';
import { configurationResource, configurationValue } from './helpers/worker-configuration';

const choices: WorkerCloudToolPaths = { codex: { kind: 'path', path: '/opt/工具 installation/codex ' }, copilot: { kind: 'auto' }, herdr: null };
const value = () => ({ ...configurationValue(), toolPaths: choices });

describe('Worker tool path drafts', () => {
  it('preserves unadopted, automatic and explicit choices without rewriting path bytes', () => {
    const draft = draftFromValue(value());
    expect(draft.toolPaths).toEqual(choices);
    expect(parseConfigurationDraft(draft).value).toEqual(value());
    expect(draftFromValue(configurationValue()).toolPaths).toBeUndefined();
  });

  it.each(['', ' ', '~/codex', './codex', '$TOOLS/codex', '/opt/codex\n', '/opt/\ud800', `/${'界'.repeat(1366)}`])('retains invalid raw input and rejects saving %j', path => {
    const draft = { ...draftFromValue(value()), toolPaths: { ...choices, codex: { kind: 'path' as const, path } } };
    const parsed = parseConfigurationDraft(draft);
    expect(parsed.value).toBeNull();
    expect(parsed.errors).toEqual({ 'toolPaths.codex': 'toolPath' });
    expect(draft.toolPaths.codex).toEqual({ kind: 'path', path });
  });

  it('checks remote platform syntax and preserves an explicit reset as distinct from an empty path', () => {
    const windows = { ...draftFromValue(value()), toolPaths: { ...choices, codex: { kind: 'path' as const, path: String.raw`C:\Tools\Codex.exe` } } };
    expect(parseConfigurationDraft(windows, false, { platform: 'windows' }).value?.toolPaths?.codex).toEqual(windows.toolPaths.codex);
    expect(parseConfigurationDraft(windows, false, { platform: 'linux' }).errors).toHaveProperty('toolPaths.codex', 'toolPath');
    const reset = { ...windows, toolPaths: { ...choices, codex: { kind: 'auto' as const } } };
    expect(parseConfigurationDraft(reset, false, { platform: 'linux' }).value?.toolPaths).toEqual({ codex: { kind: 'auto' }, copilot: { kind: 'auto' }, herdr: null });
  });

  it('excludes unavailable tool edits from a legacy submission without changing the retained draft', () => {
    const draft = { ...draftFromValue(value()), toolPaths: { ...choices, codex: { kind: 'path' as const, path: '' } } };
    expect(parseConfigurationDraft(draft, false, { toolPathsSupported: false })).toEqual({ value: configurationValue(), errors: {} });
    expect(draft.toolPaths.codex.path).toBe('');
  });

  it('compares tool edits independently from unrelated invalid native fields', () => {
    const baseline = draftFromValue(value());
    const draft = { ...baseline, native: { ...baseline.native, args: '[invalid' }, toolPaths: { ...choices, herdr: { kind: 'auto' as const } } };
    const changed = configurationFieldChanges(draft, value(), parseConfigurationDraft(draft).errors);
    expect(changed.toolPaths).toEqual({ codex: false, copilot: false, herdr: true });
    expect(changed.native).toBe(true);
    expect(configurationDraftsEqual(baseline, draft)).toBe(false);
    const changedTools = { ...value(), toolPaths: { ...choices, herdr: { kind: 'auto' as const } } };
    expect(configurationValuesEqual(value(), changedTools)).toBe(false);
    expect(configurationValuesEqual(value(), changedTools, true, false)).toBe(true);
    expect(configurationDraftsEqual(baseline, draftFromValue(changedTools), true, false)).toBe(true);
  });

  it('retains the highest desired revision while tracking current tool capability separately', () => {
    const current = { ...configurationResource('3', value()), toolPathsSupported: true };
    const incoming = { ...configurationResource('2', value()), toolPathsSupported: true, observationRevision: '2' };
    const merged = mergeConfigurationResources(current, incoming);
    expect(merged.toolPathsSupported).toBe(true);
    expect(merged.desired?.revision).toBe('3');
    const downgraded = mergeConfigurationResources(merged, configurationResource('2'));
    expect(downgraded.toolPathsSupported).not.toBe(true);
    expect(downgraded.desired?.value.toolPaths).toEqual(choices);
  });
});
