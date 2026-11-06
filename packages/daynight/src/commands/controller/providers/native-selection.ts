export type NativeModelOption = { readonly id: string; readonly aliases?: readonly string[]; readonly efforts: readonly string[] | null };
export type NativeModelObservation = { readonly models: readonly NativeModelOption[]; readonly model: string | null; readonly effort?: string | null };
export type NativeModelSelection = { readonly model: string | null; readonly effort?: string };

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
