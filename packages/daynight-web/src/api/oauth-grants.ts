import { ApiError, assertResponsePrincipal, json, request, requestId } from "./client";
import { array, boolean, id, malformed, nonemptyString, record, string, timestamp } from "./parse";

export type OwnerGrant = {
  readonly id: string;
  readonly clientName: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scope: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly status: "active" | "expired" | "revoked";
};

const parseGrant = (value: unknown): OwnerGrant => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["id", "clientName", "clientId", "resource", "scope", "createdAt", "expiresAt", "lastUsedAt", "revokedAt", "status"].includes(key))) return malformed();
  const status = data.status;
  if (status !== "active" && status !== "expired" && status !== "revoked") return malformed();
  const revokedAt = data.revokedAt === null ? null : timestamp(data.revokedAt);
  if ((status === "revoked") !== (revokedAt !== null)) return malformed();
  const clientName = string(data.clientName);
  if (!clientName.isWellFormed() || clientName.includes("\0")) return malformed();
  return { id: id(data.id), clientName, clientId: nonemptyString(data.clientId), resource: nonemptyString(data.resource), scope: nonemptyString(data.scope), createdAt: timestamp(data.createdAt), expiresAt: timestamp(data.expiresAt), lastUsedAt: data.lastUsedAt === null ? null : timestamp(data.lastUsedAt), revokedAt, status };
};

export const listOwnerGrants = async (signal: AbortSignal, expectedUserId: string, onIdentityMismatch: () => void): Promise<readonly OwnerGrant[]> => {
  const expected = requestId(expectedUserId);
  const response = await request("/api/v2/oauth/grants", signal, { headers: { Accept: "application/json" } });
  assertResponsePrincipal(response, expected, onIdentityMismatch);
  return json(response, signal, (value) => {
    if (response.status !== 200) return malformed();
    const data = record(value);
    if (Object.keys(data).some((key) => key !== "userId" && key !== "grants") || id(data.userId) !== expected) return malformed();
    const grants = array(data.grants, parseGrant);
    if (new Set(grants.map((grant) => grant.id)).size !== grants.length) return malformed();
    return grants;
  });
};

export const revokeOwnerGrant = async (grantId: string, expectedUserId: string, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<boolean> => {
  const expected = requestId(expectedUserId);
  const response = await request(`/api/v1/oauth/grants/${requestId(grantId)}/revoke`, signal, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ expectedUserId: expected }) }, onDispatch);
  assertResponsePrincipal(response, expected, onIdentityMismatch);
  return json(response, signal, (value) => {
    if (response.status !== 200) throw new ApiError("protocol", response.status);
    const data = record(value);
    if (Object.keys(data).some((key) => key !== "changed")) return malformed();
    return boolean(data.changed);
  });
};
