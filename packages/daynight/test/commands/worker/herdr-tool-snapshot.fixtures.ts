import path from "node:path";
import { toolSelectionKey, type ResolvedToolLaunch } from "../../../src/platform/tool-executables.js";

/** Store inputs identify recipes; subprocess tests separately verify actual files. */
export const recordedHerdrTool = (tool: "codex" | "herdr", suffix = "A"): ResolvedToolLaunch => {
  const file = path.resolve("tools", `${tool}-${suffix}`);
  const value = { schemaVersion: 1 as const, tool, context: "herdr" as const, source: "explicit" as const, entryPath: file, canonicalEntryPath: file, executablePath: file, interpreterPath: null, command: { file, prefixArgs: [] }, artifacts: [{ role: "entry" as const, path: file, realPath: file, size: "1", sha256: "a".repeat(64) }] };
  return { ...value, selectionKey: toolSelectionKey(value) };
};
export const recordedHerdrTools = () => ({ agent: recordedHerdrTool("codex"), herdr: recordedHerdrTool("herdr"), agentObservation: { version: "1.0.0", checkedAt: "2026-11-04T00:00:00.000Z" }, herdrObservation: { version: "0.9.5", checkedAt: "2026-11-04T00:00:00.000Z" } });
