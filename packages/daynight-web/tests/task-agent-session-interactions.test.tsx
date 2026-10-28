import { fireEvent, screen, waitFor } from '@testing-library/react';
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
});
