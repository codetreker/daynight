import type { WorkerAgent } from "../../../api/types.js";

export type NativeInputBlocker = "menu" | "disabled";

export const nativeInputBlocker = (agent: WorkerAgent, visible: string): NativeInputBlocker | null => {
  const lines = visible.split(/\r?\n/).map(line => line.trimEnd());
  if (agent === "codex") {
    const selected = (line: string) => /^\s*[›»]\s*\d+[.)]\s+\S/.test(line);
    const laterPrompt = (index: number) => lines.slice(index + 1).some(line => /^\s*[›»]/.test(line));
    // Disabled placeholders occupy the composer's own prompt row.
    // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/chat_composer.rs#L4873-L4954
    const disabled = (line: string) => /^\s*[›»]\s+(?:Input disabled\.|Viewing sub-agent — direct input is disabled)\s*$/.test(line);
    const disabledRow = lines.findLastIndex(disabled);
    if (disabledRow >= 0 && !laterPrompt(disabledRow)) return "disabled";
    const selectedRow = lines.findLastIndex(selected);
    // Selected numbered rows and the matching keyboard footer identify native pickers.
    // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/popup_consts.rs#L16-L39
    const footer = lines.findLastIndex(line => /^\s*(?:enter\s+(?:continue(?: and create sandbox)?|select|confirm)\s*·\s*esc\s+(?:quit|back|cancel|skip)|Press enter to confirm or esc to (?:go back|cancel))\s*$/i.test(line));
    return selectedRow >= 0 && footer > selectedRow && !laterPrompt(footer) ? "menu" : null;
  }
  if (agent === "claude") {
    const laterPrompt = (index: number) => lines.slice(index + 1).some(line => /^\s*❯/.test(line));
    const selected = lines.findLastIndex(line => /^\s*❯\s*\d+[.)]\s+\S/.test(line));
    // Keep the footer controls together rather than matching ordinary prose about cancellation.
    // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/detect/manifests/claude.toml
    const footer = lines.findLastIndex(line => /^\s*Enter to (?:confirm|select(?:\s*·\s*(?:(?:tab\/arrow|arrow) keys|arrows|↑\/↓|↑↓) to navigate)?)\s*·\s*Esc to cancel\s*$/i.test(line));
    if (selected >= 0 && footer > selected && !laterPrompt(footer)) return "menu";
    const model = lines.findLastIndex(line => /^\s*Select model\s*$/i.test(line));
    const modelSelection = lines.findLastIndex(line => /^\s*❯\s+\S/.test(line));
    const modelFooter = lines.findLastIndex(line => /^\s*Enter to set as default\s*·\s*Esc to cancel\s*$/i.test(line));
    if (model >= 0 && modelSelection > model && modelFooter > modelSelection && !laterPrompt(modelFooter)) return "menu";
  }
  return null;
};
