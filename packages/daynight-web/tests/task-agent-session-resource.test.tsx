import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionResourceView } from '../src/features/task-agent-session/SessionResourceView';
import { createLocaleRender } from './helpers/renderWithLocale';
const render = createLocaleRender('en');
const resource = { resourceId: '00000012-1111-4111-8111-111111111111', name: 'result.txt', status: 'available' as const, mediaType: 'text/plain', byteLength: '4', sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', error: null };
describe('session resource display', () => {
  it('does not expose bytes whose digest differs from the authorized descriptor', async () => {
    const load = vi.fn(async () => new Response('evil').blob());
    const create = vi.fn(); vi.spyOn(URL, 'createObjectURL').mockImplementation(create);
    render(<SessionResourceView resource={resource} label="Result" active onLoad={load} />);
    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    await screen.findByRole('alert');
    expect(create).not.toHaveBeenCalled();
  });
  it('renders only verified image bytes and revokes their object URL on unmount', async () => {
    const load = vi.fn(async () => new Response('test').blob());
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:verified');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const view = render(<SessionResourceView resource={{ ...resource, mediaType: 'image/png' }} label="Preview" active onLoad={load} />);
    expect(await screen.findByRole('img', { name: 'Preview' })).toHaveAttribute('src', 'blob:verified');
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:verified');
  });
  it('does not request a missing or unavailable resource', () => {
    const load = vi.fn();
    render(<SessionResourceView resource={{ ...resource, status: 'unavailable' }} label="Result" active onLoad={load} />);
    expect(screen.getByText(/Resource unavailable/)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});
