import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { decodeSessionV2Archive } from "../../src/session/v2/archive.js";

vi.mock("../../src/session/v2/protocol.js", () => { throw new Error("Live protocol must not load for archive decoding"); });

const root = new URL("./fixtures/v2/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as { cases: { file: string; type: "message" | "archive"; valid: boolean }[] };

describe("independent v2 recording archive", () => {
  it.each(manifest.cases.filter(item => item.type === "archive"))("decodes $file with expected integrity $valid", async ({ file, valid }) => {
    const result = decodeSessionV2Archive(readFileSync(new URL(file, root)));
    if (valid) await expect(result).resolves.toBeDefined();
    else await expect(result).rejects.toThrow();
  });
});
