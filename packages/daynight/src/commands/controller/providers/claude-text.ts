export const CLAUDE_TOOL_TEXT_PREFIX_UNITS = 200_002;

/**
 * Retain a real UTF-16 prefix for the existing 200000-character projection.
 * Two extra units preserve its surrogate-boundary decision and truncation
 * marker without adding that marker twice. JSON metadata keeps its own limit.
 */
export const claudeToolTextPrefix = (text: string): string => {
  if (text.length <= CLAUDE_TOOL_TEXT_PREFIX_UNITS) return text;
  const end = /[\uD800-\uDBFF]/.test(text[CLAUDE_TOOL_TEXT_PREFIX_UNITS - 1]!) && /[\uDC00-\uDFFF]/.test(text[CLAUDE_TOOL_TEXT_PREFIX_UNITS]!) ? CLAUDE_TOOL_TEXT_PREFIX_UNITS - 1 : CLAUDE_TOOL_TEXT_PREFIX_UNITS;
  return text.slice(0, end);
};
