/** Fixed measurement planes share the same journal and upload protocol. */
export const usageProfileId = (provider: string): string | null => {
  if (provider === "copilot") return "copilot-event-1.0.11-v1";
  if (provider === "codex") return "codex-snapshot-unaccountable-v1";
  return null;
};

export const usageProfileReasons = (provider: string): string[] => provider === "copilot"
  ? ["native_recovery_gap", "input_cache_semantics_unknown"]
  : provider === "codex" ? ["provider_unsupported"] : [];

export const usageCollectionState = (qualification: unknown, seal: boolean): string => qualification === "unsupported"
  ? "unsupported" : qualification === "verified" ? seal ? "partial" : "collecting" : "unavailable";
