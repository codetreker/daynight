// Production placeholder contracts from the same clipped one-line renderer, not arbitrary draft text.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/chat_composer.rs#L4941-L4954
export const nativeDisabledPlaceholders = [
  { message: "Input disabled.", identifyingPrefix: "Input disabled" },
  { message: "Viewing sub-agent — direct input is disabled", identifyingPrefix: "Viewing sub-agent" },
  { message: "Input disabled until setup completes.", identifyingPrefix: "Input disabled" },
  { message: "Shutting down...", identifyingPrefix: "Shutting down" },
  { message: "Answer the questions to continue.", identifyingPrefix: "Answer the questions to continue." },
  { message: "Respond to the tool suggestion to continue.", identifyingPrefix: "Respond to the tool suggestion to continue." },
  { message: "Respond to the MCP server request to continue.", identifyingPrefix: "Respond to the MCP server request to continue." },
  { message: "Chat stopped as a precaution", identifyingPrefix: "Chat stopped as a precaution" },
];
export const nativeDisabledClips = nativeDisabledPlaceholders.flatMap(({ message, identifyingPrefix }) =>
  Array.from({ length: message.length - identifyingPrefix.length + 1 }, (_, index) => ({
    message,
    visible: message.slice(0, identifyingPrefix.length + index),
  })));
