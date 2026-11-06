import { limited, readable } from "./projection.js";

type ToolInput = Record<string, unknown>;
const object = (value: unknown): value is ToolInput => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (input: ToolInput, excluded: readonly string[] = [], prefix = ""): string[] => Object.entries(input)
  .filter(([key]) => !excluded.includes(key))
  .map(([key, value]) => `${prefix}${key}: ${typeof value === "string" ? value : JSON.stringify(value) ?? String(value)}`);
const edit = (value: unknown): value is ToolInput & { old_string: string; new_string: string } => object(value) && typeof value.old_string === "string" && typeof value.new_string === "string";
const replacement = (input: { old_string: string; new_string: string }): string => `Before:\n${input.old_string}\n\nAfter:\n${input.new_string}`;

export const claudeApprovalDetail = (name: string, input: unknown): string => {
  const fallback = () => limited(readable(input));
  // JSON can escape NUL and unpaired surrogates that the text protocol rejects. Check
  // before truncation and keep their original escaped representation for display.
  const display = (detail: string) => detail.includes("\0") || !detail.isWellFormed() ? fallback() : limited(detail);
  if (!object(input)) return fallback();
  if (name === "Bash") {
    if (typeof input.command !== "string") return fallback();
    const description = Object.hasOwn(input, "description") ? fields({ description: input.description }) : [];
    return display([input.command, ...description, ...fields(input, ["command", "description"])].join("\n"));
  }
  if (["Write", "Edit", "MultiEdit"].includes(name)) {
    if (typeof input.file_path !== "string") return fallback();
    const header = [`file_path: ${input.file_path}`];
    // Permission-relevant extensions precede content that may exhaust the display budget.
    if (name === "Write") {
      if (typeof input.content !== "string") return fallback();
      return display([...header, ...fields(input, ["file_path", "content"]), `\nContent:\n${input.content}`].join("\n"));
    }
    if (name === "Edit") {
      if (!edit(input)) return fallback();
      return display([...header, ...fields(input, ["file_path", "old_string", "new_string"]), `\n${replacement(input)}`].join("\n"));
    }
    if (!Array.isArray(input.edits) || !input.edits.every(edit)) return fallback();
    const edits = input.edits;
    return display([
      ...header, ...fields(input, ["file_path", "edits"]),
      ...edits.flatMap((item, index) => fields(item, ["old_string", "new_string"], `Edit ${index + 1} `)),
      ...edits.map((item, index) => `\nEdit ${index + 1}\n${replacement(item)}`),
      ...(edits.length === 0 ? ["edits: []"] : []),
    ].join("\n"));
  }
  return display(fields(input).join("\n") || readable(input));
};
