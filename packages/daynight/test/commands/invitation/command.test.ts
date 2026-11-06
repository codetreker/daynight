import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, stringifyApiJson } from "../../../src/api/index.js";
import { runCli } from "../../../src/cli/application.js";
import type { CliContext } from "../../../src/cli/context.js";
import { runInvitationCommand } from "../../../src/commands/invitation/command.js";
import { invitationDefinition } from "../../../src/commands/invitation/definition.js";
import { readInvitationLink } from "../../../src/commands/invitation/input.js";
import type { runServerCommand } from "../../../src/commands/server/runtime.js";

const userId = "aaaaaaaa-1111-4111-8111-111111111111";
const personalId = "bbbbbbbb-2222-4222-8222-222222222222";
const teamId = "cccccccc-3333-4333-8333-333333333333";
const secret = `dnteam_${Buffer.alloc(32, 7).toString("base64url")}`;
const link = `http://localhost:8787/team-invitations#${secret}`;
const time = "2026-11-04T00:00:00Z";
const user = { id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: personalId, kind: "personal", name: null } };
const team = { id: teamId, kind: "ordinary", name: "Team" };
const membership = { teamId, userId, role: "member", version: 9_007_199_254_740_993n, createdAt: time, updatedAt: time };
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const json = (body: unknown) => new Response(stringifyApiJson(body), { headers: { "content-type": "application/json", "Daynight-User-ID": userId } });

const fixture = (options: { lost?: boolean; interactive?: boolean; answer?: string; realInput?: boolean } = {}) => {
  const operation = createOperation(); cleanups.push(() => operation.dispose());
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/v1/me") return json(user);
    if (pathname.endsWith("/inspect")) return json({ team, membership: null });
    if (options.lost) throw new Error(`private transport ${secret}`);
    return json({ team, membership, joined: true, consumed: true });
  });
  const api = createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", operation, fetch });
  const context = {
    version: "0", packageDirectory: "unused", homeDirectory: () => { throw new Error("Unexpected config read"); }, workingDirectory: () => { throw new Error("Unexpected repository read"); },
    stdout: vi.fn<(text: string) => void>(), stderr: vi.fn<(text: string) => void>(), stdoutBytes: vi.fn(async (_bytes: Uint8Array) => {}),
    prompt: { isInteractive: options.interactive ?? false, ask: vi.fn(async () => options.answer ?? "yes"), close: vi.fn(), select: vi.fn(), selectMany: vi.fn() },
  } satisfies CliContext;
  const runServer: typeof runServerCommand = async (current, command) => {
    const result = await command({ api, operation, serverUrl: "http://localhost:8787", serverConfiguration: { serverUrl: "http://localhost:8787" } });
    if (typeof result === "string") current.stdout(result); else if (result !== undefined) current.stdout(result.output);
  };
  const readLink = vi.fn<typeof readInvitationLink>(options.realInput ? readInvitationLink : async () => link);
  const run = (args: readonly string[]) => runCli(["invitation", ...args], context, [{ ...invitationDefinition, load: async () => ({ run: (rest, current) => runInvitationCommand(rest, current, { runServerCommand: runServer, readLink }) }) }]);
  return { context, fetch, readLink, run };
};

describe("invitation command", () => {
  it("inspects CRLF stdin and prints the complete response without exposing or accepting its secret", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "stdin")!; const input = new PassThrough();
    Object.defineProperty(process, "stdin", { configurable: true, value: input });
    try {
      const f = fixture({ realInput: true });
      const running = f.run(["inspect", "--stdin", "--json"]); input.end(`${link}\r\n`);
      expect(await running).toBe(0);
      expect(JSON.parse(f.context.stdout.mock.calls[0]![0])).toEqual({ team, membership: null });
      expect(f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/v1/me", "/api/v1/team-invitations/inspect"]);
      expect(JSON.parse(String(f.fetch.mock.calls[1]![1]!.body))).toEqual({ token: secret });
      expect(JSON.stringify([...f.context.stdout.mock.calls, ...f.context.stderr.mock.calls])).not.toContain(secret);
    } finally { Object.defineProperty(process, "stdin", original); input.destroy(); }
  });
  it("inspects and accepts the selected team as the current principal without exposing the link", async () => {
    const f = fixture();
    expect(await f.run(["accept", "--stdin", "--confirm", "--json"])).toBe(0);
    expect(f.readLink).toHaveBeenCalledOnce(); expect(f.readLink.mock.calls[0]![0]).toBe(true);
    expect(f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/v1/me", "/api/v1/team-invitations/inspect", "/api/v1/team-invitations/accept"]);
    expect(JSON.parse(String(f.fetch.mock.calls[2]![1]!.body))).toEqual({ token: secret, expectedUserId: userId });
    expect(new Headers(f.fetch.mock.calls[2]![1]!.headers).get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(f.context.stdout.mock.calls[0]![0])).toMatchObject({ team, membership: { userId, role: "member" }, joined: true, consumed: true });
    expect(f.context.stderr.mock.calls.map(([text]) => text).join("")).toContain(teamId);
    expect(JSON.stringify([...f.context.stdout.mock.calls, ...f.context.stderr.mock.calls])).not.toContain(secret);
  });
  it("preserves unknown acceptance and request identity without replay or leaking the secret", async () => {
    const f = fixture({ lost: true });
    expect(await f.run(["accept", "--stdin", "--confirm"])).toBe(1);
    const calls = f.fetch.mock.calls;
    expect(calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/v1/me", "/api/v1/team-invitations/inspect", "/api/v1/team-invitations/accept"]);
    const requestId = new Headers(calls[2]![1]!.headers).get("X-Request-ID");
    const error = f.context.stderr.mock.calls.map(([text]) => text).join("");
    expect(error).toContain(`outcome is unknown (requestId=${requestId})`); expect(error).not.toContain(secret);
    expect(f.context.stdout).not.toHaveBeenCalled();
  });
  it("rejects secret arguments and unconfirmed noninteractive acceptance before reading or sending", async () => {
    const f = fixture();
    expect(await f.run(["inspect", link])).toBe(2);
    expect(await f.run(["accept", "--stdin"])).toBe(1);
    expect(f.readLink).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(f.context.stderr.mock.calls)).not.toContain(secret);
  });
  it("rejects a token flag without exposing its value or making requests", async () => {
    const f = fixture();
    expect(await f.run(["inspect", "--token", secret])).toBe(2);
    expect(f.readLink).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    expect(f.context.stdout).not.toHaveBeenCalled();
    expect(JSON.stringify(f.context.stderr.mock.calls)).not.toContain(secret);
  });
  it("does not accept after the user declines the displayed preview", async () => {
    const f = fixture({ interactive: true, answer: "no" });
    expect(await f.run(["accept", "--stdin"])).toBe(1);
    expect(f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/v1/me", "/api/v1/team-invitations/inspect"]);
    expect(f.context.prompt.ask).toHaveBeenCalledOnce(); expect(f.context.stdout).not.toHaveBeenCalled();
  });
});

describe("invitation stdin", () => {
  it.each([{ bytes: Buffer.from("x".repeat(4096)), expected: "x".repeat(4096) }, { bytes: Buffer.from(`${link}\r\n`), expected: link }])("accepts bounded bytes and removes one line ending", async ({ bytes, expected }) => {
    const original = Object.getOwnPropertyDescriptor(process, "stdin")!; const input = new PassThrough();
    Object.defineProperty(process, "stdin", { configurable: true, value: input });
    try { const result = readInvitationLink(true, new AbortController().signal); input.end(bytes); expect(await result).toBe(expected); }
    finally { Object.defineProperty(process, "stdin", original); input.destroy(); }
  });
  it.each([Buffer.alloc(4097, 120), Buffer.from([0xff])])("rejects oversized or malformed UTF-8 before parsing", async (bytes) => {
    const original = Object.getOwnPropertyDescriptor(process, "stdin")!; const input = new PassThrough();
    Object.defineProperty(process, "stdin", { configurable: true, value: input });
    try { const result = readInvitationLink(true, new AbortController().signal); input.end(bytes); await expect(result).rejects.toThrow(); }
    finally { Object.defineProperty(process, "stdin", original); input.destroy(); }
  });
});

it.skipIf(process.platform === "win32")("reads terminal input in hidden raw mode and restores it", async () => {
  const { spawn } = await import("node-pty");
  const entry = new URL("../../../dist/commands/invitation/input.js", import.meta.url).href;
  const program = `import(${JSON.stringify(entry)}).then(async ({ readInvitationLink }) => { const before = process.stdin.isRaw === true; const value = await readInvitationLink(false, new AbortController().signal); process.stdout.write(JSON.stringify({ matches: value === ${JSON.stringify(link)}, before, after: process.stdin.isRaw === true })); }).catch(() => { process.exitCode = 1; });`;
  const terminal = spawn(process.execPath, ["--input-type=module", "-e", program], { name: "xterm", cols: 120, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
  let output = "", sent = false, exited = false;
  const closed = new Promise<number>((resolve) => terminal.onExit(({ exitCode }) => { exited = true; resolve(exitCode); }));
  terminal.onData((data) => {
    output += data;
    if (!sent && output.includes("Invitation link (hidden):")) { sent = true; terminal.write(`${link}\r`); }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Invitation terminal timed out.")), 10_000); })]);
    expect(code).toBe(0); expect(sent).toBe(true);
    // The helper reports only whether the input matched and the raw-mode state.
    expect(output).not.toContain(link);
    expect(output).toContain('"matches":true,"before":false,"after":false');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!exited) {
      try { process.kill(-terminal.pid, "SIGKILL"); }
      catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause; }
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { cleanupTimer = setTimeout(() => reject(new Error("Invitation terminal did not exit after termination.")), 3_000); })]); }
      finally { if (cleanupTimer !== undefined) clearTimeout(cleanupTimer); }
    }
  }
}, 15_000);
