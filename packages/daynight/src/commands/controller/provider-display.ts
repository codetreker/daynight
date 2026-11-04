import type { ProviderEntry } from "./providers/types.js";
import type { MessagePart } from "../../session/protocol.js";

const escapedDisplayPrefix = "[Escaped display: NUL and unpaired UTF-16 surrogates use \\uXXXX; original backslashes are doubled]\n";
const truncatedSuffix = "\n[Output truncated at 200000 characters]";
const maxDisplayCharacters = 200_000;

const displayText = (value: string, markdown: boolean): { text: string; truncated: boolean } => {
  if (!value.includes("\0") && value.isWellFormed()) return { text: value, truncated: false };
  let body = "", backtickRun = 0, tildeRun = 0, longestBackticks = 0, longestTildes = 0;
  const finish = (truncated: boolean) => {
    const text = body + (truncated ? truncatedSuffix : "");
    if (!markdown) return { text: escapedDisplayPrefix + text, truncated };
    const fence = (longestBackticks <= longestTildes ? "`" : "~").repeat(Math.max(3, Math.min(longestBackticks, longestTildes) + 1));
    return { text: `${escapedDisplayPrefix}\n${fence}\n${text}\n${fence}`, truncated };
  };
  // Iteration keeps scalar pairs intact; each escape is appended atomically.
  // This character limit also bounds each converted field below the 1 MiB
  // decoded-text limit. Whole-entry wire budgeting remains with wire-display.
  for (const character of value) {
    const code = character.charCodeAt(0);
    const token = character === "\\" ? "\\\\"
      : code === 0 || character.length === 1 && code >= 0xd800 && code <= 0xdfff
        ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    const nextBacktickRun = character === "`" ? backtickRun + 1 : 0, nextTildeRun = character === "~" ? tildeRun + 1 : 0;
    const nextLongestBackticks = Math.max(longestBackticks, nextBacktickRun), nextLongestTildes = Math.max(longestTildes, nextTildeRun);
    // Markdown would collapse doubled backslashes. A literal block preserves
    // them; both fences must exceed every retained run of their delimiter.
    const framing = markdown ? 3 + 2 * Math.max(3, Math.min(nextLongestBackticks, nextLongestTildes) + 1) : 0;
    if (escapedDisplayPrefix.length + body.length + token.length + framing > maxDisplayCharacters) return finish(true);
    body += token;
    backtickRun = nextBacktickRun; tildeRun = nextTildeRun;
    longestBackticks = nextLongestBackticks; longestTildes = nextLongestTildes;
  }
  return finish(false);
};

// Convert only display bodies before journal validation. Provider entries can
// share nested objects with raw delta caches, so transformed parts are copies.
// Identity, resources and interactive authority retain their strict validation.
export const providerDisplayEntry = (entry: ProviderEntry): ProviderEntry => {
  let truncated = false;
  const display = (value: string, markdown = false): string => {
    const result = displayText(value, markdown);
    truncated ||= result.truncated;
    return result.text;
  };
  const parts = (values: readonly MessagePart[], markdown = false): readonly MessagePart[] => values.map(value => value.type === "text" ? { ...value, text: display(value.text, markdown) } : value);
  switch (entry.kind) {
    case "user_message":
    case "assistant_message": return { ...entry, content: parts(entry.content, true) };
    case "reasoning": return { ...entry, text: display(entry.text, true) };
    case "tool_call": {
      const input = display(entry.input), output = parts(entry.output);
      return { ...entry, input, output, truncated: entry.truncated || truncated };
    }
    case "error": return { ...entry, message: display(entry.message) };
    case "compaction": return { ...entry, summary: display(entry.summary) };
    case "todo": return { ...entry, items: entry.items.map(item => ({ ...item, text: display(item.text) })) };
    case "interaction": return entry;
  }
};
