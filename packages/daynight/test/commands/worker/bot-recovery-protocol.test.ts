import { describe, expect, it } from "vitest";
import { parseBotRecoveryGrant, parseBotRecoveryIdentity, parseBotRecoveryObservation, parseBotRecoveryRegistration, parseBotRecoveryReport, parseBotRecoveryResult } from "../../../src/commands/worker/bots/recovery-protocol.js";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const identity = { botRecoveryVersion: 1, serviceOrigin: "https://daynight.test", recoveryIdentity: Buffer.alloc(32, 3).toString("base64url") };
const binding = { sessionId: id(1), testExecutionId: id(2), nativeSessionId: "original-native" };
const registration = { ...identity, ...binding, operationId: id(3), botVersion: "9223372036854775807" };
const grant = { ...identity, ...binding, operationId: id(3), expectedHostingGeneration: "9007199254740993", controllerToken: `dncontroller_${Buffer.alloc(32, 4).toString("base64url")}`, grant: { protocol: "daynight.session.v1", testExecutionId: id(2), controllerId: id(4), controllerInstanceId: id(5), executionGeneration: "2", kind: "reconnect", previousGeneration: "1", stopProof: { recordId: id(6), previousControllerInstanceId: id(7), stoppedAt: "2026-11-19T00:00:00Z" } } };
const receipt = { botRecoveryVersion: 1, operationId: id(3), kind: "takeover", workerId: id(8), hostingGeneration: "9007199254740993", botVersion: "9223372036854775807", ...binding, executionGeneration: "2", controllerId: id(4), controllerInstanceId: id(5), grantExpiresAt: "2026-11-19T00:15:00Z", controllerTokenHash: "a".repeat(64) };
const observation = { schemaVersion: 1, botId: id(9), botVersion: "9007199254740993", workerId: id(8), machine: { id: id(10), name: "Original machine" }, provider: "codex",
  ...binding, hostingGeneration: "9007199254740993", executionGeneration: "2", connectionEpoch: "0", state: "offline", reason: "worker_heartbeat_expired",
  observedAt: "2026-11-19T00:00:00Z", workerLastSeenAt: "2026-11-18T00:00:00Z", sessionLastSeenAt: null, freshUntil: null, currentTurnId: null };

describe("Bot recovery versioned protocol", () => {
  it("preserves original identity and exact versions, independently from current authorization", () => {
    expect(parseBotRecoveryIdentity(identity)).toEqual(identity);
    expect(parseBotRecoveryRegistration(registration)).toEqual(registration);
    expect(parseBotRecoveryGrant(grant)).toEqual(grant);
    expect(parseBotRecoveryResult({ receipt, current: false })).toEqual({ receipt, current: false });
    expect(parseBotRecoveryResult({ receipt: { ...receipt, kind: "register", grantExpiresAt: null, controllerTokenHash: null }, current: true }).receipt.kind).toBe("register");
    expect(parseBotRecoveryGrant({ ...grant, grant: { ...grant.grant, previousGeneration: null, stopProof: null } }).grant.stopProof).toBeNull();
    expect(parseBotRecoveryRegistration({ ...registration, nativeSessionId: null }).nativeSessionId).toBeNull();
  });
  it("rejects missing, additional, imprecise and private response fields", () => {
    for (const [parse, input] of [[parseBotRecoveryIdentity, identity], [parseBotRecoveryRegistration, registration], [parseBotRecoveryGrant, grant]] as const) {
      expect(() => parse({ ...input, unknown: 1 })).toThrow();
      for (const key of Object.keys(input)) { const copy: Record<string, unknown> = { ...input }; delete copy[key]; expect(() => parse(copy)).toThrow(); }
    }
    for (const botVersion of [1, "0", "01", "9223372036854775808"]) expect(() => parseBotRecoveryRegistration({ ...registration, botVersion })).toThrow();
    for (const recoveryIdentity of [null, "bad", `${identity.recoveryIdentity}=`]) expect(() => parseBotRecoveryIdentity({ ...identity, recoveryIdentity })).toThrow();
    expect(() => parseBotRecoveryIdentity({ ...identity, serviceOrigin: "https://daynight.test/" })).toThrow();
    expect(() => parseBotRecoveryIdentity({ ...identity, botRecoveryVersion: 2 })).toThrow();
    expect(() => parseBotRecoveryRegistration({ ...registration, operationId: "00000000-0000-0000-0000-000000000000" })).toThrow();
    expect(() => parseBotRecoveryGrant({ ...grant, controllerToken: "dncontroller_bad" })).toThrow();
    expect(() => parseBotRecoveryGrant({ ...grant, grant: { ...grant.grant, stopProof: null } })).toThrow();
    expect(() => parseBotRecoveryResult({ receipt: { ...receipt, controllerToken: grant.controllerToken }, current: true })).toThrow();
    expect(() => parseBotRecoveryResult({ receipt: { ...receipt, grantExpiresAt: null }, current: true })).toThrow();
    expect(() => parseBotRecoveryResult({ receipt, current: "true" })).toThrow();
  });
  it("parses reports with their own hosting fence and rejects malformed result/fence", () => {
    const report = { ...identity, hostingGeneration: "2", report: { botVersion: "3", fence: { sessionId: binding.sessionId, testExecutionId: binding.testExecutionId, executionGeneration: "1", connectionEpoch: "0" }, controllerId: id(4), controllerInstanceId: id(5), nativeSessionId: binding.nativeSessionId, result: { state: "ready", code: null } } };
    expect(parseBotRecoveryReport(report)).toEqual(report);
    expect(parseBotRecoveryReport({ ...report, report: { ...report.report, fence: null, result: { state: "failed", code: "recovering" } } }).report.fence).toBeNull();
    expect(() => parseBotRecoveryReport({ ...report, report: { ...report.report, result: { state: "ready", code: "bad" } } })).toThrow();
    expect(() => parseBotRecoveryReport({ ...report, report: { ...report.report, fence: { ...report.report.fence, connectionEpoch: "-1" } } })).toThrow();
  });
  it("validates a complete observation and preserves unknown values without inventing a Session snapshot", () => {
    expect(parseBotRecoveryObservation(observation)).toEqual(observation);
    const unbound = { ...observation, machine: null, sessionId: null, testExecutionId: null, nativeSessionId: null, hostingGeneration: null, executionGeneration: null, connectionEpoch: null };
    expect(parseBotRecoveryObservation(unbound)).toEqual(unbound);
    for (const key of Object.keys(observation)) {
      const incomplete: Record<string, unknown> = { ...observation }; delete incomplete[key];
      expect(() => parseBotRecoveryObservation(incomplete)).toThrow();
    }
    expect(() => parseBotRecoveryObservation({ ...observation, synchronized: true })).toThrow();
  });
  it.each([
    ["schemaVersion", 2], ["botId", "bad"], ["botVersion", 9007199254740992], ["workerId", "bad"],
    ["machine", { id: id(10), name: "Original", unexpected: true }], ["provider", "unknown"], ["sessionId", "bad"], ["testExecutionId", null],
    ["nativeSessionId", ""], ["hostingGeneration", "0"], ["executionGeneration", "01"], ["connectionEpoch", "-1"],
    ["state", "ready"], ["reason", ""], ["observedAt", "not-a-time"], ["workerLastSeenAt", 0], ["sessionLastSeenAt", "bad"],
    ["freshUntil", "bad"], ["currentTurnId", ""],
  ])("rejects malformed observation field %s", (key, value) => {
    expect(() => parseBotRecoveryObservation({ ...observation, [key as string]: value })).toThrow();
  });
});
