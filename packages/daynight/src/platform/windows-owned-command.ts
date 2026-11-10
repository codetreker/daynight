import type { Readable, Writable } from "node:stream";
import { spawnNodeGuardianCommand } from "./windows-node-guardian.js";
import type { WindowsCommandJobKernel } from "./windows-job.js";
export { WindowsCommandCleanupError } from "./windows-command-job.js";

export type SerializedSpawnError = {
  name: string;
  message: string;
  code?: string;
  errno?: number | string;
  syscall?: string;
  path?: string;
  spawnargs?: string[];
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
  stdin: "pipe" | "ignore";
  resolver: "node" | "cross-spawn";
  deadline: number;
  graceMs: number;
  pipeCloseMs: number;
};
export type WindowsOwnedCommandOptions = WindowsCommandOptions & (
  | { normalDisposition: "release"; stopAdmission: "seal"; failureDisposition: "last-close"; onReleased: () => void }
  | { normalDisposition: "stop"; stopAdmission: "membership"; failureDisposition: "retain"; onReleased?: never }
);
export type WindowsOwnedCommandDependencies = {
  loadKernel?: () => Promise<WindowsCommandJobKernel>;
};

export const restoreWindowsSpawnError = (value: SerializedSpawnError): Error & Omit<SerializedSpawnError, "name" | "message"> & { readonly origin: "windows-target" } =>
  Object.assign(new Error(value.message), value, { origin: "windows-target" as const }, value.spawnargs === undefined ? {} : { spawnargs: [...value.spawnargs] });

export const spawnWindowsOwnedCommand = (
  options: WindowsOwnedCommandOptions,
  dependencies: WindowsOwnedCommandDependencies = {},
): WindowsOwnedCommand => spawnNodeGuardianCommand(options, dependencies).command;
