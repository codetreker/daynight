import { expect, test } from "vitest";
import { nativeInputText, textNativeInput } from "../../../src/commands/controller/providers/native-input.js";

test("structured native text preserves text fragments and exact whitespace", () => {
  expect(nativeInputText({ content: [{ type: "text", text: " first " }, { type: "text", text: "第二行\n" }] })).toBe(" first \n第二行\n");
  expect(textNativeInput("  text\n")).toEqual({ content: [{ type: "text", text: "  text\n" }] });
});

test("an unimplemented native image encoder rejects the complete input before extracting text", () => {
  expect(() => nativeInputText({ content: [{ type: "text", text: "must not dispatch alone" }, { type: "image", imageId: "image", resourceId: "resource", mediaType: "image/png", byteLength: "1", sha256: "a".repeat(64), localPath: "/private/verified.png" }] })).toThrow("Native image input is not supported");
  expect(() => nativeInputText({ content: [] })).toThrow("empty");
});
