export type WorkerLocalNativeOverrides = {
  readonly agentModel?: string;
  readonly agentReasoningEffort?: string;
};

export const parseWorkerLocalNativeOverrides = (worker: Record<string, unknown>): WorkerLocalNativeOverrides => {
  const result: { agentModel?: string; agentReasoningEffort?: string } = {};
  for (const field of ["agentModel", "agentReasoningEffort"] as const) {
    if (!Object.hasOwn(worker, field)) continue;
    const value = worker[field];
    if (typeof value !== "string" || value.trim() === "" || !value.isWellFormed() || /\p{Cc}/u.test(value) || Buffer.byteLength(value) > (field === "agentModel" ? 256 : 64)) {
      throw new TypeError(`worker.${field} must be nonempty text within its supported length. Delete the field to restore defaults.`);
    }
    result[field] = value;
  }
  if (result.agentModel !== undefined && typeof worker.model === "string" && worker.model.trim() !== "" && worker.model !== result.agentModel) {
    throw new TypeError("worker.model and worker.agentModel conflict. Use the same value or remove the legacy model field.");
  }
  return result;
};
