import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateNativeInput, verifyNativeImageFiles } from "../../../src/commands/controller/providers/native-input.js";
import type { NativeImagePart, NativeInput } from "../../../src/commands/controller/providers/types.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const fixture = async (): Promise<NativeImagePart> => {
  const root = path.resolve("../../.tmp/native-input-tests"); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "input-")); directories.push(directory);
  const localPath = path.join(directory, "original.png"); await writeFile(localPath, png, { mode: 0o400 });
  return { type: "image", imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", localPath, byteLength: String(png.length), sha256: createHash("sha256").update(png).digest("hex") };
};

test("native input retains optional text then ordered images without invented prompt text", async () => {
  const a = await fixture(), b = await fixture();
  expect(validateNativeInput({ content: [a, b] })).toEqual({ text: "", images: [a, b] });
  expect(validateNativeInput({ content: [{ type: "text", text: " read these " }, a, b] })).toEqual({ text: " read these ", images: [a, b] });
  expect(() => validateNativeInput({ content: [a, { type: "text", text: "after" }] })).toThrow(/order/);
  expect(() => validateNativeInput({ content: [a, { ...b, byteLength: "10485761" }] })).toThrow(/bound/);
  expect(() => validateNativeInput({ content: [{ type: "text", text: "" }] })).toThrow(/empty/);
  expect(() => validateNativeInput({ content: [{ type: "unknown" }] } as unknown as NativeInput)).toThrow(/invalid/);
});

test("every native image must still be a regular file with original bytes and MIME", async () => {
  const a = await fixture(), b = await fixture();
  await expect(verifyNativeImageFiles([a, b])).resolves.toBeUndefined();
  await expect(verifyNativeImageFiles([a, { ...b, sha256: "f".repeat(64) }])).rejects.toThrow(/integrity/);
  await expect(verifyNativeImageFiles([{ ...a, mediaType: "image/jpeg" }])).rejects.toThrow(/MIME/);
  const link = path.join(path.dirname(a.localPath), "alias.png"); await symlink(a.localPath, link);
  await expect(verifyNativeImageFiles([{ ...a, localPath: link }])).rejects.toThrow();
});

test.skipIf(process.platform === "win32")("POSIX native image permissions reject writable originals", async () => {
  const image = await fixture();
  await chmod(image.localPath, 0o600);
  await expect(verifyNativeImageFiles([image])).rejects.toThrow(/immutable/);
});
