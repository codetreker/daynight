import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountSessionProvider } from '../src/app/AccountSessionProvider';
import { LandingPage } from '../src/features/landing/LandingPage';
import { SetupGuideShell } from '../src/features/setup/SetupGuideShell';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const userId = '11111111-1111-4111-8111-111111111111';
class Channel extends EventTarget { postMessage() {} close() {} }
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([['home', LandingPage], ['setup', SetupGuideShell]] as const)('%s keeps the confirmed page and retries a failed account publication', async (_name, Page) => {
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: userId, name: 'Alice', email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: userId, kind: 'personal', name: null } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  const original = Storage.prototype.setItem;
  let fail = true;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === 'daynight.activeUser' && fail) throw new Error('storage unavailable');
    return original.call(this, key, value);
  });
  render(<AccountSessionProvider><Page /></AccountSessionProvider>);
  expect(await screen.findByText('Account synchronization failed.')).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry account synchronization' }));
  await waitFor(() => expect(screen.queryByText('Account synchronization failed.')).not.toBeInTheDocument());
  expect(localStorage.getItem('daynight.activeUser')).toBe(JSON.stringify(userId));
});
