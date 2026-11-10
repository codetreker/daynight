import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { CopilotBridgeChannel } from "../../../src/commands/controller/providers/copilot-bridge-channel.js";

afterEach(() => vi.useRealTimers());

test("metadata larger than an IPC frame is reconstructed with exact UTF-8 bytes", async () => {
  const a = new PassThrough(), b = new PassThrough(), received: unknown[] = [], errors: Error[] = [];
  const left = new CopilotBridgeChannel(b, a, value => received.push(value), error => errors.push(error));
  const right = new CopilotBridgeChannel(a, b, value => received.push(value), error => errors.push(error));
  const catalog = { id: "model/list:1", revision: "7", items: Array.from({ length: 500 }, (_, id) => ({ id, name: "你好".repeat(500) })) };
  try { await left.send(catalog); expect(received).toEqual([catalog]); expect(errors).toEqual([]); }
  finally { left.close(); right.close(); a.destroy(); b.destroy(); }
});

test("a corrupt segmented metadata digest is rejected before delivering content", async () => {
  const input = new PassThrough(), output = new PassThrough(), received: unknown[] = [], errors: Error[] = [];
  const channel = new CopilotBridgeChannel(input, output, value => received.push(value), error => errors.push(error));
  try {
    input.write(JSON.stringify({ kind: "begin", id: "x", length: 2, sha256: "0".repeat(64) }) + "\n");
    input.write(JSON.stringify({ kind: "part", id: "x", offset: 0, data: Buffer.from("{}").toString("base64") }) + "\n");
    input.write(JSON.stringify({ kind: "end", id: "x" }) + "\n");
    expect(received).toEqual([]); expect(errors).toHaveLength(1);
  } finally { channel.close(); input.destroy(); output.destroy(); }
});

test("an IPC line cannot grow beyond one MiB before parsing", () => {
  const input = new PassThrough(), output = new PassThrough(), errors: Error[] = [];
  const channel = new CopilotBridgeChannel(input, output, () => { throw new Error("must not deliver"); }, error => errors.push(error));
  try { input.write(Buffer.alloc(1_048_577, 65)); expect(errors).toHaveLength(1); }
  finally { channel.close(); input.destroy(); output.destroy(); }
});

test.each(["duplicate", "third", "offset", "incomplete"])("metadata assembly rejects %s without publishing partial controls", kind => {
  const input = new PassThrough(), output = new PassThrough(), received: unknown[] = [], errors: Error[] = [];
  const channel = new CopilotBridgeChannel(input, output, value => received.push(value), error => errors.push(error));
  const write = (value: unknown) => input.write(JSON.stringify(value) + "\n");
  const begin = (id: string) => write({ kind: "begin", id, length: 2, sha256: "0".repeat(64) });
  try {
    begin("first");
    if (kind === "duplicate") begin("first");
    else if (kind === "third") { begin("second"); begin("third"); }
    else if (kind === "offset") write({ kind: "part", id: "first", offset: 1, data: "eA==" });
    else write({ kind: "end", id: "first" });
    expect(received).toEqual([]); expect(errors).toHaveLength(1);
  } finally { channel.close(); input.destroy(); output.destroy(); }
});

test("an admitted metadata transfer expires after no progress and returns no partial object", async () => {
  vi.useFakeTimers();
  const input = new PassThrough(), output = new PassThrough(), received: unknown[] = [], errors: Error[] = [];
  const channel = new CopilotBridgeChannel(input, output, value => received.push(value), error => errors.push(error));
  try {
    input.write(JSON.stringify({ kind: "begin", id: "slow", length: 2, sha256: "0".repeat(64) }) + "\n");
    await vi.advanceTimersByTimeAsync(29_999); expect(errors).toEqual([]);
    input.write(JSON.stringify({ kind: "part", id: "slow", offset: 0, data: "ew==" }) + "\n");
    await vi.advanceTimersByTimeAsync(29_999); expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(errors).toHaveLength(1); expect(received).toEqual([]);
  } finally { channel.close(); input.destroy(); output.destroy(); }
});
