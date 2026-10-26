import { invitationLocation } from "../../app/router";

export const invitationStorageKey = "daynight.pendingInvitation";

export type PendingInvitation = {
  readonly token: string | null;
  readonly storageUnavailable: boolean;
};

export const captureInvitation = (): PendingInvitation => {
  if (!invitationLocation(window.location.pathname, window.location.search)) {
    return { token: null, storageUnavailable: false };
  }
  const token = window.location.pathname === "/invitations" ? window.location.hash.slice(1) : "";
  if (token !== "") window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  try {
    if (token !== "") window.sessionStorage.setItem(invitationStorageKey, token);
    const stored = token === "" ? window.sessionStorage.getItem(invitationStorageKey) : token;
    return { token: stored === "" ? null : stored, storageUnavailable: false };
  } catch {
    return { token: token === "" ? null : token, storageUnavailable: true };
  }
};

export const clearInvitation = (): boolean => {
  try {
    window.sessionStorage.removeItem(invitationStorageKey);
    return true;
  } catch {
    try {
      window.sessionStorage.setItem(invitationStorageKey, "");
      return true;
    } catch {
      return false;
    }
  }
};
