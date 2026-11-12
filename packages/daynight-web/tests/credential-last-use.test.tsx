import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialClockProvider, CredentialLastUse, latestCredentialUse, mergeCredentialUses } from '../src/features/management/CredentialLastUse';
import { getFormats } from '../src/i18n/formats';
import { renderWithLocale } from './helpers/renderWithLocale';

const stamp = '2026-11-12T12:00:00Z';
const base = Date.parse(stamp);

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('credential use display', () => {
  it.each(['en', 'zh-CN'] as const)('shows null and a localized full time in %s', locale => {
    vi.useFakeTimers(); vi.setSystemTime(base + 180_000);
    const view = renderWithLocale(<CredentialClockProvider visible><CredentialLastUse value={null} /></CredentialClockProvider>, { locale });
    expect(screen.getByText(locale === 'en' ? 'Last used: No usage recorded' : '最后使用: 暂无使用记录')).toBeInTheDocument();
    expect(document.querySelector('details')).toBeNull();
    view.rerender(<CredentialClockProvider visible><CredentialLastUse value={stamp} /></CredentialClockProvider>);
    const summary = document.querySelector('summary')!;
    expect(summary).toHaveTextContent(locale === 'en' ? 'About 3 min ago' : '约 3 分钟前');
    expect(summary).toHaveAttribute('title', expect.stringContaining(getFormats(locale).dateTime(stamp)));
    fireEvent.click(summary);
    expect(document.querySelector('details')).toHaveAttribute('open');
    expect(document.querySelector('.full-time')).toHaveTextContent(getFormats(locale).dateTime(stamp));
  });

  it.each([
    [-1, 'About just now'], [59_999, 'About just now'], [60_000, 'About 1 min ago'],
    [3_600_000, 'About 1 hour ago'], [86_400_000, 'About 1 day ago'],
  ])('uses the correct age boundary at %i ms', (age, expected) => {
    vi.useFakeTimers(); vi.setSystemTime(base + age);
    renderWithLocale(<CredentialClockProvider visible><CredentialLastUse value={stamp} /></CredentialClockProvider>, { locale: 'en' });
    expect(document.querySelector('summary')).toHaveTextContent(expected);
  });

  it('merges by identity at full fractional precision while preserving metadata-only order', () => {
    expect(latestCredentialUse('2026-11-12T12:00:00.123456789Z', '2026-11-12T12:00:00.123456788Z')).toBe('2026-11-12T12:00:00.123456789Z');
    const old = [{ id: 'a', lastUsedAt: stamp, name: 'A' }, { id: 'b', lastUsedAt: null, name: 'B' }];
    expect(mergeCredentialUses(old, [{ ...old[1]!, lastUsedAt: stamp }, { ...old[0]!, lastUsedAt: null }])).toEqual([{ ...old[0] }, { ...old[1], lastUsedAt: stamp }]);
    expect(mergeCredentialUses(old, [{ id: 'new', name: 'A', lastUsedAt: null }])).toEqual([{ id: 'new', name: 'A', lastUsedAt: null }]);
  });

  it('ticks once per minute only when visible and immediately catches up on return', () => {
    vi.useFakeTimers(); vi.setSystemTime(base);
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const Clock = ({ visible }: { visible: boolean }) => <CredentialClockProvider visible={visible}><CredentialLastUse value={stamp} /></CredentialClockProvider>;
    const view = renderWithLocale(<Clock visible />, { locale: 'en' });
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(60_000)); expect(document.querySelector('summary')).toHaveTextContent('About 1 min ago');
    visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(120_000)); expect(document.querySelector('summary')).toHaveTextContent('About 1 min ago');
    visibility = 'visible'; act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(document.querySelector('summary')).toHaveTextContent('About 3 min ago');
    view.rerender(<Clock visible={false} />); expect(vi.getTimerCount()).toBe(0);
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
});
