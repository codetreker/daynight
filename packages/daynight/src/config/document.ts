import { parseDocument, YAMLParseError, YAMLWarning } from "yaml";
import { readConfigurationSource } from "./files.js";
import type { ConfigurationPaths } from "./paths.js";

export type ConfigurationDocument = {
  document: ReturnType<typeof parseDocument>;
  mapping: Record<string, unknown>;
};

const safeYamlFailure = (cause: unknown): Error => {
  // Parser messages can include secret scalar, alias, and tag text; retain only diagnostic metadata.
  if (cause instanceof YAMLParseError || cause instanceof YAMLWarning) {
    return new Error(`${cause.name}: ${cause.code} at offsets ${cause.pos.join(", ")}.`);
  }
  const category = cause instanceof ReferenceError ? "ReferenceError" : cause instanceof TypeError ? "TypeError" : cause instanceof RangeError ? "RangeError" : cause instanceof SyntaxError ? "SyntaxError" : "Error";
  return new Error(`YAML value decoding failed (${category}).`);
};

export const parseConfigurationDocument = (
  source: string,
  paths: ConfigurationPaths,
): ConfigurationDocument => {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, {
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      prettyErrors: false,
    });
  } catch (cause) {
    throw new Error(`Cannot parse YAML in ${paths.configFile}.`, { cause: safeYamlFailure(cause) });
  }
  const problems = [...document.errors, ...document.warnings];
  if (problems.length !== 0) {
    throw new Error(`Invalid YAML in ${paths.configFile}.`, {
      cause: new AggregateError(problems.map(safeYamlFailure), "YAML configuration was rejected."),
    });
  }
  let parsed: unknown;
  try {
    parsed = document.toJS();
  } catch (cause) {
    throw new Error(`Cannot decode YAML in ${paths.configFile}.`, { cause: safeYamlFailure(cause) });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Configuration must be a mapping.");
  }
  return { document, mapping: parsed as Record<string, unknown> };
};

export const readConfiguration = async (paths: ConfigurationPaths): Promise<ConfigurationDocument> =>
  parseConfigurationDocument(await readConfigurationSource(paths), paths);
