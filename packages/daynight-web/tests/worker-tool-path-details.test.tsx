import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkerToolPathDetails } from '../src/features/workers/WorkerToolPathDetails';
import { renderWithLocale } from './helpers/renderWithLocale';
import { automaticToolPaths, toolPathActual, toolPathConfiguration, toolPathObservation, toolPathTelemetry } from './helpers/worker-tool-paths';

describe('Worker tool path details', () => {
  it('separates current admission, candidate and running selections with their own paths and versions', () => {
    const old = toolPathActual('herdr', { version: 'old-version' }), choice = { kind: 'path' as const, path: '/new/herdr' };
    const candidate = toolPathActual('herdr', { selection: choice, entryPath: choice.path, executablePath: '/real/new/herdr', source: 'explicit', selectionKey: 'b'.repeat(64), version: 'new-version' });
    const observation = toolPathObservation('herdr', 'herdr', { target: choice, state: 'pending', reason: 'active_instance', actual: old, candidate, activeSelectionCount: 1, activeSelections: [{ actual: old, executionCount: 2, instanceCount: 1, unconfirmedCount: 0 }] });
    const { container } = renderWithLocale(<WorkerToolPathDetails tool="herdr" telemetry={toolPathTelemetry([observation])} desired={toolPathConfiguration('1', { ...automaticToolPaths(), herdr: choice }).desired} online />, { locale: 'en' });
    const actual = container.querySelector('[data-selection-role="actual"]')!, pending = container.querySelector('[data-selection-role="candidate"]')!, active = container.querySelector('[data-selection-role="active"]')!;
    expect(within(actual as HTMLElement).getByText('old-version')).toBeInTheDocument();
    expect(within(pending as HTMLElement).getByText('new-version')).toBeInTheDocument();
    expect(within(active as HTMLElement).getByText('old-version')).toBeInTheDocument();
    expect(screen.getByText('Waiting for running executions to release the shared Herdr instance.')).toBeInTheDocument();
    expect(screen.queryByText('Applied')).toBeNull();
  });

  it('keeps new application success separate from an incomplete historical inventory', () => {
    const entry = toolPathObservation('herdr', 'herdr', { activeSelectionsComplete: false, activeSelectionCount: null, activeObservationError: 'legacy_tool_identity_missing' });
    renderWithLocale(<WorkerToolPathDetails tool="herdr" telemetry={toolPathTelemetry([entry])} desired={toolPathConfiguration().desired} online />, { locale: 'en' });
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.getByText('Some running selections are not shown.')).toBeInTheDocument();
    expect(screen.getByText('Older executions did not record their tool identity.')).toBeInTheDocument();
    expect(screen.queryByText('Application failed')).toBeNull();
  });

  it('copies the complete actual path and preserves expanded content across report refreshes', async () => {
    const path = `/Users/example/${'installation/'.repeat(40)}codex`, writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const entry = toolPathObservation('herdr', 'herdr', { actual: toolPathActual('herdr', { entryPath: path }) });
    const props = { tool: 'herdr' as const, telemetry: toolPathTelemetry([entry]), desired: toolPathConfiguration().desired, online: true };
    const view = renderWithLocale(<WorkerToolPathDetails {...props} />, { locale: 'en' });
    const summary = screen.getByText('Entry path', { selector: 'summary' }); fireEvent.click(summary);
    const pathDetails = summary.closest('details')!; pathDetails.open = true;
    const button = within(pathDetails).getByRole('button', { name: 'Copy entry path' }); button.focus(); fireEvent.click(button);
    expect(await screen.findByText('Copied')).toBeInTheDocument(); expect(writeText).toHaveBeenCalledWith(path);
    view.rerender(<WorkerToolPathDetails {...props} telemetry={{ ...props.telemetry, entries: [{ ...entry }] }} />);
    expect(summary.closest('details')).toBe(pathDetails); expect(pathDetails.open).toBe(true); expect(button).toHaveFocus();
  });

  it('reports clipboard failure and never invents actual values for a missing context', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const entry = toolPathObservation('herdr', 'herdr');
    const view = renderWithLocale(<WorkerToolPathDetails tool="herdr" telemetry={toolPathTelemetry([entry])} desired={toolPathConfiguration().desired} online />, { locale: 'en' });
    const summary = screen.getByText('Entry path', { selector: 'summary' }); summary.closest('details')!.open = true;
    fireEvent.click(screen.getByRole('button', { name: 'Copy entry path' }));
    expect(await screen.findByText('Copy failed. Select and copy the full path.')).toBeInTheDocument();
    view.rerender(<WorkerToolPathDetails tool="herdr" telemetry={toolPathTelemetry([])} desired={toolPathConfiguration().desired} online />);
    expect(screen.getByText('Not checked')).toBeInTheDocument(); expect(screen.queryByText('1.2.3')).toBeNull();
  });

  it('keeps Web and Herdr sources separate and retains the expanded other mode across locale changes', () => {
    const web = toolPathObservation('copilot', 'web', { actual: toolPathActual('copilot', { source: 'bundled', version: 'bundled-version' }) });
    const herdr = toolPathObservation('copilot', 'herdr', { actual: toolPathActual('copilot', { version: 'path-version' }) });
    const { container, setLocale } = renderWithLocale(<WorkerToolPathDetails tool="copilot" telemetry={toolPathTelemetry([web, herdr])} desired={toolPathConfiguration().desired} online />, { locale: 'en' });
    const webSection = container.querySelector('[data-context="web"]')!, herdrSection = container.querySelector('[data-context="herdr"]')!;
    expect(within(webSection as HTMLElement).getByText('Bundled runtime')).toBeInTheDocument();
    expect(within(webSection as HTMLElement).queryByText('path-version')).toBeNull();
    expect(within(herdrSection as HTMLElement).getByText('path-version')).toBeInTheDocument();
    const details = container.querySelector<HTMLDetailsElement>('.worker-tool-other-context')!;
    details.open = true; const summary = details.querySelector('summary')!; summary.focus();
    setLocale('zh-CN');
    expect(container.querySelector('.worker-tool-other-context')).toBe(details); expect(details.open).toBe(true); expect(summary).toHaveFocus();
    expect(screen.getByText('内置运行时')).toBeInTheDocument();
  });

  it('shows parallel Herdr versions and unknown stop responsibility without replacing the new selection', () => {
    const current = toolPathActual('herdr', { version: 'current' }), previous = toolPathActual('herdr', { selectionKey: 'b'.repeat(64), entryPath: '/old/herdr', version: 'previous' });
    const entry = toolPathObservation('herdr', 'herdr', { actual: current, activeSelectionCount: 2, activeSelections: [
      { actual: current, executionCount: 1, instanceCount: 1, unconfirmedCount: 0 },
      { actual: previous, executionCount: null, instanceCount: 1, unconfirmedCount: 1 },
    ] });
    const { container } = renderWithLocale(<WorkerToolPathDetails tool="herdr" telemetry={toolPathTelemetry([entry])} desired={toolPathConfiguration().desired} online />, { locale: 'en' });
    const currentSelection = container.querySelector('[data-selection-role="actual"]')!;
    expect(within(currentSelection as HTMLElement).getByText('current')).toBeInTheDocument();
    expect(within(currentSelection as HTMLElement).queryByText('previous')).toBeNull();
    expect(container.querySelectorAll('[data-selection-role="active"]')).toHaveLength(2);
    expect(screen.getByText('Executions: Unknown')).toBeInTheDocument(); expect(screen.getByText('Stop unconfirmed: 1')).toBeInTheDocument();
  });

  it('keeps reported errors and checked times visible offline while withholding current application', () => {
    const entry = toolPathObservation('herdr', 'herdr', { state: 'error', error: { code: 'permission_denied', occurredAt: '2026-10-25T10:00:00Z' } });
    const view = renderWithLocale(<WorkerToolPathDetails tool="herdr" telemetry={toolPathTelemetry([entry])} desired={toolPathConfiguration().desired} online={false} />, { locale: 'en' });
    expect(screen.getByText('Recorded before going offline')).toBeInTheDocument();
    expect(screen.getByText(/Permission to access or execute the tool was denied./)).toBeInTheDocument();
    expect(screen.queryByText('Applied')).toBeNull();
    view.rerender(<WorkerToolPathDetails tool="herdr" online />);
    expect(screen.getByText('This Worker has not reported tool path support. Upgrade it or wait for a supported report.')).toBeInTheDocument();
    expect(screen.queryByText('1.2.3')).toBeNull();
  });
});
