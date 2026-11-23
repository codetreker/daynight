import { normalizeTaskTagFilter } from "../../api/task-tag-filter.js";
import type { TaskTagFilter } from "../../api/task-tag-filter.js";
import { UsageError } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";

type Command = Extract<ParsedCommand, { readonly kind: "run" }>;

export const parseTagFilter = (command: Command, help: string): TaskTagFilter => {
  try {
    const tagIds = command.options.get("--tag") as readonly string[] | undefined;
    const tagMatch = command.options.get("--tag-match") as "all" | "any" | undefined;
    return normalizeTaskTagFilter({
      ...(tagIds === undefined ? {} : { tagIds }),
      ...(tagMatch === undefined ? {} : { tagMatch }),
      ...(command.options.has("--untagged") ? { untagged: true } : {}),
    });
  } catch (cause) {
    throw new UsageError(cause instanceof Error ? cause.message : "Invalid tag filter.", help);
  }
};
