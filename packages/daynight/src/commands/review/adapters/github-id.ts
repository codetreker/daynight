export const repositoryId = (value: unknown, subject: string): string => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "bigint" && value > 0n && value <= 9_223_372_036_854_775_807n) return value.toString();
  throw new Error(`${subject} must be a positive 64-bit integer.`);
};

export const fullDatabaseId = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 19 || !/^[1-9]\d*$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) throw new Error("GitHub repository full database ID must be a positive 64-bit decimal string.");
  return value;
};

const parse = JSON.parse as unknown as (source: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown) => unknown;
export const parseGitHubJson = (source: string): unknown => parse(source, (key, value, context) => {
  if (key === "id" && typeof value === "number" && !Number.isSafeInteger(value) && context.source !== undefined && /^-?(?:0|[1-9]\d*)$/.test(context.source)) return BigInt(context.source);
  return value;
});
