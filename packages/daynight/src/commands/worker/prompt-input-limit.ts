/** A complete prompt was rejected before any native input was submitted. */
export class PromptInputLimitError extends Error {
  readonly submission = "not-submitted" as const;
  constructor(readonly inputPath: "herdr_rpc" | "macos_terminal" | "web_ticket", readonly actualBytes: number, readonly maxBytes: number) {
    super(`Prompt input exceeds the ${inputPath} limit (${actualBytes} > ${maxBytes} bytes).`);
    this.name = "PromptInputLimitError";
  }
}
