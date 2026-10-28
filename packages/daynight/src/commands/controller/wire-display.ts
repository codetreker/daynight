import type { TimelineEntry } from "../../session/protocol.js";
import type { SourceTimelineEntry } from "../../session/controller-protocol.js";

// Go's JSON encoder preserves HTML text on this transport, but still escapes
// these two Unicode separators in typed strings. Budget for that representation
// even when the controller's JSON.stringify leaves them as literal characters.
export const sessionWireBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029"));
const maxDisplayEntryBytes = 1_400_000;

// This is a display projection only: callers retain the original local entry.
// Interactive requests are authority-bearing and must never be replaced here.
// Both live delivery and local history use this same deterministic projection.
export function sessionDisplayEntry(entry: TimelineEntry): TimelineEntry;
export function sessionDisplayEntry(entry: SourceTimelineEntry): SourceTimelineEntry;
export function sessionDisplayEntry(entry: SourceTimelineEntry): SourceTimelineEntry {
  if (entry.kind === "interaction" || sessionWireBytes(entry) <= maxDisplayEntryBytes) return entry;
  return { entryId: entry.entryId, ...(entry.entrySeq === undefined ? {} : { entrySeq: entry.entrySeq }), revision: entry.revision, kind: "error", code: "display_budget_exceeded", message: "This entry exceeds the web display size limit. Its complete projected content is retained in the controller's local session journal." };
}
