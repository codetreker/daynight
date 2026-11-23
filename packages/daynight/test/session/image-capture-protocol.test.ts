import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { parseImageCaptureRequest, parseImageCaptureReceipt } from "../../src/session/image-values.js";
import { parseControllerMessage, parseRelayMessage } from "../../src/session/controller-protocol.js";
import { parseSessionResource } from "../../src/session/protocol.js";
const captureId = randomUUID(), attemptId = randomUUID();
const occurrence = { imageId: randomUUID(), entryId: randomUUID(), container: "content", partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey: "original-native-part" };
const request = { captureId, attemptId, occurrence, nativeSource: null, locator: { kind: "external", url: "https://example.test/original.png" } };
const receipt = { captureId, attemptId, revision: "9007199254740993", occurrence, state: "reserved", resourceId: randomUUID(), resource: null, error: null };
const frame = { protocol: "daynight.session.v1", sessionId: randomUUID(), claimId: randomUUID(), executionGeneration: "2", connectionEpoch: "3", requestId: randomUUID() };
const validated = { mediaType: "image/png", byteLength: "10", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 };
test("capture requests and receipts require exact attempt and decimal revision fences", () => {
  expect(parseImageCaptureRequest(request)).toEqual(request);
  expect(parseImageCaptureReceipt(receipt, parseSessionResource)).toEqual(receipt);
  const { attemptId: _attempt, ...oldRequest } = request; expect(() => parseImageCaptureRequest(oldRequest)).toThrow();
  const { revision: _revision, ...oldReceipt } = receipt; expect(() => parseImageCaptureReceipt(oldReceipt, parseSessionResource)).toThrow();
  expect(() => parseImageCaptureReceipt({ ...receipt, revision: 1 }, parseSessionResource)).toThrow();
  expect(() => parseImageCaptureRequest({ ...request, unexpected: true })).toThrow();
});
test("capture WS consumers preserve register, capture-only query, commit and failure identities", () => {
  for (const [action, body] of [["register", request], ["query", { captureId }], ["commit", { captureId, attemptId, validated }], ["failed", { captureId, attemptId, error: { code: "decode_failed", message: "Malformed original" } }]] as const) {
    expect(parseControllerMessage({ ...frame, type: "image_capture", action, body })).toMatchObject({ action, body });
    expect(parseRelayMessage({ ...frame, type: "image_capture_result", action, result: receipt, error: null })).toMatchObject({ action, result: receipt });
  }
  expect(() => parseControllerMessage({ ...frame, type: "image_capture", action: "query", body: { captureId, attemptId } })).toThrow();
  expect(() => parseControllerMessage({ ...frame, type: "image_capture", action: "commit", body: { captureId, validated } })).toThrow();
  expect(() => parseRelayMessage({ ...frame, type: "image_capture_result", action: "query", result: receipt, error: { code: "conflict", message: "Conflict" } })).toThrow();
});
test("retry and read_capture use the original capture with an explicit attempt and reject a new locator", () => {
  expect(parseRelayMessage({ ...frame, type: "image_request", action: "retry_capture", body: { captureId, attemptId } })).toMatchObject({ body: { captureId, attemptId } });
  expect(parseControllerMessage({ ...frame, type: "image_response", action: "retry_capture", result: validated, error: null })).toMatchObject({ result: validated });
  expect(() => parseRelayMessage({ ...frame, type: "image_request", action: "retry_capture", body: { captureId, attemptId, locator: request.locator } })).toThrow();
  const body = { captureId, attemptId, sha256: validated.sha256, byteLength: "10", offset: "0", limit: 10 };
  expect(parseRelayMessage({ ...frame, type: "image_request", action: "read_capture", body })).toMatchObject({ body });
  const { attemptId: _attempt, ...oldRead } = body;
  expect(() => parseRelayMessage({ ...frame, type: "image_request", action: "read_capture", body: oldRead })).toThrow();
});
test("submit accepts only the three strict outcomes and retains the original request on a later attempt", () => {
  const currentAttempt = randomUUID();
  for (const outcome of [
    { kind: "validated", validated },
    { kind: "resource" },
    { kind: "failed", error: { code: "decode_failed", message: "Malformed original" } },
  ]) {
    const body = { request, attemptId: currentAttempt, outcome };
    expect(parseControllerMessage({ ...frame, type: "image_capture", action: "submit", body })).toMatchObject({ action: "submit", body });
    expect(parseRelayMessage({ ...frame, type: "image_capture_result", action: "submit", result: receipt, error: null })).toMatchObject({ action: "submit", result: receipt });
  }
  for (const outcome of [
    { kind: "validated" }, { kind: "resource", validated },
    { kind: "failed", error: { code: "decode_failed", message: "Malformed original" }, extra: true },
    { kind: "other" }, null,
  ]) {
    expect(() => parseControllerMessage({ ...frame, type: "image_capture", action: "submit", body: { request, attemptId, outcome } })).toThrow();
  }
  expect(() => parseControllerMessage({ ...frame, type: "image_capture", action: "submit", body: { request, attemptId, outcome: { kind: "resource" }, extra: true } })).toThrow();
});
