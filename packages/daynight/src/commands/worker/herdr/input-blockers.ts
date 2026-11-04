import type { WorkerAgent } from "../../../api/types.js";

export type NativeInputBlocker = "menu" | "disabled";

const footerGap = String.raw`(?:[ \t]+|[ \t]*\n[ \t]*)`;
const footerSeparator = String.raw`[ \t]*(?:\n[ \t]*)?·[ \t]*(?:\n[ \t]*)?`;
// cfg(test) snapshots force backspace/del; production macOS renders delete/fwd del.
// Only names admitted by the Codex keymap parser are relevant, not every Crossterm enum.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/key_hint.rs#L68-L122
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/keymap.rs#L2709-L2760
// https://github.com/openai-oss-forks/crossterm/blob/ed1cdab335221515706178d68495bba2aed1924f/src/event.rs#L1453-L1515
const footerModifiers = String.raw`(?:⌃?⇧?⌥?⌘?|(?:\^|ctrl\+)?(?:shift\+)?(?:alt\+)?(?:super\+)?)`;
const footerKeyName = `(?:fwd${footerGap}del|enter|esc|tab|home|end|pgup|pgdn|space|backspace|delete|del|f(?:[1-9]|1\\d|2[0-4])|[↑↓←→]|[!-~])`;
const footerKey = `${footerModifiers}${footerKeyName}`;
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
const configurationGroupKey = `${footerModifiers}(?:${footerKeyName}|left|right)`;
const configurationGroupShortcut = `${configurationGroupKey}(?:${footerGap}${configurationGroupKey})?`;
const configurationGroup = `${configurationGroupShortcut}(?:/${configurationGroupShortcut})?${footerGap}group`;
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
// Checkbox views own Space[/accept] toggles, optional ordering, and finite save/back actions.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/multi_select_picker.rs#L308-L329
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/multi_select_picker.rs#L606-L617
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/multi_select_picker.rs#L779-L802
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/hooks_browser_view.rs#L519-L570
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/memories_settings_view.rs#L455-L468
const checkboxFooter = `space(?:/${footerShortcut})?${footerGap}toggle(?:${footerSeparator}${footerShortcut}/${footerShortcut}${footerGap}reorder)?(?:${footerSeparator}${footerShortcut}${footerGap}save(?:/select)?)?(?:${footerSeparator}${footerShortcut}${footerGap}(?:cancel|back|close|save/close))?`;
const codexCheckboxFooter = new RegExp(`^[ \\t]*(?:${checkboxFooter})[ \\t]*$`, "gmi");
const codexShortCheckbox = new RegExp(`^[ \\t\\r\\n]*(?:Type${footerGap}to${footerGap}search[ \\t]*\\r?\\n)?[ \\t]*(?:${checkboxFooter})[ \\t\\r\\n]*$`, "i");
const hooksEventFooter = `(?:t${footerGap}trust${footerGap}all${footerSeparator}(?:${footerShortcut}${footerGap}review${footerSeparator})?|${footerShortcut}${footerGap}details${footerSeparator})?${footerShortcut}${footerGap}close`;
const hooksHandlerFooter = `(?:Managed${footerGap}\\(always${footerGap}on\\)${footerSeparator}|t${footerGap}trust${footerSeparator})?${footerShortcut}${footerGap}back`;
const hookEvents = "PreToolUse|PermissionRequest|PostToolUse|PreCompact|PostCompact|PreModelRequest|PostModelRequest|SessionStart|SessionEnd|UserPromptSubmit|SubagentStart|SubagentStop|Stop|Interrupt";
// The import customization screen is also a checkbox input owner, with fixed legacy hints.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/external_agent_config_migration/render.rs#L168-L207
const importFooter = ["Use ↑/↓ to move, space to toggle, b to go back", "Press enter to continue, ↑/↓ to move, b to go back", "Use ↑/↓ to move, enter to select, c to customize"].map(message => message.replaceAll(" ", footerGap)).join("|");
// Custom bottom-pane views own these controls rather than the shared picker defaults.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/plugin_catalog.rs#L1283-L1312
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/experimental_features_view.rs#L450-L465
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/skills_toggle_view.rs#L332-L351
const pluginToggle = `${footerShortcut}${footerGap}toggle`;
const pluginFooter = `(?:${footerShortcut}${footerGap}upgrade${footerSeparator})?(?:${footerShortcut}${footerGap}remove${footerSeparator})?(?:${pluginToggle}${footerSeparator})?${footerShortcut}/${footerShortcut}${footerGap}tabs${footerSeparator}${footerShortcut}${footerGap}details(?:${footerSeparator}${pluginToggle})?${footerSeparator}${footerShortcut}${footerGap}close`;
// These footers keep the same input-owning view mounted while a save runs or needs retry.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/experimental_features_view.rs#L125-L135
const experimentalStatus = ["Saving… Closing this popup will not cancel the write.", "Selections retained. Save to retry, or cancel to close."].map(message => message.replaceAll(".", "\\.").replaceAll(" ", footerGap)).join("|");
// The session picker paints title, conversation rows, then separately packed footer rows.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/resume_picker/layout.rs#L54-L90
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/resume_picker.rs#L2480-L2597
const sessionControl = `${footerShortcut}(?:/${footerShortcut})?${footerGap}(?:archive|(?:start${footerGap})?new|exit|clear(?:${footerGap}search)?|quit|focus(?:${footerGap}sort/filter)?|(?:change${footerGap})?option)`;
const sessionFooter = `${footerShortcut}${footerGap}(?:resume|fork|restore)(?:[ \\t]{2,}${sessionControl})+`;
const namedCodexMenus = [
  { header: /^\s*Configuration\s*$/, footer: codexConfigurationFooter },
  { header: /^\s*Keymap\s*$/, footer: codexKeymapFooter },
  { header: /^\s*Configure (?:Status Line|Terminal Title)\s*$/, footer: codexCheckboxFooter },
  { header: /^\s*Microphone: \S.*$/, footer: codexCheckboxFooter },
  { header: /^\s*Plugins\s*$/, footer: new RegExp(`^[ \\t]*(?:${pluginFooter}|${pickerFooter})[ \\t]*$`, "gmi") },
  { header: /^\s*Experimental features\s*$/, footer: new RegExp(`^[ \\t]*(?:${checkboxFooter}|${experimentalStatus})[ \\t]*$`, "gmi") },
  { header: /^\s*(?:Enable\/Disable Skills|Memories)\s*$/, footer: codexCheckboxFooter },
  { header: /^\s*Reset all memories\?\s*$/, footer: codexFooter },
  { header: /^\s*Hooks\s*$/, footer: new RegExp(`^[ \\t]*(?:${hooksEventFooter})[ \\t]*$`, "gmi") },
  { header: new RegExp(`^\\s*(?:${hookEvents}) hooks\\s*$`), footer: new RegExp(`^[ \\t]*(?:${checkboxFooter}|${hooksHandlerFooter})[ \\t]*$`, "gmi") },
  { header: /^\s*> (?:Import setup|Choose what to import)\s*$/, footer: new RegExp(`^[ \\t]*(?:${importFooter})[ \\t]*$`, "gmi") },
  { header: /^\s*Choose an import source\s*$/, footer: codexFooter },
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
    const checkbox = lines.findLastIndex(line => /^\s*(?:[›»]\s+)?\[[ x!]\]\s+\S/.test(line));
    const emptyCheckboxSearch = lines.findLastIndex(line => /^\s*no matches\s*$/.test(line));
    const checkboxEnd = footerEnd(codexCheckboxFooter);
    if (codexShortCheckbox.test(screen) || (checkbox >= 0 && checkboxEnd > checkbox || emptyCheckboxSearch >= 0 && checkboxEnd > emptyCheckboxSearch) && !laterPrompt(checkboxEnd)) return "menu";
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
