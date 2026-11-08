import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { resolve, join, basename } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileHandle } from "node:fs/promises";
import type { PreparedOperation } from "../../../src/commands/webhook/files.js";

const fault = vi.hoisted(() => ({
  mode: "" as "" | "write" | "close" | "link" | "unlink" | "occupy" | "abort" | "grow" | "swap-file" | "swap-symlink" | "no-proc" | "no-proc-bound",
  temp: "", destination: "", controller: undefined as AbortController | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      if (fault.mode === "no-proc" && path.startsWith("/proc/self/fd/") || fault.mode === "no-proc-bound" && /^\/proc\/self\/fd\/\d+$/.test(path)) throw Object.assign(new Error("procfs unavailable"), { code: "ENOENT" });
      const handle = await actual.open(...args);
      if ((!basename(path).includes(".tmp") && !basename(path).endsWith("prepared-test") && !basename(path).endsWith("grow-test")) || fault.mode === "") return handle;
      fault.temp = path;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat" && fault.mode === "grow") return async () => {
            const before = await target.stat();
            await actual.appendFile(path, Buffer.alloc(256 * 1024));
            return before;
          };
          if (property === "writeFile" && fault.mode === "write") return async (data: Uint8Array) => {
            await target.writeFile(data.subarray(0, Math.min(7, data.length)));
            throw new Error("injected write failure");
          };
          if (property === "close" && ["close", "abort", "occupy", "swap-file", "swap-symlink"].includes(fault.mode)) return async () => {
            await target.close();
            if (fault.mode === "abort") fault.controller?.abort();
            else if (fault.mode === "close") throw new Error("injected close failure");
            else if (fault.mode === "occupy") await actual.writeFile(fault.destination, "concurrent owner", { flag: "wx" });
            else {
              await actual.rename(path, `${path}.saved`);
              if (fault.mode === "swap-file") await actual.writeFile(path, "replacement");
              else await actual.symlink(fault.destination, path);
            }
          };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as FileHandle;
    },
    unlink: async (path: string) => {
      if (fault.mode === "unlink" && path === fault.temp) throw new Error("injected cleanup failure");
      await actual.unlink(path);
    },
  };
});
import { runWebhookCommand } from "../../../src/commands/webhook/command.js";
import { parseWebhookInput, readWebhookInput } from "../../../src/commands/webhook/input.js";
import { PayloadCleanupError, publishPayload, readPrepared, writePrepared } from "../../../src/commands/webhook/files.js";

const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const execFileAsync = promisify(execFile);
const directories: string[] = [];
const dir = async (): Promise<string> => {
  const root = resolve("../../.tmp"); await fs.mkdir(root, { recursive: true });
  const result = await fs.mkdtemp(join(root, "webhook-file-boundary-")); directories.push(result); return result;
};
const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const endpoint = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const operation = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const prepared: PreparedOperation = {
  formatVersion: 1, serverOrigin: "https://daynight.example", actorUserId: user,
  owner: { kind: "personal", id: user }, kind: "endpoint.patch", operationId: operation,
  issuedAt: "2026-11-08T01:02:03.123Z", endpointId: endpoint, deliveryId: null,
  ifVersion: "9007199254740993", ifGeneration: null, requestSha256: "a".repeat(64),
};
const signal = (): AbortSignal => new AbortController().signal;
afterEach(async () => {
  fault.mode = ""; fault.temp = ""; fault.destination = ""; fault.controller = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe("webhook input and private files", () => {
  it("accepts the exact input byte limit and rejects an additional byte", async () => {
    const path = join(await dir(), "input.json");
    const prefix = Buffer.from('{"name":"x"}');
    const input = Buffer.concat([prefix, Buffer.alloc(256 * 1024 - prefix.length, 0x20)]);
    expect(input.length).toBe(256 * 1024);
    await fs.writeFile(path, input);
    const read = await readWebhookInput(path, signal());
    expect(read).toEqual(input);
    expect(parseWebhookInput(read, "update")).toEqual({ name: "x" });
    await fs.appendFile(path, " ");
    await expect(readWebhookInput(path, signal())).rejects.toThrow();
  });

  it("bounds a regular file that grows after the initial metadata check", async () => {
    const path = join(await dir(), "grow-test");
    await fs.writeFile(path, '{"name":"x"}');
    fault.mode = "grow";
    await expect(readWebhookInput(path, signal())).rejects.toThrow();
    expect((await fs.stat(path)).size).toBeGreaterThan(256 * 1024);
  });

  it("rejects duplicate keys at any depth, invalid UTF-8 and command-controlled fields", () => {
    const inputs = [
      '{"name":"x","name":"y"}',
      '{"destination":{"kind":"http","adapterVersion":"1","configuration":{"url":"a","url":"b"}}}',
      '{"operationId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","name":"x"}',
      '{"destination":{"kind":"http","adapterVersion":"1","configuration":{"url":"a","extra":"b"}}}',
      '{"name":"\\ud800"}',
      Buffer.from([0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    ];
    for (const input of inputs) expect(() => parseWebhookInput(Buffer.from(input), "update")).toThrow();
  });

  it("retains distinct subscriptions and refuses repeated IDs, event keys or unknown events", () => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const item = { id, projectId: user, eventTypes: ["task.created"] };
    expect(parseWebhookInput(Buffer.from(JSON.stringify([item, { ...item, id: null }])), "subscriptions")).toEqual([item, { ...item, id: null }]);
    for (const rows of [[item, item], [{ ...item, eventTypes: ["task.created", "task.created"] }], [{ ...item, eventTypes: ["task.unknown"] }], [{ ...item, eventTypes: [] }]]) {
      expect(() => parseWebhookInput(Buffer.from(JSON.stringify(rows)), "subscriptions")).toThrow();
    }
  });

  it.skipIf(process.platform === "win32")("rejects FIFOs and devices without waiting for a writer", async () => {
    const fifo = join(await dir(), "input.fifo");
    await execFileAsync("mkfifo", [fifo], { timeout: 5000 });
    await expect(readWebhookInput(fifo, signal())).rejects.toThrow();
    await expect(readWebhookInput("/dev/null", signal())).rejects.toThrow();
  });

  it("does not create or read files after cancellation", async () => {
    const d = await dir(), path = join(d, "cancelled");
    const cancelled = new AbortController(); cancelled.abort();
    await expect(readWebhookInput(path, cancelled.signal)).rejects.toThrow();
    await expect(writePrepared(path, prepared, cancelled.signal)).rejects.toThrow();
    await expect(publishPayload(path, Buffer.from("payload"), cancelled.signal)).rejects.toThrow();
    expect(await fs.readdir(d)).toEqual([]);
  });

  it("cancels a stalled stdin read without consuming unrelated bytes", async () => {
    const input = new PassThrough();
    vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
    const controller = new AbortController();
    const pending = readWebhookInput(undefined, controller.signal);
    input.write('{"name":"unfinished');
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    input.destroy();
  });

  it.skipIf(process.platform === "win32")("creates an exclusive private prepared record, then preserves existing files and symlinks", async () => {
    const d = await dir(), path = join(d, "prepared.json"), link = join(d, "link.json");
    await writePrepared(path, prepared, signal());
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    const bytes = await fs.readFile(path);
    expect(await readPrepared(path, signal())).toEqual(prepared);
    expect(bytes.toString()).not.toContain("payload");
    await expect(writePrepared(path, { ...prepared, requestSha256: "b".repeat(64) }, signal())).rejects.toThrow();
    await fs.symlink(path, link);
    await expect(writePrepared(link, prepared, signal())).rejects.toThrow();
    await expect(readPrepared(link, signal())).rejects.toThrow();
    expect(await fs.readFile(path)).toEqual(bytes);
  });

  it("rejects malformed or oversized prepared records", async () => {
    const path = join(await dir(), "prepared.json");
    const valid = JSON.stringify(prepared);
    for (const raw of [valid.replace('"formatVersion":1', '"formatVersion":1,"formatVersion":1'), valid.replace('"ifVersion":"9007199254740993"', '"ifVersion":"01"'), valid.replace('"serverOrigin":"https://daynight.example"', '"serverOrigin":"https://daynight.example/private"'), `${valid}${" ".repeat(2 * 256 * 1024 + 8193)}`]) {
      await fs.writeFile(path, raw);
      await expect(readPrepared(path, signal())).rejects.toThrow();
    }
  });

  it.skipIf(process.platform === "win32").each(["write", "close"] as const)("removes an incomplete prepared record when %s fails", async (mode) => {
    const d = await dir(), path = join(d, "prepared-test");
    fault.mode = mode;
    await expect(writePrepared(path, prepared, signal())).rejects.toThrow();
    expect(await fs.readdir(d)).toEqual([]);
  });

  it.skipIf(process.platform === "win32").each(["swap-file", "swap-symlink"] as const)("does not dispatch when prepared output is replaced with %s", async (mode) => {
    const d = await dir(), path = join(d, "prepared-test"), victim = join(d, "victim");
    await fs.writeFile(victim, "replacement");
    await fs.writeFile(join(d, "config.yml"), "serverUrl: http://localhost:8787\nserverToken: test-token\n");
    vi.stubEnv("DN_CONFIG_DIR", d);
    const me = { id: user, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: endpoint, kind: "personal", name: null } };
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      calls.push(new URL(String(url)).pathname);
      return new Response(JSON.stringify(me), { status: 200, headers: { "content-type": "application/json", "Daynight-User-ID": user } });
    }));
    const context = { version: "0", packageDirectory: d, homeDirectory: () => d, workingDirectory: () => d, stdout: vi.fn(), stdoutBytes: vi.fn(async () => {}), stderr: vi.fn() };
    fault.mode = mode; fault.destination = victim;
    await expect(runWebhookCommand(["enable", endpoint, "--personal", "--if-version", "1", "--confirm", "--operation-out", path, "--json"], context)).rejects.toThrow();
    expect(calls).toEqual(["/api/v1/me"]);
    if (mode === "swap-symlink") expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
    else expect(await fs.readFile(path, "utf8")).toBe("replacement");
    expect(await fs.readFile(victim, "utf8")).toBe("replacement");
    expect(JSON.parse(await fs.readFile(`${path}.saved`, "utf8"))).toMatchObject({ actorUserId: user, endpointId: endpoint });
  });

  it.skipIf(process.platform !== "linux").each(["no-proc", "no-proc-bound"] as const)("fails without publishing when procfs is unavailable (%s)", async (mode) => {
    const d = await dir(), path = join(d, "payload");
    fault.mode = mode;
    await expect(publishPayload(path, Buffer.from("original bytes"), signal())).rejects.toThrow();
    expect(await fs.readdir(d)).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")("publishes exact private bytes and refuses existing files, symlinks and concurrent occupants", async () => {
    const d = await dir(), path = join(d, "payload"), link = join(d, "link"), race = join(d, "race");
    const bytes = Buffer.concat([Buffer.from("  你好\n"), Buffer.from([0, 0xff])]);
    await publishPayload(path, bytes, signal());
    expect(await fs.readFile(path)).toEqual(bytes);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    await expect(publishPayload(path, Buffer.from("replacement"), signal())).rejects.toThrow();
    await fs.symlink(path, link);
    await expect(publishPayload(link, Buffer.from("replacement"), signal())).rejects.toThrow();
    expect(await fs.readFile(path)).toEqual(bytes);
    fault.mode = "occupy"; fault.destination = race;
    await expect(publishPayload(race, bytes, signal())).rejects.toThrow();
    expect(await fs.readFile(race, "utf8")).toBe("concurrent owner");
    expect((await fs.readdir(d)).sort()).toEqual(["link", "payload", "race"]);
  });

  it.skipIf(process.platform !== "linux").each(["write", "close", "link", "abort"] as const)("leaves no partial payload after %s fails", async (mode) => {
    const d = await dir(), path = join(d, "payload"), controller = new AbortController();
    if (mode === "link") await fs.writeFile(path, "existing");
    fault.mode = mode; fault.controller = controller;
    await expect(publishPayload(path, Buffer.from("0123456789 original body"), controller.signal)).rejects.toThrow();
    expect(await fs.readdir(d)).toEqual(mode === "link" ? ["payload"] : []);
    if (mode === "link") expect(await fs.readFile(path, "utf8")).toBe("existing");
  });

  it.skipIf(process.platform !== "linux").each(["swap-file", "swap-symlink"] as const)("never publishes or removes the replacement after %s at writer close", async (mode) => {
    const d = await dir(), path = join(d, "payload"), victim = join(d, "victim");
    const original = Buffer.from("original bytes\n"), replacement = "replacement";
    await fs.writeFile(victim, replacement);
    fault.mode = mode; fault.destination = victim;
    const error = await publishPayload(path, original, signal()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PayloadCleanupError);
    const temp = join(d, basename(fault.temp));
    if (mode === "swap-symlink") expect((await fs.lstat(temp)).isSymbolicLink()).toBe(true);
    else expect(await fs.readFile(temp, "utf8")).toBe(replacement);
    expect(await fs.readFile(victim, "utf8")).toBe(replacement);
    try { expect(await fs.readFile(path)).toEqual(original); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    expect(await fs.readFile(`${temp}.saved`)).toEqual(original);
  });

  it.skipIf(process.platform !== "linux")("identifies a temporary file if cleanup fails after a publish error", async () => {
    const d = await dir(), path = join(d, "payload");
    await fs.writeFile(path, "existing");
    fault.mode = "unlink";
    const error = await publishPayload(path, Buffer.from("replacement"), signal()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PayloadCleanupError);
    expect((error as PayloadCleanupError).path).toBe(join(d, basename(fault.temp)));
    expect(await fs.readFile(path, "utf8")).toBe("existing");
    expect(await fs.readFile(join(d, basename(fault.temp)), "utf8")).toBe("replacement");
  });
});
