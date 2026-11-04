import { assertResponsePrincipal, json, request, requestId } from "./client";
import { parseApiJson, isTaskVersion } from "./json";
import { jsonContainerSources, jsonObjectSources } from "./json-source";
import { parseTeamRef } from "./team-parse";
import { array, id, malformed, record, string, timestamp } from "./validation";
import type { TeamRef } from "./auth-types";

export type Team = TeamRef & { readonly version: bigint; readonly createdAt: string; readonly updatedAt: string; readonly membership: { readonly teamId: string; readonly userId: string; readonly role: "admin" | "member"; readonly version: bigint; readonly createdAt: string; readonly updatedAt: string } };
export type TeamPage = { readonly items: readonly Team[]; readonly nextCursor: string | null };

const teamSource = (text: string): unknown => {
  const data = record(parseApiJson(text));
  const fields = jsonObjectSources(text);
  if (Object.hasOwn(data, "membership")) data.membership = parseApiJson(fields.get("membership")!);
  return data;
};
const decodeTeam = async (response: Response): Promise<unknown> => teamSource(await response.text());
const decodePage = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  const data = record(JSON.parse(text));
  if (Array.isArray(data.items)) data.items = jsonContainerSources(jsonObjectSources(text).get("items")!).map(teamSource);
  return data;
};
const exact = (data: Record<string, unknown>, keys: readonly string[]) => { if (Object.keys(data).some((key) => !keys.includes(key))) return malformed(); };
const parseTeam = (value: unknown, userId: string): Team => {
  const data = record(value);
  exact(data, ["id", "kind", "name", "version", "createdAt", "updatedAt", "membership"]);
  const ref = parseTeamRef({ id: data.id, kind: data.kind, name: data.name });
  if (!isTaskVersion(data.version)) return malformed();
  const member = record(data.membership);
  exact(member, ["teamId", "userId", "role", "version", "createdAt", "updatedAt"]);
  const teamId = id(member.teamId), memberUserId = id(member.userId);
  if (teamId !== ref.id || memberUserId !== userId || !isTaskVersion(member.version) || member.role !== "admin" && member.role !== "member" || ref.kind === "personal" && member.role !== "admin") return malformed();
  return { ...ref, version: data.version, createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt), membership: { teamId, userId: memberUserId, role: member.role, version: member.version, createdAt: timestamp(member.createdAt), updatedAt: timestamp(member.updatedAt) } };
};
const teamRead = async <T>(url: string, userId: string, signal: AbortSignal, onMismatch: () => void, parse: (data: unknown) => T, decode: (response: Response) => Promise<unknown>): Promise<T> => {
  const response = await request(url, signal, { headers: { Accept: "application/json" } });
  assertResponsePrincipal(response, userId, onMismatch);
  return json(response, signal, parse, decode);
};
export const getTeam = (teamId: string, userId: string, signal: AbortSignal, onMismatch: () => void): Promise<Team> => teamRead(`/api/v1/teams/${requestId(teamId)}`, userId, signal, onMismatch, (value) => {
  const team = parseTeam(value, userId);
  if (team.id !== teamId) return malformed();
  return team;
}, decodeTeam);
export const listTeams = (cursor: string | null, userId: string, signal: AbortSignal, onMismatch: () => void): Promise<TeamPage> => {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor !== null) { if (cursor === "") return malformed(); query.set("cursor", cursor); }
  return teamRead(`/api/v1/teams?${query}`, userId, signal, onMismatch, (value) => {
    const data = record(value); exact(data, ["items", "nextCursor"]);
    const items = array(data.items, (item) => parseTeam(item, userId));
    if (new Set(items.map((item) => item.id)).size !== items.length) return malformed();
    const nextCursor = data.nextCursor === null ? null : string(data.nextCursor);
    if (nextCursor === "") return malformed();
    return { items, nextCursor };
  }, decodePage);
};
