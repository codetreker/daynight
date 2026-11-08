import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { decideConsent, inspectConsent, isLoopbackCallback, parseConsent, parseConsentRedirect, type ConsentView } from '../src/api/oauth-consent';
import { isLoginReturnPath, parseAuthRoute } from '../src/app/router';
import { OAuthConsentPage } from '../src/features/auth/OAuthConsentPage';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const id = '00000000-0000-4000-8000-000000000001';
const user = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id, name: 'Alice', email: 'alice@example.com', emailVerified: true, avatarUrl: null };
const view: ConsentView = { requestId: id, userId: id, status: 'pending', clientName: 'Example', clientId: 'client', clientProvenance: 'dcr', redirectUri: 'http://127.0.0.1:41235/callback?x=1', resource: 'https://daynight.example/mcp', scope: 'daynight:mcp', codeExpired: false };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const result = { redirectUri: 'http://127.0.0.1:41235/callback?x=1&code=secret&iss=https%3A%2F%2Fdaynight.example&state=state' };
const fixture = () => ({ inspect: vi.fn<typeof inspectConsent>().mockResolvedValue(view), decide: vi.fn<typeof decideConsent>().mockResolvedValue(result.redirectUri) });
const mismatch = vi.fn(), switchAccount = vi.fn(), navigate = vi.fn();
const page = (transport: ReturnType<typeof fixture>) => <OAuthConsentPage requestId={id} user={user} transport={transport} onSwitchAccount={switchAccount} onIdentityMismatch={mismatch} navigate={navigate} />;
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

describe('OAuth browser authorization', () => {
  it('accepts only a single canonical request in a local login return', () => {
    expect(parseAuthRoute('/oauth/consent', `?request=${id}`)).toEqual({ kind: 'oauthConsent', requestId: id });
    expect(isLoginReturnPath(`/oauth/consent?request=${id}`)).toBe(true);
    for (const suffix of ['', '?request=bad', `?request=${id}&request=${id}`, `?request=${id}&next=https://evil.example`]) expect(isLoginReturnPath(`/oauth/consent${suffix}`)).toBe(false);
    expect(isLoginReturnPath('//evil.example/oauth/consent')).toBe(false);
  });
  it('validates identity, metadata and the exact callback, including loopback port', () => {
    expect(parseConsent({ ...view, clientName: '' }, id, id).clientName).toBe('client');
    expect(() => parseConsent({ ...view, userId: '00000000-0000-4000-8000-000000000002' }, id, id)).toThrow();
    expect(parseConsentRedirect(result, view, 'approve')).toBe(result.redirectUri);
    for (const redirectUri of [result.redirectUri.replace('41235', '41236'), result.redirectUri.replace('secret', ''), result.redirectUri.replace('daynight.example', 'evil.example'), result.redirectUri + '&code=second']) expect(() => parseConsentRedirect({ redirectUri }, view, 'approve')).toThrow();
  });
  it.each([['http://127.0.0.1/a', true], ['http://127.127.4.3/a', true], ['http://127.255.255.255/a', true], ['http://[::1]/a', true], ['http://[::ffff:127.2.3.4]/a', true], ['http://[::ffff:7fff:ffff]/a', true], ['http://localhost/a', true], ['https://128.0.0.1/a', false], ['https://[::ffff:8000:1]/a', false], ['https://localhost.example/a', false], ['https://127.attacker.example/a', false]])('classifies local callback %s', (url, expected) => { expect(isLoopbackCallback(url)).toBe(expected); });
  it('shows verified source categories without implying verification of the display name', async () => {
    const api = fixture(); api.inspect.mockResolvedValue({ ...view, clientProvenance: 'cimd', clientId: 'https://client.example/metadata.json' }); render(page(api));
    expect(await screen.findByText('Client metadata URL · https://client.example')).toBeInTheDocument();
    expect(screen.getByText('The client supplied this name; it has not been independently verified.')).toBeInTheDocument();
  });
  it('sends expected account once and treats malformed success as an unconfirmed response', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ redirectUri: 'https://evil.example/?code=secret' }));
    await expect(decideConsent(view, 'approve', new AbortController().signal)).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/oauth/requests/${id}/decision`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedUserId: id, decision: 'approve' }), credentials: 'same-origin' }));
  });
  it('invalidates an account mismatch without exposing client data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ ...view, userId: '00000000-0000-4000-8000-000000000002' }));
    const changed = vi.fn();
    await expect(inspectConsent(id, id, new AbortController().signal, changed)).rejects.toBeInstanceOf(ApiError);
    expect(changed).toHaveBeenCalledOnce();
  });
  it('shows actual client, callback and account, and sends the received redirect only on explicit return', async () => {
    const api = fixture(); render(page(api));
    expect(await screen.findByText('127.0.0.1:41235')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText(/returns to a client on your device/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow access' }));
    await screen.findByRole('heading', { name: 'Authorization request approved' });
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Daynight').tagName).toBe('DIV');
    fireEvent.click(screen.getByRole('button', { name: 'Return to client' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith(result.redirectUri);
  });
  it('reconciles an unconfirmed decision without reissuing code, including after reload', async () => {
    const api = fixture(); api.decide.mockRejectedValue(new ApiError('network'));
    api.inspect.mockResolvedValueOnce(view).mockResolvedValueOnce({ ...view, status: 'approved' });
    const rendered = render(page(api));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow access' }));
    await screen.findByRole('heading', { name: 'Authorization outcome unconfirmed' });
    rendered.unmount();
    const next = fixture(); next.inspect.mockResolvedValue(view);
    render(page(next));
    await screen.findByRole('heading', { name: 'Authorization outcome unconfirmed' });
    expect(screen.queryByRole('button', { name: 'Allow access' })).toBeNull();
    next.inspect.mockResolvedValueOnce({ ...view, status: 'approved' });
    fireEvent.click(screen.getByRole('button', { name: 'Check authorization status' }));
    await screen.findByRole('heading', { name: 'Approved; connection unconfirmed' });
    expect(next.decide).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Return to client' })).toBeNull();
  });
  it('shows a failed status check while keeping the outcome unknown and permits a retry', async () => {
    const api = fixture(); api.decide.mockRejectedValue(new ApiError('network'));
    api.inspect.mockResolvedValueOnce(view).mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce({ ...view, status: 'denied' });
    render(page(api)); fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await screen.findByRole('heading', { name: 'Authorization outcome unconfirmed' });
    fireEvent.click(screen.getByRole('button', { name: 'Check authorization status' }));
    await screen.findByText('Unable to read the authorization status. Please retry.');
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check authorization status' }));
    await screen.findByRole('heading', { name: 'Access denied' });
    expect(api.decide).toHaveBeenCalledOnce();
  });
  it.each([[400, 'invalid_request'], [404, 'invalid_request'], [403, 'forbidden'], [401, 'unauthorized']] as const)('rechecks after a definite %s rejection and clears the pending marker', async (status, code) => {
    const api = fixture(); api.decide.mockRejectedValue(new ApiError('server', status, code));
    render(page(api)); fireEvent.click(await screen.findByRole('button', { name: 'Allow access' }));
    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Allow access' })).toBeEnabled();
    expect(sessionStorage.getItem(`daynight.oauth.decision.${id}`)).toBeNull();
    expect(api.decide).toHaveBeenCalledOnce();
  });
  it('clears an undispatched decision when identity gating is cancelled', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(view));
    const rendered = render(<OAuthConsentPage requestId={id} user={user} onSwitchAccount={switchAccount} onIdentityMismatch={mismatch} navigate={navigate} />);
    await screen.findByRole('button', { name: 'Allow access' });
    pauseAuthRequests(); fireEvent.click(screen.getByRole('button', { name: 'Allow access' }));
    expect(sessionStorage.getItem(`daynight.oauth.decision.${id}`)).toBe('pending');
    rendered.unmount(); invalidateAuthRequests();
    expect(sessionStorage.getItem(`daynight.oauth.decision.${id}`)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('clears the marker before the global unauthorized lifecycle starts', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ error: 'unauthorized' }, 401));
    const clear = vi.fn();
    await expect(decideConsent(view, 'approve', new AbortController().signal, clear)).rejects.toMatchObject({ status: 401 });
    expect(clear).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not drop a decision during background inspection or publish its stale result', async () => {
    const api = fixture(); let finish!: (value: ConsentView) => void; let signal: AbortSignal | undefined;
    api.inspect.mockImplementationOnce(async () => view).mockImplementationOnce((_id, _user, captured) => { signal = captured; return new Promise((resolve) => { finish = resolve; }); });
    render(page(api)); await screen.findByRole('button', { name: 'Allow access' });
    fireEvent.focus(window); await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Allow access' }));
    await screen.findByRole('heading', { name: 'Authorization request approved' });
    expect(signal?.aborted).toBe(true); expect(api.decide).toHaveBeenCalledOnce();
    await act(async () => finish({ ...view, status: 'expired' }));
    expect(screen.getByRole('heading', { name: 'Authorization request approved' })).toBeInTheDocument();
  });
  it.each(['denied', 'expired', 'consumed'] as const)('shows existing %s without another decision', async (status) => {
    const api = fixture(); api.inspect.mockResolvedValue({ ...view, status }); render(page(api));
    await screen.findByRole('heading', { name: status === 'denied' ? 'Access denied' : status === 'expired' ? 'Authorization request expired' : 'Approved; connection unconfirmed' });
    expect(api.decide).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Allow access' })).toBeNull();
  });
});
