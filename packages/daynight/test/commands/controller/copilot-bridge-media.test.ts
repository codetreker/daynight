import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { encodeCopilotBridgeImages, exportCopilotBridgeMedia } from "../../../src/commands/controller/providers/copilot-bridge-media.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const file = async (value: string) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-bridge-media"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); roots.push(root);
  const filename = path.join(root, "image"), bytes = Buffer.from(value); await writeFile(filename, bytes, { mode: 0o400 });
  return { path: filename, byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/png" };
};

test("ordered image lease files produce one native blob array and no invented prompt", async () => {
  const first = await file("first"), second = await file("second");
  expect(await encodeCopilotBridgeImages({ prompt: "", mode: "immediate", attachments: [first, second] })).toEqual({ prompt: "", mode: "immediate", attachments: [
    { type: "blob", data: Buffer.from("first").toString("base64"), mimeType: "image/png" },
    { type: "blob", data: Buffer.from("second").toString("base64"), mimeType: "image/png" },
  ] });
});

test("second image failure prevents any native send instead of sending a prepared subset", async () => {
  const first = await file("first"), second = await file("second"), send = vi.fn();
  second.sha256 = "f".repeat(64);
  await expect(encodeCopilotBridgeImages({ prompt: "question", mode: "immediate", attachments: [first, second] }).then(send)).rejects.toThrow("integrity");
  expect(send).not.toHaveBeenCalled();
});

test("only explicit native media fields become transfer slots and source order is preserved", async () => {
  const media: unknown[] = [];
  const event = { type: "tool.execution_complete", id: "event", data: { toolCallId: "tool", success: false, result: { contents: [
    { type: "text", text: "before" }, { type: "image", mimeType: "image/png", data: "YWJj" }, { type: "text", text: "after" },
  ], structuredContent: { data: "not-an-image", type: "image" }, binaryResultsForLlm: [{ type: "image", mimeType: "image/png", data: "ZGVm" }] } } };
  const output = await exportCopilotBridgeMedia(event, "event", async (data, mime) => { media.push({ data, mime }); return { transferId: String(media.length) }; });
  expect(media).toEqual([{ data: "YWJj", mime: "image/png" }, { data: "ZGVm", mime: "image/png" }]);
  expect(output.images.map(image => image.path)).toEqual([["data", "result", "contents", 1, "data"], ["data", "result", "binaryResultsForLlm", 0, "data"]]);
  expect(output.value).toMatchObject({ data: { success: false, toolCallId: "tool", result: { contents: [{ type: "text", text: "before" }, { type: "image", data: null }, { type: "text", text: "after" }], structuredContent: { data: "not-an-image" } } } });
  expect(event.data.result.contents[1]!.data).toBe("YWJj");
});

test("user attachments transfer sequentially so a slow receiver retains one image at a time", async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; }), started: string[] = [];
  const work = exportCopilotBridgeMedia({ type: "user.message", data: { attachments: [
    { type: "blob", mimeType: "image/png", data: "first" }, { type: "blob", mimeType: "image/png", data: "second" },
  ] } }, "event", async data => { started.push(data); if (data === "first") await blocked; return { transferId: data }; });
  try { await setImmediate(); expect(started).toEqual(["first"]); }
  finally { unblock(); }
  expect((await work).images.map(slot => slot.transferId)).toEqual(["first", "second"]);
});
