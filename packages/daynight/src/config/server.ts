import { parseConfigurationDocument } from "./document.js";
import { readConfigurationSource } from "./files.js";
import type { ConfigurationPaths } from "./paths.js";
import { MissingConfigurationFileError } from "./errors.js";
import { validateServerToken, validateTokenTransport } from "./server-token.js";

export const DEFAULT_SERVER_URL = "https://daynight.cc";

export type ServerConfiguration = { serverUrl: string; serverToken?: string };

export const normalizeServerUrl = (value: unknown): string => {
  const invalid = (): Error => new Error("serverUrl must be an HTTP(S) origin without credentials, a non-root path, query, fragment, whitespace, or backslashes.");
  if (typeof value !== "string" || !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f-\u009f\\?#]/u.test(value)) {
    throw invalid();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error("serverUrl must be a valid HTTP(S) origin.", { cause });
  }
  const authority = value.slice(value.indexOf("://") + 3);
  if (authority.includes("@") || /\//.test(authority.replace(/\/$/, "")) || !["http:", "https:"].includes(url.protocol) || url.hostname === "" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw invalid();
  }
  return url.origin;
};

export const parseServerConfiguration = (source: string, paths: ConfigurationPaths): ServerConfiguration => {
  try {
    const { mapping } = parseConfigurationDocument(source, paths);
    const serverUrl = configuredServerUrl(mapping);
    if (!Object.hasOwn(mapping, "serverToken")) return { serverUrl };
    const serverToken = validateServerToken(mapping.serverToken);
    validateTokenTransport(serverUrl);
    return { serverUrl, serverToken };
  } catch (cause) {
    throw new Error(`Invalid configuration file ${paths.configFile}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
};

export const configuredServerUrl = (mapping: Record<string, unknown>): string =>
  Object.hasOwn(mapping, "serverUrl") ? normalizeServerUrl(mapping.serverUrl) : DEFAULT_SERVER_URL;

export const loadServerConfiguration = async (paths: ConfigurationPaths, signal?: AbortSignal): Promise<ServerConfiguration> => {
  let source: string;
  try { source = await readConfigurationSource(paths, signal); }
  catch (cause) {
    if (cause instanceof MissingConfigurationFileError) return { serverUrl: DEFAULT_SERVER_URL };
    throw cause;
  }
  return parseServerConfiguration(source, paths);
};
