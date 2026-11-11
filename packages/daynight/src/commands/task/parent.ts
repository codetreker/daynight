import { UsageError } from "../../cli/context.js";

export const parseParent = async (value: string | undefined, help: string): Promise<string | null | undefined> => {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  const { canonicalId } = await import("../../api/parse.js");
  const id = canonicalId(value);
  if (id === null) throw new UsageError("--parent must be a hyphenated Goal UUID or none.", help);
  return id;
};
