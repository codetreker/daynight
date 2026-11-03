import { expect, it } from "vitest";
import { formatError } from "../../src/platform/diagnostics.js";
import { SqliteAccessError } from "../../src/platform/sqlite-error.js";

it("exposes SQLite context and codes without printing stored values from cause messages", () => {
  const stored = 'private prompt {"token":"private-token"}';
  const cause = Object.assign(new SyntaxError(`Unexpected token in ${stored}`), { code: "SQLITE_CORRUPT" });
  const error = new SqliteAccessError("migration-failed", { database: "web", phase: "migrate", fromVersion: 0, toVersion: 1, stepVersion: 1 }, { cause, outcome: "rolled-back" });
  const output = formatError(error);
  expect(output).toContain("web");
  expect(output).toContain("migrate");
  expect(output).toContain('"fromVersion":0');
  expect(output).toContain('"toVersion":1');
  expect(output).toContain('"stepVersion":1');
  expect(output).toContain("SQLITE_CORRUPT");
  expect(output).toContain("SyntaxError");
  expect(output).not.toContain(stored);
  expect(output).not.toContain("private-token");
  expect(error.cause).toBe(cause);
});

it("keeps SQLite errors safe inside ordinary aggregate and cause formatting", () => {
  const error = new SqliteAccessError("cleanup-failed", { database: "journal", phase: "close" }, { cause: new Error("private stored JSON"), outcome: "committed" });
  const output = formatError(new Error("Shutdown failed.", { cause: new AggregateError([error, new Error("Other cleanup failed.")], "Multiple failures.") }));
  expect(output).toContain("Shutdown failed.");
  expect(output).toContain("Multiple failures.");
  expect(output).toContain("Other cleanup failed.");
  expect(output).toContain("committed");
  expect(output).not.toContain("private stored JSON");
});
