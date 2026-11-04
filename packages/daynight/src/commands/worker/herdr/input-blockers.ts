import type { WorkerAgent } from "../../../api/types.js";

export type NativeInputBlocker = "menu" | "disabled";

const footerGap = String.raw`(?:[ \t]+|[ \t]*\n[ \t]*)`;
const footerSeparator = String.raw`[ \t]*(?:\n[ \t]*)?·[ \t]*(?:\n[ \t]*)?`;
// ShortcutHint renders one key or a two-key chord; runtime bindings also replace Enter/Esc.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/key_hint.rs#L68-L122
const footerKey = String.raw`(?:(?:ctrl|shift|alt|super)\+|[⌃⇧⌥⌘^])*(?:enter|esc|tab|home|end|pgup|pgdn|space|backspace|del|insert|left|right|up|down|f\d{1,2}|[^\s·›»❯])`;
const footerShortcut = `${footerKey}(?:${footerGap}${footerKey})?`;
const pickerAccept = `${footerShortcut}${footerGap}(?:select|default|apply|toggle|open|choose|confirm|continue(?:${footerGap}and${footerGap}create${footerGap}sandbox)?)`;
const pickerCancel = `${footerShortcut}${footerGap}(?:back|close|quit|cancel|skip)`;
const pickerExtra = `${footerShortcut}${footerGap}(?:session|search)`;
// Shared pickers allow unbound actions; model/effort rows add the session action.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/popup_consts.rs#L16-L63
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/session_model_selection.rs#L53-L83
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/config_panel/render.rs#L43-L58
const pickerFooter = `${pickerAccept}(?:${footerSeparator}${pickerExtra})*(?:${footerSeparator}${pickerCancel})?|${pickerExtra}(?:${footerSeparator}${pickerCancel})?|${pickerCancel}`;
const textualFooter = `Press${footerGap}${footerShortcut}${footerGap}to${footerGap}confirm${footerGap}or${footerGap}${footerShortcut}${footerGap}to${footerGap}(?:go${footerGap}back|cancel|continue${footerGap}working)(?:${footerGap}or${footerGap}${footerShortcut}${footerGap}to${footerGap}open${footerGap}thread)?`;
// Configuration menus have group/search hints and distinct search cancellation labels.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/config_panel/render.rs#L349-L430
const configurationGroup = `${footerShortcut}(?:/${footerShortcut})?${footerGap}group`;
const configurationSearch = `${footerShortcut}${footerGap}search`;
const configurationAccept = `${footerShortcut}${footerGap}(?:toggle|open|test)`;
const configurationCancel = `${footerShortcut}${footerGap}clear${footerGap}search(?:/close)?`;
const configurationFooter = `${configurationGroup}(?:${footerSeparator}${configurationSearch})?(?:${footerSeparator}${configurationAccept})?(?:${footerSeparator}${configurationCancel})?|${configurationSearch}(?:${footerSeparator}${configurationAccept})?(?:${footerSeparator}${configurationCancel})?|${configurationAccept}(?:${footerSeparator}${configurationCancel})?|${configurationCancel}`;
const codexFooter = new RegExp(`^[ \\t]*(?:${pickerFooter}|${textualFooter})[ \\t]*$`, "gmi");
const codexConfigurationFooter = new RegExp(`^[ \\t]*(?:${configurationFooter})[ \\t]*$`, "gmi");
// The Keymap browser owns unnumbered action rows and explicit edit/close controls.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap_setup/picker.rs#L457-L486
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/selection_picker_tests.rs#L9-L43
const keymapFooter = `(?:${configurationGroup}${footerSeparator})?${footerShortcut}${footerGap}edit(?:${footerGap}shortcut)?(?:${footerSeparator}${footerShortcut}${footerGap}custom)?(?:${footerSeparator}${footerShortcut}${footerGap}unbound)?${footerSeparator}${footerShortcut}${footerGap}close`;
const codexKeymapFooter = new RegExp(`^[ \\t]*(?:${keymapFooter})[ \\t]*$`, "gmi");
// Custom bottom-pane views own these controls rather than the shared picker defaults.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/plugin_catalog.rs#L1283-L1312
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/experimental_features_view.rs#L450-L465
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/skills_toggle_view.rs#L332-L351
const pluginToggle = `${footerShortcut}${footerGap}toggle`;
const pluginFooter = `(?:${footerShortcut}${footerGap}upgrade${footerSeparator})?(?:${footerShortcut}${footerGap}remove${footerSeparator})?(?:${pluginToggle}${footerSeparator})?${footerShortcut}/${footerShortcut}${footerGap}tabs${footerSeparator}${footerShortcut}${footerGap}details(?:${footerSeparator}${pluginToggle})?${footerSeparator}${footerShortcut}${footerGap}close`;
const experimentalFooter = `${footerShortcut}${footerGap}toggle(?:${footerSeparator}${footerShortcut}${footerGap}save)?(?:${footerSeparator}${footerShortcut}${footerGap}save/close)?`;
// These footers keep the same input-owning view mounted while a save runs or needs retry.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/experimental_features_view.rs#L125-L135
const experimentalStatus = ["Saving… Closing this popup will not cancel the write.", "Selections retained. Save to retry, or cancel to close."].map(message => message.replaceAll(".", "\\.").replaceAll(" ", footerGap)).join("|");
const skillsFooter = `${footerShortcut}(?:/${footerShortcut})?${footerGap}toggle(?:${footerSeparator}${footerShortcut}${footerGap}close)?`;
// The session picker paints title, conversation rows, then separately packed footer rows.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/resume_picker/layout.rs#L54-L90
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/resume_picker.rs#L2480-L2597
const sessionControl = `${footerShortcut}(?:/${footerShortcut})?${footerGap}(?:archive|(?:start${footerGap})?new|exit|clear(?:${footerGap}search)?|quit|focus(?:${footerGap}sort/filter)?|(?:change${footerGap})?option)`;
const sessionFooter = `${footerShortcut}${footerGap}(?:resume|fork|restore)(?:[ \\t]{2,}${sessionControl})+`;
const namedCodexMenus = [
  { header: /^\s*Configuration\s*$/, footer: codexConfigurationFooter },
  { header: /^\s*Keymap\s*$/, footer: codexKeymapFooter },
  { header: /^\s*Plugins\s*$/, footer: new RegExp(`^[ \\t]*(?:${pluginFooter}|${pickerFooter})[ \\t]*$`, "gmi") },
  { header: /^\s*Experimental features\s*$/, footer: new RegExp(`^[ \\t]*(?:${experimentalFooter}|${experimentalStatus})[ \\t]*$`, "gmi") },
  { header: /^\s*Enable\/Disable Skills\s*$/, footer: new RegExp(`^[ \\t]*(?:${skillsFooter})[ \\t]*$`, "gmi") },
  { header: /^\s*(?:Resume|Fork) a previous session\s*$/, footer: new RegExp(`^[ \\t]*(?:${sessionFooter})[ \\t]*$`, "gmi") },
];

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
    // The native renderer wraps adjacent footer controls; later prompts follow the whole footer.
    // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/list_selection_view.rs#L1070-L1108
    const screen = lines.join("\n");
    const footerEnd = (pattern: RegExp): number => {
      const hint = [...screen.matchAll(pattern)].findLast(match => {
        const previousLine = screen.slice(0, match.index).split("\n").at(-2);
        return previousLine === undefined || !previousLine.trimEnd().endsWith("·");
      });
      return hint === undefined ? -1 : screen.slice(0, hint.index + hint[0].length).split("\n").length - 1;
    };
    const footer = footerEnd(codexFooter);
    if (selectedRow >= 0 && footer > selectedRow && !laterPrompt(footer)) return "menu";
    for (const menu of namedCodexMenus) {
      const header = lines.findLastIndex(line => menu.header.test(line));
      const end = footerEnd(menu.footer);
      if (header >= 0 && end > header && !laterPrompt(end)) return "menu";
    }
    return null;
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
