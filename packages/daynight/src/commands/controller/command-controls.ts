import type { SessionCommand } from '../../session/protocol.js';
import type { ControllerSnapshot } from './lifecycle-store.js';
import { NativeRpcError } from './providers/native-rpc.js';

// Settings, commands and input share a dispatch boundary. Interruptions and
// interaction responses must remain available while a setting awaits native ACK.
export function createNativeCommandQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(kind: SessionCommand['kind'], invoke: () => Promise<T>): Promise<T> => {
    if (kind === 'cancel' || kind === 'interaction_response') return invoke();
    const result = tail.then(invoke, invoke);
    tail = result.catch(() => {});
    return result;
  };
}

export function assertControlCommand(command: SessionCommand, snapshot: Pick<ControllerSnapshot, "controls" | "activity" | "currentTurnId">): void {
  if (command.kind === 'refresh_controls') return;
  if (command.kind !== 'update_setting' && command.kind !== 'execute_command') return;
  const controls = snapshot.controls;
  if (!controls || controls.revision !== command.payload.expectedControlsRevision) throw new NativeRpcError(-32602, 'Session controls changed. Refresh before trying again.');
  if (command.kind === 'update_setting') {
    const setting = controls.settings.find(item => item.id === command.payload.settingId);
    if (!setting?.mutable || !setting.options.some(option => option.value === command.payload.value)) throw new NativeRpcError(-32602, 'This setting or value is not available.');
  } else {
    const entry = controls.commands.find(item => item.id === command.payload.commandId);
    if (!entry?.available || snapshot.activity !== 'idle' || command.payload.expectedTurnId !== null || snapshot.currentTurnId !== null || entry.argumentHint === null && command.payload.arguments.trim()) throw new NativeRpcError(-32602, 'This command is not available in the current turn.');
  }
}
