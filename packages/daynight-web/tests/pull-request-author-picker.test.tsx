import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PullRequestAuthorPicker, type PullRequestAuthorPickerProps } from '../src/features/pull-requests/PullRequestAuthorPicker';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('zh-CN');
const authors = [{ id: '9007199254740993', login: 'same', loginAmbiguous: true }, { id: '9007199254740994', login: 'same', loginAmbiguous: true }];
const props = (): PullRequestAuthorPickerProps => ({ selected: null, items: authors, query: '', loading: false, loaded: true, error: null, nextCursor: 'next', rebuilding: false, disabled: false, active: true, onOpen: vi.fn(), onClose: vi.fn(), onQueryChange: vi.fn(), onLoadMore: vi.fn(), onRetry: vi.fn(), onSelect: vi.fn() });
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PR creator picker', () => {
  it('distinguishes same-name identities through keyboard selection', async () => {
    const p = props(), user = userEvent.setup();
    render(<PullRequestAuthorPicker {...p} />);
    const trigger = screen.getByRole('button', { name: '创建者：全部' });
    await user.click(trigger);
    expect(screen.getByRole('combobox', { name: '搜索 GitHub 用户名' })).toHaveFocus();
    expect(p.onOpen).toHaveBeenCalledOnce();
    const list = screen.getByRole('listbox', { name: 'PR 创建者' });
    expect(within(list).getByRole('option', { name: '全部创建者' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(p.onSelect).toHaveBeenCalledWith(authors[0]);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('retains the open search and entries during loading and recoverable errors', async () => {
    const p = props(), user = userEvent.setup();
    const view = render(<PullRequestAuthorPicker {...p} />);
    await user.click(screen.getByRole('button', { name: '创建者：全部' }));
    const search = screen.getByRole('combobox');
    view.rerender(<PullRequestAuthorPicker {...p} query="same" loading />);
    expect(search).toHaveFocus();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByRole('status')).toHaveTextContent('正在读取创建者');
    view.rerender(<PullRequestAuthorPicker {...p} query="same" error={new Error('offline')} />);
    expect(search).toHaveFocus();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(p.onRetry).toHaveBeenCalledWith({ focusedId: null, visibleId: null });
    view.rerender(<PullRequestAuthorPicker {...p} />);
    await user.click(screen.getByRole('button', { name: '加载更多' }));
    expect(p.onLoadMore).toHaveBeenCalledOnce();
  });

  it('handles IME and Escape and does not steal focus on outside clicks', async () => {
    const p = props(), user = userEvent.setup();
    const view = render(<><PullRequestAuthorPicker {...p} /><button>外部</button></>);
    const trigger = screen.getByRole('button', { name: '创建者：全部' });
    await user.click(trigger);
    const search = screen.getByRole('combobox');
    fireEvent.compositionStart(search);
    fireEvent.change(search, { target: { value: '中' } });
    expect(p.onQueryChange).toHaveBeenCalledWith('中', true);
    view.rerender(<><PullRequestAuthorPicker {...p} query="中" /><button>外部</button></>);
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
    expect(p.onSelect).not.toHaveBeenCalled();
    fireEvent.compositionEnd(search, { data: '中' });
    expect(p.onQueryChange).toHaveBeenLastCalledWith('中', false);
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    const outside = screen.getByRole('button', { name: '外部' });
    await user.click(outside);
    expect(outside).toHaveFocus();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('restores a surviving focused creator after an explicit rebuild', async () => {
    const p = props(), user = userEvent.setup();
    const view = render(<PullRequestAuthorPicker {...p} error={new Error('conflict')} />);
    await user.click(screen.getByRole('button', { name: '创建者：全部' }));
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const target = screen.getByRole('option', { name: /9007199254740993/ });
    expect(target).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(p.onRetry).toHaveBeenCalledWith({ focusedId: authors[0]!.id, visibleId: null });
    view.rerender(<PullRequestAuthorPicker {...p} error={new Error('conflict')} rebuilding />);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    view.rerender(<PullRequestAuthorPicker {...p} items={[authors[1]!, authors[0]!]} />);
    expect(screen.getByRole('option', { name: /9007199254740993/ })).toHaveFocus();
  });

  it('distinguishes empty, unmatched and disabled states', async () => {
    const p = props(), user = userEvent.setup();
    const view = render(<PullRequestAuthorPicker {...p} items={[]} nextCursor={null} />);
    await user.click(screen.getByRole('button', { name: '创建者：全部' }));
    expect(screen.getByRole('status')).toHaveTextContent('暂无创建者');
    view.rerender(<PullRequestAuthorPicker {...p} items={[]} nextCursor={null} query="absent" />);
    expect(screen.getByRole('status')).toHaveTextContent('没有匹配的创建者');
    expect(screen.getByRole('option', { name: '全部创建者' })).toBeVisible();
    view.rerender(<PullRequestAuthorPicker {...p} disabled />);
    expect(screen.getByRole('button', { name: '创建者：全部' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
