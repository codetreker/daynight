const literalCharacter = /^[a-zA-Z0-9_./,:+@%-]$/;

function unwrapShellCommand(input: string): string {
  const prefix = /^[ \t]*(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh|dash|ksh)[ \t]+-(?:lc|c)[ \t]+/.exec(input);
  if (!prefix) return input;
  let index = prefix[0].length;
  if (input[index] !== "'" && input[index] !== '"' && !literalCharacter.test(input[index] ?? '')) return input;
  let quote: "'" | '"' | null = null;
  let command = '';
  // Decode one literal argument only. Expansion, extra arguments, and shell
  // operators require context that a display summary cannot reconstruct.
  while (index < input.length) {
    const character = input[index++]!;
    if (quote === "'") {
      if (character === "'") quote = null;
      else command += character;
    } else if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '$' || character === '`') return input;
      else if (character === '\\') {
        const escaped = input[index++];
        if (escaped === undefined) return input;
        if (escaped === '\n') continue;
        command += '"\\$`'.includes(escaped) ? escaped : `\\${escaped}`;
      } else command += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '\\') {
      const escaped = input[index++];
      if (escaped === undefined) return input;
      if (escaped !== '\n') command += escaped;
    } else if (literalCharacter.test(character)) {
      command += character;
    } else {
      if (!/^[ \t\n]*$/.test(input.slice(index - 1))) return input;
      break;
    }
  }
  // Shells can consume a leading sign as an option even after -c.
  return quote === null && !/^[+-]/.test(command) ? command : input;
}

export function toolSummary(input: string, toolName: string): string {
  let value = input;
  let isCommand = toolName === 'commandExecution';
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>;
      const key = ['command', 'cmd', 'file_path', 'filePath', 'path', 'query', 'description', 'url'].find(key => typeof fields[key] === 'string');
      if (key !== undefined) {
        value = fields[key] as string;
        isCommand = key === 'command' || key === 'cmd';
      }
    }
  } catch { /* Shell commands and other plain-text parameters are already readable. */ }
  const line = (isCommand ? unwrapShellCommand(value) : value).replace(/\s+/g, ' ').trim();
  return line.length > 180 ? `${line.slice(0, 179)}…` : line;
}
