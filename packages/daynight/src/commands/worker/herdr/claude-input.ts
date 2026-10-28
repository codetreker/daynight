export type ClaudeInputSurface = "composer" | "blocked" | "unknown";
// The official Herdr Claude manifest identifies the prompt box, not OSC idle,
// as visible input readiness. Keep consent/menu footers outside that boundary.
// https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/detect/manifests/claude.toml
export const claudeInputSurface = (visible: string): ClaudeInputSurface => {
  const lines = visible.split(/\r?\n/).map(line => line.trimEnd());
  const prompt = lines.findLastIndex(line => /^\s*❯\s*(?:Try\s+["“].*["”])?\s*$/.test(line));
  const footer = lines.findLastIndex(line => /(?:enter to (?:select|confirm)|esc to cancel|select login method|do you trust the files)/i.test(line));
  const selected = lines.findLastIndex(line => /^\s*❯\s*\d+[.)]\s/.test(line));
  if (footer > prompt || selected > prompt) return "blocked";
  if (prompt < 1) return "unknown";
  const before = lines.slice(0,prompt).findLastIndex(line => /^\s*[─━]{3,}\s*$/.test(line));
  const after = lines.slice(prompt+1); const border = after.findIndex(line => /^\s*[─━]{3,}\s*$/.test(line));
  if (before < 0 || border < 0 || lines.slice(before+1,prompt).some(line => line.trim() !== "") || after.slice(0,border).some(line => line.trim() !== "")) return "unknown";
  return after.slice(border+1).some(line => /(?:\? for shortcuts|shift\+tab to|esc to interrupt)/i.test(line)) ? "composer" : "unknown";
};
