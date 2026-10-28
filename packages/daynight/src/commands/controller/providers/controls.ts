import { parseSessionControls, type SessionControls, type SessionSetting, type SessionNativeCommand } from "../../../session/controls.js";
import { NativeRpcError } from "./native-rpc.js";
export type { SessionControls, SessionSetting, SessionNativeCommand };
export const controlError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 1000) || "Native controls unavailable.";
export const controlDeadline = <T>(operation: Promise<T>, label: string, ms = 30_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} was not confirmed. Check native state before retrying.`)), ms);
  operation.then(result => { clearTimeout(timer); resolve(result); }, error => { clearTimeout(timer); reject(error); });
});
export class ProviderControls {
  value: SessionControls = { revision: "1", settings: [], commands: [], settingsError: null, commandsError: null };
  constructor(private readonly changed: () => void, floor = "0") {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(floor)) throw new Error("Invalid native control revision floor.");
    this.value = parseSessionControls({ ...this.value, revision: String(BigInt(floor) + 1n) });
  }
  update(patch: Partial<Omit<SessionControls, "revision">>): void {
    const next = { ...this.value, ...patch };
    if (sameControlValue(next, this.value)) return;
    this.value = parseSessionControls({ ...next, revision: String(BigInt(this.value.revision) + 1n) }); this.changed();
  }
  requireRevision(revision: string): void { if (revision !== this.value.revision) throw new NativeRpcError(-32602, "The native control directory changed. Refresh and choose again."); }
  setting(id: string, value: string, revision: string): SessionSetting {
    this.requireRevision(revision);
    const setting = this.value.settings.find(item => item.id === id);
    if (!setting?.mutable || !setting.options.some(option => option.value === value)) throw new NativeRpcError(-32602, "The requested native setting is unavailable.");
    return setting;
  }
  command(id: string, revision: string): SessionNativeCommand {
    this.requireRevision(revision);
    const command = this.value.commands.find(item => item.id === id);
    if (!command?.available) throw new NativeRpcError(-32602, "The requested native command is unavailable.");
    return command;
  }
}
export const uniqueOptions = (values: readonly { value: string; label: string }[]) => [...new Map(values.filter(item => item.value && item.label).map(item => [item.value, item])).values()].slice(0, 500);

export const sameControlValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameControlValue(value, right[index]));
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) { const a = left as Record<string, unknown>, b = right as Record<string, unknown>; return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => sameControlValue(a[key], b[key])); }
  return false;
};
