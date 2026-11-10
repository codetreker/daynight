import type { Readable, Writable } from "node:stream";
import { spawnNodeGuardianCommand } from "./windows-node-guardian.js";
import { spawnWindowsNativeCommand } from "./windows-native-command.js";
import type { WindowsCommandJobKernel } from "./windows-job.js";
import type { WindowsNativeProcessKernel } from "./windows-native-process.js";
export { WindowsCommandCleanupError } from "./windows-command-job.js";

export type SerializedSpawnError = {
  name: string;
  message: string;
  code?: string;
  errno?: number | string;
  syscall?: string;
  path?: string;
  spawnargs?: string[];
  win32Code?: number;
  cause?: unknown;
};
export type WindowsTargetReceipt =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null; failure: SerializedSpawnError | null }
  | { kind: "not-started"; error: SerializedSpawnError };
export type WindowsOwnedCommand = {
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly result: WindowsTargetReceipt | undefined;
  readonly closed: Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  release(): Promise<void>;
};
type WindowsCommandOptions = {
  file: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  deadline: number;
  graceMs: number;
  pipeCloseMs: number;
};
export type WindowsOwnedCommandOptions = WindowsCommandOptions & (
  | { stdin: "ignore"; resolver: "node"; normalDisposition: "release"; stopAdmission: "seal"; failureDisposition: "last-close"; onReleased: () => void }
  | { stdin: "pipe"; resolver: "cross-spawn"; normalDisposition: "stop"; stopAdmission: "membership"; failureDisposition: "retain"; onReleased?: never }
);
export type WindowsNativeCommandOptions = Extract<WindowsOwnedCommandOptions, { normalDisposition: "release" }>;
export type WindowsNodeCommandOptions = Extract<WindowsOwnedCommandOptions, { normalDisposition: "stop" }>;
export type WindowsOwnedCommandDependencies = {
  loadKernel?: () => Promise<WindowsCommandJobKernel>;
  loadNative?: () => Promise<WindowsNativeProcessKernel>;
};

export const restoreWindowsSpawnError = (value: SerializedSpawnError): Error & Omit<SerializedSpawnError, "name" | "message"> & { readonly origin: "windows-target" } =>
  Object.assign(new Error(value.message), value, { origin: "windows-target" as const }, value.spawnargs === undefined ? {} : { spawnargs: [...value.spawnargs] });

export const spawnWindowsOwnedCommand = (
  options: WindowsOwnedCommandOptions,
  dependencies: WindowsOwnedCommandDependencies = {},
): WindowsOwnedCommand => options.normalDisposition === "release"
  ? spawnWindowsNativeCommand(options, dependencies)
  : spawnNodeGuardianCommand(options, dependencies).command;
