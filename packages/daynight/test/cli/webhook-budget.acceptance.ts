import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

// Deliberately excluded from routine CI: this creates hundreds of real endpoints
// and observes the unscaled five-minute command deadline.
const enabled = process.env.DAYNIGHT_WEBHOOK_BUDGET === "1" && process.env.DAYNIGHT_TEST_DATABASE_URL !== undefined;
const token = (prefix: string): string => prefix + randomBytes(32).toString("base64url");
const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
type HostInfo = { url: string; userId: string; teamId: string; schema: string };
type Page = { mode: string; method: string; path: string; startedMs: number; readyMs: number; status: number; bytes: number; sha256: string; responseBase64: string; clientClosedMs?: number; forwardedMs?: number };

it.skipIf(!enabled)("bounds real installed webhook list and read operations across their original budgets", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const root = path.join(receipt.root, "webhook-budget"), config = path.join(root, "config"), tmp = path.join(root, "tmp"), home = path.join(root, "home");
  const originalServer = path.resolve(import.meta.dirname, "../../../daynight-server"), copiedServer = path.join(root, "server");
  const admin = token("dnpat_"), member = token("dnpat_");
  const records: Page[] = [], created: { scope: string; status: number; requestSha256: string; responseSha256: string; requestBase64: string; responseBase64: string }[] = [];
  const cases: { name: string; status: number | null; durationMs: number; stdout: string; stdoutBytes: number; stdoutSha256: string; stderr: string; requests: Page[] }[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const children = new Map<ChildProcess, Promise<unknown>>();
  let info: HostInfo | undefined, host: ChildProcess | undefined, hostClosed: Promise<unknown> | undefined;
  let originalHostHash = "", adaptedHostHash = "", databaseVersion = "", failure: unknown;
  let mode = "none", commandStart = 0;
  const now = (): number => Math.round(performance.now() - commandStart);
  const proxy = createServer((incoming, outgoing) => {
    const requestBody: Buffer[] = [];
    incoming.on("data", (part: Buffer) => requestBody.push(part));
    incoming.on("end", () => {
      const target = new URL(incoming.url!, info!.url);
      const startedMs = now(), requestMode = mode;
      const upstream = httpRequest(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => {
          const bytes = Buffer.concat(parts);
          const entry: Page = { mode: requestMode, method: incoming.method!, path: incoming.url!, startedMs, readyMs: now(), status: response.statusCode!, bytes: bytes.length, sha256: sha(bytes), responseBase64: bytes.toString("base64") };
          records.push(entry);
          const delayed = requestMode === "request-timeout" && incoming.url === "/api/v1/webhook-event-types" || requestMode === "total-timeout" && incoming.url!.startsWith("/api/v1/me/webhooks");
          const deliver = (): void => {
            if (outgoing.destroyed) return;
            entry.forwardedMs = now();
            outgoing.writeHead(response.statusCode!, response.headers); outgoing.end(bytes);
          };
          if (!delayed) { deliver(); return; }
          const delay = requestMode === "request-timeout" ? 32_000 : 28_800;
          const timer = setTimeout(() => { timers.delete(timer); deliver(); }, delay);
          timers.add(timer);
          outgoing.once("close", () => { entry.clientClosedMs = now(); clearTimeout(timer); timers.delete(timer); });
        });
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.end(Buffer.concat(requestBody));
    });
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, DN_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(root, "xdg"), XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: tmp, TMP: tmp, TEMP: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const invoke = async (label: string, args: string[], timeoutMs: number): Promise<void> => {
    const begin = records.length;
    mode = label; commandStart = performance.now();
    const child = spawn(receipt.launcherPath, ["webhook", ...args, "--json"], { cwd: root, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout!.on("data", (part: Buffer) => stdout.push(part)); child.stderr!.on("data", (part: Buffer) => stderr.push(part));
    let launchError: unknown; child.once("error", cause => { launchError = cause; });
    const closed = new Promise<number | null>(resolve => child.once("close", code => { children.delete(child); resolve(code); })); children.set(child, closed);
    let timer: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), timeoutMs); })]);
      if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error(`${label} did not finish within the test deadline.`); }
      if (launchError !== undefined) throw launchError;
      const output = Buffer.concat(stdout), diagnostic = Buffer.concat(stderr);
      cases.push({ name: label, status: code, durationMs: now(), stdout: output.toString("base64"), stdoutBytes: output.length, stdoutSha256: sha(output), stderr: diagnostic.toString("base64"), requests: records.slice(begin) });
      expect(code).toBe(1); expect(output.length).toBe(0);
      expect(JSON.parse(diagnostic.toString()).error).toMatchObject({ invocationOutcome: "read_failed" });
    } finally { if (timer !== undefined) clearTimeout(timer); mode = "none"; }
  };
  const create = async (scope: "personal" | "team", index: number, longUrl: boolean): Promise<void> => {
    const base = scope === "personal" ? "/api/v1/me/webhooks" : `/api/v1/teams/${info!.teamId}/webhooks`;
    const payload = JSON.stringify({ operationId: randomUUID(), issuedAt: new Date().toISOString(), expectedUserId: info!.userId, name: `Budget ${scope} ${index}`, enabled: false, destination: { kind: "http", adapterVersion: "1", configuration: { url: `https://receiver.example/${longUrl ? "x".repeat(3_000) : "hook"}/${index}` } }, subscriptions: [] });
    const response = await fetch(info!.url + base, { method: "POST", headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: payload, signal: AbortSignal.timeout(30_000) });
    const body = Buffer.from(await response.arrayBuffer());
    created.push({ scope, status: response.status, requestSha256: sha(Buffer.from(payload)), responseSha256: sha(body), requestBase64: Buffer.from(payload).toString("base64"), responseBase64: body.toString("base64") });
    if (response.status !== 201) throw new Error(`Real endpoint setup failed at ${scope} ${index} (HTTP ${response.status}).`);
    const value = JSON.parse(body.toString());
    if (value.operation.requestSha256 !== sha(Buffer.from(payload)) || value.endpoint.owner.kind !== scope) throw new Error("Real endpoint setup receipt did not match the request.");
  };
  const populate = async (scope: "personal" | "team", count: number, longUrl: boolean): Promise<void> => {
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { while (next < count) { const index = next++; await create(scope, index, longUrl); } }));
  };
  try {
    await Promise.all([home, config, tmp].map(dir => mkdir(dir, { recursive: true })));
    await cp(originalServer, copiedServer, { recursive: true });
    const sourcePath = path.join(copiedServer, "testdata/webhook-host/main.go");
    const original = await readFile(sourcePath, "utf8");
    const adapted = original.replace('authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"', '"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"\n\tauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"').replace("\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    if (adapted === original || !adapted.includes("httpx.RequestLogging(logger, mux).ServeHTTP(w, r)")) throw new Error("Could not apply production middleware to the fixture copy.");
    originalHostHash = sha(Buffer.from(original)); adaptedHostHash = sha(Buffer.from(adapted));
    await writeFile(sourcePath, adapted);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: copiedServer, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: process.env.DAYNIGHT_TEST_DATABASE_URL!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: admin, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: member } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const infoLine = new Promise<string>((resolve, reject) => {
      let text = ""; host!.once("error", reject); host!.stderr!.resume();
      host!.stdout!.on("data", (part: Buffer) => { text += part.toString(); const end = text.indexOf("\n"); if (end >= 0) resolve(text.slice(0, end)); });
      host!.once("close", () => reject(new Error("Webhook fixture exited before readiness.")));
    });
    info = JSON.parse(await Promise.race([infoLine, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Webhook fixture readiness timed out.")), 60_000); timer.unref(); })])) as HostInfo;
    const versionProbe = path.join(root, "pg-version.go");
    await writeFile(versionProbe, 'package main\nimport ("context"; "fmt"; "os"; "github.com/jackc/pgx/v5")\nfunc main(){ctx:=context.Background(); c,e:=pgx.Connect(ctx,os.Getenv("DAYNIGHT_TEST_DATABASE_URL")); if e!=nil { panic("database unavailable") }; defer c.Close(ctx); var v string; if c.QueryRow(ctx,"SHOW server_version").Scan(&v)!=nil { panic("version unavailable") }; fmt.Println(v)}\n', { mode: 0o600 });
    const probe = spawn("go", ["run", versionProbe], { cwd: copiedServer, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: process.env.DAYNIGHT_TEST_DATABASE_URL! } });
    let probeError: unknown; probe.once("error", error => { probeError = error; });
    const versionParts: Buffer[] = []; probe.stdout!.on("data", (part: Buffer) => versionParts.push(part)); probe.stderr!.resume();
    const probeClosed = new Promise<number | null>(resolve => probe.once("close", code => { children.delete(probe); resolve(code); })); children.set(probe, probeClosed);
    let probeTimer: NodeJS.Timeout | undefined;
    try {
      const status = await Promise.race([probeClosed, new Promise<"timeout">(resolve => { probeTimer = setTimeout(() => resolve("timeout"), 60_000); })]);
      if (status === "timeout") { await terminateInstalledProcess(probe, probeClosed); throw new Error("PostgreSQL version probe timed out."); }
      if (probeError !== undefined || status !== 0) throw new Error("PostgreSQL version probe failed.");
      databaseVersion = Buffer.concat(versionParts).toString().trim();
      if (databaseVersion.length === 0) throw new Error("PostgreSQL version is empty.");
    } finally { if (probeTimer !== undefined) clearTimeout(probeTimer); }
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (address === null || typeof address === "string") throw new Error("Proxy address unavailable.");
    await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${admin}\n`, { mode: 0o600 });

    await populate("team", 200, true);
    console.log("Budget acceptance: 200 real Team endpoints created.");
    await invoke("render-limit", ["list", "--team", info.teamId], 60_000);
    const rendered = cases.at(-1)!;
    const teamPages = rendered.requests.filter(r => r.path.startsWith(`/api/v1/teams/${info!.teamId}/webhooks`));
    expect(teamPages.length).toBeGreaterThanOrEqual(3);
    expect(teamPages.every(page => page.status === 200 && page.bytes <= 1_048_576)).toBe(true);
    const combined: unknown[] = [];
    for (const [index, page] of teamPages.entries()) {
      combined.push(...JSON.parse(Buffer.from(page.responseBase64, "base64").toString()).items);
      const renderedBytes = Buffer.byteLength(JSON.stringify({ items: combined }));
      if (index < teamPages.length - 1) expect(renderedBytes).toBeLessThanOrEqual(1_048_576);
      else expect(renderedBytes).toBeGreaterThan(1_048_576);
    }

    console.log("Budget acceptance: cumulative render boundary verified; measuring the single-request deadline.");
    await invoke("request-timeout", ["catalog"], 40_000);
    const requestTimeout = cases.at(-1)!;
    expect(requestTimeout.durationMs).toBeGreaterThanOrEqual(29_000); expect(requestTimeout.durationMs).toBeLessThan(38_000);
    expect(requestTimeout.requests.filter(r => r.path === "/api/v1/webhook-event-types")).toHaveLength(1);
    expect(requestTimeout.requests.find(r => r.path === "/api/v1/webhook-event-types")?.forwardedMs).toBeUndefined();

    console.log("Budget acceptance: single-request deadline verified; preparing the total deadline.");
    await populate("personal", 501, false);
    console.log("Budget acceptance: 501 real Personal endpoints created; measuring the five-minute deadline.");
    await invoke("total-timeout", ["list", "--personal"], 330_000);
    const total = cases.at(-1)!;
    const pages = total.requests.filter(r => r.path.startsWith("/api/v1/me/webhooks"));
    expect(total.durationMs).toBeGreaterThanOrEqual(295_000); expect(total.durationMs).toBeLessThan(315_000);
    expect(pages).toHaveLength(11); expect(pages.slice(0, 10).every(p => p.status === 200 && p.forwardedMs !== undefined && JSON.parse(Buffer.from(p.responseBase64, "base64").toString()).nextCursor !== null)).toBe(true);
    expect(pages[10]!.forwardedMs).toBeUndefined();
    expect(pages.reduce((sum, page) => sum + page.bytes, 0)).toBeLessThan(1_048_576);
    console.log("Budget acceptance: five-minute deadline verified.");
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const timer of timers) clearTimeout(timer);
  for (const [child, closed] of children) try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); }
  if (info !== undefined) try {
    const response = await fetch(info.url + "/__fixture/shutdown", { method: "POST", headers: { Authorization: `Bearer ${admin}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Fixture shutdown returned ${response.status}.`);
  } catch (cause) { cleanup.push(cause); }
  if (host !== undefined && hostClosed !== undefined) try {
    let timer: NodeJS.Timeout | undefined;
    try { if (await Promise.race([hostClosed.then(() => "closed"), new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10_000); })]) === "timeout") await terminateInstalledProcess(host, hostClosed); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  } catch (cause) { cleanup.push(cause); }
  try { proxy.closeAllConnections(); if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  if (process.env.DAYNIGHT_WEBHOOK_BUDGET_EVIDENCE !== undefined) try {
    const output = process.env.DAYNIGHT_WEBHOOK_BUDGET_EVIDENCE;
    if (!path.isAbsolute(output)) throw new Error("Budget evidence path must be absolute.");
    await writeFile(output, `${JSON.stringify({ source: receipt.source, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256 }, fixture: { ...info, originalHostSha256: originalHostHash, adaptedHostSha256: adaptedHostHash, databaseVersion, adaptation: "T05 fixture plus production request logging middleware" }, passed: failure === undefined && cleanup.length === 0, cleanupErrors: cleanup.length, created, cases }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (cause) { cleanup.push(cause); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Webhook budget acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 900_000);
