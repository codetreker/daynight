import { Socket } from "node:net";

import type { SessionV2Key } from "../../../session/v2/types.js";

export type TerminalKey = SessionV2Key;
export type TerminalInput = { kind: "paste"; text: string } | { kind: "keys"; key: TerminalKey };
export type TerminalInputResult = { status: "transport_completed" | "rejected" | "unknown"; reason: string };
export type TerminalInputRequest = {
  endpoint: string; terminalId: string; width: number; height: number; herdrVersion: string;
  inputs: readonly TerminalInput[]; signal: AbortSignal;
  /** Revalidate the durable target and admission immediately before each Input frame. */
  beforeWrite: () => Promise<void>;
  /** Synchronous notification immediately before invoking the native Input write. */
  onWrite?: () => void;
};

export const HERDR_INPUT_TIMEOUT_MS = 10_000;
export const HERDR_INPUT_MAX_PASTE_BYTES = 16 * 1024;
const maximumFrameBytes = 2 * 1024 * 1024;
const maximumReceivedBytes = 8 * 1024 * 1024;
const supportedVersion = "0.9.5";

// Frozen direct-terminal protocol 22; endpoint-shell negotiation is a separate protocol.
// https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/protocol/wire.rs#L464
const integer = (value: number): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Invalid wire integer.");
  if (value < 251) return Buffer.from([value]);
  const result = Buffer.alloc(value <= 65535 ? 3 : 5);
  result[0] = result.length === 3 ? 251 : 252;
  if (result.length === 3) result.writeUInt16LE(value, 1); else result.writeUInt32LE(value, 1);
  return result;
};
const vector = (value: string): Buffer => { const bytes = Buffer.from(value); return Buffer.concat([integer(bytes.length), bytes]); };
const frame = (...parts: Buffer[]): Buffer => {
  const payload = Buffer.concat(parts), length = Buffer.alloc(4); length.writeUInt32LE(payload.length);
  return Buffer.concat([length, payload]);
};
class Reader {
  private offset = 0;
  constructor(private readonly bytes: Buffer) {}
  byte(): number { return this.bytes.readUInt8(this.offset++); }
  boolean(): number { const value = this.byte(); if (value > 1) throw new Error("Invalid wire boolean."); return value; }
  number(): number {
    const tag = this.bytes.readUInt8(this.offset++);
    if (tag < 251) return tag;
    const size = tag === 251 ? 2 : tag === 252 ? 4 : tag === 253 ? 8 : 0;
    if (size === 0) throw new Error("Invalid wire integer.");
    const value = size === 8 ? Number(this.bytes.readBigUInt64LE(this.offset)) : this.bytes.readUIntLE(this.offset, size);
    this.offset += size;
    if (!Number.isSafeInteger(value)) throw new Error("Wire integer exceeds the safe range.");
    return value;
  }
  vector(): Buffer {
    const length = this.number();
    if (length > this.bytes.length - this.offset) throw new Error("Truncated wire vector.");
    const value = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return value;
  }
  text(): string { return new TextDecoder("utf-8", { fatal: true }).decode(this.vector()); }
  optionalText(): string | undefined {
    const option = this.byte();
    if (option > 1) throw new Error("Invalid optional text.");
    return option === 1 ? this.text() : undefined;
  }
  done(): void { if (this.offset !== this.bytes.length) throw new Error("Unexpected wire payload."); }
}
const basicKeys = {
  Enter: [13, "\r"], Escape: [27, "\x1b"], Tab: [9, "\t"], Backspace: [127, "\x7f"],
  "Ctrl+C": [99, "\x03"], "Ctrl+D": [100, "\x04"], "Ctrl+U": [117, "\x15"],
} as const;
const functionalKeys = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F", Delete: "3~", PageUp: "5~", PageDown: "6~" } as const;
const validKey = (key: string): key is TerminalKey => Object.hasOwn(basicKeys, key) || Object.hasOwn(functionalKeys, key);
const keyBytes = (key: TerminalKey, flags: number, modify: number): string => {
  if (Object.hasOwn(functionalKeys, key)) {
    const final = functionalKeys[key as keyof typeof functionalKeys];
    const prefix = final.endsWith("~") ? final.slice(0, -1) : "1";
    const suffix = final.endsWith("~") ? "~" : final;
    return flags & 2 ? `\x1b[${prefix};1:1${suffix}\x1b[${prefix};1:3${suffix}` : `\x1b[${final}`;
  }
  const [code, legacy] = basicKeys[key as keyof typeof basicKeys];
  const modifier = key.startsWith("Ctrl+") ? 5 : 1;
  if (flags && (flags & 8 || modifier !== 1 || key === "Escape")) {
    const press = `\x1b[${code};${modifier}${flags & 2 ? ":1" : ""}u`;
    const release = flags & 2 ? `\x1b[${code};${modifier}:3u` : "";
    return press + release;
  }
  return modify === 2 && modifier !== 1 ? `\x1b[27;${modifier};${code}~` : legacy;
};
const prepare = (request: TerminalInputRequest): readonly TerminalInput[] => {
  if (request.herdrVersion !== supportedVersion) throw new Error("Herdr version has no verified terminal-input profile.");
  if (!request.endpoint || /[\0\r\n]/.test(request.endpoint) || !request.terminalId || /[\0\r\n]/.test(request.terminalId)) throw new Error("Invalid terminal endpoint or identity.");
  if (![request.width, request.height].every((value) => Number.isInteger(value) && value > 0 && value <= 1000)) throw new Error("Invalid terminal geometry.");
  if (!Array.isArray(request.inputs) || request.inputs.length < 1 || request.inputs.length > 2) throw new Error("Invalid terminal input batch.");
  let pasteBytes = 0;
  const inputs = request.inputs.map((input): TerminalInput => {
    if (input.kind === "keys" && typeof input.key === "string" && validKey(input.key)) return { kind: "keys", key: input.key };
    if (input.kind !== "paste" || typeof input.text !== "string" || !input.text.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(input.text)) throw new Error("Invalid terminal paste or shortcut.");
    pasteBytes += Buffer.byteLength(input.text);
    return { kind: "paste", text: input.text };
  });
  if (pasteBytes > HERDR_INPUT_MAX_PASTE_BYTES) throw new Error("Terminal paste exceeds 16 KiB.");
  if (inputs.length === 2 && !(inputs[0]?.kind === "paste" && inputs[1]?.kind === "keys" && inputs[1].key === "Enter")) throw new Error("Only a prompt paste followed by Enter may share an attachment.");
  return inputs;
};

/**
 * Short strict attachment for one admitted batch. Detach proves transport completion only.
 * Attach can resize or resume a pending runtime before beforeWrite runs; the caller must
 * reject pending or unowned native targets before calling, then recheck in beforeWrite.
 * No write or connection failure is retried. Relative endpoints support isolated probes;
 * managed execution supplies its persisted private endpoint.
 */
export const submitTerminalInput = async (request: TerminalInputRequest): Promise<TerminalInputResult> => {
  let inputs: readonly TerminalInput[];
  try { inputs = prepare(request); } catch (error) { return { status: "rejected", reason: error instanceof Error ? error.message : "Invalid input." }; }
  if (request.signal.aborted) return { status: "rejected", reason: "Terminal input cancelled." };
  const deadline = performance.now() + HERDR_INPUT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const socket = new Socket();
    let pending = Buffer.alloc(0), received = 0, welcomed = false, baseline = false, sending = false, written = false, detached = false;
    let keyboard: { flags: number; modify: number } | undefined;
    let result: TerminalInputResult | undefined;
    const finish = (reason: string, status: TerminalInputResult["status"] = written ? "unknown" : "rejected"): void => {
      if (result) return; result = { status, reason }; socket.destroy();
    };
    const cancelled = (): void => finish("Terminal input cancelled.");
    const timer = setTimeout(() => finish("Terminal input deadline exceeded."), HERDR_INPUT_TIMEOUT_MS);
    const check = (): void => {
      if (result || request.signal.aborted || performance.now() >= deadline) throw new Error("Terminal input no longer admitted.");
    };
    const send = async (): Promise<void> => {
      if (!baseline || !keyboard || sending || result) return;
      sending = true;
      try {
        for (const input of inputs) {
          await request.beforeWrite(); check();
          const bytes = input.kind === "paste" ? `\x1b[200~${input.text}\x1b[201~` : keyBytes(input.key, keyboard.flags, keyboard.modify);
          // Keep each complete paste separate so Herdr applies the live runtime paste mode.
          const message = frame(integer(1), vector(bytes));
          request.onWrite?.(); written = true;
          socket.write(message);
        }
        check(); detached = true; socket.write(frame(integer(4)));
      } catch (error) { finish(error instanceof Error ? error.message : "Terminal admission failed."); }
    };
    socket.once("connect", () => {
      try { check(); socket.write(frame(integer(0), integer(22), integer(request.width), integer(request.height), integer(0), integer(0), integer(0))); }
      catch (error) { finish(error instanceof Error ? error.message : "Terminal connection failed."); }
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        check(); received += chunk.length;
        if (received > maximumReceivedBytes) throw new Error("Terminal response exceeds its byte budget.");
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4 && !result) {
          const length = pending.readUInt32LE();
          if (length < 1 || length > maximumFrameBytes) throw new Error("Invalid terminal frame size.");
          if (pending.length < length + 4) break;
          const reader = new Reader(pending.subarray(4, length + 4)); pending = pending.subarray(length + 4);
          const tag = reader.number();
          if (!welcomed) {
            if (tag !== 0 || reader.number() !== 22 || reader.number() !== 1 || reader.optionalText() !== undefined) throw new Error("Unsupported terminal handshake.");
            reader.done(); welcomed = true;
            socket.write(frame(integer(5), vector(request.terminalId), integer(0)));
          } else if (tag === 1) {
            reader.number(); const width = reader.number(), height = reader.number(), full = reader.boolean(); reader.vector(); reader.done();
            if (width !== request.width || height !== request.height || full > 1) throw new Error("Terminal baseline geometry changed.");
            if (!baseline && full !== 1) throw new Error("Terminal delta preceded its baseline.");
            baseline = true;
          } else if (tag === 16) {
            const flags = reader.number(), modify = reader.byte(); reader.done();
            if (flags > 31 || modify > 2) throw new Error("Unsupported terminal keyboard mode.");
            keyboard = { flags, modify };
          } else if (tag === 3) {
            const reason = reader.optionalText(); reader.done();
            finish(reason ?? "Terminal closed.", written && detached && reason === "detached" ? "transport_completed" : undefined);
          } else if (tag === 2) {
            reader.vector(); reader.done();
          } else if (tag === 4) {
            if (reader.number() > 2) throw new Error("Unknown terminal notification.");
            reader.text(); reader.optionalText(); reader.done();
          } else if (tag === 5) {
            reader.text(); reader.done();
          } else if (tag === 6) {
            reader.optionalText(); reader.done();
          } else if (tag === 7) {
            reader.done();
          } else if (tag === 8) {
            reader.boolean(); reader.boolean(); reader.done();
          } else if (tag === 9) {
            if (reader.number() > 65535) throw new Error("Invalid terminal bell count.");
            reader.done();
          } else {
            throw new Error(`Unsupported terminal message ${tag}.`);
          }
        }
        void send();
      } catch (error) { finish(error instanceof Error ? error.message : "Invalid terminal response."); }
    });
    socket.once("error", (error) => finish(error.message));
    socket.once("end", () => finish("Terminal closed before a detach receipt."));
    socket.once("close", () => {
      clearTimeout(timer); request.signal.removeEventListener("abort", cancelled);
      resolve(result ?? { status: written ? "unknown" : "rejected", reason: "Terminal connection closed." });
    });
    request.signal.addEventListener("abort", cancelled, { once: true });
    if (request.signal.aborted) cancelled();
    else try { socket.connect(request.endpoint); } catch (error) { finish(error instanceof Error ? error.message : "Terminal connection failed."); }
  });
};
