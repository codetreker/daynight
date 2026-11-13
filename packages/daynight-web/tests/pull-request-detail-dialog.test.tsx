import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PullRequestDetailDialog, type PullRequestDetailDialogProps } from '../src/features/pull-request-detail/PullRequestDetailDialog';
import { renderWithLocale } from './helpers/renderWithLocale';

const userId = '6153d2b9-82b1-4589-9107-8f6fc78b5da7';
const projectId = 'fb1a3e30-f945-4c48-ab0f-55be117e098e';
const record = {
  number: '123', id: '9007199254740993', url: 'https://github.com/example/repo/pull/123', title: 'A very long title',
  author: { id: '42', login: 'author' }, state: 'open', draft: false,
  base: { repositoryId: '4', repositoryFullName: 'example/repo', ref: 'main' },
  head: { repositoryId: '8', repositoryFullName: 'fork/repo', ref: 'feature/full-branch', sha: '1234567890abcdef' },
  createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', closedAt: null, mergedAt: null,
  observedAt: '2026-11-03T10:00:00Z', revision: '4',
  description: '## Heading\n\n[Link](https://example.com) ![photo](https://evil.example/image.png)\n\n<script>alert(1)</script>\n\n```mermaid\ngraph TD; A-->B\n```',
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
const options = (overrides: Partial<PullRequestDetailDialogProps> = {}): PullRequestDetailDialogProps => ({
  userId, projectId, number: '123', canRead: true, active: true, onPrincipalMismatch: vi.fn(), onClose: vi.fn(), ...overrides,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe('pull request detail dialog', () => {
  it('renders actual detail with safe Markdown, source option, full branch and SHA', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(record)));
    renderWithLocale(<PullRequestDetailDialog {...options()} />, { locale: 'en' });
    const dialog = await screen.findByRole('dialog', { name: record.title });
    expect(within(dialog).getByText('fork/repo:feature/full-branch')).toBeVisible();
    expect(within(dialog).getByText(record.head.sha)).toBeVisible();
    expect(within(dialog).getByRole('heading', { name: 'Heading' })).toBeVisible();
    expect(dialog.querySelector('img, script, iframe, svg')).toBeNull();
    expect(within(dialog).getByText(/graph TD/).tagName).toBe('CODE');
    expect(within(dialog).getByRole('link', { name: 'Link' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(dialog).getByRole('link', { name: /View on GitHub/ })).toHaveAttribute('href', record.url);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Raw Markdown' }));
    expect(dialog.querySelector('.pr-description-source')).toHaveTextContent(record.description.replace(/\s+/g, ' '));
    expect(dialog.querySelector('.pr-description-source')?.textContent).toBe(record.description);
    expect(dialog.querySelector('script, img')).toBeNull();
  });

  it('retains the dialog, raw selection, focus and scroll during a background update', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(response(record)).mockReturnValueOnce(pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const initial = options({ refreshKey: 0 });
    const view = renderWithLocale(<PullRequestDetailDialog {...initial} />, { locale: 'en' });
    const dialog = await screen.findByRole('dialog', { name: record.title });
    const raw = within(dialog).getByRole('checkbox', { name: 'Raw Markdown' });
    fireEvent.click(raw); raw.focus();
    const body = dialog.querySelector<HTMLElement>('.dialog-body')!;
    body.scrollTop = 100;
    view.rerender(<PullRequestDetailDialog {...initial} refreshKey={1} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(raw).toBeChecked(); expect(raw).toHaveFocus(); expect(body.scrollTop).toBe(100);
    await act(async () => pending.resolve(response({ ...record, revision: '5', title: 'Updated title', description: `${record.description}\nnew` })));
    expect(screen.getByRole('dialog', { name: 'Updated title' })).toBe(dialog);
    expect(raw).toBeChecked(); expect(raw).toHaveFocus(); expect(body.scrollTop).toBe(100);
  });

  it('presents missing author, fork, empty description and read failures distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ ...record, author: null, head: { ...record.head, repositoryFullName: null, ref: null }, description: null })).mockResolvedValueOnce(response({ error: { code: 'internal_error', message: 'private details', requestId: 'x' } }, 500)));
    const initial = options({ refreshKey: 0 });
    const view = renderWithLocale(<PullRequestDetailDialog {...initial} />, { locale: 'en' });
    expect(await screen.findByText('Author unavailable')).toBeVisible();
    expect(screen.getByText('Source repository or branch unavailable')).toBeVisible();
    expect(screen.getByText('This pull request has no description.')).toBeVisible();
    view.rerender(<PullRequestDetailDialog {...initial} refreshKey={1} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load pull request details.');
    expect(screen.getByText('Author unavailable')).toBeVisible();
    expect(screen.queryByText('private details')).toBeNull();
  });

  it('clears the visible detail immediately on access revocation and cancels its pending refresh', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(response(record)).mockReturnValueOnce(pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const initial = options({ refreshKey: 0 });
    const view = renderWithLocale(<PullRequestDetailDialog {...initial} />, { locale: 'en' });
    await screen.findByRole('dialog', { name: record.title });
    view.rerender(<PullRequestDetailDialog {...initial} refreshKey={1} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const signal = fetcher.mock.calls[1]![1]!.signal as AbortSignal;
    view.rerender(<PullRequestDetailDialog {...initial} refreshKey={1} canRead={false} />);
    expect(screen.queryByText(record.title)).toBeNull();
    expect(screen.getByText('Pull request details are unavailable.')).toBeVisible();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(response({ ...record, title: 'Stale content', revision: '6' })));
    expect(screen.queryByText('Stale content')).toBeNull();
  });

  it('invokes close from its button and restores focus via the caller callback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(record)));
    const onClose = vi.fn(), onRestoreFocus = vi.fn();
    const view = renderWithLocale(<PullRequestDetailDialog {...options({ onClose, onRestoreFocus })} />, { locale: 'en' });
    fireEvent.click(await screen.findByRole('button', { name: 'Close pull request details' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(onRestoreFocus).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and restores the original opener', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(record)));
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    const onClose = vi.fn();
    const view = renderWithLocale(<PullRequestDetailDialog {...options({ onClose })} />, { locale: 'en' });
    await screen.findByRole('dialog', { name: record.title });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(opener).toHaveFocus(); opener.remove();
  });
});
