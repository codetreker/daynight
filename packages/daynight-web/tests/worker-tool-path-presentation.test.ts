import { describe, expect, it } from 'vitest';
import { toolPathApplicationState, toolPathSummaryStates, toolSoftwareEntries } from '../src/features/workers/tool-path-presentation';
import { automaticToolPaths, toolPathActual, toolPathConfiguration, toolPathObservation, toolPathTelemetry } from './helpers/worker-tool-paths';

describe('tool path application evidence', () => {
  it('requires the current cloud revision, target and actual choice before confirming application', () => {
    const desired = toolPathConfiguration().desired;
    const entry = toolPathObservation();
    expect(toolPathApplicationState(entry, desired, true)).toBe('applied');
    expect(toolPathApplicationState({ ...entry, targetRevision: '2' }, desired, true)).toBe('pending');
    expect(toolPathApplicationState({ ...entry, configurationSource: 'local', targetRevision: null }, desired, true)).toBe('pending');
    expect(toolPathApplicationState({ ...entry, actual: toolPathActual('codex', { selection: { kind: 'path', path: '/old/codex' } }) }, desired, true)).toBe('pending');
    expect(toolPathApplicationState(entry, toolPathConfiguration('1', { ...automaticToolPaths(), codex: null }).desired, true)).toBe('not_checked');
    expect(toolPathApplicationState(entry, toolPathConfiguration('1', { ...automaticToolPaths(), codex: { kind: 'path', path: '/new/codex' } }).desired, true)).toBe('pending');
    expect(toolPathApplicationState({ ...entry, actual: null }, desired, true)).toBe('pending');
  });

  it('does not present offline, stale, unavailable or unchecked observations as current application', () => {
    const desired = toolPathConfiguration().desired, entry = toolPathObservation();
    expect(toolPathApplicationState(entry, desired, false)).toBe('offline');
    expect(toolPathApplicationState(entry, desired, null)).toBe('unconfirmed');
    expect(toolPathApplicationState(entry, undefined, true)).toBe('unconfirmed');
    expect(toolPathApplicationState(undefined, desired, true)).toBe('not_checked');
    expect(toolPathApplicationState({ ...entry, state: 'checking' }, desired, true)).toBe('checking');
  });

  it('requires only selected providers in the target mode without rewriting unrelated failures', () => {
    const resource = toolPathConfiguration();
    const failing = toolPathObservation('copilot', 'web', { state: 'error', error: { code: 'not_found', occurredAt: '2026-10-25T10:00:00Z' } });
    expect(toolPathSummaryStates(resource, toolPathTelemetry(), true)).toEqual(['applied']);
    expect(toolPathSummaryStates(resource, toolPathTelemetry([toolPathObservation()]), true)).toEqual(['applied']);
    expect(toolPathSummaryStates(resource, toolPathTelemetry([toolPathObservation(), failing, toolPathObservation('herdr')]), true)).not.toContain('error');
    expect(toolPathSummaryStates({ ...resource, desired: { ...resource.desired!, value: { ...resource.desired!.value, native: { agent: 'copilot', model: null, args: [] } } } }, toolPathTelemetry([failing]), true)).toContain('error');
    expect(toolPathSummaryStates(resource, undefined, true)).toEqual(['not_checked']);
    expect(toolPathSummaryStates({ ...resource, desired: { ...resource.desired!, value: { ...resource.desired!.value, agentControlMode: 'herdr' } } }, toolPathTelemetry(), true)).toEqual(['not_checked', 'applied']);
    expect(toolPathApplicationState(failing, resource.desired, true)).toBe('error');
  });

  it('resolves all project overrides, deduplicates inherited providers and keeps Claude native-only', () => {
    const resource = toolPathConfiguration();
    const value = resource.desired!.value;
    const withValue = (changes: Partial<typeof value>) => ({ ...resource, desired: { ...resource.desired!, value: { ...value, ...changes } } });
    const projects = [{ projectId: 'a', nativeOverrides: {} }, { projectId: 'b', nativeOverrides: { agent: 'copilot' as const } }, { projectId: 'c', nativeOverrides: { agent: 'claude' as const } }];
    expect(toolPathSummaryStates(withValue({ projects }), toolPathTelemetry([toolPathObservation()]), true)).toEqual(['applied', 'not_checked']);
    expect(toolPathSummaryStates(withValue({ native: { ...value.native, agent: 'claude' } }), undefined, true)).toEqual([]);
    expect(toolPathSummaryStates(withValue({ native: { ...value.native, agent: 'claude' }, agentControlMode: 'herdr' }), toolPathTelemetry(), true)).toEqual(['applied']);
    expect(toolPathSummaryStates(withValue({ agentControlMode: null }), toolPathTelemetry(), true)).toEqual(['unconfirmed']);
  });

  it.each(['not_checked', 'checking', 'error', 'applied'] as const)('excludes explicit Herdr targets and old running contexts in Web when Herdr is %s', state => {
    const resource = toolPathConfiguration('1', { ...automaticToolPaths(), herdr: { kind: 'path', path: '/custom/herdr' } });
    const old = toolPathObservation('codex', 'herdr', { state: 'error', activeSelectionCount: 1, activeSelections: [{ actual: toolPathActual(), executionCount: 1, instanceCount: 0, unconfirmedCount: 0 }] });
    const herdr = toolPathObservation('herdr', 'herdr', { state, targetRevision: '99' });
    expect(toolPathSummaryStates(resource, toolPathTelemetry([toolPathObservation(), old, herdr]), true)).toEqual(['applied']);
    expect(toolSoftwareEntries(toolPathTelemetry([old]), 'codex')).toEqual([old]);
  });

  it('preserves missing, stale, mismatched and offline evidence for required tools', () => {
    const resource = toolPathConfiguration();
    expect(toolPathSummaryStates(resource, toolPathTelemetry([]), true)).toEqual(['not_checked']);
    expect(toolPathSummaryStates(resource, toolPathTelemetry(), false)).toEqual(['offline']);
    expect(toolPathSummaryStates(resource, toolPathTelemetry(), null)).toEqual(['unconfirmed']);
    expect(toolPathSummaryStates(resource, toolPathTelemetry([toolPathObservation('codex', 'web', { targetRevision: '2' })]), true)).toEqual(['pending']);
    expect(toolPathSummaryStates(toolPathConfiguration('1', { ...automaticToolPaths(), codex: { kind: 'path', path: '/new/codex' } }), toolPathTelemetry(), true)).toEqual(['pending']);
  });
});

describe('software summary entries', () => {
  it('omits only a completely empty unchecked context and preserves order and tool identity', () => {
    const empty = toolPathObservation('codex', 'herdr', { state: 'not_checked', actual: null });
    const actual = toolPathActual();
    const informative = [
      { ...empty, state: 'checking' as const }, { ...empty, actual }, { ...empty, candidate: actual },
      { ...empty, reason: 'active_instance' as const }, { ...empty, error: { code: 'not_found' as const, occurredAt: actual.checkedAt } },
      { ...empty, activeSelectionCount: 1 }, { ...empty, activeSelectionCount: null }, { ...empty, activeSelectionsComplete: false },
      { ...empty, activeObservationError: 'inventory_unavailable' as const },
      { ...empty, activeSelections: [{ actual, executionCount: 1, instanceCount: 0, unconfirmedCount: 0 }] },
    ];
    const web = toolPathObservation();
    expect(toolSoftwareEntries(toolPathTelemetry([empty, web, toolPathObservation('copilot')]), 'codex')).toEqual([web]);
    for (const entry of informative) expect(toolSoftwareEntries(toolPathTelemetry([entry]), 'codex')).toEqual([entry]);
    expect(toolSoftwareEntries(toolPathTelemetry([empty]), 'codex')).toEqual([]);
    expect(toolSoftwareEntries(toolPathTelemetry([]), 'herdr')).toEqual([]);
  });
});
