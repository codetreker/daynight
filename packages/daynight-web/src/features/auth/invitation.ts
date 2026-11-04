import { invitationLocation } from "../../app/router";
import { browserNavigation } from "../../app/navigation";

export const invitationStorageKey = "daynight.pendingInvitation";
export const teamInvitationStorageKey = "daynight.pendingTeamInvitation";

export type PendingInvitation = {
  readonly token: string | null;
  readonly scope: "project" | "team" | null;
  readonly storageUnavailable: boolean;
  readonly cleanupFailed: boolean;
};

const erase = (key: string): boolean => {
  try { window.sessionStorage.removeItem(key); return true; }
  catch {
    try { window.sessionStorage.setItem(key, ""); return true; }
    catch { return false; }
  }
};

export const captureInvitation = (): PendingInvitation => {
  if (!invitationLocation(window.location.pathname, window.location.search)) {
    return { token: null, scope: null, storageUnavailable: false, cleanupFailed: false };
  }
  const path = window.location.pathname === "/login"
    ? new URL(new URLSearchParams(window.location.search).get("returnPath")!, window.location.origin).pathname
    : window.location.pathname;
  const scope = path === "/team-invitations" ? "team" : "project";
  const key = scope === "team" ? teamInvitationStorageKey : invitationStorageKey;
  const otherKey = scope === "team" ? invitationStorageKey : teamInvitationStorageKey;
  const token = window.location.pathname === path ? window.location.hash.slice(1) : "";
  if (token !== "") browserNavigation().clearCapturedFragment();
  const cleanupFailed = !erase(otherKey);
  try {
    if (token !== "") window.sessionStorage.setItem(key, token);
    const stored = token === "" ? window.sessionStorage.getItem(key) : token;
    return { token: stored === "" ? null : stored, scope, storageUnavailable: false, cleanupFailed };
  } catch {
    return { token: token === "" ? null : token, scope, storageUnavailable: true, cleanupFailed };
  }
};

export const clearInvitation = (): boolean => {
  const projectCleared = erase(invitationStorageKey);
  const teamCleared = erase(teamInvitationStorageKey);
  return projectCleared && teamCleared;
};

// A full-page login needs a short-lived copy; authenticated views retain it only in memory.
export const persistInvitation = (invitation: PendingInvitation): PendingInvitation => {
  if (invitation.token === null || invitation.scope === null) return invitation;
  const key = invitation.scope === "team" ? teamInvitationStorageKey : invitationStorageKey;
  const otherKey = invitation.scope === "team" ? invitationStorageKey : teamInvitationStorageKey;
  const cleanupFailed = !erase(otherKey);
  try { window.sessionStorage.setItem(key, invitation.token); return { ...invitation, storageUnavailable: false, cleanupFailed }; }
  catch { return { ...invitation, storageUnavailable: true, cleanupFailed }; }
};
