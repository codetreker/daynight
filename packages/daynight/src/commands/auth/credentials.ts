import { Document } from "yaml";
import { parseConfigurationDocument } from "../../config/document.js";
import { updateConfigurationFile } from "../../config/files.js";
import type { ConfigurationPaths } from "../../config/paths.js";
import { configuredServerUrl } from "../../config/server.js";
import type { ServerConfiguration } from "../../config/server.js";

export const updateCredential = async (
  paths: ConfigurationPaths,
  observed: ServerConfiguration,
  token: string | undefined,
  signal: AbortSignal,
): Promise<void> => updateConfigurationFile(paths, async (source) => {
  const current = source === undefined ? undefined : parseConfigurationDocument(source, paths);
  const mapping = current?.mapping ?? {};
  if (configuredServerUrl(mapping) !== observed.serverUrl || mapping.serverToken !== observed.serverToken) {
    throw new Error("Server or credential configuration changed during authentication. Run the command again for the current configuration.");
  }
  const document = current?.document ?? new Document({});
  if (token === undefined) document.delete("serverToken");
  else document.set("serverToken", token);
  return { kind: "write", result: undefined, source: document.toString(), ownership: { fields: ["serverToken"] } };
}, signal);
