export type NativeModelOption = { readonly id: string; readonly aliases?: readonly string[]; readonly efforts: readonly string[] | null; readonly label?: string; readonly hidden?: boolean; readonly defaultEffort?: string | null };
export type NativeModelObservation = { readonly models: readonly NativeModelOption[]; readonly model: string | null; readonly effort?: string | null };
export type NativeModelSelection = { readonly model: string | null; readonly effort?: string };

export class NativeCapabilityError extends Error {
  constructor(readonly code: "capability_error" | "limit_exceeded" | "cleanup_unknown", message: string, options?: ErrorOptions) { super(message, options); this.name = "NativeCapabilityError"; }
}

/** Validate the complete native observation before exposing or paging its contents. */
export const validateNativeModelObservation = (value: unknown): NativeModelObservation => {
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
  const invalid = (): never => { throw new NativeCapabilityError("capability_error", "Native model capability observation is invalid or unknown."); };
  const text = (item: unknown, bytes = 256): item is string => {
    if (typeof item !== "string" || !item.trim() || !item.isWellFormed() || /\p{Cc}/u.test(item)) return false;
    if (Buffer.byteLength(item) > bytes) throw new NativeCapabilityError("limit_exceeded", "Native model capability text exceeds its bound.");
    return true;
  };
  const list = (items: unknown, bytes: number, limit: number): boolean => {
    if (!Array.isArray(items)) return false;
    if (items.length > limit) throw new NativeCapabilityError("limit_exceeded", "Native model capability options exceed their bound.");
    return items.every(item => text(item, bytes)) && new Set(items).size === items.length;
  };
  if (!object(value) || !Array.isArray(value.models)) return invalid();
  if (value.models.length > 500) throw new NativeCapabilityError("limit_exceeded", "Native model catalog exceeds its bound.");
  if (value.models.length === 0 || value.model !== null && !text(value.model) || value.effort !== undefined && value.effort !== null && !text(value.effort, 64)) return invalid();
  const ids = new Set<string>();
  for (const model of value.models) {
    if (!object(model) || !text(model.id) || ids.has(model.id) || model.aliases !== undefined && !list(model.aliases, 256, 100)
      || model.efforts !== null && !list(model.efforts, 64, 100) || model.label !== undefined && !text(model.label, 1024)
      || model.hidden !== undefined && typeof model.hidden !== "boolean"
      || model.defaultEffort !== undefined && model.defaultEffort !== null && (!text(model.defaultEffort, 64) || !Array.isArray(model.efforts) || !model.efforts.includes(model.defaultEffort))) return invalid();
    ids.add(model.id);
  }
  // Leave room for the probe response and bounded stderr inside its 64 KiB supervisor budget.
  if (Buffer.byteLength(JSON.stringify(value)) > 60 * 1024) throw new NativeCapabilityError("limit_exceeded", "Native model capability output exceeds its bound.");
  return value as NativeModelObservation;
};

/** Validate native evidence without replacing an unknown or unsupported selection. */
export const assertNativeModelSelection = (provider: string, requested: NativeModelSelection, actual: NativeModelObservation): void => {
  const matches = (option: NativeModelOption, model: string) => option.id === model || option.aliases?.includes(model) === true;
  if (actual.model === null) throw new Error(`${provider} effective model is unknown; native selection cannot be validated.`);
  const matching = actual.models.filter(option => matches(option, actual.model!));
  const selected = requested.model === null ? matching.find(option => option.id === actual.model) ?? matching[0] : matching.find(option => matches(option, requested.model!)) ?? matching[0];
  if (selected === undefined) throw new Error(`${provider} effective model is absent from its native model catalog.`);
  if (requested.model === null && !matching.some(option => option.id === actual.model) && matching.some(option => JSON.stringify(option.efforts) !== JSON.stringify(selected.efforts))) throw new Error(`${provider} effective model aliases have ambiguous reasoning capabilities.`);
  if (requested.model !== null && !matches(selected, requested.model)) throw new Error(`${provider} did not apply the requested model from its native catalog.`);
  const effort = requested.effort ?? actual.effort;
  if (effort !== undefined && effort !== null && !selected.efforts?.includes(effort)) throw new Error(`${provider} model does not support the requested or inherited reasoning effort.`);
  if (requested.effort !== undefined) {
    if (actual.effort !== undefined && actual.effort !== requested.effort) throw new Error(`${provider} did not apply the requested reasoning effort.`);
  }
};
