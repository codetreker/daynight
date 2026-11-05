import { nativeInputBlocker } from "./input-blockers.js";

type StyledRow = { text: string; faint: boolean[] };
const resumeRows = (visible: string): StyledRow[] | null => {
  const rows: StyledRow[] = [{ text: "", faint: [] }];
  let faint = false;
  for (let index = 0; index < visible.length;) {
    if (visible[index] === "\x1b") {
      const sgr = /^\x1b\[([0-9;]*)m/.exec(visible.slice(index));
      if (!sgr) return null;
      const parameters = sgr[1]!.split(";");
      if (parameters.length > 1 && parameters.some(value => value === "")) return null;
      const codes = parameters.map(value => value === "" ? 0 : Number(value));
      for (let position = 0; position < codes.length; position++) {
        const code = codes[position]!;
        if (code === 0 || code === 22) faint = false;
        else if (code === 2) faint = true;
        else if (code === 38 || code === 48 || code === 58) {
          const count = codes[position + 1] === 2 ? 3 : codes[position + 1] === 5 ? 1 : 0;
          if (count === 0 || position + 1 + count >= codes.length || codes.slice(position + 2, position + 2 + count).some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
          position += count + 1;
        } else if (![1, 3, 4, 5, 7, 8, 9, 21, 23, 24, 25, 27, 28, 29, 39, 49, 59].includes(code) && !(code >= 30 && code <= 37) && !(code >= 40 && code <= 47) && !(code >= 90 && code <= 97) && !(code >= 100 && code <= 107)) return null;
      }
      index += sgr[0].length;
      continue;
    }
    const character = String.fromCodePoint(visible.codePointAt(index)!);
    index += character.length;
    if (character === "\n") { rows.push({ text: "", faint: [] }); continue; }
    if (character === "\r" && visible[index] === "\n") continue;
    if (/[\p{Cc}]/u.test(character)) return null;
    const row = rows.at(-1)!;
    row.text += character;
    row.faint.push(...Array<boolean>(character.length).fill(faint));
  }
  return rows;
};

/** Resume proof reads renderer attributes; unknown escape/rendering forms remain unproved. */
export const hasEmptyResumeComposer = (provider: "codex" | "claude", visible: string): boolean => {
  const rows = resumeRows(visible);
  if (rows === null) return false;
  const lines = rows.map(row => row.text.trimEnd());
  if (nativeInputBlocker(provider, lines.join("\n")) !== null) return false;
  if (provider === "codex") {
    // Only the empty placeholder is dim; a literal draft with identical words is textarea text.
    // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/chat_composer.rs#L4873-L4954
    const prompt = lines.findLastIndex(line => /^\s*[›»]\s+(?:Ask Codex to do anything|Ask a follow-up question)\s*$/.test(line));
    if (prompt < 0 || lines.findLastIndex(line => /^\s*[›»]/.test(line)) !== prompt) return false;
    const row = rows[prompt]!;
    const placeholder = /(?:Ask Codex to do anything|Ask a follow-up question)/.exec(row.text)!;
    const glyph = row.text.search(/[›»]/);
    if (row.faint[glyph] !== false || !row.faint.slice(placeholder.index, placeholder.index + placeholder[0].length).every(value => value)) return false;
    if (lines[prompt + 1] !== "") return false;
    const footer = lines.findLastIndex(line => /^\s*\? for shortcuts(?:\s|$)/.test(line));
    return footer > prompt + 1 && lines.slice(prompt + 2, footer).filter(line => line.trim() !== "").length <= 1;
  }
  // An actually blank bordered Claude field is unambiguous; a Try placeholder can be literal draft.
  // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/detect/manifests/claude.toml
  const prompt = lines.findLastIndex(line => /^\s*❯\s*$/.test(line));
  if (prompt < 0 || lines.findLastIndex(line => /^\s*❯/.test(line)) !== prompt) return false;
  const divider = (line: string) => /^\s*[─━]{3,}\s*$/.test(line);
  const before = lines.slice(0, prompt).findLastIndex(divider);
  const after = lines.slice(prompt + 1).findIndex(divider);
  if (before < 0 || after < 0 || lines.slice(before + 1, prompt).some(line => line.trim() !== "") || lines.slice(prompt + 1, prompt + 1 + after).some(line => line.trim() !== "")) return false;
  const permissionFooter = /^\s*⏵⏵ bypass permissions on \(shift\+tab to cycle\)(?:\s+·\s+PR #[1-9][0-9]*)?(?:\s+·\s+← for agents)?\s*$/;
  return lines.slice(prompt + 2 + after).some(line => /^\s*(?:\? for shortcuts|shift\+tab to|esc to interrupt)(?:\s|$)/i.test(line) || permissionFooter.test(line));
};
