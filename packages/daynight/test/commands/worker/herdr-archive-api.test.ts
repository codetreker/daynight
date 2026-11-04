import { describe, expect, it } from "vitest";
import { createHerdrArchiveApi, ensureHerdrRecordingResponsibility, HerdrArchiveHttpError, type HerdrArchiveApi } from "../../../src/commands/worker/herdr/archive-api.js";
import type { HerdrSessionState } from "../../../src/commands/worker/herdr/session-api.js";
import { sessionV2ReceiptDigest } from "../../../src/session/v2/protocol.js";
import type { SessionV2Message, SessionV2Owner } from "../../../src/session/v2/types.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: SessionV2Owner = { projectId: id(1), taskId: id(2), workerId: id(3), worktreeId: id(4), ownerUserId: id(5), serverOrigin: "https://daynight.example", provider: "codex" };
const expected = { owner, sessionId: id(6), claimId: id(7), executionGeneration: "1" };
const envelope = { protocol: "daynight.session.v2" as const, schemaVersion: 2 as const, projectionVersion: 1 as const, sessionId: id(6), claimId: id(7), executionGeneration: "1", agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const };
const receipt = async (): Promise<Extract<SessionV2Message, { type: "receipt" }>> => {
  const m: Extract<SessionV2Message, { type: "receipt" }> = { ...envelope, type: "receipt", payload: { finalizationId: id(8), disposition: "unavailable", dispositionDigest: "0".repeat(64), reason: "recording_not_enabled", sha256: null, byteLength: null, completeness: null, evidence: { recordingEnabled: false, selectedFrameCount: "0", registeredFrameCount: "0", captureError: null } } };
  m.payload.dispositionDigest = await sessionV2ReceiptDigest(m); return m;
};
describe("Herdr archive HTTP", () => {
  it("checks the original owner service before dispatching and verifies receipt digest and fence", async () => {
    let response: unknown = await receipt(), calls = 0;
    const api = createHerdrArchiveApi(owner.serverOrigin, "test-token", { fetch: async (_url, init) => { calls++; expect(new Headers(init?.headers).get("Daynight-Session-Protocol")).toBe("daynight.session.v2"); return Response.json(response); } });
    expect(await api.receipt(expected)).toEqual(response);
    response = { ...await receipt(), claimId: id(99) }; await expect(api.receipt(expected)).rejects.toThrow();
    response = await receipt(); (response as Extract<SessionV2Message, { type: "receipt" }>).payload.dispositionDigest = "0".repeat(64);
    await expect(api.receipt(expected)).rejects.toThrow();
    const before = calls;
    await expect(api.receipt({ ...expected, owner: { ...owner, serverOrigin: "https://other.example" } })).rejects.toThrow(); expect(calls).toBe(before);
  });
  it("does not replay unknown requests and exposes classified service errors", async () => {
    let calls = 0;
    const api = createHerdrArchiveApi(owner.serverOrigin, "test-token", { fetch: async () => { calls++; throw new TypeError("response lost"); } });
    await expect(api.receipt(expected)).rejects.toThrow("response lost"); expect(calls).toBe(1);
    const denied = createHerdrArchiveApi(owner.serverOrigin, "test-token", { fetch: async () => Response.json({ error: { code: "permission_denied", message: "denied" } }, { status: 403 }) });
    await expect(denied.receipt(expected)).rejects.toMatchObject({ status: 403, code: "permission_denied" });
    expect(new HerdrArchiveHttpError(503, "archive_pending")).toBeInstanceOf(Error);
  });
  it("preserves PUT bytes and rejects bounded responses before decoding", async () => {
    const raw = "{  \"fixed\": true }\n", answer = await receipt();
    const api = createHerdrArchiveApi(owner.serverOrigin, "test-token", { fetch: async (_url, init) => { expect(init?.method).toBe("PUT"); expect(init?.body).toBe(raw); return Response.json(answer); } });
    await expect(api.upload(expected, raw)).resolves.toEqual(answer);
    const bounded = createHerdrArchiveApi(owner.serverOrigin, "test-token", { maxResponseBytes: 64, fetch: async () => new Response("x".repeat(65)) });
    await expect(bounded.receipt(expected)).rejects.toThrow();
  });
  it("observes the original responsibility after response loss without repeating its registration", async () => {
    const responsibility = { responsibilityId: id(42), recordingEnabled: true };
    const state = { executionGeneration: "1", connectionEpoch: "1", ledger: { finalizationId: null, runs: [{ executionGeneration: "1", stopProof: null }] }, recording: [] } as unknown as HerdrSessionState;
    let calls = 0;
    const api = { state: async () => state, recording: async () => { calls++; state.recording.push({ executionGeneration: "1", responsibility, evidence: null }); throw new Error("response lost"); } } as unknown as HerdrArchiveApi;
    await ensureHerdrRecordingResponsibility(api, expected, responsibility);
    await ensureHerdrRecordingResponsibility(api, expected, responsibility); expect(calls).toBe(1);
    await expect(ensureHerdrRecordingResponsibility(api, expected, { ...responsibility, responsibilityId: id(43) })).rejects.toThrow();
  });
});
