import { isDeepStrictEqual } from "node:util";
import { parse, TomlDate } from "smol-toml";

const trimStart = (line: string): string => line.replace(/^\p{White_Space}+/u, "");
const trim = (line: string): string => trimStart(line).replace(/\p{White_Space}+$/u, "");
const linesOf = (content: string): string[] => {
  if (content === "") return [];
  const lines = content.split("\n");
  const terminated = content.endsWith("\n");
  if (terminated) lines.pop();
  return lines.map((line, index) => (index < lines.length - 1 || terminated) && line.endsWith("\r") ? line.slice(0, -1) : line);
};
const headerOf = (line: string): string | undefined => {
  const value = trimStart(line);
  if (!value.startsWith("[")) return undefined;
  const size = value.startsWith("[[") ? 2 : 1;
  const end = value.indexOf(size === 2 ? "]]" : "]");
  if (end === -1) return undefined;
  const rest = trimStart(value.slice(end + size));
  if (rest !== "" && !rest.startsWith("#")) return undefined;
  return value.slice(0, end + size);
};
const isKey = (line: string, key: string): boolean => {
  const value = trim(line);
  return value.startsWith(key) && trimStart(value.slice(key.length)).startsWith("=");
};

// Herdr 0.9.5 edits lines without TOML awareness, including lines inside multiline strings.
// Project its exact rewrite before authorizing installation; never write the projection ourselves.
// https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/integration/config_edit.rs#L801-L853
// https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/integration/config_edit.rs#L949-L984
export const projectCodexInstallConfiguration = (content: string): string => {
  const lines = linesOf(content);
  const trailingNewline = content.endsWith("\n");
  let inFeatures = false;
  let headerIndex: number | undefined;
  let hooksIndex: number | undefined;
  const deprecatedIndexes: number[] = [];
  lines.forEach((line, index) => {
    const header = headerOf(line);
    if (header !== undefined) {
      inFeatures = header === "[features]";
      if (inFeatures && headerIndex === undefined) headerIndex = index;
      return;
    }
    if (!inFeatures) return;
    if (isKey(line, "codex_hooks")) deprecatedIndexes.push(index);
    else if (isKey(line, "hooks")) hooksIndex = index;
  });
  if (hooksIndex !== undefined) lines[hooksIndex] = "hooks = true";
  for (const index of deprecatedIndexes.reverse()) lines.splice(index, 1);
  if (hooksIndex === undefined) {
    if (headerIndex === undefined) {
      const result = content.replace(/\n+$/, "");
      return `${result}${result === "" ? "" : "\n\n"}[features]\nhooks = true\n`;
    }
    lines.splice(headerIndex + 1, 0, "hooks = true");
  }
  const result = lines.join("\n");
  return result + (trailingNewline || result === "" ? "\n" : "");
};

const supportedValues = (value: unknown, depth = 0): void => {
  // TomlDate truncates fractional seconds to milliseconds; equality would miss changed native values.
  if (depth > 100 || value instanceof TomlDate) throw new Error("Unsupported TOML semantic value.");
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) supportedValues(child, depth + 1);
  }
};

export const assertCodexInstallConfigurationSafe = (source: string): void => {
  try {
    const options = { integersAsBigInt: true, unsafeKeyBehaviour: "throw", maxDepth: 100, useLegacyDate: true } as const;
    const original = parse(source, options);
    const candidate = parse(projectCodexInstallConfiguration(source), options);
    supportedValues(original);
    supportedValues(candidate);
    if (!Object.hasOwn(original, "features")) original.features = parse("[features]\n", options).features!;
    const value = original.features;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid features table.");
    const features = value as Record<string, unknown>;
    // The deprecated root key belongs to the official integration, which removes it during installation.
    delete features.codex_hooks;
    features.hooks = true;
    if (!isDeepStrictEqual(original, candidate)) throw new Error("Unsafe TOML rewrite.");
  } catch {
    // Parser diagnostics may contain native secrets, including excerpts in their cause chain.
    throw new Error("Cannot safely install the Codex Herdr integration: config.toml is invalid, contains unsupported semantic values, or the official rewrite would change settings beyond features.hooks and the deprecated features.codex_hooks key. Inspect the native configuration before retrying.");
  }
};
