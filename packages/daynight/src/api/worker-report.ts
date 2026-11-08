import { stringifyApiJson } from "./json.js";
import type { WorkerReport } from "./types.js";
import type { WorkerCloudReport } from "./worker-configuration.js";

const WORKER_REPORT_BYTES = 1_048_576;

export const workerReportBody = (input: WorkerReport & { readonly configuration?: WorkerCloudReport }) => ({
  kind: "json" as const,
  maxBytes: WORKER_REPORT_BYTES,
  // Evaluate inside exchange preparation so encoding failures retain their API outcome classification.
  get value() {
    if (input.runtimeConfiguration === undefined || Buffer.byteLength(stringifyApiJson(input), "utf8") <= WORKER_REPORT_BYTES) return input;
    const { runtimeConfiguration: _runtimeConfiguration, ...required } = input;
    // Source telemetry is optional; inventory and configuration acknowledgements are not.
    return Buffer.byteLength(stringifyApiJson(required), "utf8") <= WORKER_REPORT_BYTES ? required : input;
  },
});
