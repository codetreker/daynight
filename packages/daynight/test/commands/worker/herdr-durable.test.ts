import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertHerdrRecovery, herdrRunDirectory } from "../../../src/commands/worker/herdr/durable.js";

describe("durable Herdr recovery admission", () => {
  it("rejects an unknown original stop before creating another native process", () => {
    expect(() => assertHerdrRecovery({ phase: "stop_unknown", nativeSessionId: "native", initialAssignment: "transport_completed" })).toThrow(/stop/i);
  });
  it("does not replace a stopped conversation whose native identity is unknown", () => {
    expect(() => assertHerdrRecovery({ phase: "stopped_confirmed", nativeSessionId: null, initialAssignment: "transport_completed" })).toThrow(/native/i);
  });
  it("does not replay unknown initial input on recovery", () => {
    expect(() => assertHerdrRecovery({ phase: "stopped_confirmed", nativeSessionId: "native", initialAssignment: "unknown" })).toThrow(/input/i);
  });
  it("accepts only a confirmed stopped original conversation", () => {
    expect(() => assertHerdrRecovery({ phase: "stopped_confirmed", nativeSessionId: "native", initialAssignment: "transport_completed" })).not.toThrow();
  });
  it("uses bounded per-run directories and refuses unsafe instance identifiers", () => {
    const root = path.resolve("/state/worker/h");
    expect(herdrRunDirectory(root, "00000000-0000-4000-8000-000000000001")).toBe(path.join(root, "r", "AAAAAAAAQACAAAAAAAAAAQ"));
    expect(() => herdrRunDirectory("/state/worker/h", "../other")).toThrow();
  });
});
