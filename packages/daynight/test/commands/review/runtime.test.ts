import { describe, expect, it } from "vitest";
import { formatCoordinatorEvent } from "../../../src/commands/review/runtime.js";

describe("coordinator event formatting", () => {
  it("formats durable execution context and retry time", () => {
    expect(formatCoordinatorEvent({ level: "error", phase: "retry", message: "missing marker", repository: "o/r", number: 4,
      reviewId: "uuid", revision: 2, attempt: 1, retryAt: 1_000 })).toBe("o/r PR 4 review=uuid revision=2 attempt=1 retry: missing marker retryAt=1970-01-01T00:00:01.000Z");
  });

  it("reports the affected repository and the complete original error chain", () => {
    expect(formatCoordinatorEvent({ level: "error", phase: "poll", repository: "o/r", message: "Polling failed.",
      error: new Error("Cannot read PRs", { cause: new AggregateError([new Error("HTTP 403"), new Error("Rate limited")], "API rejected") }) }))
      .toBe("o/r poll: Polling failed.\nCannot read PRs\nCaused by: API rejected\nHTTP 403\nRate limited");
  });
});
