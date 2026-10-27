import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskId } from '../src/features/task-detail/TaskId';
import { LanguageSelector } from '../src/i18n/LanguageSelector';
import { renderWithLocale } from './helpers/renderWithLocale';

const id = '20000000-0000-4000-8000-000000000001';
const clipboard = (writeText: ReturnType<typeof vi.fn>) => vi.stubGlobal('navigator', { clipboard: { writeText } });

describe('overview task ID copy', () => {
  it('copies the exact full ID and translates the action and result without another write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); clipboard(writeText);
    renderWithLocale(<><LanguageSelector /><TaskId value={id} /></>, { locale: 'en' });
    expect(screen.getByText(id)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Copy task ID' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    expect(writeText).toHaveBeenCalledExactlyOnceWith(id);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zh-CN' } });
    expect(screen.getByRole('button', { name: '复制任务 ID' })).toHaveAttribute('title', '复制任务 ID');
    expect(screen.getByRole('button', { name: '复制任务 ID' })).toHaveTextContent('');
    expect(screen.getByRole('status')).toHaveTextContent('已复制');
    expect(writeText).toHaveBeenCalledOnce();
  });

  it('exposes clipboard rejection and allows a successful retry with the ID still readable', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError')).mockResolvedValueOnce(undefined);
    clipboard(writeText);
    renderWithLocale(<TaskId value={id} />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy task ID' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy the task ID. Select and copy it manually.');
    expect(screen.getByText(id)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Copy task ID' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable clipboard access and does not claim success', async () => {
    vi.stubGlobal('navigator', {});
    renderWithLocale(<TaskId value={id} />, { locale: 'zh-CN' });
    fireEvent.click(screen.getByRole('button', { name: '复制任务 ID' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法复制任务 ID，请选中并手动复制。');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disables duplicate copies while pending and ignores a result after switching task identity', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const writeText = vi.fn().mockReturnValue(pending); clipboard(writeText);
    const view = renderWithLocale(<TaskId key={id} value={id} />, { locale: 'en' });
    const copy = screen.getByRole('button', { name: 'Copy task ID' });
    fireEvent.click(copy); fireEvent.click(copy);
    expect(copy).toBeDisabled(); expect(writeText).toHaveBeenCalledOnce();
    const next = '00000000-0000-4000-8000-000000000001';
    view.rerender(<TaskId key={next} value={next} />);
    await act(async () => resolve());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText(next)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy task ID' })).toBeEnabled();
  });
});
