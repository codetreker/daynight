/** Fixed measurement planes share the same journal and upload protocol. */
export const usageProfileId = (provider: string, profileId?: string): string | null => {
  if (provider === "codex" && profileId === "codex-response-0.169.0-v1") return profileId;
  if (provider === "copilot") return "copilot-event-1.0.11-v1";
  if (provider === "claude") return "claude-message-input-0.3.247-v1";
  if (provider === "codex") return "codex-snapshot-unaccountable-v1";
  return null;
};

export const usageProfileReasons = (provider: string, profileId?: string): string[] => provider === "copilot"
  ? ["native_recovery_gap", "input_cache_semantics_unknown"]
  : provider === "claude" ? ["subagent_scope_unknown", "native_recovery_gap"] : provider === "codex" ? profileId === "codex-response-0.169.0-v1" ? ["model_unknown", "subagent_scope_unknown", "native_recovery_gap"] : ["provider_unsupported"] : [];

export const usageCollectionState = (qualification: unknown, seal: boolean): string => qualification === "unsupported"
  ? "unsupported" : qualification === "verified" ? seal ? "partial" : "collecting" : "unavailable";
