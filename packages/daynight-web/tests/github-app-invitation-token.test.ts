import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserNavigation } from '../src/app/navigation';
import { captureGitHubAppInvitation } from '../src/features/github-app-administration/invitation-token';

const token = `dn_gai_${'A'.repeat(43)}`;
const path = '/github-app-admin-invitations';
const setFragment = (fragment: string) => window.history.replaceState({ other: 'preserved' }, '', `${path}?source=link#${fragment}`);
afterEach(() => { vi.restoreAllMocks(); browserNavigation().dispose(); window.history.replaceState(null, '', '/'); });

describe('GitHub App invitation token capture', () => {
  it('scrubs the fragment synchronously, preserves navigation, and returns it only in memory', () => {
    const owner = browserNavigation();
    setFragment(token);
    const stored = vi.spyOn(Storage.prototype, 'setItem');
    const logged = vi.spyOn(console, 'log');
    const historyLength = window.history.length;
    expect(captureGitHubAppInvitation()).toEqual({ token, cleanupFailed: false });
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(`${path}?source=link`);
    expect(owner.snapshot().hash).toBe('');
    expect(window.history.state.other).toBe('preserved');
    expect(window.history.length).toBe(historyLength);
    expect(stored).not.toHaveBeenCalled(); expect(logged).not.toHaveBeenCalled();
    expect(JSON.stringify(window.history.state)).not.toContain(token);
    expect(captureGitHubAppInvitation()).toEqual({ token: null, cleanupFailed: false });
  });

  it.each(['invalid', `dn_gai_${'A'.repeat(42)}B`, `dn_gai_${'A'.repeat(44)}`, `wrong_${'A'.repeat(43)}`, `${token}%20`, `${token}#extra`])('clears malformed fragment without returning it: %s', fragment => {
    setFragment(fragment);
    expect(captureGitHubAppInvitation()).toEqual({ token: null, cleanupFailed: false });
    expect(window.location.hash).toBe('');
  });

  it('does not expose the token if browser history rejects cleanup', () => {
    browserNavigation(); setFragment(token);
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => { throw new Error('history unavailable'); });
    const log = vi.spyOn(console, 'error');
    expect(captureGitHubAppInvitation()).toEqual({ token: null, cleanupFailed: true });
    expect(window.location.hash).toBe(`#${token}`);
    expect(log).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  it('treats a silently ineffective cleanup as failure', () => {
    const owner = browserNavigation(); setFragment(token);
    vi.spyOn(owner, 'clearFragment').mockImplementation(() => {});
    expect(captureGitHubAppInvitation()).toEqual({ token: null, cleanupFailed: true });
  });
});
