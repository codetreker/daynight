import { getSystemErrorMap } from "node:util";
import { OperationError } from "../../api/operation.js";
import type { WorkerCloudFailure } from "../../api/worker-configuration.js";
import { ToolSelectionError, type ToolSelectionCode } from "../../platform/tool-executables.js";
import { HerdrCommandDeadlineError, HerdrCommandError } from "./herdr/command.js";
import { NativeVersionOutputError } from "./herdr/version-probe.js";

export type ConfigurationFileOperation = "read" | "directory" | "persist";
export type ConfigurationFailureReason = ToolSelectionCode | "timeout" | "operation_limit" | "disposed" | "invalid_configuration" | "invalid_output" | "command_failed" | "unavailable";
export type ConfigurationFailure = Readonly<{
  code: WorkerCloudFailure["code"];
  reason: ConfigurationFailureReason;
  tool?: ToolSelectionError["tool"];
  context?: ToolSelectionError["context"];
  stage?: ToolSelectionError["stage"];
  systemCode?: string;
  operationKind?: OperationError["kind"];
}>;

/** Construct only at a configuration filesystem boundary, retaining its original failure. */
export class ConfigurationFileOperationError extends Error {
  constructor(readonly operation: ConfigurationFileOperation, cause: unknown) {
    super(`Worker configuration file ${operation} failed.`, { cause });
    this.name = "ConfigurationFileOperationError";
  }
}

const toolCodes: Readonly<Record<ToolSelectionCode, WorkerCloudFailure["code"]>> = {
  not_found: "not_found", permission_denied: "permission_denied", not_executable: "invalid_configuration",
  unsupported_launcher: "invalid_configuration", unrecognized_output: "invalid_output", incompatible_runtime: "invalid_configuration",
  probe_timeout: "timeout", cleanup_unknown: "unavailable", tool_identity_changed: "unavailable",
  legacy_tool_identity_missing: "unavailable", cancelled: "unavailable", invalid_path: "invalid_configuration", io_error: "io_error",
};
const filesystemCodes = new Set([...getSystemErrorMap().values()].map(([code]) => code));
const fileCodes = (error: unknown): readonly string[] | undefined => {
  if (error instanceof AggregateError) {
    if (error.errors.length === 0) return undefined;
    const codes = error.errors.map(fileCodes);
    return codes.some(code => code === undefined) ? undefined : codes.flatMap(code => code!);
  }
  return error instanceof Error && !(error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError)
    && "code" in error && typeof error.code === "string" && filesystemCodes.has(error.code) ? [error.code] : undefined;
};
const fileCode = (code: string): "not_found" | "permission_denied" | "timeout" | "io_error" =>
  code === "ENOENT" || code === "ENOTDIR" ? "not_found"
    : code === "EACCES" || code === "EPERM" ? "permission_denied"
      : code === "ETIMEDOUT" ? "timeout" : "io_error";

/** Project only established failure types; messages and arbitrary error properties are not evidence. */
export const classifyConfigurationFailure = (error: unknown): ConfigurationFailure => {
  if (error instanceof ToolSelectionError) return {
    code: toolCodes[error.code], reason: error.code, tool: error.tool, context: error.context, stage: error.stage,
  };
  if (error instanceof OperationError) return {
    code: error.kind === "deadline" || error.kind === "request_timeout" ? "timeout" : "unavailable",
    reason: error.kind === "deadline" || error.kind === "request_timeout" ? "timeout"
      : error.kind === "cancelled" || error.kind === "disposed" ? error.kind : "operation_limit",
    operationKind: error.kind,
  };
  if (error instanceof ConfigurationFileOperationError) {
    const codes = fileCodes(error.cause);
    if (codes !== undefined) {
      const categories = new Set(codes.map(fileCode)), code = categories.size === 1 ? fileCode(codes[0]!) : "io_error";
      return { code, reason: code,
        ...(new Set(codes).size === 1 ? { systemCode: codes[0]! } : {}) };
    }
  }
  if (error instanceof NativeVersionOutputError) return { code: "invalid_output", reason: "invalid_output" };
  if (error instanceof HerdrCommandDeadlineError) return { code: "timeout", reason: "timeout" };
  if (error instanceof HerdrCommandError && error.exitCode !== null && Number.isSafeInteger(error.exitCode) && error.exitCode > 0) return { code: "command_failed", reason: "command_failed" };
  return { code: "unavailable", reason: "unavailable" };
};
