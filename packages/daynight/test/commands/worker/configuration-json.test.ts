import { describe, expect, it } from "vitest";
import { configurationJsonChunks, parseConfigurationJson } from "../../../src/commands/worker/configuration-json.js";

async function* bytes(source: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < source.length; i += size) yield source.subarray(i, i + size);
}
const parse = (source: string, size = 1): Promise<unknown> => parseConfigurationJson(bytes(Buffer.from(source), size));

describe("configuration cache chunked JSON", () => {
  it("round trips Unicode, escaped characters and value strings resembling forbidden keys", async () => {
    const value = { schemaVersion: 4, nativeModes: { "native:": "web" }, values: ["雪😀", "__proto__", "123", "escaped \" slash \\ newline\n"], nested: { ok: true, nothing: null, count: 42 } };
    const chunks = configurationJsonChunks(value);
    async function* encoded(): AsyncGenerator<Uint8Array> {
      for (const chunk of chunks) yield Buffer.from(chunk);
    }
    expect(await parseConfigurationJson(encoded())).toEqual(value);
    expect(await parse(JSON.stringify(value))).toEqual(value);
  });

  it.each([
    '{"key":1,"k\\u0065y":2}',
    '{"__pr\\u006fto__":1}',
    '{"\\u0031":1}',
    '{"a":-1}', '{"a":1.0}', '{"a":1e2}', '{"a":01}',
    '\ufeff{"a":1}', '{"a":1} {}', '{"a":1}x', '{"a":', '{"a":"unterminated}',
    '{"a":"\\q"}', '{"a":"\\u0x00"}', '{"a":"\n"}',
    '{"a":true,}', '{"a":[1,]}', '{"a":true false}', '[]',
  ])("rejects invalid cache source %s across fragment boundaries", async source => {
    await expect(parse(source)).rejects.toThrow();
  });

  it("rejects invalid and truncated UTF-8 rather than replacing it", async () => {
    for (const source of [Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe9])]) {
      await expect(parseConfigurationJson(bytes(source, 1))).rejects.toThrow();
    }
  });

  it("accepts at most 64 nested containers", async () => {
    const source = (count: number): string => '{"a":' + '['.repeat(count - 1) + '0' + ']'.repeat(count - 1) + '}';
    await expect(parse(source(64), 7)).resolves.toBeDefined();
    await expect(parse(source(65), 7)).rejects.toThrow();
  });

  it("streams a container larger than the permitted single JSON operation", async () => {
    const value = { records: Array.from({ length: 192 }, (_, index) => ({ index, value: "x".repeat(4096) })) };
    const originalParse = JSON.parse, originalStringify = JSON.stringify;
    let maxParse = 0, maxStringify = 0;
    try {
      JSON.parse = ((source: string, ...args: unknown[]) => {
        maxParse = Math.max(maxParse, source.length);
        if (source.length > 65_536) throw new RangeError("parse text budget exceeded");
        return Reflect.apply(originalParse, JSON, [source, ...args]);
      }) as typeof JSON.parse;
      JSON.stringify = ((input: unknown, ...args: unknown[]) => {
        const result = Reflect.apply(originalStringify, JSON, [input, ...args]) as string | undefined;
        if (result !== undefined) {
          maxStringify = Math.max(maxStringify, result.length);
          if (result.length > 65_536) throw new RangeError("stringify text budget exceeded");
        }
        return result;
      }) as typeof JSON.stringify;
      async function* encoded(): AsyncGenerator<Uint8Array> {
        for (const chunk of configurationJsonChunks(value)) yield Buffer.from(chunk);
      }
      const decoded = await parseConfigurationJson(encoded()) as typeof value;
      expect(decoded.records).toHaveLength(192);
      expect(decoded.records[191]).toEqual(value.records[191]);
      expect(maxParse).toBeLessThanOrEqual(65_536);
      expect(maxStringify).toBeLessThanOrEqual(65_536);
    } finally {
      JSON.parse = originalParse;
      JSON.stringify = originalStringify;
    }
  });

  it("checks true EOF even when a completed object has already been read", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('{"ok":true}');
      yield Buffer.from(' ');
      yield Buffer.from('false');
    }
    await expect(parseConfigurationJson(chunks())).rejects.toThrow();
  });
});
