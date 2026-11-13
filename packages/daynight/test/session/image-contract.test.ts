import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalSessionIntent, verifyTimelineImageMetadata, parseImageOccurrenceStatus, parseDirectImageContent } from "../../src/session/image-values.js";
import {
  parseSessionCommand,
  parseSessionResource,
  parseTimelineEntry,
} from "../../src/session/protocol.js";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
it("keeps source retry eligibility distinct from observation and saved originals", () => {
  const status = { imageId: id(1), revision: "9007199254740993", state: "failed", resourceId: null, action: "retry_source", error: { code: "decode_failed", message: "Saved original" } };
  expect(parseImageOccurrenceStatus(status).action).toBe("retry_source");
  expect(() => parseImageOccurrenceStatus({ ...status, state: "committed", resourceId: id(2) })).toThrow();
  expect(parseImageOccurrenceStatus({ ...status, state: "committed", resourceId: id(2), action: "read_saved", error: null }).action).toBe("read_saved");
  expect(() => parseImageOccurrenceStatus({ ...status, state: "unknown" })).toThrow();
  expect(() => parseImageOccurrenceStatus({ ...status, error: null })).toThrow();
  expect(() => parseImageOccurrenceStatus({ ...status, state: "unregistered", action: "none", error: null, resourceId: id(2) })).toThrow();
  expect(() => parseImageOccurrenceStatus({ ...status, unexpected: true })).toThrow();
});
it("matches the shared ordered intent vectors without changing their original identities", () => {
  const vectors = JSON.parse(readFileSync(new URL("./fixtures/image-intent-vectors.json", import.meta.url), "utf8")) as { command: unknown; canonical: string; sha256: string }[];
  for (const vector of vectors) {
    const canonical = canonicalSessionIntent(parseSessionCommand(vector.command));
    expect(canonical).toBe(vector.canonical);
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(vector.sha256);
  }
});
const image = (n: number) => ({
  type: "image",
  imageId: id(n),
  uploadId: id(n + 10),
  resourceId: id(n + 20),
  sha256: "a".repeat(64),
  byteLength: "10",
});
const fence = {
  sessionId: id(1),
  claimId: id(2),
  executionGeneration: "9007199254740993",
};
const command = () => ({
  protocol: "daynight.session.v1",
  contentRevision: 2,
  requestId: "request-1",
  operationId: id(3),
  ...fence,
  kind: "send_message",
  payload: {
    content: [{ type: "text", text: "参考" }, image(4), image(5)],
    expectedTurnId: null,
    target: {
      serverOrigin: "https://daynight.cc",
      actorUserId: id(6),
      fence,
      expectedNativeSessionId: null,
    },
    expectedImageCapabilityRevision: "1",
    draftId: id(7),
    draftRevision: "1",
  },
});
it("parses a real nonempty direct first chunk within the declared image length", () => {
  const spec = {
    uploadId: id(1), imageId: id(2), target: command().payload.target,
    name: '"'.repeat(1024), mediaType: "image/png", byteLength: "524288", sha256: "a".repeat(64),
  };
  const data = Buffer.alloc(524288, 0xa5).toString("base64");
  const input = { spec, offset: "0", sha256: "b".repeat(64), data };
  expect(parseDirectImageContent(input)).toEqual(input);
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(1_048_576);
  for (const invalid of [
    { ...input, offset: "1" }, { ...input, data: "" }, { ...input, data: "Zh==" },
    { ...input, data: Buffer.alloc(524289).toString("base64") },
    { ...input, spec: { ...spec, byteLength: "524287" } },
    { ...input, sha256: "invalid" }, { ...input, extra: true },
  ]) expect(() => parseDirectImageContent(invalid)).toThrow();
});
it("keeps image input origin in the intent while treating explicit user as the legacy default", () => {
  const original = parseSessionCommand(command());
  const user = parseSessionCommand({ ...command(), payload: { ...command().payload, origin: "user" } });
  const daynight = parseSessionCommand({ ...command(), payload: { ...command().payload, origin: "daynight" } });
  expect(user).toMatchObject({ payload: { origin: "user" } });
  expect(daynight).toMatchObject({ payload: { origin: "daynight" } });
  expect(canonicalSessionIntent(user)).toBe(canonicalSessionIntent(original));
  expect(canonicalSessionIntent(daynight)).not.toBe(canonicalSessionIntent(original));
});
describe("unified image wire input", () => {
  it("preserves ordered images with an exact initialization target", () => {
    expect(parseSessionCommand(command())).toEqual(command());
  });
  it("preserves a pure-image message without manufacturing text", () => {
    const c = command();
    c.payload.content = [image(4)] as typeof c.payload.content;
    expect(parseSessionCommand(c)).toEqual(c);
  });
  it("rejects duplicate occurrences and image order violations", () => {
    const c = command();
    c.payload.content = [image(4), image(4)] as typeof c.payload.content;
    expect(() => parseSessionCommand(c)).toThrow();
    c.payload.content = [
      image(4),
      { type: "text", text: "late" },
    ] as typeof c.payload.content;
    expect(() => parseSessionCommand(c)).toThrow();
  });
  it("rejects a target whose fence differs from its operation", () => {
    const c = command();
    c.payload.target.fence = { ...fence, executionGeneration: "2" };
    expect(() => parseSessionCommand(c)).toThrow();
  });
  it("accepts complete immutable image geometry in the single resource model", () => {
    const r = {
      resourceId: id(4),
      revision: "1",
      status: "available",
      name: "test.png",
      mediaType: "image/png",
      byteLength: "10",
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
      frameCount: 1,
      error: null,
    };
    expect(parseSessionResource(r)).toEqual(r);
    expect(() => parseSessionResource({ ...r, frameCount: null })).toThrow();
  });
  it("keeps an unavailable image occurrence without an invented resource", () => {
    const e = {
      entryId: id(5),
      entrySeq: "1",
      revision: "1",
      kind: "assistant_message",
      imageProjectionError: null,
      content: [
        {
          type: "image_unavailable",
          imageId: id(6),
          label: "image",
          error: { code: "source_unavailable", message: "Source unavailable." },
        },
      ],
    };
    expect(parseTimelineEntry(e)).toEqual(e);
  });
});

describe("persisted media projections", () => {
  const body = "😀 ![original](resource:original)";
  const metadata = () => ({ partId: id(40), revision: "2", textSha256: createHash("sha256").update(body).digest("hex"), complete: true, truncated: false, bindings: [{ imageId: id(41), start: 3, end: body.length, part: { type: "image", imageId: id(41), resourceId: id(42), label: "original" } }], retainedImages: [] });
  const entry = () => ({ entryId: id(43), entrySeq: "1", revision: "3", kind: "assistant_message", imageProjectionError: null, content: [{ type: "markdown", text: body, ...metadata() }] });
  it("verifies the exact UTF-8 body independently of the entry revision", async () => {
    const parsed = parseTimelineEntry(entry());
    await expect(verifyTimelineImageMetadata(parsed)).resolves.toBeUndefined();
    const changed = entry(); changed.content[0]!.text += "changed";
    await expect(verifyTimelineImageMetadata(parseTimelineEntry(changed))).rejects.toThrow();
  });
  it("requires a projection result for new media while preserving old text entries", () => {
    const { imageProjectionError, ...withoutProjection } = entry();
    expect(() => parseTimelineEntry(withoutProjection)).toThrow();
    expect(() => parseTimelineEntry({ ...withoutProjection, content: [{ type: "text", text: body }] })).not.toThrow();
  });
  it("rejects overlapping, repeated and surrogate-splitting bindings", () => {
    for (const change of [(value: ReturnType<typeof entry>) => { value.content[0]!.bindings[0]!.start = 1; }, (value: ReturnType<typeof entry>) => { value.content[0]!.bindings.push(value.content[0]!.bindings[0]!); }, (value: ReturnType<typeof entry>) => { value.content.push(value.content[0]!); }]) {
      const value = entry(); change(value); expect(() => parseTimelineEntry(value)).toThrow();
    }
  });
  it("keeps failed reasoning distinct from a successfully empty image set", () => {
    const failed = { entryId: id(43), entrySeq: "1", revision: "3", kind: "reasoning", text: body, markdown: { ...metadata(), bindings: null }, imageProjectionError: { code: "source_unavailable", message: "Projection is unavailable." } };
    expect(() => parseTimelineEntry(failed)).not.toThrow();
    expect(() => parseTimelineEntry({ ...failed, markdown: { ...failed.markdown, bindings: [] } })).toThrow();
    expect(() => parseTimelineEntry({ ...failed, imageProjectionError: null })).toThrow();
  });
  it("keeps the existing resource shape and validates every media extension field", () => {
    const resource = { resourceId: id(44), revision: "1", status: "available", name: "a".repeat(300), mediaType: "image/png", byteLength: "10", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1, error: null };
    expect(() => parseSessionResource(resource)).not.toThrow();
    expect(() => parseSessionResource({ ...resource, mediaType: "image/svg+xml" })).toThrow();
    expect(() => parseSessionResource({ ...resource, byteLength: "0" })).toThrow();
    expect(() => parseSessionResource({ ...resource, status: "pending" })).toThrow();
    expect(() => parseSessionResource({ resourceId: id(44), status: "available", name: "old", mediaType: "text/plain", byteLength: "0", sha256: "a".repeat(64), error: null })).not.toThrow();
  });
});

it("canonicalizes intent keys without changing literal escapes or attachment order", async () => {
  const { canonicalImageJson, canonicalSessionIntent } =
    await import("../../src/session/image-values.js");
  expect(canonicalImageJson({ z: "\\n", a: "\n", b: "中文" })).toBe(
    '{"a":"\\u000a","b":"中文","z":"\\\\n"}',
  );
  const c = parseSessionCommand(command());
  expect(canonicalSessionIntent({ ...c, requestId: "another" })).toBe(
    canonicalSessionIntent(c),
  );
  const swapped = command();
  swapped.payload.content.reverse();
  expect(canonicalImageJson(swapped)).not.toBe(canonicalImageJson(command()));
});

it("round trips fenced media requests and rejects mismatched result shapes", async () => {
  const { parseImageRequest, parseImageResponse } =
    await import("../../src/session/controller-protocol.js");
  const base = {
    protocol: "daynight.session.v1",
    ...fence,
    connectionEpoch: "3",
    requestId: id(9),
  };
  const req = {
    ...base,
    type: "image_request",
    action: "read_prepared",
    body: { preparationId: id(10), offset: "0", limit: 524288 },
  };
  expect(parseImageRequest(req)).toEqual(req);
  expect(() =>
    parseImageRequest({ ...req, body: { ...req.body, limit: 524289 } }),
  ).toThrow();
  const response = {
    ...base,
    type: "image_response",
    action: "read",
    result: {
      resourceId: id(8),
      sha256: "a".repeat(64),
      byteLength: "1",
      offset: "0",
      data: "AA==",
      eof: true,
    },
    error: null,
  };
  expect(parseImageResponse(response)).toEqual(response);
  expect(() => parseImageResponse({ ...response, action: "status" })).toThrow();
  expect(() =>
    parseImageResponse({
      ...response,
      error: { code: "source_unavailable", message: "Unavailable." },
    }),
  ).toThrow();
});
