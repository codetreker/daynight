import { NativeRpcError } from "./native-rpc.js";
import type { NativeInput } from "./types.js";

export const textNativeInput = (text: string): NativeInput => ({ content: [{ type: "text", text }] });

/** Text adapters fail before mutation when the whole input needs an image encoder. */
export const nativeInputText = (input: NativeInput): string => {
  if (!input || !Array.isArray(input.content) || input.content.length === 0) throw new NativeRpcError(-32602, "Native input is empty.");
  if (input.content.some(part => part.type === "image")) throw new NativeRpcError(-32602, "Native image input is not supported by this provider revision.");
  if (input.content.some(part => part.type !== "text" || typeof part.text !== "string" || !part.text.isWellFormed())) throw new NativeRpcError(-32602, "Native text input is invalid.");
  return input.content.map(part => part.type === "text" ? part.text : "").join("\n");
};
