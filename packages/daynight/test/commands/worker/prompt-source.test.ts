import { describe, expect, it } from "vitest";
import { createWorkerPromptSource } from "../../../src/commands/worker/prompt-source.js";
import type { WorkerPromptCapture } from "../../../src/commands/worker/prompt-source.js";
import type { WorkerPromptResult } from "../../../src/api/worker-configuration.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const source = () => createWorkerPromptSource({ serverOrigin: "https://daynight.cc", userId, workerId });
const values = (capture: WorkerPromptCapture, text = ""): WorkerPromptResult[] => capture.selectors.map(({ key }) => ({ key, status: "value", value: { scope: key.scope, scopeId: key.scope === "project" ? key.projectId : key.scope === "user" ? userId : workerId, revision: text === "" ? "0" : "1", text, updatedAt: text === "" ? null : "2026-11-09T00:00:00Z" } }));

describe("Worker prompt source", () => {
  it("captures empty confirmed values in memory and restarts with unknown selectors", () => {
    const first = source(); first.setDemand([projectId(1)]); first.beginCycle();
    const batch = first.captureBatch()!;
    expect(batch.selectors.map(item => item.knownRevision)).toEqual([null, null, null]);
    expect(first.current(projectId(1))).toBeNull();
    expect(first.accept(batch, values(batch))).toBe(false);
    expect(first.current(projectId(1))).toMatchObject({ user: { text: "" }, project: { text: "" }, worker: { text: "" } });
    first.beginCycle(); const repeat = first.captureBatch()!;
    expect(repeat.selectors.map(item => item.knownRevision)).toEqual(["0", "0", "0"]);
    expect(first.accept(repeat, repeat.selectors.map(item => ({ key: item.key, status: "unchanged", revision: "0" })))).toBe(false);
    const restarted = source(); restarted.setDemand([projectId(1)]); restarted.beginCycle();
    expect(restarted.captureBatch()!.selectors.every(item => item.knownRevision === null)).toBe(true);
  });
  it("serves new demand without starving existing FIFO and terminates the cycle", () => {
    const s = source(); s.setDemand([1, 2, 3, 4, 5].map(projectId)); s.beginCycle();
    const first = s.captureBatch()!; s.setDemand([1, 2, 3, 4, 5, 6, 7].map(projectId));
    expect(s.accept(first, values(first))).toBe(true);
    const second = s.captureBatch()!;
    expect(second.selectors.map(item => item.key)).toEqual([{ scope: "project", projectId: projectId(6) }, { scope: "project", projectId: projectId(2) }, { scope: "project", projectId: projectId(3) }]);
    expect(s.accept(second, values(second))).toBe(true);
    const third = s.captureBatch()!; expect(third.selectors).toHaveLength(3);
    expect(s.accept(third, values(third))).toBe(false);
    expect(s.captureBatch()).toBeNull();
  });
  it("rejects late removed generations and clears values on explicit loss or close", () => {
    const s = source(); s.setDemand([projectId(1)]); s.beginCycle(); const old = s.captureBatch()!;
    s.setDemand([]); s.setDemand([projectId(1)]); expect(s.accept(old, values(old))).toBe(true);
    expect(s.current(projectId(1))).toBeNull(); const current = s.captureBatch()!;
    expect(current.selectors[0]?.knownRevision).toBeNull(); expect(s.accept(current, values(current))).toBe(false);
    expect(s.current(projectId(1))).not.toBeNull();
    s.beginCycle(); const again = s.captureBatch()!;
    const loss = values(again).map(item => item.key.scope === "project" ? { key: item.key, status: "unavailable" as const } : item);
    s.accept(again, loss); expect(s.current(projectId(1))).toBeNull();
    s.close(); expect(s.current(projectId(1))).toBeNull(); expect(s.accept(again, loss)).toBe(false);
  });
  it("stops catchup after every result in a batch fails", () => {
    const s = source(); s.setDemand([1, 2, 3, 4].map(projectId)); s.beginCycle();
    const batch = s.captureBatch()!;
    expect(s.accept(batch, batch.selectors.map(item => ({ key: item.key, status: "error", error: "timeout" })))).toBe(false);
    expect(s.captureBatch()).toBeNull();
    s.beginCycle(); expect(s.captureBatch()).not.toBeNull();
  });
  it("keeps last values on errors and rejects divergent same revisions atomically", () => {
    const s = source(); s.setDemand([projectId(1)]); s.beginCycle(); const a = s.captureBatch()!; s.accept(a, values(a, "old"));
    s.beginCycle(); const b = s.captureBatch()!;
    s.accept(b, b.selectors.map(item => ({ key: item.key, status: "error", error: "timeout" })));
    expect(s.current(projectId(1))?.user.text).toBe("old");
    s.beginCycle(); const c = s.captureBatch()!;
    expect(() => s.accept(c, values(c, "different"))).toThrow();
    expect(s.current(projectId(1))?.user.text).toBe("old");
    expect(s.captureBatch()).toBeNull();
  });
});
