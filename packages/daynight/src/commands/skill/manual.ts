export const manualTopicFiles = [
  "references/setup-and-projects.md",
  "references/tasks.md",
  "references/steps.md",
  "references/materials.md",
  "references/write-safety.md",
  "references/session-reads.md",
  "references/session-messages.md",
  "references/webhooks.md",
  "references/worker-operations.md",
] as const;

export const validateManualContents = (contents: Uint8Array): void => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  if (/^[\s\p{White_Space}]*$/u.test(text)) throw new Error("Daynight CLI manual must not be empty or whitespace.");
};
