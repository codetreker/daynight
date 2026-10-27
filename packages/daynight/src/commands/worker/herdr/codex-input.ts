export type CodexInputSurface = "composer" | "blocked" | "unknown";

// Herdr's OSC-derived idle/readiness can coexist with Codex's independent
// directory-trust screen. That screen discards paste but accepts Enter as trust.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/onboarding/directory_trust.rs#L97-L128
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/onboarding/onboarding_screen.rs#L631-L687
export const codexInputSurface = (visible: string): CodexInputSurface => {
  const lines = visible.split(/\r?\n/).map((line) => line.trimEnd());
  const composer = lines.findLastIndex((line) => /^\s*[›»]\s+(?:Ask Codex to do anything|Ask a follow-up question)\s*$/.test(line));
  const selected = lines.findLastIndex((line) => /^\s*[›»]\s*\d+[.)]\s+\S/.test(line));
  const trustTitle = lines.findLastIndex((line) => /^\s*Folder access\s*$/.test(line));
  const trustQuestion = lines.findLastIndex((line) => /^\s*Trust this folder\?/.test(line));
  // Numbered selection plus the renderer's Enter/Esc hint identifies an active
  // modal without interpreting arbitrary business prose as a consent request.
  // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/popup_consts.rs#L16-L39
  const footer = lines.findLastIndex((line) => /^\s*(?:enter\s+(?:continue(?: and create sandbox)?|select|confirm)\s*·.*\besc\s+(?:quit|back|cancel)\b|Press enter to confirm or esc to (?:go back|cancel)\b)/i.test(line));
  if (selected > composer && footer > selected) return "blocked";
  if (selected > composer && trustTitle >= 0 && trustQuestion > trustTitle && trustQuestion < selected) return "blocked";
  // Disabled placeholders retain the prompt glyph on the same rendered row.
  // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/chat_composer.rs#L4873-L4954
  if (lines.findLastIndex((line) => /^\s*(?:[›»]\s+)?(?:Input disabled|Viewing sub-agent)\b/.test(line)) > composer) return "blocked";
  if (composer < 0 || selected > composer) return "unknown";
  const after = lines.slice(composer + 1);
  // The visible startup header omits its loading model. A version header plus
  // placeholder is insufficient; the main widget supplies the model/cwd status.
  // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/startup_draft.rs#L467-L533
  // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget.rs#L470
  // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/status_surfaces.rs#L728-L737
  // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/status_line_style.rs#L118-L122
  const status = after.some((line) => /^\s*\S.*\s·\s(?:~(?=$|[\s\\/])|[\\/]|[a-z]:[\\/])/i.test(line) && !/^\s*(?:loading\b|enter\b|esc\b)/i.test(line));
  return status ? "composer" : "unknown";
};
