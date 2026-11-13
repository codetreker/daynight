import { expect, test } from "vitest";
import { formatOutboxDiagnostic } from "../../../src/commands/controller/outbox-diagnostic.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { SqliteAccessError } from "../../../src/platform/sqlite-error.js";

const ticket = { executionId: "execution", sessionId: "platform-session", claimId: "claim", executionGeneration: "2" } as ControllerLaunchTicket;

test("reports the original outbox failure through cleanup wrappers without exposing stored content", () => {
  const cause = new Error("secret prompt and SQL binding");
  const outbox = new SqliteAccessError("invalid-format", { database: "controller-journal", phase: "outbox-ack" }, { cause, outcome: "unknown" });
  const error = new AggregateError([new Error("cleanup"), outbox], "secret wrapper");
  const text = formatOutboxDiagnostic(error, ticket)!;
  expect(JSON.parse(text)).toMatchObject({ kind: "controller-sqlite-error", component: "outbox", phase: "outbox-ack", executionId: "execution", sessionId: "platform-session", claimId: "claim", generation: "2", error: { errors: [{}, { kind: "invalid-format", outcome: "unknown" }] } });
  expect(text).not.toContain("secret");
  expect(outbox.cause).toBe(cause);
  expect(formatOutboxDiagnostic(new Error("unrelated"), ticket)).toBeUndefined();
});

test("keeps a complete bounded JSON record and transaction outcome when details are large", () => {
  const outbox = new SqliteAccessError("invalid-format", { database: "controller-journal", phase: "outbox-append", file: "x".repeat(5000) });
  const error = new SqliteAccessError("cleanup-failed", { database: "controller-journal", phase: "close" }, { cause: outbox, outcome: "unknown" });
  const text = formatOutboxDiagnostic(error, { ...ticket, claimId: undefined, testExecutionId: "test-execution" } as ControllerLaunchTicket)!;
  expect(text.length).toBeLessThanOrEqual(4096);
  expect(JSON.parse(text)).toMatchObject({ testExecutionId: "test-execution", phase: "outbox-append", error: { kind: "invalid-format", outcome: "unknown" }, truncated: true });
});
