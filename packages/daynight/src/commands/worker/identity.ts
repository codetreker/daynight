import { randomUUID } from "node:crypto";
import { Document } from "yaml";
import { canonicalId } from "../../api/parse.js";
import { parseConfigurationDocument } from "../../config/document.js";
import { MissingConfigurationFileError } from "../../config/errors.js";
import { readConfigurationSource, updateConfigurationFile } from "../../config/files.js";
import type { ConfigurationPaths } from "../../config/paths.js";

const configuredWorkerIdentity = (mapping: Record<string, unknown>): string | undefined => {
  if (!Object.hasOwn(mapping, "workerId")) return undefined;
  const value = mapping.workerId;
  const identity = typeof value === "string" ? canonicalId(value) : null;
  if (identity === null) throw new Error("Configuration workerId must be a hyphenated UUID; the existing value was retained.");
  return identity;
};

export const ensureWorkerIdentity = async (
  paths: ConfigurationPaths,
  signal?: AbortSignal,
): Promise<string> => {
  signal?.throwIfAborted();
  try {
    const current = parseConfigurationDocument(await readConfigurationSource(paths, signal), paths);
    const identity = configuredWorkerIdentity(current.mapping);
    if (identity !== undefined) return identity;
  } catch (cause) {
    if (!(cause instanceof MissingConfigurationFileError)) throw cause;
  }
  return updateConfigurationFile(paths, async (source) => {
    const current = source === undefined ? undefined : parseConfigurationDocument(source, paths);
    if (current !== undefined) {
      const identity = configuredWorkerIdentity(current.mapping);
      if (identity !== undefined) return { kind: "unchanged", result: identity };
    }
    const identity = randomUUID();
    const document = current === undefined ? new Document({}) : current.document;
    document.set("workerId", identity);
    return { kind: "write", result: identity, source: document.toString(), ownership: { fields: ["workerId"] } };
  }, signal);
};
