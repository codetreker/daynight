// Provider-discovered controls carry confirmed values, never optimistic UI intent.
export type SessionSetting = {
  readonly id: string;
  readonly category: "model" | "reasoning" | "permission";
  readonly label: string;
  readonly description: string | null;
  readonly value: string | null;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly mutable: boolean;
  readonly scope: "session" | "next_turn";
};
export type SessionNativeCommand = {
  readonly id: string; readonly name: string; readonly description: string;
  readonly argumentHint: string | null; readonly available: boolean;
};
export type SessionControls = {
  readonly revision: string;
  readonly settings: readonly SessionSetting[];
  readonly commands: readonly SessionNativeCommand[];
  readonly settingsError: string | null;
  readonly commandsError: string | null;
};

const invalid = (): never => { throw new Error("Invalid session controls."); };
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return invalid();
  return result;
};
const text = (value: unknown, maximum = 4096): string => typeof value === "string" && value.isWellFormed() && !value.includes("\0") && /[^\p{White_Space}]/u.test(value) && new TextEncoder().encode(value).length <= maximum ? value : invalid();
const nullable = (value: unknown): string | null => value === null ? null : text(value);
const bool = (value: unknown): boolean => typeof value === "boolean" ? value : invalid();
const choice = <T extends string>(value: unknown, options: readonly T[]): T => options.includes(value as T) ? value as T : invalid();
const list = <T>(value: unknown, parse: (value: unknown) => T, key: (value: T) => string, maximum: number): T[] => {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  const result = value.map(parse);
  if (new Set(result.map(key)).size !== result.length) return invalid();
  return result;
};
export const parseSessionControls = (value: unknown): SessionControls => {
  const data = object(value, ["revision", "settings", "commands", "settingsError", "commandsError"]);
  const revision = text(data.revision, 19);
  if (!/^[1-9][0-9]{0,18}$/.test(revision) || BigInt(revision) > 9223372036854775807n) return invalid();
  return {
    revision,
    settings: list(data.settings, raw => {
      const setting = object(raw, ["id", "category", "label", "description", "value", "options", "mutable", "scope"]);
      return { id: text(setting.id, 256), category: choice(setting.category, ["model", "reasoning", "permission"]), label: text(setting.label), description: nullable(setting.description), value: nullable(setting.value), options: list(setting.options, raw => { const option = object(raw, ["value", "label"]); return { value: text(option.value), label: text(option.label) }; }, option => option.value, 500), mutable: bool(setting.mutable), scope: choice(setting.scope, ["session", "next_turn"]) };
    }, setting => setting.id, 32),
    commands: list(data.commands, raw => { const command = object(raw, ["id", "name", "description", "argumentHint", "available"]); return { id: text(command.id, 256), name: text(command.name, 256), description: text(command.description), argumentHint: nullable(command.argumentHint), available: bool(command.available) }; }, command => command.id, 500),
    settingsError: nullable(data.settingsError), commandsError: nullable(data.commandsError),
  };
};
