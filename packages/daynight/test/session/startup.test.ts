import { describe, expect, it } from "vitest";
import { parseSessionStartupReport } from "../../src/session/startup.js";
import { parseCurrentSessionResponse } from "../../src/session/controller-protocol.js";
import snapshot from "./fixtures/snapshot.json" with { type: "json" };

const id = "11111111-1111-4111-8111-111111111111";
const report = () => ({ schemaVersion: 1, source: "worker", sessionId: id, claimId: id,
  executionGeneration: "1", controllerInstanceId: id, revision: "1", observedAt: "2026-11-05T00:00:00.000Z",
  startup: { state: "unknown", reasonCode: "native_timeout" },
  recovery: { state: "blocked", reasonCode: "native_identity_missing" } });

describe("session startup report", () => {
  it("preserves unknown startup independently of blocked recovery", () => {
    expect(parseSessionStartupReport(report())).toEqual(report());
  });
  it("accepts legacy missing evidence and fences negotiated current reports", () => {
    expect(parseCurrentSessionResponse({ status: "registered", session: snapshot })).toEqual({ status: "registered", session: snapshot });
    const bound = { ...report(), sessionId: snapshot.sessionId, claimId: snapshot.claimId, executionGeneration: snapshot.executionGeneration, controllerInstanceId: snapshot.identity.controllerInstanceId };
    expect(parseCurrentSessionResponse({ status: "registered", session: snapshot, startupReport: bound })).toHaveProperty("startupReport", bound);
    expect(parseCurrentSessionResponse({ status: "registered", session: snapshot, startupReport: null })).toHaveProperty("startupReport", null);
    expect(() => parseCurrentSessionResponse({ status: "registered", session: snapshot, startupReport: { ...bound, executionGeneration: "2" } })).toThrow();
  });
  it.each([
    { schemaVersion: 2 }, { source: "browser" }, { revision: "0" }, { revision: "9223372036854775808" },
    { executionGeneration: "01" }, { sessionId: "private/path" }, { observedAt: "2026-02-30T00:00:00Z" },
    { error: "private provider output" }, { startup: { state: "failed", reasonCode: "native_timeout" } },
    { startup: { state: "ready", reasonCode: "evidence_missing" } },
    { recovery: { state: "none", reasonCode: "native_identity_missing" } },
    { recovery: { state: "blocked", reasonCode: null } },
  ])("rejects malformed or contradictory observations: %j", patch => {
    expect(() => parseSessionStartupReport({ ...report(), ...patch })).toThrow();
  });
});
