// These labels describe the parent operation, not the child session's outcome.
export function codexSubagentActivity(value: unknown): { name: string; input: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.type !== "subAgentActivity" || typeof item.id !== "string" || !item.id) return null;
  const text = (key: string): string => typeof item[key] === "string" ? item[key] : "";
  const kind = text("kind");
  const name = kind === "started" ? "Start subagent" : kind === "interacted" ? "Interact with subagent" : kind === "interrupted" ? "Interrupt subagent" : "Subagent activity";
  return { name, input: JSON.stringify({ path: text("agentPath"), agentThreadId: text("agentThreadId"), activityKind: kind, model: text("model"), reasoningEffort: text("reasoningEffort") }, null, 2) };
}
