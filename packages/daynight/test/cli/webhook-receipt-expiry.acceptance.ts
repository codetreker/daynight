import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

type Info = { url: string; userId: string; projectId: string; receiverUrl: string; schema: string };
type Observation = { args: string[]; status: number | null; stdout: Buffer; stderr: Buffer };
type Wire = { method: string; path: string; status: number; body: Buffer; response: Buffer[] };
const digest = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const secret = (prefix: string): string => prefix + randomBytes(32).toString("base64url");
const database = process.env.DAYNIGHT_TEST_DATABASE_URL;

// The copied T05 host adds request logging and a read-only database observation.
// A scoped test clock controls the original commit time without replacing the production business modules.
it.skipIf(database === undefined)("does not resend an original operation when its real retained receipt has expired", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const root = path.join(receipt.root, "webhook-receipt-expiry");
  const home = path.join(root, "home"), config = path.join(root, "config"), tmp = path.join(root, "tmp");
  const serverSource = path.resolve(import.meta.dirname, "../../../daynight-server");
  const serverCopy = path.join(root, "server"), pat = secret("dnpat_");
  const calls: Observation[] = [], wire: Wire[] = [], controls: { method: string; path: string; status: number; body: Buffer; response: Buffer }[] = [];
  const snapshots: { label: string; value: unknown }[] = [];
  const children = new Map<ChildProcess, Promise<unknown>>();
  let info: Info | undefined, host: ChildProcess | undefined, hostClosed: Promise<unknown> | undefined;
  let originalHash: string | undefined, adaptedHash: string | undefined, failure: unknown;
  const proxy = createServer((incoming, outgoing) => {
    const parts: Buffer[] = []; incoming.on("data", (part: Buffer) => parts.push(part));
    incoming.on("end", () => {
      const target = new URL(incoming.url!, info!.url), body = Buffer.concat(parts);
      const upstream = request(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
        const observed: Wire = { method: incoming.method!, path: incoming.url!, status: response.statusCode!, body, response: [] };
        wire.push(observed); response.on("data", (part: Buffer) => observed.response.push(part));
        outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing);
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); upstream.end(body);
    });
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, DN_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(root, "xdg"), XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: tmp, TMP: tmp, TEMP: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const invoke = async (args: string[], input?: string, json = true, preload?: string) => {
    const child = spawn(receipt.launcherPath, ["webhook", ...args, ...(json ? ["--json"] : [])], { cwd: root, env: preload === undefined ? env : { ...env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout!.on("data", (part: Buffer) => out.push(part)); child.stderr!.on("data", (part: Buffer) => err.push(part));
    let launchError: unknown; child.once("error", cause => { launchError = cause; });
    const closed = new Promise<number | null>(resolve => child.once("close", code => { children.delete(child); resolve(code); }));
    children.set(child, closed); child.stdin!.end(input);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 30_000); })]);
      if (status === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed webhook command timed out."); }
      if (launchError !== undefined) throw launchError;
      const observed = { args, status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }; calls.push(observed);
      return observed;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const success = async (args: string[], input?: string, preload?: string) => {
    const result = await invoke(args, input, true, preload);
    expect(result.status, `webhook ${args.slice(0, 2).join(" ")}`).toBe(0);
    expect(result.stderr.length).toBe(0); expect(result.stdout.at(-1)).toBe(10);
    return JSON.parse(result.stdout.toString());
  };
  const control = async (method: string, route: string, value?: unknown) => {
    const source = value === undefined ? "" : JSON.stringify(value), body = Buffer.from(source);
    const response = await fetch(info!.url + route, { method, headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: source }) });
    const bytes = Buffer.from(await response.arrayBuffer()); controls.push({ method, path: route, status: response.status, body, response: bytes });
    if (!response.ok) throw new Error(`Fixture control failed: ${method} ${route} (${response.status}).`);
    return bytes.length ? JSON.parse(bytes.toString()) : undefined;
  };
  const observe = async (label: string, id: string) => {
    const value = await control("GET", `/__fixture/receipts/state/${id}`); snapshots.push({ label, value }); return value;
  };
  const replaceOnce = (source: string, from: string, to: string): string => {
    if (source.indexOf(from) < 0 || source.indexOf(from) !== source.lastIndexOf(from)) throw new Error("Unexpected T05 fixture source.");
    return source.replace(from, to);
  };
  try {
    await Promise.all([home, config, tmp].map(dir => mkdir(dir, { recursive: true })));
    await cp(serverSource, serverCopy, { recursive: true });
    const filename = path.join(serverCopy, "testdata/webhook-host/main.go");
    const original = await readFile(filename, "utf8"); let adapted = original;
    adapted = replaceOnce(adapted, 'q.Set("search_path", f.schema)', 'q.Set("search_path", f.schema+",pg_catalog")');
    adapted = replaceOnce(adapted, 'authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"', '"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"\n\tauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"');
    const marker = '\tmux.HandleFunc("POST /__fixture/runner/start", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {';
    adapted = replaceOnce(adapted, "\tcapture := &webhook.Capturer{Keys: keys, Logger: logger}", `\tif _, e := f.db.Pool.Exec(ctx, "CREATE TABLE fixture_clock(delta interval NOT NULL); INSERT INTO fixture_clock VALUES (interval '0 seconds'); CREATE FUNCTION statement_timestamp() RETURNS timestamptz LANGUAGE SQL STABLE AS 'SELECT pg_catalog.statement_timestamp() + delta FROM fixture_clock LIMIT 1' "); e != nil { return nil, e }\n\tcapture := &webhook.Capturer{Keys: keys, Logger: logger}`);
    const addition = `\tmux.HandleFunc("POST /__fixture/receipts/clock", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w,"forbidden",403); return }; var input struct { Delta string ` + '`json:"delta"`' + ` }; if json.NewDecoder(r.Body).Decode(&input)!=nil || (input.Delta != "-31 days" && input.Delta != "0 seconds") { http.Error(w,"invalid",400); return }; if _,e:=f.db.Pool.Exec(r.Context(),"UPDATE fixture_clock SET delta=$1::interval",input.Delta); e!=nil { http.Error(w,"clock unavailable",500); return }; w.WriteHeader(204) }))\n\tmux.HandleFunc("GET /__fixture/receipts/state/{id}", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w,"forbidden",403); return }; id:=r.PathValue("id"); var count int; var issued,hash string; var recorded,expires,actual time.Time; if e:=f.db.Pool.QueryRow(r.Context(),"SELECT count(*),coalesce(max(issued_at_lexeme),''),coalesce(max(encode(request_sha256,'hex')),''),max(recorded_at),max(expires_at),pg_catalog.statement_timestamp() FROM webhook_operations WHERE operation_id=$1",id).Scan(&count,&issued,&hash,&recorded,&expires,&actual); e!=nil { http.Error(w,"receipt read failed",500); return }; var postgresVersion string; if e:=f.db.Pool.QueryRow(r.Context(),"SHOW server_version").Scan(&postgresVersion); e!=nil { http.Error(w,"version read failed",500); return }; w.Header().Set("Content-Type","application/json"); json.NewEncoder(w).Encode(map[string]any{"postgresVersion":postgresVersion,"count":count,"issuedAt":issued,"requestSha256":hash,"recordedAt":recorded.UTC(),"expiresAt":expires.UTC(),"actualTime":actual.UTC()}) }))\n`;
    adapted = replaceOnce(adapted, marker, addition + marker);
    adapted = replaceOnce(adapted, "\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    originalHash = digest(Buffer.from(original)); adaptedHash = digest(Buffer.from(adapted));
    await writeFile(filename, adapted);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: serverCopy, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: pat, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: secret("dnpat_") } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const line = new Promise<string>((resolve, reject) => {
      let text = ""; host!.once("error", reject); host!.stderr!.resume();
      host!.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); const newline = text.indexOf("\n"); if (newline >= 0) resolve(text.slice(0, newline)); });
      host!.once("close", () => reject(new Error("Receipt-expiry fixture exited before readiness.")));
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try { info = JSON.parse(await Promise.race([line, new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Receipt-expiry fixture did not become ready.")), 60_000); })])) as Info; }
    finally { if (startupTimer !== undefined) clearTimeout(startupTimer); }
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (address === null || typeof address === "string") throw new Error("Missing proxy address.");
    await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${pat}\n`, { mode: 0o600 });
    await control("POST", "/__fixture/receipts/clock", { delta: "-31 days" });
    const issuedAt = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString(), operationId = randomUUID();
    const prepared = path.join(root, "original.json"), clockPreload = path.join(root, "client-clock.cjs");
    await writeFile(clockPreload, "const now=Date.now.bind(Date);Date.now=()=>now()-31*24*60*60*1000;\n", { mode: 0o600 });
    const input = JSON.stringify({ name: "Expired receipt", enabled: false, destination: { kind: "http", adapterVersion: "1", configuration: { url: info.receiverUrl } }, subscriptions: [] });
    const originalArgs = ["create", "--personal", "--stdin", "--confirm", "--operation-id", operationId, "--issued-at", issuedAt, "--operation-out", prepared];
    const originalResult = await success(originalArgs, input, clockPreload);
    expect(originalResult.operation.operationId).toBe(operationId);
    const record = JSON.parse((await readFile(prepared)).toString());
    expect(record.issuedAt).toBe(issuedAt); expect(record.requestSha256).toBe(originalResult.operation.requestSha256);
    const before = await observe("historically-committed", operationId);
    expect(before.count).toBe(1); expect(before.issuedAt).toBe(issuedAt); expect(before.requestSha256).toBe(record.requestSha256);
    expect(Date.parse(before.expiresAt)).toBeLessThan(Date.parse(before.actualTime));
    expect(Date.parse(before.recordedAt)).toBeLessThan(Date.parse(before.expiresAt));
    await control("POST", "/__fixture/receipts/clock", { delta: "0 seconds" });
    const now = await observe("expired-and-physically-retained", operationId);
    expect(now.count).toBe(1); expect(now.issuedAt).toBe(issuedAt); expect(now.requestSha256).toBe(record.requestSha256);
    expect(Date.parse(now.expiresAt)).toBeLessThan(Date.parse(now.actualTime));
    const beforeRead = wire.length;
    const observation = await invoke(["operation", "show", operationId, "--personal"]);
    const receiptReads = wire.slice(beforeRead).filter(item => item.method === "GET" && item.path.endsWith(`/operations/${operationId}`));
    expect(receiptReads).toHaveLength(1); expect(receiptReads[0]!.status).toBe(200);
    snapshots.push({ label: "actual-receipt-read", value: { status: observation.status, response: observation.stdout.toString("base64"), stderr: observation.stderr.toString("base64"), httpStatus: receiptReads[0]!.status } });
    const beforeResume = wire.length;
    const resumed = await invoke(["create", "--personal", "--stdin", "--confirm", "--resume-operation", prepared], input);
    const resumeTrace = wire.slice(beforeResume);
    const writes = resumeTrace.filter(item => item.method === "POST");
    const reads = resumeTrace.filter(item => item.method === "GET" && item.path.endsWith(`/operations/${operationId}`));
    expect(writes).toHaveLength(0); expect(reads).toHaveLength(1);
    snapshots.push({ label: "resume-with-expired-receipt", value: { status: resumed.status, stdout: resumed.stdout.toString("base64"), stderr: resumed.stderr.toString("base64"), httpStatus: reads[0]!.status } });
    expect(await observe("after-resume", operationId)).toEqual({ ...now, actualTime: expect.any(String) });
    expect(resumed.status).toBe(1); expect(resumed.stdout.length).toBe(0);
    expect(JSON.parse(resumed.stderr.toString()).error.operationOutcome).toBe("unknown");
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); }
  if (info !== undefined) try { await control("POST", "/__fixture/shutdown"); } catch (cause) { cleanup.push(cause); }
  if (host !== undefined && hostClosed !== undefined) try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { const result = await Promise.race([hostClosed.then(() => "closed"), new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10_000); })]); if (result === "timeout") await terminateInstalledProcess(host, hostClosed); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  } catch (cause) { cleanup.push(cause); }
  try { proxy.closeAllConnections(); if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  if (process.env.DAYNIGHT_WEBHOOK_RECEIPT_EXPIRY_EVIDENCE !== undefined) try {
    const evidence = process.env.DAYNIGHT_WEBHOOK_RECEIPT_EXPIRY_EVIDENCE;
    if (!path.isAbsolute(evidence)) throw new Error("Webhook receipt-expiry evidence path must be absolute.");
    const safe = (bytes: Buffer) => ({ length: bytes.length, sha256: digest(bytes), base64: bytes.includes(Buffer.from(pat)) ? null : bytes.toString("base64") });
    const material = { source: receipt.source, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256 }, fixture: { ...info, originalHostSha256: originalHash, adaptedHostSha256: adaptedHash, adapter: "copied T05 host with production request logging and adjustable schema-scoped statement clock; initial CLI clock also shifted 31 days" }, passed: failure === undefined && cleanup.length === 0, cleanupErrors: cleanup.length, snapshots, calls: calls.map(call => ({ args: call.args, status: call.status, stdout: safe(call.stdout), stderr: safe(call.stderr) })), requests: wire.map(record => ({ method: record.method, path: record.path, status: record.status, body: safe(record.body), response: safe(Buffer.concat(record.response)) })), controls: controls.map(record => ({ method: record.method, path: record.path, status: record.status, body: safe(record.body), response: safe(record.response) })) };
    await writeFile(evidence, `${JSON.stringify(material, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (cause) { cleanup.push(cause); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Webhook receipt-expiry acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 180_000);
