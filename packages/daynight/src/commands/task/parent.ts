import { UsageError } from "../../cli/context.js";

export const parseParent = async (value: string | undefined, help: string): Promise<string | null | undefined> => {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  const { canonicalId } = await import("../../api/parse.js");
  const id = canonicalId(value);
  if (id === null) throw new UsageError("--parent must be a hyphenated Goal UUID or none.", help);
  return id;
};

export const parseParentTask = async (value: string | undefined, goalParent: string | null | undefined, help: string): Promise<string | undefined> => {
  if (value === undefined) return undefined;
  if (goalParent !== undefined) throw new UsageError("--parent-task conflicts with --parent.", help);
  const { canonicalId } = await import("../../api/parse.js");
  const id = canonicalId(value);
  if (id === null) throw new UsageError("--parent-task must be a hyphenated Task UUID.", help);
  return id;
};
