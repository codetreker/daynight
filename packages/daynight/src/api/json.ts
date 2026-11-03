const losslessJson = JSON as unknown as {
  parse(text: string, reviver: (key: string, value: unknown, context: { readonly source?: string }) => unknown): unknown;
  rawJSON(text: string): unknown;
};

const maxVersion = 9_223_372_036_854_775_807n;

export const parseVersionArgument = (value: string): bigint => {
  if (!/^[0-9]+$/.test(value)) throw new Error("version must be a positive 64-bit integer.");
  const version = BigInt(value);
  if (version < 1n || version > maxVersion) throw new Error("version must be a positive 64-bit integer.");
  return version;
};

export const parseApiJson = (text: string): unknown => {
  const versionSources = new WeakMap<object, string>();
  const parsed = losslessJson.parse(text, function (this: object, key, value, context) {
    if (key === "version" && typeof value === "number" && context.source !== undefined && /^-?[0-9]+$/.test(context.source)) versionSources.set(this, context.source);
    return value;
  });
  const resourceVersions = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(resourceVersions); return; }
    if (typeof value !== "object" || value === null) return;
    const data = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(data)) {
      if (key === "properties") continue;
      const source = key === "version" ? versionSources.get(data) : undefined;
      if (source !== undefined) data[key] = BigInt(source);
      else resourceVersions(item);
    }
  };
  resourceVersions(parsed);
  return parsed;
};

export const stringifyApiJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (typeof item !== "bigint") return item;
  if (item < 1n || item > maxVersion) throw new Error("version must be a positive 64-bit integer.");
  return losslessJson.rawJSON(item.toString());
});
