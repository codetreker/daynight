import { isDeepStrictEqual } from "node:util";
import { parseConfigurationDocument } from "./document.js";
import type { ConfigurationPaths } from "./paths.js";

type RetainedSequenceOwnership = { field: string; identity: string; fields: readonly string[] };

type ConfigurationOwnership = {
  section?: string;
  fields: readonly string[];
  retainedSequence?: RetainedSequenceOwnership;
};

const mapping = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${field} must be a mapping.`);
  return value as Record<string, unknown>;
};

const outsideFields = (value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([field]) => !fields.includes(field)));

const sectionMapping = (value: Record<string, unknown>, section: string | undefined): Record<string, unknown> =>
  section === undefined ? value : Object.hasOwn(value, section) ? mapping(value[section], section) : {};

const unownedConfiguration = (value: Record<string, unknown>, ownership: ConfigurationOwnership): unknown => {
  const section = outsideFields(sectionMapping(value, ownership.section), ownership.fields);
  return ownership.section === undefined ? section : { root: outsideFields(value, [ownership.section]), section };
};

const retainedEntries = (
  value: Record<string, unknown>,
  ownership: ConfigurationOwnership,
  sequence: RetainedSequenceOwnership,
): Map<unknown, Record<string, unknown>> => {
  const section = sectionMapping(value, ownership.section);
  if (!Object.hasOwn(section, sequence.field)) return new Map();
  const entries = section[sequence.field];
  if (!Array.isArray(entries)) throw new TypeError(`${sequence.field} must be a sequence.`);
  return new Map(entries.map((value: unknown) => {
    const entry = mapping(value, sequence.field);
    return [entry[sequence.identity], outsideFields(entry, sequence.fields)];
  }));
};

export const verifyConfigurationUpdate = (
  before: Record<string, unknown>,
  updatedSource: string,
  paths: ConfigurationPaths,
  ownership: ConfigurationOwnership,
): void => {
  const { mapping: after } = parseConfigurationDocument(updatedSource, paths);
  const fail = (): never => {
    throw new Error("Configuration uses shared YAML aliases that would change unrelated settings. Separate the edited settings from those aliases, then run the command again.");
  };
  if (!isDeepStrictEqual(unownedConfiguration(before, ownership), unownedConfiguration(after, ownership))) fail();
  if (ownership.retainedSequence !== undefined) {
    const afterEntries = retainedEntries(after, ownership, ownership.retainedSequence);
    for (const [identity, entry] of retainedEntries(before, ownership, ownership.retainedSequence)) {
      if (afterEntries.has(identity) && !isDeepStrictEqual(entry, afterEntries.get(identity))) fail();
    }
  }
};
