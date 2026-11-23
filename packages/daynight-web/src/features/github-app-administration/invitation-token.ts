import { browserNavigation } from '../../app/navigation';

export type GitHubAppInvitationCapture = { readonly token: string | null; readonly cleanupFailed: boolean };

// A 32-byte unpadded base64url token has 43 characters and two zero pad bits.
const tokenFormat = /^dn_gai_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

// The caller keeps a successful token only in memory. An unsafe URL cannot
// authorize inspection or acceptance, even if its fragment looks valid.
export const captureGitHubAppInvitation = (): GitHubAppInvitationCapture => {
  const fragment = window.location.hash;
  if (fragment === '') return { token: null, cleanupFailed: false };
  try {
    browserNavigation().clearFragment();
    if (window.location.hash !== '') return { token: null, cleanupFailed: true };
  } catch {
    return { token: null, cleanupFailed: true };
  }
  const token = fragment.slice(1);
  return { token: tokenFormat.test(token) ? token : null, cleanupFailed: false };
};
