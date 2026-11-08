import { ApiError } from "../../api/client";
import type { WebhookEndpoint, WebhookEndpointSummary, WebhookOwner } from "../../api/webhooks";

export type WebhookTeamObservation = { readonly role: "admin" | "member" | null; readonly membershipVersion: string | null; readonly membershipCreatedAt: string | null; readonly restricted: boolean; readonly denied: boolean; readonly epoch: number };
export type WebhookOwnerAuthorization = { readonly key: string; readonly status: "personal" | "unknown" | "admin" | "member" | "absent"; readonly readable: boolean; readonly manage: boolean };
export type WebhookAuthorizationResolver = (owner: WebhookOwner) => WebhookOwnerAuthorization;
export type WebhookConfigurationObservation = (endpoint: WebhookEndpoint | WebhookEndpointSummary, authorizationKey: string) => WebhookOwnerAuthorization;

export type WebhookOwnerDenial = (owner: WebhookOwner, authorizationKey: string) => WebhookOwnerAuthorization;

export const ownerAuthorization = (owner: WebhookOwner, userId: string, observed: boolean, teams: ReadonlyMap<string, WebhookTeamObservation>): WebhookOwnerAuthorization => {
  if (owner.kind === "personal") {
    if (owner.id !== userId) throw new ApiError("protocol");
    return { key: `personal:${userId}`, status: "personal", readable: true, manage: true };
  }
  if (!observed) return { key: `team:${owner.id}:unknown`, status: "unknown", readable: false, manage: false };
  const team = teams.get(owner.id);
  if (team?.denied) return { key: `team:${owner.id}:denied:${team.epoch}`, status: "absent", readable: false, manage: false };
  if (team === undefined || team.role === null) return { key: `team:${owner.id}:absent:${team?.epoch ?? 0}`, status: "absent", readable: false, manage: false };
  const status = team.restricted ? "member" : team.role;
  return { key: `team:${owner.id}:${status}:${team.membershipCreatedAt}:${team.membershipVersion}:${team.epoch}`, status, readable: true, manage: status === "admin" };
};

export const assertOwnerDisclosure = (authorization: WebhookOwnerAuthorization, endpoint: WebhookEndpoint | WebhookEndpointSummary): void => {
  if (!authorization.readable) throw new ApiError("protocol");
  if (authorization.status !== "member" || "lifecycle" in endpoint && endpoint.lifecycle === "deleted") return;
  if (endpoint.destination.url !== null || "capabilities" in endpoint && (endpoint.capabilities.manage || endpoint.capabilities.readSecret || endpoint.capabilities.redeliver)) throw new ApiError("protocol");
};
