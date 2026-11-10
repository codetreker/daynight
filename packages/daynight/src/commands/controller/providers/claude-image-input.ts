import type { InputObservation } from "../../../session/image-values.js";
import { NativeRpcError, record, string } from "./native-rpc.js";
import type { NativeInput, ProviderOptions } from "./types.js";

type Saved = { nativeSessionId: string; operationId: string; intentSha256: string; input: NativeInput; executionObserved?: boolean; executed: boolean };

/** Image acknowledgement requires the original UUID in the native root execution. */
export class ClaudeImageInputs {
  private readonly ancestry = new Map<string, string>();
  constructor(private readonly options: ProviderOptions, private readonly sessionId: string) {}
  private key(id: string) { return `claude:input:${this.sessionId}:${id}`; }
  private saved(id: string): Saved | null { return this.options.imageRuntime?.readState(this.key(id)) as Saved | null ?? null; }
  private intent(input: NativeInput, id: string): string | null {
    const intent = this.options.imageRuntime?.getIntent(id), command = intent?.command;
    if (!intent || command?.kind !== "send_message" || command.operationId !== id || command.payload.expectedTurnId !== null || command.payload.target?.expectedNativeSessionId !== null && command.payload.target?.expectedNativeSessionId !== this.sessionId || input.content.length !== command.payload.content.length) return null;
    if (!input.content.every((part, index) => {
      const original = command.payload.content[index]!;
      return part.type === "text" ? original.type === "text" && original.text === part.text : original.type === "image" && part.imageId === original.imageId && part.resourceId === original.resourceId && part.byteLength === original.byteLength && part.sha256 === original.sha256;
    })) return null;
    return intent.sha256;
  }
  prepare(input: NativeInput, operationId: string): void {
    if (!input.content.some(part => part.type === "image")) return;
    const intentSha256 = this.intent(input, operationId);
    if (!intentSha256) throw new NativeRpcError(-32602, "Claude image input differs from its complete authorized intent.");
    if (this.saved(operationId)) throw new NativeRpcError(-32602, "The original Claude image input was already dispatched.");
    this.options.imageRuntime!.writeState(this.key(operationId), { nativeSessionId: this.sessionId, operationId, intentSha256, input, executed: false } satisfies Saved);
  }
  original(operationId: string): NativeInput | null {
    const saved = this.saved(operationId);
    return saved?.nativeSessionId === this.sessionId && this.intent(saved.input, operationId) === saved.intentSha256 ? saved.input : null;
  }
  observe(raw: unknown, history = false): string | null {
    const message = record(raw);
    if (message.session_id !== this.sessionId || message.parent_tool_use_id) return null;
    const type = string(message.type), uuid = string(message.uuid);
    let id = string(message.user_message_uuid);
    if (history && uuid) {
      const parent = string(message.parentUuid), inherited = this.ancestry.get(parent);
      const original = type === "user" && this.original(uuid) ? uuid : inherited;
      if (original) {
        if (this.ancestry.size >= 100_000 && !this.ancestry.has(uuid)) throw new Error("Claude input ancestry exceeds its metadata bound.");
        this.ancestry.set(uuid, original);
        if (type === "assistant") id ||= original;
      }
    }
    const executed = type === "command_lifecycle" && message.state === "started" || type === "assistant" && message.error === undefined && message.isApiErrorMessage !== true || type === "stream_event" && record(message.event).type === "message_start";
    if (!executed && type !== "result") return null;
    if (type === "command_lifecycle") id = string(message.command_uuid);
    const saved = this.saved(id);
    if (!id || !saved || !this.original(id)) return null;
    // A result also describes hook rejection and empty local turns. It may
    // retry a durable receipt only after an exact root execution was observed.
    if (!executed && !saved.executionObserved) return null;
    if (executed && !saved.executionObserved) { saved.executionObserved = true; this.options.imageRuntime!.writeState(this.key(id), saved); }
    const observation: InputObservation = { provider: "claude", nativeSessionId: this.sessionId, operationId: id, nativeMessageId: id, intentSha256: saved.intentSha256 };
    if (this.options.onInputObserved?.(observation) !== true) return null;
    saved.executed = true; this.options.imageRuntime!.writeState(this.key(id), saved); return id;
  }
}
