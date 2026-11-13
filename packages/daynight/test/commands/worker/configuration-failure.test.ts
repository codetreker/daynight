import { describe, expect, it } from "vitest";
import { OperationError } from "../../../src/api/operation.js";
import { ToolSelectionError, type ToolSelectionCode } from "../../../src/platform/tool-executables.js";
import { classifyConfigurationFailure, ConfigurationFileOperationError } from "../../../src/commands/worker/configuration-failure.js";
import { HerdrCommandDeadlineError, HerdrCommandError } from "../../../src/commands/worker/herdr/command.js";
import { NativeVersionOutputError } from "../../../src/commands/worker/herdr/version-probe.js";
import type { WorkerCloudFailure } from "../../../src/api/worker-configuration.js";

const secret = "secret /private/path prompt $(command output)";
const systemError = (code: string) => Object.assign(new Error(secret), { code, syscall: "write", path: secret });

describe("configuration failure classification", () => {
  it.each<readonly [ToolSelectionCode, WorkerCloudFailure["code"]]>([
    ["not_found", "not_found"], ["permission_denied", "permission_denied"],
    ["not_executable", "invalid_configuration"], ["unsupported_launcher", "invalid_configuration"],
    ["unrecognized_output", "invalid_output"], ["incompatible_runtime", "invalid_configuration"],
    ["probe_timeout", "timeout"], ["cleanup_unknown", "unavailable"],
    ["tool_identity_changed", "unavailable"], ["legacy_tool_identity_missing", "unavailable"],
    ["cancelled", "unavailable"], ["invalid_path", "invalid_configuration"], ["io_error", "io_error"],
  ])("retains trusted tool detail for %s", (reason, code) => {
    const original = new Error(secret), error = new ToolSelectionError("copilot", "web", "probe", reason, { cause: original });
    error.message = secret;
    expect(classifyConfigurationFailure(error)).toEqual({ code, reason, tool: "copilot", context: "web", stage: "probe" });
    expect(error.cause).toBe(original);
    expect(JSON.stringify(classifyConfigurationFailure(error))).not.toContain(secret);
  });

  it.each<readonly [OperationError["kind"], WorkerCloudFailure["code"], string]>([
    ["deadline", "timeout", "timeout"], ["request_timeout", "timeout", "timeout"],
    ["cancelled", "unavailable", "cancelled"], ["disposed", "unavailable", "disposed"],
    ["request_limit", "unavailable", "operation_limit"], ["response_limit", "unavailable", "operation_limit"], ["total_limit", "unavailable", "operation_limit"],
  ])("preserves operation semantics for %s", (operationKind, code, reason) => {
    const original = new Error(secret), error = new OperationError(operationKind, { cause: original });
    expect(classifyConfigurationFailure(error)).toEqual({ code, reason, operationKind });
    expect(error.cause).toBe(original);
  });

  it.each<readonly [string, WorkerCloudFailure["code"]]>([
    ["ENOENT", "not_found"], ["ENOTDIR", "not_found"], ["EACCES", "permission_denied"], ["EPERM", "permission_denied"],
    ["ETIMEDOUT", "timeout"], ["EIO", "io_error"], ["ENOSPC", "io_error"], ["EISDIR", "io_error"],
  ])("uses system code %s only at a controlled file boundary", (systemCode, code) => {
    const original = systemError(systemCode), error = new ConfigurationFileOperationError("persist", original);
    expect(classifyConfigurationFailure(original)).toEqual({ code: "unavailable", reason: "unavailable" });
    expect(classifyConfigurationFailure(error)).toEqual({ code, reason: code, systemCode });
    expect(error.operation).toBe("persist");
    expect(error.cause).toBe(original);
    expect(JSON.stringify(classifyConfigurationFailure(error))).not.toContain(secret);
  });

  it("keeps all-I/O aggregates categorical without claiming one system cause", () => {
    const same = new AggregateError([systemError("EACCES"), systemError("EPERM")], secret);
    expect(classifyConfigurationFailure(new ConfigurationFileOperationError("read", same))).toEqual({ code: "permission_denied", reason: "permission_denied" });
    const mixed = new AggregateError([systemError("EACCES"), systemError("EIO")], secret);
    expect(classifyConfigurationFailure(new ConfigurationFileOperationError("directory", mixed))).toEqual({ code: "io_error", reason: "io_error" });
    const repeated = new AggregateError([systemError("EIO"), new AggregateError([systemError("EIO")], secret)], secret);
    expect(classifyConfigurationFailure(new ConfigurationFileOperationError("persist", repeated))).toEqual({ code: "io_error", reason: "io_error", systemCode: "EIO" });
  });

  it("rejects spoofed errors, untrusted chains and mixed format failures", () => {
    const tool = new ToolSelectionError("codex", "web", "probe", "not_found");
    const inputs: unknown[] = [
      { name: "ToolSelectionError", tool: "codex", context: "web", stage: "probe", code: "not_found" },
      Object.assign(new Error(secret), { name: "ToolSelectionError", code: "permission_denied" }),
      new Error(secret, { cause: tool }), new AggregateError([tool], secret),
      { name: "OperationError", kind: "deadline" }, new TypeError(secret), new RangeError(secret), undefined,
      new ConfigurationFileOperationError("persist", { code: "EIO" }),
      new ConfigurationFileOperationError("persist", systemError("unrecognized_code")),
      new ConfigurationFileOperationError("persist", Object.assign(new TypeError(secret), { code: "EIO" })),
      new ConfigurationFileOperationError("persist", new AggregateError([systemError("EIO"), new SyntaxError(secret)], secret)),
      new ConfigurationFileOperationError("persist", new AggregateError([], secret)),
    ];
    for (const error of inputs) expect(classifyConfigurationFailure(error)).toEqual({ code: "unavailable", reason: "unavailable" });
    expect(JSON.stringify(inputs.map(classifyConfigurationFailure))).not.toContain(secret);
  });

  it("recognizes existing native output, deadline and confirmed command failures", () => {
    const output = new NativeVersionOutputError("codex"), deadline = new HerdrCommandDeadlineError();
    output.message = secret; deadline.message = secret;
    expect(classifyConfigurationFailure(output)).toEqual({ code: "invalid_output", reason: "invalid_output" });
    expect(classifyConfigurationFailure(deadline)).toEqual({ code: "timeout", reason: "timeout" });
    expect(classifyConfigurationFailure(new HerdrCommandError(secret, 17, null, secret))).toEqual({ code: "command_failed", reason: "command_failed" });
    for (const exit of [null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(classifyConfigurationFailure(new HerdrCommandError(secret, exit, null, secret))).toEqual({ code: "unavailable", reason: "unavailable" });
    }
  });
});
