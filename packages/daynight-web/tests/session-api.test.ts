import { createSessionApi } from "../src/api/sessions";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSessionCommand, parseSessionEvent, parseSessionSnapshot } from "../src/api/parse";
const fixture = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), `../daynight/test/session/fixtures/${name}.json`), "utf8"));
describe("browser session wire contract", () => {
  it("uses the same lossless command, snapshot and event codecs as the controller", () => {
    expect(parseSessionCommand(fixture("send-message"))).toEqual(fixture("send-message"));
    expect(parseSessionSnapshot(fixture("snapshot"))).toEqual(fixture("snapshot"));
    expect(parseSessionEvent(fixture("event"))).toEqual(fixture("event"));
  });
  it("rejects incompatible versions and optimistic initial-input controls", () => {
    expect(() => parseSessionCommand({ ...fixture("send-message"), protocol: "daynight.session.v2" })).toThrow();
    expect(() => parseSessionSnapshot({ ...fixture("snapshot"), initialInputState: "unknown" })).toThrow();
  });
});

afterEach(() => vi.unstubAllGlobals());
it("negotiates the startup report without weakening its current execution fence", async () => {
  const session = fixture("snapshot"), userId = "00000009-1111-4111-8111-111111111111";
  const report = { schemaVersion: 1, source: "worker", sessionId: session.sessionId, claimId: session.claimId, executionGeneration: session.executionGeneration, controllerInstanceId: session.identity.controllerInstanceId, revision: "1", observedAt: "2026-11-05T00:00:00.000Z", startup: { state: "unknown", reasonCode: "native_timeout" }, recovery: { state: "blocked", reasonCode: "native_identity_missing" } };
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ status: "registered", session, startupReport: report }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
  vi.stubGlobal("fetch", fetch);
  const api = createSessionApi(session.identity.projectId, session.identity.taskId, userId, vi.fn());
  expect(await api.current(new AbortController().signal)).toMatchObject({ startupReport: { startup: { state: "unknown" }, recovery: { state: "blocked" } } });
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("X-Daynight-Startup-Version")).toBe("1");
  report.executionGeneration = "9";
  await expect(api.current(new AbortController().signal)).rejects.toMatchObject({ code: "protocol" });
});
