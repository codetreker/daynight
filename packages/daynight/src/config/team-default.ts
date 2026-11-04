import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap } from "yaml";
import { parseConfigurationDocument } from "./document.js";
import { readConfigurationSource, updateConfigurationFile } from "./files.js";
import { verifyConfigurationUpdate } from "./ownership.js";
import type { ConfigurationPaths } from "./paths.js";
import { configuredServerUrl } from "./server.js";
import type { ServerConfiguration } from "./server.js";

export type TeamDefaultSnapshot = { readonly present: false } | { readonly present: true; readonly value: unknown };

const mapping = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be a mapping.`);
  return value as Record<string, unknown>;
};

const pair = (root: Record<string, unknown>, origin: string, userId: string): TeamDefaultSnapshot => {
  if (!Object.hasOwn(root, "teamDefaults")) return { present: false };
  const defaults = mapping(root.teamDefaults, "teamDefaults");
  if (!Object.hasOwn(defaults, origin)) return { present: false };
  const accounts = mapping(defaults[origin], "The Team defaults for this server");
  return Object.hasOwn(accounts, userId) ? { present: true, value: accounts[userId] } : { present: false };
};

const checkServer = (root: Record<string, unknown>, observed: ServerConfiguration): void => {
  if (configuredServerUrl(root) !== observed.serverUrl || root.serverToken !== observed.serverToken) {
    throw new Error("The configured server or credential changed during the Team operation. Run the command again.");
  }
};

export const readTeamDefaultSnapshot = async (
  paths: ConfigurationPaths, observed: ServerConfiguration, userId: string, signal: AbortSignal,
): Promise<TeamDefaultSnapshot> => {
  const { mapping: root } = parseConfigurationDocument(await readConfigurationSource(paths, signal), paths);
  checkServer(root, observed);
  return pair(root, observed.serverUrl, userId);
};

export const writeTeamDefault = async (
  paths: ConfigurationPaths, observed: ServerConfiguration, userId: string,
  snapshot: TeamDefaultSnapshot, target: string, signal: AbortSignal,
): Promise<void> => {
  let attempted = false;
  try {
    await updateConfigurationFile(paths, async (source) => {
      if (source === undefined) throw new Error("The configuration was removed during the Team operation. Run the command again.");
      const { document, mapping: root } = parseConfigurationDocument(source, paths);
      checkServer(root, observed);
      if (!isDeepStrictEqual(pair(root, observed.serverUrl, userId), snapshot)) {
        throw new Error("The configured default Team changed during the Team operation. Run the command again.");
      }
      const ownership = { path: ["teamDefaults", observed.serverUrl, userId] as const };
      if (snapshot.present && snapshot.value === target) {
        // Retain identical YAML while the shared writer enforces token-file mode.
        attempted = true;
        return { kind: "write", result: undefined, source, ownership };
      }

      // Resolve mapping aliases before editing so ownership validation can detect
      // any collateral changes through other references to the same anchor.
      let node: unknown = document.contents;
      for (const key of ["teamDefaults", observed.serverUrl]) {
        if (isAlias(node)) node = node.resolve(document);
        if (!isMap(node)) throw new Error("Team default configuration must be a mapping.");
        let next = node.get(key, true);
        if (next === undefined) {
          node.set(key, document.createNode({}));
          next = node.get(key, true);
        }
        node = next;
      }
      if (isAlias(node)) node = node.resolve(document);
      if (!isMap(node)) throw new Error("The Team defaults for this server must be a mapping.");
      node.set(userId, target);
      const updatedSource = document.toString();
      verifyConfigurationUpdate(root, parseConfigurationDocument(updatedSource, paths).mapping, ownership);
      attempted = true;
      return { kind: "write", result: undefined, source: updatedSource, ownership };
    }, signal);
  } catch (cause) {
    if (!attempted) throw cause;
    try {
      // A replacement or lock cleanup may have failed after the file changed.
      // Observe the exact pair without replaying the write or assuming causation.
      const { mapping: root } = parseConfigurationDocument(await readConfigurationSource(paths), paths);
      const current = pair(root, observed.serverUrl, userId);
      const matches = current.present && current.value === target;
      throw new Error(`The Team default update failed; the current saved pair ${matches ? "matches" : "does not match"} the requested Team. Verify the configuration before retrying.`, { cause });
    } catch (observation) {
      if (observation instanceof Error && observation.cause === cause) throw observation;
      throw new AggregateError([cause, observation], "The Team default update failed and its current saved pair could not be read. Verify the configuration before retrying.");
    }
  }
};
