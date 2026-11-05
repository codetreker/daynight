import { array, bool, fields, id, malformed, nullableTimestamp, text, timestamp } from "./validation.js";
import type { CreatedTeamInvitation, TeamInvitation, TeamInvitationRevokeReceipt } from "./types.js";

const metadataFields = ["id", "teamId", "createdBy", "createdAt", "expiresAt", "consumedBy", "consumedAt", "revokedAt"] as const;

const parseMetadata = (data: Record<string, unknown>, teamId: string): TeamInvitation => {
  const result: TeamInvitation = {
    id: id(data.id), teamId: id(data.teamId), createdBy: id(data.createdBy),
    createdAt: timestamp(data.createdAt), expiresAt: timestamp(data.expiresAt),
    consumedBy: data.consumedBy === null ? null : id(data.consumedBy),
    consumedAt: nullableTimestamp(data.consumedAt), revokedAt: nullableTimestamp(data.revokedAt),
  };
  if (result.teamId !== teamId || (result.consumedBy === null) !== (result.consumedAt === null) || result.consumedAt !== null && result.revokedAt !== null || Date.parse(result.expiresAt) - Date.parse(result.createdAt) !== 7 * 24 * 60 * 60 * 1000) return malformed();
  return result;
};

export const parseTeamInvitations = (value: unknown, teamId: string): readonly TeamInvitation[] => {
  const data = fields(value, ["items"]);
  const items = array(data.items, (item) => parseMetadata(fields(item, metadataFields), teamId));
  if (new Set(items.map((item) => item.id)).size !== items.length) return malformed();
  return items;
};

export const parseCreatedTeamInvitation = (value: unknown, teamId: string, userId: string, origin: string): CreatedTeamInvitation => {
  const data = fields(value, [...metadataFields, "link"]);
  const result = parseMetadata(data, teamId);
  if (result.createdBy !== userId || result.consumedBy !== null || result.consumedAt !== null || result.revokedAt !== null) return malformed();
  const link = text(data.link);
  const prefix = `${origin}/team-invitations#dnteam_`;
  if (!link.startsWith(prefix)) return malformed();
  const encoded = link.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded) || Buffer.from(encoded, "base64url").byteLength !== 32 || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) return malformed();
  return { ...result, link };
};

export const parseTeamInvitationRevoke = (value: unknown, teamId: string, invitationId: string): TeamInvitationRevokeReceipt => {
  const data = fields(value, ["teamId", "invitationId", "changed"]);
  if (id(data.teamId) !== teamId || id(data.invitationId) !== invitationId) return malformed();
  return { teamId, invitationId, changed: bool(data.changed) };
};
