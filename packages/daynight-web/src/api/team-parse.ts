import { id, malformed, record, string } from "./validation";
import { isTaskVersion } from "./json";
import type { ProjectOwnership, TeamRef } from "./auth-types";

export const parseTeamRef = (value: unknown): TeamRef => {
  const data = record(value);
  if (Object.keys(data).some((key) => !["id", "kind", "name"].includes(key))) return malformed();
  if (data.kind !== "personal" && data.kind !== "ordinary") return malformed();
  const name = data.name === null ? null : string(data.name);
  if (data.kind === "personal" && name !== null || data.kind === "ordinary" && (name === null || !name.isWellFormed() || name.includes("\0") || !/[^\p{White_Space}]/u.test(name))) return malformed();
  return { id: id(data.id), kind: data.kind, name };
};

export const parseProjectOwnership = (value: unknown): ProjectOwnership => {
  const data = record(value);
  if (Object.keys(data).some((key) => key !== "teamId" && key !== "version") || !isTaskVersion(data.version)) return malformed();
  return { teamId: id(data.teamId), version: data.version };
};
