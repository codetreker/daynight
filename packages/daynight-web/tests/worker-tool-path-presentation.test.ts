import { describe, expect, it } from 'vitest';
import { toolPathApplicationState, toolPathSummaryStates } from '../src/features/workers/tool-path-presentation';
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

  it('includes missing contexts in the configuration summary without promoting unused auto failures to Worker failure', () => {
    const resource = toolPathConfiguration();
    const failing = toolPathObservation('copilot', 'web', { state: 'error', error: { code: 'not_found', occurredAt: '2026-10-25T10:00:00Z' } });
    expect(toolPathSummaryStates(resource, toolPathTelemetry(), true)).toEqual(['applied', 'applied', 'applied']);
    expect(toolPathSummaryStates(resource, toolPathTelemetry([toolPathObservation()]), true)).toEqual(['applied', 'not_checked', 'not_checked']);
    expect(toolPathSummaryStates(resource, toolPathTelemetry([toolPathObservation(), failing, toolPathObservation('herdr')]), true)).not.toContain('error');
    expect(toolPathSummaryStates({ ...resource, desired: { ...resource.desired!, value: { ...resource.desired!.value, native: { agent: 'copilot', model: null, args: [] } } } }, toolPathTelemetry([failing]), true)).toContain('error');
    expect(toolPathSummaryStates(resource, undefined, true)).toEqual(['not_checked']);
    expect(toolPathSummaryStates({ ...resource, desired: { ...resource.desired!, value: { ...resource.desired!.value, agentControlMode: 'herdr' } } }, toolPathTelemetry(), true)).toEqual(['applied', 'not_checked', 'applied', 'not_checked', 'applied']);
  });
});
