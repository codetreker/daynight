import path from "node:path";
import { toolSelectionKey, type ResolvedToolLaunch } from "../../src/platform/tool-executables.js";

/** A frozen storage contract fixture; process tests supply their own executable. */
export const frozenToolLaunch = (tool: "codex" | "copilot" = "codex", context: "web" | "herdr" = "web"): ResolvedToolLaunch => {
  const file = path.resolve(import.meta.dirname, "fixtures", `${tool}-fixture`);
  const launch: ResolvedToolLaunch = { schemaVersion: 1, tool, context, source: "explicit", entryPath: file, canonicalEntryPath: file,
    executablePath: file, interpreterPath: null, command: { file, prefixArgs: [] },
    artifacts: [{ role: "entry", path: file, realPath: file, size: "0", sha256: "a".repeat(64) }], selectionKey: "" };
  launch.selectionKey = toolSelectionKey(launch);
  return launch;
};
