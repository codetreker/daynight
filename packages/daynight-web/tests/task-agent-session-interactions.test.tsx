import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionInteractionCard } from '../src/features/task-agent-session/SessionInteractionCard';
import { createLocaleRender } from './helpers/renderWithLocale';
import type { SessionInteraction } from '../src/api/types';
const render = createLocaleRender('en');
const base = { interactionId: 'native-request', revision: '1', state: 'pending', title: 'Choose a destination' } as const;
describe('native session interactions', () => {
  it('only exposes declared approval actions and waits for the real response', async () => {
    let settle!: () => void;
    const respond = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    render(<SessionInteractionCard interaction={{ ...base, kind: 'approval', detail: 'Run this command?', actions: ['allow_once', 'reject'] }} enabled onRespond={respond} />);
    expect(screen.queryByRole('button', { name: 'Allow for session' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(respond).toHaveBeenCalledWith({ kind: 'approval', action: 'allow_once' });
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(screen.queryByRole('status')).toBeNull();
    settle();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull());
    expect(screen.getByText('Resolved')).toBeVisible();
  });
  it('preserves question answers on failure and sends typed choices plus custom text', async () => {
    const respond = vi.fn(async () => { throw new Error('Connection lost'); });
    const interaction: SessionInteraction = { ...base, kind: 'question', canDismiss: false, questions: [{ questionId: 'q', label: 'Destination', options: [{ id: 'eu', label: 'Europe' }], multiple: true, allowCustom: true, required: true, sensitive: false }] };
    render(<SessionInteractionCard interaction={interaction} enabled onRespond={respond} />);
    fireEvent.click(screen.getByLabelText('Europe'));
    fireEvent.change(screen.getByLabelText('Destination — Other answer'), { target: { value: 'Asia' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByText('Connection lost');
    expect(respond).toHaveBeenCalledWith({ kind: 'question', answers: [{ questionId: 'q', optionIds: ['eu'], text: 'Asia' }] });
    expect(screen.getByLabelText('Europe')).toBeChecked();
  });
  it('rejects empty required and out-of-range values before dispatching typed form values', async () => {
    const respond = vi.fn(async () => {});
    render(<SessionInteractionCard interaction={{ ...base, kind: 'form', canDismiss: true, fields: [
      { fieldId: 'name', label: 'Name', type: 'text', sensitive: true, required: true },
      { fieldId: 'count', label: 'Count', type: 'number', min: 1, max: 3, required: true },
      { fieldId: 'flag', label: 'Enabled', type: 'boolean', required: true },
    ] }} enabled onRespond={respond} />);
    fireEvent.submit(screen.getByRole('button', { name: 'Submit' }).closest('form')!);
    expect(respond).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Name')).toHaveAttribute('type', 'password');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('Count'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Enabled'), { target: { value: 'false' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Submit' }).closest('form')!);
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ kind: 'form', values: [{ fieldId: 'name', value: 'secret' }, { fieldId: 'count', value: 2 }, { fieldId: 'flag', value: false }] }));
  });
  it('cannot respond to resolved or disabled native requests', () => {
    const respond = vi.fn();
    render(<SessionInteractionCard interaction={{ ...base, state: 'expired', kind: 'approval', detail: 'Expired', actions: ['allow_once'] }} enabled onRespond={respond} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('retains multiple selections as arrays and boolean false through pending and failed form responses', async () => {
    const response = Promise.withResolvers<void>(), respond = vi.fn(() => response.promise);
    const interaction: SessionInteraction = { ...base, kind: 'form', canDismiss: false, fields: [
      { fieldId: 'regions', label: 'Regions', type: 'multiselect', required: true,
        options: [{ id: 'eu', label: 'Europe' }, { id: 'us', label: 'Americas' }, { id: 'ap', label: 'Asia Pacific' }, { id: 'af', label: 'Africa' }, { id: 'oc', label: 'Oceania' }] },
      { fieldId: 'flag', label: 'Enabled', type: 'boolean', required: true },
    ] };
    const view = render(<SessionInteractionCard interaction={interaction} enabled onRespond={respond} />);
    const regions = screen.getByRole('listbox', { name: 'Regions' }) as HTMLSelectElement;
    const flag = screen.getByRole('combobox', { name: 'Enabled' });
    expect(regions).toHaveValue([]);
    expect(regions.options).toHaveLength(5);
    expect(regions).not.toBeRequired();
    expect(regions.parentElement).toHaveAttribute('data-density', 'form');
    expect(regions.parentElement).toHaveAttribute('data-layout', 'fill');
    expect(regions.parentElement).toHaveAttribute('data-mode', 'list');
    expect(regions.parentElement!.querySelector('svg')).toBeNull();
    expect(flag.parentElement).toHaveAttribute('data-mode', 'popup');
    fireEvent.submit(screen.getByRole('button', { name: 'Submit' }).closest('form')!);
    expect(respond).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeVisible();
    for (const option of regions.options) option.selected = ['eu', 'ap'].includes(option.value);
    fireEvent.change(regions);
    fireEvent.change(flag, { target: { value: 'false' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(respond).toHaveBeenCalledExactlyOnceWith({ kind: 'form', values: [
      { fieldId: 'regions', value: ['eu', 'ap'] }, { fieldId: 'flag', value: false },
    ] });
    expect(regions).toBeDisabled();
    expect(flag).toBeDisabled();
    expect(regions.disabled).toBe(false);
    expect(regions.closest('fieldset')).toBeDisabled();
    expect(regions).toHaveValue(['eu', 'ap']);
    await act(async () => response.reject(new Error('Response unavailable')));
    await screen.findByText('Response unavailable');
    expect(regions).toBeEnabled();
    expect(flag).toHaveValue('false');
    expect(regions).toHaveValue(['eu', 'ap']);
    view.rerender(<SessionInteractionCard interaction={interaction} enabled onRespond={respond} />);
    expect(screen.getByRole('listbox', { name: 'Regions' })).toBe(regions);
    expect(regions).toHaveValue(['eu', 'ap']);
    expect(respond).toHaveBeenCalledOnce();
  });
  it.each(['resolved', 'expired'] as const)('keeps %s approval requests collapsed, readable and non-actionable', state => {
    const respond = vi.fn();
    const detail = 'notes/review.txt\n+ approval card check <literal>';
    const view = render(<SessionInteractionCard interaction={{ ...base, state, kind: 'approval', detail, actions: ['allow_once', 'reject'] }} enabled={false} onRespond={respond} />);
    expect(screen.getByText(state === 'resolved' ? 'Resolved' : 'Expired')).toBeVisible();
    const toggle = screen.getByText('Show request');
    const disclosure = toggle.closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    fireEvent.click(toggle);
    expect(disclosure).toHaveAttribute('open');
    const content = screen.getByRole('region', { name: 'Request content' });
    expect(content.textContent).toBe(detail);
    expect(content).toHaveAttribute('tabindex', '0');
    expect(content.querySelector('input, button, select, textarea, form')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    view.setLocale('zh-CN');
    expect(screen.getByText('查看请求内容')).toBeVisible();
    expect(screen.getByText(state === 'resolved' ? '已处理' : '已过期')).toBeVisible();
    expect(screen.getByRole('region', { name: '请求内容' })).toBeVisible();
    fireEvent.click(screen.getByText('查看请求内容'));
    expect(disclosure).not.toHaveAttribute('open');
    expect(respond).not.toHaveBeenCalled();
  });
  it.each(['question', 'form'] as const)('retains the original %s definition after a local answer without exposing entered values', async kind => {
    const respond = vi.fn(async () => {});
    const interaction: SessionInteraction = kind === 'question'
      ? { ...base, kind, canDismiss: false, questions: [{ questionId: 'secret', label: 'Access code', sensitive: true, required: true, multiple: false, allowCustom: true, options: [{ id: 'public', label: 'Public access' }] }] }
      : { ...base, kind, canDismiss: false, fields: [{ fieldId: 'secret', label: 'Access code', sensitive: true, required: true, type: 'text' }] };
    const view = render(<SessionInteractionCard interaction={interaction} enabled onRespond={respond} />);
    fireEvent.change(screen.getByLabelText(kind === 'question' ? 'Access code — Other answer' : 'Access code'), { target: { value: 'private-answer-do-not-display' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    const toggle = await screen.findByText('Show request');
    fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: 'Request content' })).toHaveTextContent('Access code');
    if (kind === 'question') expect(screen.getByText('Public access')).toBeVisible();
    expect(view.container.innerHTML).not.toContain('private-answer-do-not-display');
    expect(view.container.querySelector('input, select, textarea, form')).toBeNull();
    expect(respond).toHaveBeenCalledOnce();
    view.rerender(<SessionInteractionCard interaction={{ ...interaction, state: 'expired', revision: '2' }} enabled={false} onRespond={respond} />);
    expect(screen.getByText('Access code')).toBeVisible();
    expect(respond).toHaveBeenCalledOnce();
  });
});
