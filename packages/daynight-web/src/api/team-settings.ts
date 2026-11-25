import { ApiError, assertResponsePrincipal, json, request, requestId, responseSignal } from "./client";
import { isTaskVersion, stringifyApiJson } from "./json";
import { boolean, malformed, record } from "./validation";

export type TeamSettings = { readonly version: bigint; readonly allowNestedSubtask: boolean };
export type TeamSettingsRead = { readonly kind: "available"; readonly settings: TeamSettings } | { readonly kind: "unavailable" };

const parseSettings = (value: unknown): TeamSettings => {
  const data = record(value);
  if (Object.keys(data).length !== 2 || !Object.hasOwn(data, "version") || !Object.hasOwn(data, "allowNestedSubtask") || !isTaskVersion(data.version)) return malformed();
  return { version: data.version, allowNestedSubtask: boolean(data.allowNestedSubtask) };
};

export const getTeamSettings = async (teamId: string, userId: string, signal: AbortSignal, onMismatch: () => void): Promise<TeamSettingsRead> => {
  const team = requestId(teamId), user = requestId(userId);
  const response = await request(`/api/v1/teams/${team}/settings`, signal, { headers: { Accept: "application/json" }, cache: "no-store" });
  // An old router returns this 404 before authenticated middleware runs.
  if (response.status === 404 && response.headers.get("Daynight-User-ID") === null) {
    try { await json(response, signal, () => malformed()); }
    catch (error) {
      responseSignal(response, signal).throwIfAborted();
      if (error instanceof ApiError && error.kind === "server" && error.code === "not_found") return { kind: "unavailable" };
      throw error;
    }
  }
  assertResponsePrincipal(response, user, onMismatch);
  if (response.ok && response.status !== 200) throw new ApiError("protocol", response.status);
  return { kind: "available", settings: await json(response, signal, parseSettings) };
};

export const saveTeamSettings = async (teamId: string, userId: string, current: TeamSettings, allowNestedSubtask: boolean, signal: AbortSignal, onMismatch: () => void, onDispatch: () => void): Promise<TeamSettings> => {
  const team = requestId(teamId), user = requestId(userId);
  if (!isTaskVersion(current.version) || typeof current.allowNestedSubtask !== "boolean" || typeof allowNestedSubtask !== "boolean") throw new ApiError("protocol");
  const response = await request(`/api/v1/teams/${team}/settings`, signal, {
    method: "PATCH", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: stringifyApiJson({ version: current.version, expectedUserId: user, allowNestedSubtask }),
  }, onDispatch);
  assertResponsePrincipal(response, user, onMismatch);
  if (response.ok && response.status !== 200) throw new ApiError("protocol", response.status);
  try {
    return await json(response, signal, value => {
      const settings = parseSettings(value);
      if (settings.allowNestedSubtask !== allowNestedSubtask || settings.version !== current.version + (current.allowNestedSubtask === allowNestedSubtask ? 0n : 1n)) return malformed();
      return settings;
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "identity_mismatch") onMismatch();
    throw error;
  }
};
