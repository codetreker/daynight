export const MAX_JSON_SOURCE_DEPTH = 64;

type SourceNode = {
  readonly start: number;
  readonly end: number;
  readonly values?: readonly SourceNode[];
  readonly members?: ReadonlyMap<string, SourceNode>;
  readonly memberSources?: readonly { readonly start: number; readonly end: number }[];
};

const invalid = (): never => { throw new SyntaxError("Invalid JSON source."); };

const inspectJsonSource = (source: string, ignoreDuplicateWithin?: readonly string[]): SourceNode => {
  let offset = 0;
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const whitespace = (): void => {
    while (offset < source.length && (source[offset] === " " || source[offset] === "\n" || source[offset] === "\r" || source[offset] === "\t")) offset++;
  };
  const string = (): SourceNode => {
    const start = offset;
    if (source[offset++] !== '"') return invalid();
    while (offset < source.length) {
      const character = source[offset++]!;
      if (character === '"') return { start, end: offset };
      if (character.charCodeAt(0) < 0x20) return invalid();
      if (character !== "\\") continue;
      const escape = source[offset++];
      if (escape === "u") {
        if (!/^[0-9a-f]{4}$/i.test(source.slice(offset, offset + 4))) return invalid();
        offset += 4;
      } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) return invalid();
    }
    return invalid();
  };
  const value = (depth: number, path: readonly string[]): SourceNode => {
    whitespace();
    const start = offset;
    const token = source[offset];
    if (token === '"') return string();
    if (token === "{" || token === "[") {
      if (depth >= MAX_JSON_SOURCE_DEPTH) return invalid();
      offset++;
      whitespace();
      const object = token === "{";
      const closing = object ? "}" : "]";
      const values: SourceNode[] = [];
      const members = new Map<string, SourceNode>();
      const memberSources: { start: number; end: number }[] = [];
      if (source[offset] !== closing) {
        while (offset < source.length) {
          whitespace();
          const memberStart = offset;
          let key: string | undefined;
          if (object) {
            const keySource = string();
            key = JSON.parse(source.slice(keySource.start, keySource.end)) as string;
            if (members.has(key) && !(ignoreDuplicateWithin !== undefined && ignoreDuplicateWithin.every((part, index) => path[index] === part))) return invalid();
            whitespace();
            if (source[offset++] !== ":") return invalid();
          }
          const child = value(depth + 1, key === undefined ? path : [...path, key]);
          if (key === undefined) values.push(child);
          else {
            members.set(key, child);
            memberSources.push({ start: memberStart, end: child.end });
          }
          whitespace();
          if (source[offset] === closing) break;
          if (source[offset++] !== ",") return invalid();
        }
      }
      if (source[offset++] !== closing) return invalid();
      return object ? { start, end: offset, members, memberSources } : { start, end: offset, values };
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return { start, end: offset };
      }
    }
    number.lastIndex = offset;
    const parsedNumber = number.exec(source);
    if (parsedNumber === null) return invalid();
    offset = number.lastIndex;
    return { start, end: offset };
  };
  const root = value(0, []);
  whitespace();
  if (offset !== source.length) return invalid();
  return root;
};

export const jsonContainerSources = (source: string): readonly string[] => {
  const node = inspectJsonSource(source);
  const entries = node.values ?? node.memberSources;
  if (entries === undefined) return invalid();
  return entries.map(({ start, end }) => source.slice(start, end));
};

export const jsonObjectSources = (source: string, ignoreDuplicateWithin?: readonly string[]): ReadonlyMap<string, string> => {
  const node = inspectJsonSource(source, ignoreDuplicateWithin);
  if (node.members === undefined) return invalid();
  return new Map([...node.members].map(([key, { start, end }]) => [key, source.slice(start, end)]));
};
