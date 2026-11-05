import { canonicalId } from "../../api/parse.js";
import type { User } from "../../api/types.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { readConfigurationSource } from "../../config/files.js";
import { resolveConfigurationPaths } from "../../config/paths.js";
import { configuredServerUrl } from "../../config/server.js";

const mapping = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const readTeamDefault = async (home: string, origin: string, user: User, signal: AbortSignal): Promise<string | undefined> => {
  const paths = resolveConfigurationPaths(home);
  const source = await readConfigurationSource(paths, signal);
  const { mapping: config } = parseConfigurationDocument(source, paths);
  if (configuredServerUrl(config) !== origin) throw new Error("The configured server changed during the Team operation.");
  if (!Object.hasOwn(config, "teamDefaults")) return undefined;
  if (!mapping(config.teamDefaults)) throw new Error("teamDefaults must be a mapping.");
  if (!Object.hasOwn(config.teamDefaults, origin)) return undefined;
  const accounts = config.teamDefaults[origin];
  if (!mapping(accounts)) throw new Error("The Team defaults for this server must be a mapping.");
  if (!Object.hasOwn(accounts, user.id)) return undefined;
  const value = accounts[user.id];
  if (typeof value !== "string" || canonicalId(value) !== value) throw new Error("The configured default Team must be a canonical UUID.");
  return value;
};

export const teamTarget = (value: string, user: User): string => value === "personal" ? user.personalTeam.id : value;
