import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeHerdrAnsi } from "../../../src/commands/worker/herdr/recording-ansi.js";
import { openHerdrRecordingStore } from "../../../src/commands/worker/herdr/recording-store.js";
import { SESSION_V2_LIMITS, canonicalSessionJson } from "../../../src/session/v2/values.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { projectId: id(1), taskId: id(2), workerId: id(3), worktreeId: id(4), ownerUserId: id(5), serverOrigin: "https://daynight.example", provider: "codex" as const };
const start = "2026-11-04T00:00:00.000Z";
const binding = { instanceId: "daemon", sessionId: "w", workspaceId: "workspace", paneId: "pane", terminalId: "terminal", nativeSessionId: null };
const segment = { segmentId: id(8), segmentOrdinal: "1", executionGeneration: "1", binding, startedAt: start, endedAt: null, durationMs: null, gap: null };
const root = fileURLToPath(new URL("../../../../../.tmp/herdr-recording-test/", import.meta.url));
const directories: string[] = [];
const fixture = () => {
  mkdirSync(root, { recursive: true }); const directory = mkdtempSync(path.join(root, "run-")); directories.push(directory);
  const options = { directory, owner, sessionId: id(6), claimId: id(7) };
  const store = openHerdrRecordingStore(options); store.registerRun("1"); store.openSegment(segment);
  return { directory, options, store };
};
const screen = (value: string) => ({ width: 80, height: 2, rows: normalizeHerdrAnsi(value, 80, 2) });
const at = (elapsed: number) => ({ elapsedMs: String(elapsed), capturedAt: new Date(Date.parse(start) + elapsed).toISOString() });
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("Herdr production recording byte budget", () => {
  it("bounds the exact serialized files-and-index package and preserves already written frames", () => {
    const f = fixture();
    const rows = Array.from({ length: 16 }, () => [{ text: "x".repeat(16000), foreground: null, background: null, bold: false, italic: false, underline: false, inverse: false }]);
    let accepted = 0;
    for (let i = 0; i < 300; i++) {
      rows[0]![0]!.text = String(i).padStart(6, "0") + "x".repeat(15994);
      const result = f.store.sample(segment.segmentId, { width: 1000, height: 16, rows }, at(i * 350));
      if (!result.recorded) break;
      accepted++;
    }
    expect(accepted).toBeGreaterThan(200); expect(accepted).toBeLessThan(300);
    const snapshot = f.store.snapshot(), actualBytes = Buffer.byteLength(canonicalSessionJson({ files: snapshot.files, index: snapshot.index }));
    expect(actualBytes).toBeLessThanOrEqual(60 * 1024 * 1024);
    expect(actualBytes + Buffer.byteLength(canonicalSessionJson(snapshot.files.at(-1)))).toBeGreaterThan(60 * 1024 * 1024);
    expect(snapshot.files).toHaveLength(accepted); expect(snapshot.runs[0]!.captureError).toBe("recording_limit");
  }, 60_000);
});
