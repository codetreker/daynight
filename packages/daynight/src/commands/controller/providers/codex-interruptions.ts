import { string, type NativeObject } from "./native-rpc.js";
import { limited, nativeEntryId } from "./projection.js";
import type { ProviderEntry } from "./types.js";

type SubmittedInput = { text: string; turnId: string | null; outcome: "pending" | "accepted" | "unknown" };
type Dispatch = { turnId: string | null; settled: Promise<void>; settle(): void };

// Submitted text is presentation evidence only. Native receipt reconciliation
// still requires a userMessage with its original clientId.
export class CodexInterruptions {
  private readonly submitted = new Map<string, SubmittedInput>();
  private readonly dispatches = new Map<string, Dispatch>();
  private readonly observed = new Set<string>();
  private readonly userTurns = new Set<string>();
  private readonly fallbackIds = new Map<string, string>();
  private pendingInput: string | null = null;

  constructor(private readonly sessionId: () => string, private readonly emit: (entry: ProviderEntry) => void, private readonly hasTimelineEntry?: (entryId: string) => boolean, private readonly onInputMessage?: (operationId: string, nativeSessionId: string, entryId: string) => void) {}

  submitting(operationId: string, text: string, turnId: string | null): void {
    this.submitted.set(operationId, { text, turnId, outcome: "pending" });
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    this.dispatches.set(operationId, { turnId, settled, settle });
    this.pendingInput = operationId;
  }

  started(turnId: string): void {
    if (this.pendingInput) this.bind(this.pendingInput, turnId);
  }

  private bind(operationId: string, turnId: string): void {
    const input = this.submitted.get(operationId);
    if (input) input.turnId = turnId;
    const dispatch = this.dispatches.get(operationId);
    if (dispatch) dispatch.turnId = turnId;
  }

  accepted(operationId: string, turnId: string): void {
    this.bind(operationId, turnId);
    const input = this.submitted.get(operationId);
    if (input) input.outcome = "accepted";
  }

  settlement(turnId: string): Promise<void> | null {
    const pending = [...this.dispatches].filter(([id, dispatch]) => dispatch.turnId === turnId && !this.observed.has(id));
    return pending.length ? Promise.all(pending.map(([, dispatch]) => dispatch.settled)).then(() => {}) : null;
  }

  rejected(operationId: string): void { this.submitted.delete(operationId); }

  dispatched(operationId: string): void {
    const input = this.submitted.get(operationId);
    if (input?.turnId === null) this.submitted.delete(operationId);
    else if (input?.outcome === "pending") input.outcome = "unknown";
    this.dispatches.get(operationId)?.settle();
    this.dispatches.delete(operationId);
    if (this.pendingInput === operationId) this.pendingInput = null;
  }

  finished(turnId: string): void {
    for (const [id, input] of this.submitted) if (input.turnId === turnId) this.submitted.delete(id);
  }

  item(turnId: string, raw: NativeObject): NativeObject {
    if (raw.type !== "userMessage") return raw;
    if (turnId) this.userTurns.add(turnId);
    const clientId = string(raw.clientId);
    if (clientId) { this.observed.add(clientId); this.submitted.delete(clientId); }
    const candidate = turnId && clientId ? `submitted-input:${turnId}:${clientId}` : "";
    // A previous Controller generation may have retained this submission before
    // native history became readable. Reuse only an identity it actually saved.
    const fallbackId = this.fallbackIds.get(clientId) ?? (candidate && this.hasTimelineEntry?.(nativeEntryId(this.sessionId(), candidate)) ? candidate : undefined);
    return fallbackId ? { ...raw, id: fallbackId } : raw;
  }

  missing(turnId: string): boolean {
    const inputs = [...this.submitted.entries()].filter(([, input]) => input.turnId === turnId);
    return inputs.length ? inputs.some(([id]) => !this.observed.has(id)) : !this.userTurns.has(turnId);
  }

  completed(turn: NativeObject, completeHistory: boolean | null): void {
    const turnId = string(turn.id);
    if (!turnId || turn.status !== "interrupted") return;
    const base = (id: string) => ({ entryId: nativeEntryId(this.sessionId(), id), revision: "1" });
    if (this.missing(turnId)) {
      for (const [operationId, input] of this.submitted) {
        if (input.turnId !== turnId || this.observed.has(operationId)) continue;
        const id = `submitted-input:${turnId}:${operationId}`;
        this.fallbackIds.set(operationId, id);
        this.onInputMessage?.(operationId, this.sessionId(), base(id).entryId);
        this.emit({ ...base(id), kind: "user_message", content: [{ type: "text", text: limited(input.text) }, { type: "text", text: input.outcome === "unknown" ? "[Submitted input retained by the Controller; dispatch outcome is unknown and native recording is unavailable.]" : "[Submitted input retained by the Controller; native recording is unavailable.]" }] });
      }
      if (completeHistory !== null) this.emit({ ...base(`missing-input:${turnId}`), kind: "error", code: "native_input_missing", message: completeHistory
        ? "Native Codex did not record this interrupted turn's submitted input. Any submitted text shown here is retained by the Controller."
        : "Native input for this interrupted turn could not be verified. Any submitted text shown here is retained by the Controller." });
    }
    this.emit({ ...base(`turn-interrupted:${turnId}`), kind: "error", code: "turn_interrupted", message: "Interrupted by the user." });
  }
}
