import { expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import { TaskCacheError } from "../src/features/task-cache/database";
import { taskCacheFailureDiagnostic } from "../src/features/task-cache/diagnostics";

it("classifies cache lifecycle failures precisely and preserves only known cause metadata", () => {
  const cause = new DOMException("Private database contents", "AbortError");
  const failure = new TaskCacheError("storage", cause);
  expect(taskCacheFailureDiagnostic(failure)).toEqual({ error_category: "storage", cause: { name: "TaskCacheError", category: "storage", cause: { name: "AbortError" } } });
  expect(failure.cause).toBe(cause);
  for (const category of ["blocked", "closed", "corrupt", "versionchange"] as const) expect(taskCacheFailureDiagnostic(new TaskCacheError(category)).error_category).toBe(category);
  expect(taskCacheFailureDiagnostic(new ApiError("protocol", 404, "principal_mismatch"))).toEqual({ error_category: "protocol", cause: { name: "ApiError", kind: "protocol", code: "principal_mismatch" } });
});

it("does not expose arbitrary exception names, messages, response codes or nested private contents", () => {
  const secret = "cookie=session-token; private task body";
  const arbitrary = new Error(secret, { cause: { Cookie: secret, responseBody: secret } }); arbitrary.name = secret;
  const failure = new ApiError("server", 500, secret, secret, undefined, new TaskCacheError("storage", arbitrary));
  const diagnostic = taskCacheFailureDiagnostic(failure);
  expect(JSON.stringify(diagnostic)).not.toContain(secret);
  expect(diagnostic).toEqual({ error_category: "server", cause: { name: "ApiError", kind: "server", cause: { name: "TaskCacheError", category: "storage", cause: { name: "Error", cause: { name: "Error" } } } } });
  expect(taskCacheFailureDiagnostic(new DOMException(secret, secret))).toEqual({ error_category: "storage", cause: { name: "DOMException" } });
  expect(failure.cause).toBeInstanceOf(TaskCacheError);
});

it("bounds a cyclic failure cause without serializing arbitrary values", () => {
  const error = new Error("Private request contents"); error.cause = error;
  const diagnostic = taskCacheFailureDiagnostic(error);
  expect(JSON.stringify(diagnostic)).toBe('{"error_category":"storage","cause":{"name":"Error","cause":{"name":"Error","cause":{"name":"Error","cause":{"name":"Error"}}}}}');
});
