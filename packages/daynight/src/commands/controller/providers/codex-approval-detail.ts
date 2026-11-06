import { record, type NativeObject } from "./native-rpc.js";
import { limited, readable } from "./projection.js";

const internalFields = new Set(["threadId", "turnId", "itemId", "startedAtMs", "environmentId", "approvalId", "availableDecisions", "proposedExecpolicyAmendment"]);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const extraContent = (value: NativeObject): string[] => Object.keys(value).length ? [readable(value)] : [];

export const codexApprovalDetail = (method: string, params: NativeObject, item?: NativeObject): string => {
  const remaining = Object.fromEntries(Object.entries(params).filter(([key, value]) => !internalFields.has(key) && value !== null && value !== undefined));
  const lines: string[] = [];
  const appendText = (key: string, label?: string) => {
    if (text(params[key])) { lines.push(label ? `${label}: ${params[key]}` : params[key]); delete remaining[key]; }
  };

  if (method === "item/commandExecution/requestApproval") {
    const command = params.command ?? (item?.type === "commandExecution" ? item.command : undefined);
    if (text(command)) {
      lines.push(command); delete remaining.command;
      const cwd = params.cwd ?? (item?.type === "commandExecution" ? item.cwd : undefined);
      if (text(cwd)) { lines.push(`cwd: ${cwd}`); delete remaining.cwd; }
      // Parsed actions are a lossy interpretation; the exact command owns its preview.
      delete remaining.commandActions;
      if (remaining.kind === "command") delete remaining.kind;
    }
    appendText("reason");
  } else if (method === "item/fileChange/requestApproval") {
    const changes = params.changes ?? (item?.type === "fileChange" ? item.changes : undefined);
    const diffs: string[] = [];
    if (Array.isArray(changes)) {
      for (const raw of changes) {
        const change = record(raw), kind = record(change.kind);
        const label = kind.type === "add" ? "Add" : kind.type === "delete" ? "Delete" : kind.type === "update" ? "Update" : undefined;
        if (text(change.path) && label) {
          lines.push(`${label}: ${change.path}${text(kind.move_path) ? ` → ${kind.move_path}` : ""}`);
          if (text(change.diff)) diffs.push(`${change.path}\n${change.diff}`);
          const extra = Object.fromEntries(Object.entries(change).filter(([key]) => !["path", "kind", "diff"].includes(key)));
          const extraKind = Object.fromEntries(Object.entries(kind).filter(([key]) => key !== "type" && !(key === "move_path" && (kind.move_path === null || text(kind.move_path)))));
          if (Object.keys(extraKind).length) extra.kind = extraKind;
          if (change.diff !== undefined && change.diff !== null && typeof change.diff !== "string") extra.diff = change.diff;
          diffs.push(...extraContent(extra));
        } else {
          lines.push(readable(raw));
        }
      }
      delete remaining.changes;
    } else if (changes !== null && changes !== undefined) {
      lines.push(readable({ changes })); delete remaining.changes;
    }
    appendText("reason");
    appendText("grantRoot", "Requested write root");
    // Keep every target and permission scope ahead of potentially large patches.
    lines.push(...extraContent(remaining));
    return limited([...lines, ...diffs].join("\n") || "No approval details were provided.");
  }

  // Unknown extensions can carry permission scope and must survive the projection.
  lines.push(...extraContent(remaining));
  return limited(lines.join("\n") || "No approval details were provided.");
};
