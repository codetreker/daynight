import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import type { WorkerAlias } from '../src/api/worker-alias';
import { WorkerAliasEditor } from '../src/features/workers/WorkerAliasEditor';
import { renderWithLocale } from './helpers/renderWithLocale';
import { WORKER_USER, workerId, workerResponse } from './helpers/workers';

const initial = { value: null, version: '1' } satisfies WorkerAlias;
const receipt = (alias: WorkerAlias) => workerResponse({ workerId: workerId(1), alias });
const rejection = (status: number, code: string) => workerResponse({ error: { code, message: 'Rejected', requestId: 'alias-test' } }, WORKER_USER, status);
const Host = ({ enabled = true, worker = workerId(1), incoming = initial }: { readonly enabled?: boolean; readonly worker?: string; readonly incoming?: WorkerAlias }) => {
  const [resource, setResource] = useState<WorkerAlias | null>(null);
  return <WorkerAliasEditor key={worker} workerId={worker} resource={resource ?? incoming} readEnabled={enabled} onSaved={setResource} header={trigger => <header><h1>Worker</h1>{trigger}</header>} />;
};
const render = (ui = <Host />) => renderWithLocale(ui, { locale: 'en', taskCache: { viewerId: WORKER_USER } });
const open = () => fireEvent.click(screen.getByRole('button', { name: /Set alias|Edit alias/ }));
const type = (text: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Worker alias' }), { target: { value: text } });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('Worker alias editing', () => {
  it('sets, modifies and explicitly clears aliases, restoring focus without replacing the editor', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(receipt({ value: '办公室 Windows', version: '2' }))
      .mockResolvedValueOnce(receipt({ value: '家里 Mac mini', version: '3' })).mockResolvedValueOnce(receipt({ value: null, version: '4' }));
    vi.stubGlobal('fetch', fetch); render();
    const opener = screen.getByRole('button', { name: 'Set alias' }); open();
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Save alias' })).toBeDisabled();
    type('  办公室 Windows  '); fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
    await screen.findByRole('button', { name: 'Edit alias' }); expect(opener).toHaveFocus();
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ value: '办公室 Windows', expectedVersion: '1' });
    open(); type('家里 Mac mini'); fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
    await screen.findByRole('button', { name: 'Edit alias' });
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ value: '家里 Mac mini', expectedVersion: '2' });
    open(); type(''); fireEvent.click(screen.getByRole('button', { name: 'Clear alias' }));
    await screen.findByRole('button', { name: 'Set alias' });
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({ value: null, expectedVersion: '3' });
  });
  it('cancels without network, preserves IME composition, and renders unsafe-looking text literally', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); render();
    open(); type('<img src=x onerror=alert(1)>');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape', isComposing: true });
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.getByRole('button', { name: 'Set alias' })).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains the draft on rejection and across background data, language and admission changes', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(rejection(400, 'invalid_input')); vi.stubGlobal('fetch', fetch);
    const view = render(); open(); type('my draft'); fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
    await screen.findByRole('alert'); expect(screen.getByRole('textbox')).toHaveValue('my draft');
    view.rerender(<Host enabled={false} incoming={{ value: 'remote', version: '5' }} />);
    expect(screen.getByRole('textbox')).toHaveValue('my draft'); expect(screen.getByRole('textbox')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save alias' })).toBeDisabled();
    view.setLocale('zh-CN'); expect(screen.getByRole('textbox', { name: 'Worker 别名' })).toHaveValue('my draft');
  });
  it('requires explicit conflict reconciliation without overwriting the input or silently adopting poll versions', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(rejection(409, 'version_conflict'))
      .mockResolvedValueOnce(receipt({ value: 'remote', version: '3' })).mockResolvedValueOnce(receipt({ value: 'my draft', version: '4' }));
    vi.stubGlobal('fetch', fetch);
    const view = render(); open(); type('my draft');
    view.rerender(<Host incoming={{ value: 'remote', version: '3' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
    await screen.findByRole('alert');
    expect(JSON.parse(fetch.mock.calls[0]![1].body).expectedVersion).toBe('1');
    expect(screen.getByRole('button', { name: 'Save alias' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check saved alias' }));
    await screen.findByRole('status'); expect(screen.getByRole('textbox')).toHaveValue('my draft');
    fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
    await screen.findByRole('button', { name: 'Edit alias' });
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({ value: 'my draft', expectedVersion: '3' });
  });
  it('never retries an uncertain write, including after failed checks and closing/reopening', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce(receipt({ value: 'my draft', version: '2' }));
    vi.stubGlobal('fetch', fetch); render(); open(); type('my draft');
    fireEvent.click(screen.getByRole('button', { name: 'Save alias' })); await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Check saved alias' })); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check saved alias' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: 'Save alias' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); open();
    expect(screen.getByRole('button', { name: 'Save alias' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check saved alias' })); await screen.findByRole('status');
    expect(fetch.mock.calls.map(call => call[1].method)).toEqual(['PUT', 'GET', 'GET']);
  });
  it('prevents duplicates, pending cancellation and publication into a different Worker', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal('fetch', fetch);
    const view = render(); open(); type('original'); fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('textbox').closest('form')!); expect(fetch).toHaveBeenCalledOnce();
    view.rerender(<Host worker={workerId(2)} />);
    await act(async () => resolve(receipt({ value: 'original', version: '2' })));
    expect(screen.getByRole('button', { name: 'Set alias' })).toBeInTheDocument();
  });
  it('rechecks admission after waiting for authentication before dispatching', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const view = render(); open(); type('blocked');
    const resume = pauseAuthRequests();
    fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
    view.rerender(<Host enabled={false} />);
    await act(async () => { resume(); });
    expect(fetch).not.toHaveBeenCalled(); expect(screen.getByRole('textbox')).toHaveValue('blocked');
  });
  it('retains the editor while a dispatched receipt waits for readmission', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const view = render(); open(); type('preserved');
    fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
    await waitFor(() => expect(resolve).toBeDefined());
    view.rerender(<Host enabled={false} />);
    await act(async () => resolve(receipt({ value: 'preserved', version: '2' })));
    expect(screen.getByRole('textbox')).toHaveValue('preserved');
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    view.rerender(<Host />);
    await screen.findByRole('button', { name: 'Edit alias' });
  });
});
