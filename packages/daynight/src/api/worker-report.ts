import { stringifyApiJson } from "./json.js";
import type { WorkerReport } from "./types.js";
import type { WorkerCloudReport } from "./worker-configuration.js";
import { boundToolPathTelemetry } from "./worker-tool-paths.js";

export const WORKER_REPORT_BYTES = 1_048_576;
export const WORKER_CONFIGURATION_REPORT_BYTES = 9 * 1_048_576;
type Report = WorkerReport & { readonly configuration?: WorkerCloudReport };
export type ToolPathsReportBudget = { readonly code: "report_budget_exceeded"; readonly omitted: boolean } | null;
const size = (value: unknown) => Buffer.byteLength(stringifyApiJson(value), "utf8");
const fitTools = (input: Report, maxBytes: number): Report => {
  if (input.toolPaths === undefined) return input;
  const { toolPaths, ...required } = input;
  const maximum = maxBytes - size(required) - 13;
  const bounded = { ...required, toolPaths: boundToolPathTelemetry(toolPaths, maximum) };
  // If even the intact targets do not fit, omit only this optional observation.
  return size(bounded) <= maxBytes ? bounded : required;
};
/** Preserve the original snapshot and expose any optional-report loss locally. */
export const prepareWorkerReport = (input: Report, maxBytes = WORKER_REPORT_BYTES): { readonly value: Report; readonly toolPathsBudget: ToolPathsReportBudget } => {
  let value = input.toolPaths === undefined ? input : { ...input, toolPaths: boundToolPathTelemetry(input.toolPaths) };
  if (size(value) > maxBytes) {
    value = fitTools(value, maxBytes);
    if (size(value) > maxBytes && value.runtimeConfiguration !== undefined) {
      const { runtimeConfiguration: _runtimeConfiguration, ...required } = value;
      // Inventory and configuration acknowledgements remain required.
      if (size(required) <= maxBytes) value = required;
    }
  }
  const reduced = input.toolPaths !== undefined && JSON.stringify(value.toolPaths) !== JSON.stringify(input.toolPaths);
  return { value, toolPathsBudget: reduced ? { code: "report_budget_exceeded", omitted: value.toolPaths === undefined } : null };
};
export const workerReportBody = (input: Report, maxBytes = WORKER_REPORT_BYTES) => {
  let prepared: ReturnType<typeof prepareWorkerReport> | undefined;
  const prepare = () => prepared ??= prepareWorkerReport(input, maxBytes);
  return {
    kind: "json" as const,
    maxBytes,
    // Evaluate inside exchange preparation so encoding failures retain their API outcome classification.
    get value(): Report { return prepare().value; },
    get toolPathsBudget(): ToolPathsReportBudget { return prepare().toolPathsBudget; },
  };
};
