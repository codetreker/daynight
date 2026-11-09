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
// Business routes, capture and the real TLS runner remain production operations; stored-body adjustments are controlled fixtures.
it.skipIf(database === undefined)("preserves partial PATCH, response media failures and payload bytes through installed CLI", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const root = path.join(receipt.root, "webhook-wire");
  const home = path.join(root, "home"), config = path.join(root, "config"), tmp = path.join(root, "tmp");
  const serverSource = path.resolve(import.meta.dirname, "../../../daynight-server");
  const serverCopy = path.join(root, "server"), pat = secret("dnpat_");
  const calls: Observation[] = [], wire: Wire[] = [], controls: { method: string; path: string; status: number; body: Buffer; response: Buffer }[] = [];
  const snapshots: { label: string; value: unknown }[] = [];
  const children = new Map<ChildProcess, Promise<unknown>>();
  let info: Info | undefined, host: ChildProcess | undefined, hostClosed: Promise<unknown> | undefined;
  let originalHash: string | undefined, adaptedHash: string | undefined, failure: unknown;
  let mediaFault: "read" | "write" | "page" | undefined;
  let mediaTarget = "";
  const faults: { kind: string; path: string; upstreamContentType: string | null; forwardedContentType: string; body: string }[] = [];
  const proxy = createServer((incoming, outgoing) => {
    const parts: Buffer[] = []; incoming.on("data", (part: Buffer) => parts.push(part));
    incoming.on("end", () => {
      const target = new URL(incoming.url!, info!.url), body = Buffer.concat(parts);
      const upstream = request(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
        const observed: Wire = { method: incoming.method!, path: incoming.url!, status: response.statusCode!, body, response: [] };
        wire.push(observed);
        const selected = response.statusCode === 200 && (mediaFault === "read" && incoming.method === "GET" && target.pathname === mediaTarget || mediaFault === "write" && incoming.method === "PATCH" && target.pathname === mediaTarget || mediaFault === "page" && incoming.method === "GET" && target.pathname === "/api/v1/me/webhooks" && target.searchParams.has("cursor"));
        if (!selected) { response.on("data", (part: Buffer) => observed.response.push(part)); outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing); return; }
        const kind = mediaFault!; mediaFault = undefined; const chunks: Buffer[] = [];
        response.on("data", (part: Buffer) => chunks.push(part));
        response.on("end", () => {
          const bytes = Buffer.concat(chunks); observed.response.push(bytes);
          faults.push({ kind, path: incoming.url!, upstreamContentType: response.headers["content-type"] ?? null, forwardedContentType: "text/plain", body: bytes.toString("base64") });
          outgoing.writeHead(response.statusCode!, { ...response.headers, "content-type": "text/plain" }); outgoing.end(bytes);
        });
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); upstream.end(body);
    });
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, DN_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(root, "xdg"), XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: tmp, TMP: tmp, TEMP: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const invoke = async (args: string[], input?: string, json = true) => {
    const child = spawn(receipt.launcherPath, ["webhook", ...args, ...(json ? ["--json"] : [])], { cwd: root, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
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
  const success = async (args: string[], input?: string) => {
    const result = await invoke(args, input);
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
    const value = await control("GET", `/__fixture/wire/body/${id}`); snapshots.push({ label, value }); return value;
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
    adapted = replaceOnce(adapted, '\t"context"', '\t"bytes"\n\t"context"\n\t"crypto/sha256"');
    adapted = replaceOnce(adapted, 'authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"', '"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"\n\tauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"');
    const marker = '\tmux.HandleFunc("POST /__fixture/runner/start", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {';
    const addition = `\tmux.HandleFunc("POST /__fixture/wire/body/{id}", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w,"forbidden",403); return }; id:=r.PathValue("id"); var input struct { Mode string ` + '`json:"mode"`' + `; Body string ` + '`json:"body"`' + ` }; if json.NewDecoder(r.Body).Decode(&input)!=nil { http.Error(w,"invalid",400); return }; var original []byte; if e:=f.db.Pool.QueryRow(r.Context(),"SELECT body FROM webhook_deliveries WHERE id=$1 AND state='pending' AND attempt_sequence=0",id).Scan(&original); e!=nil { http.Error(w,"delivery unavailable",409); return }; var replacement []byte; if input.Mode=="indent" { var formatted bytes.Buffer; if e:=json.Indent(&formatted,original,"","  "); e!=nil { http.Error(w,"indent failed",400); return }; replacement=formatted.Bytes() } else if input.Mode=="bytes" { var e error; replacement,e=base64.StdEncoding.DecodeString(input.Body); if e!=nil { http.Error(w,"invalid bytes",400); return } } else { http.Error(w,"invalid mode",400); return }; if len(replacement)>65536 { http.Error(w,"too large",400); return }; tag,e:=f.db.Pool.Exec(r.Context(),"UPDATE webhook_deliveries SET body=$2,body_sha256=sha256($2),original_body_bytes=octet_length($2) WHERE id=$1 AND state='pending' AND attempt_sequence=0",id,replacement); if e!=nil || tag.RowsAffected()!=1 { http.Error(w,"body update failed",409); return }; w.Header().Set("Content-Type","application/json"); json.NewEncoder(w).Encode(map[string]any{"original":original,"replacement":replacement,"originalSha256":fmt.Sprintf("%x",sha256.Sum256(original)),"replacementSha256":fmt.Sprintf("%x",sha256.Sum256(replacement))}) }))\n\tmux.HandleFunc("GET /__fixture/wire/body/{id}", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w,"forbidden",403); return }; var body []byte; var hash,event string; var size int; if e:=f.db.Pool.QueryRow(r.Context(),"SELECT body,encode(body_sha256,'hex'),event_id::text,original_body_bytes FROM webhook_deliveries WHERE id=$1",r.PathValue("id")).Scan(&body,&hash,&event,&size); e!=nil { http.Error(w,"body read failed",500); return }; var pg string; if e:=f.db.Pool.QueryRow(r.Context(),"SHOW server_version").Scan(&pg); e!=nil { http.Error(w,"version read failed",500); return }; w.Header().Set("Content-Type","application/json"); json.NewEncoder(w).Encode(map[string]any{"postgresVersion":pg,"body":body,"sha256":hash,"eventId":event,"bytes":size}) }))\n`;
    adapted = replaceOnce(adapted, marker, addition + marker);
    adapted = replaceOnce(adapted, "\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    originalHash = digest(Buffer.from(original)); adaptedHash = digest(Buffer.from(adapted));
    await writeFile(filename, adapted);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: serverCopy, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: pat, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: secret("dnpat_") } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const line = new Promise<string>((resolve, reject) => {
      let text = ""; host!.once("error", reject); host!.stderr!.resume();
      host!.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); const newline = text.indexOf("\n"); if (newline >= 0) resolve(text.slice(0, newline)); });
      host!.once("close", () => reject(new Error("Wire fixture exited before readiness.")));
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try { info = JSON.parse(await Promise.race([line, new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Wire fixture did not become ready.")), 60_000); })])) as Info; }
    finally { if (startupTimer !== undefined) clearTimeout(startupTimer); }
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (address === null || typeof address === "string") throw new Error("Missing proxy address.");
    await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${pat}\n`, { mode: 0o600 });
    const subscription = [{ id: null, projectId: info.projectId, eventTypes: ["task.created"] }];
    const destination = { kind: "http", adapterVersion: "1", configuration: { url: info.receiverUrl } };
    const input = (name: string) => JSON.stringify({ name, enabled: true, destination, subscriptions: subscription });
    const fragments = await success(["create", "--personal", "--stdin", "--confirm"], input("Partial fields"));
    const endpoint = fragments.endpoint.id as string;
    const beforeFalse = wire.length;
    const disabled = await success(["update", endpoint, "--personal", "--stdin", "--if-version", fragments.endpoint.configVersion, "--confirm"], JSON.stringify({ enabled: false }));
    const falseRequests = wire.slice(beforeFalse).filter(item => item.path.startsWith(`/api/v1/me/webhooks/${endpoint}`));
    expect(falseRequests).toHaveLength(1); expect(falseRequests[0]!.method).toBe("PATCH");
    const falseBody = JSON.parse(falseRequests[0]!.body.toString());
    expect(Object.keys(falseBody).sort()).toEqual(["enabled", "expectedUserId", "ifVersion", "issuedAt", "operationId"].sort());
    expect(falseBody.enabled).toBe(false); expect(disabled.endpoint.enabled).toBe(false);
    expect(disabled.endpoint.name).toBe(fragments.endpoint.name); expect(disabled.endpoint.destination).toEqual(fragments.endpoint.destination); expect(disabled.endpoint.destinationRevision).toBe(fragments.endpoint.destinationRevision); expect(disabled.endpoint.subscriptions).toEqual(fragments.endpoint.subscriptions);
    const beforeEmpty = wire.length;
    const emptied = await success(["update", endpoint, "--personal", "--stdin", "--if-version", disabled.endpoint.configVersion, "--confirm"], JSON.stringify({ subscriptions: [] }));
    const emptyRequests = wire.slice(beforeEmpty).filter(item => item.path.startsWith(`/api/v1/me/webhooks/${endpoint}`));
    expect(emptyRequests).toHaveLength(1); expect(emptyRequests[0]!.method).toBe("PATCH");
    const emptyBody = JSON.parse(emptyRequests[0]!.body.toString());
    expect(Object.keys(emptyBody).sort()).toEqual(["expectedUserId", "ifVersion", "issuedAt", "operationId", "subscriptions"].sort());
    expect(emptyBody.subscriptions).toEqual([]); expect(emptied.endpoint.subscriptions).toEqual([]); expect(emptied.endpoint.enabled).toBe(false);
    expect(emptied.endpoint.name).toBe(disabled.endpoint.name); expect(emptied.endpoint.destination).toEqual(disabled.endpoint.destination); expect(emptied.endpoint.destinationRevision).toBe(disabled.endpoint.destinationRevision);
    mediaTarget = `/api/v1/me/webhooks/${endpoint}`;
    mediaFault = "read"; const beforeRead = wire.length;
    const readFailure = await invoke(["show", endpoint, "--personal"]);
    expect(mediaFault).toBeUndefined(); expect(readFailure.status).toBe(1); expect(readFailure.stdout.length).toBe(0); expect(JSON.parse(readFailure.stderr.toString()).error.invocationOutcome).toBe("read_failed");
    expect(wire.slice(beforeRead).filter(item => item.path === mediaTarget && item.method === "GET")).toHaveLength(1);
    mediaFault = "write"; const beforeWrite = wire.length;
    const write = await success(["update", endpoint, "--personal", "--stdin", "--if-version", emptied.endpoint.configVersion, "--confirm"], JSON.stringify({ name: "Media confirmed" }));
    expect(mediaFault).toBeUndefined(); expect(write.operation.effect).toBe("applied");
    const writeRequests = wire.slice(beforeWrite);
    expect(writeRequests.filter(item => item.path === mediaTarget && item.method === "PATCH")).toHaveLength(1);
    expect(writeRequests.filter(item => item.path.endsWith(`/operations/${write.operation.operationId}`) && item.method === "GET")).toHaveLength(1);
    const afterWrite = await success(["show", endpoint, "--personal"]);
    expect(afterWrite.name).toBe("Media confirmed"); expect(afterWrite.configVersion).toBe(write.operation.configVersionAfter);
    const controlled = await success(["create", "--personal", "--stdin", "--confirm"], input("Controlled payload"));
    await control("POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "Controlled data source" });
    const controlPage = await success(["delivery", "list", controlled.endpoint.id, "--personal"]); expect(controlPage.items).toHaveLength(1);
    const controlledId = controlPage.items[0].id as string;
    const utf8 = Buffer.from('{  "消息": "你好 世界" }', "utf8");
    const replaced = await control("POST", `/__fixture/wire/body/${controlledId}`, { mode: "bytes", body: utf8.toString("base64") });
    expect(Buffer.from(replaced.replacement, "base64")).toEqual(utf8);
    const controlledState = await observe("controlled-multibyte-body", controlledId);
    expect(controlledState.sha256).toBe(digest(utf8)); expect(controlledState.bytes).toBe(utf8.length);
    const encoded = await success(["delivery", "payload", controlled.endpoint.id, controlledId, "--personal"]);
    expect(Buffer.from(encoded.body, "base64")).toEqual(utf8); expect(encoded.sha256).toBe(digest(utf8));
    const raw = await invoke(["delivery", "payload", controlled.endpoint.id, controlledId, "--personal"], undefined, false);
    expect(raw.status).toBe(0); expect(raw.stderr.length).toBe(0); expect(raw.stdout).toEqual(utf8); expect(raw.stdout.at(-1)).not.toBe(10);
    const file = path.join(root, "multibyte.bin");
    const fileResult = await invoke(["delivery", "payload", controlled.endpoint.id, controlledId, "--personal", "--output", file], undefined, false);
    expect(fileResult.status).toBe(0); expect(fileResult.stdout.length).toBe(0); expect(fileResult.stderr.length).toBe(0); expect(await readFile(file)).toEqual(utf8);
    await success(["disable", controlled.endpoint.id, "--personal", "--if-version", controlled.endpoint.configVersion, "--confirm"]);
    const transport = await success(["create", "--personal", "--stdin", "--confirm"], input("TLS whitespace"));
    await control("POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "TLS event source" });
    const transportPage = await success(["delivery", "list", transport.endpoint.id, "--personal"]); expect(transportPage.items).toHaveLength(1);
    const transportId = transportPage.items[0].id as string;
    const indented = await control("POST", `/__fixture/wire/body/${transportId}`, { mode: "indent" });
    const bytes = Buffer.from(indented.replacement, "base64"), originalBytes = Buffer.from(indented.original, "base64");
    expect(bytes).not.toEqual(originalBytes); expect(bytes.includes(10)).toBe(true); expect(bytes.at(-1)).not.toBe(10); expect(JSON.parse(bytes.toString())).toEqual(JSON.parse(originalBytes.toString()));
    const state = await observe("controlled-whitespace-body", transportId);
    expect(state.sha256).toBe(digest(bytes)); expect(state.bytes).toBe(bytes.length);
    const payload = await invoke(["delivery", "payload", transport.endpoint.id, transportId, "--personal"], undefined, false);
    expect(payload.status).toBe(0); expect(payload.stdout).toEqual(bytes); expect(payload.stderr.length).toBe(0);
    await control("POST", "/__fixture/runner/start");
    let received: any[] = [];
    for (let i = 0; i < 160 && received.length < 1; i++) { received = await control("GET", "/__fixture/receiver"); if (!received.length) await new Promise(resolve => setTimeout(resolve, 50)); }
    expect(received).toHaveLength(1); expect(received[0].eventId).toBe(state.eventId); expect(Buffer.from(received[0].body, "base64")).toEqual(bytes); expect(digest(Buffer.from(received[0].body, "base64"))).toBe(state.sha256);
    await control("POST", "/__fixture/runner/stop");
    for (let i = 0; i < 48; i++) await control("POST", "/api/v1/me/webhooks", { operationId: randomUUID(), issuedAt: new Date().toISOString(), expectedUserId: info.userId, name: `Media page ${i}`, enabled: false, destination, subscriptions: [] });
    mediaFault = "page"; const beforePage = wire.length;
    const failedPage = await invoke(["list", "--personal"]);
    expect(mediaFault).toBeUndefined(); expect(failedPage.status).toBe(1); expect(failedPage.stdout.length).toBe(0); expect(JSON.parse(failedPage.stderr.toString()).error.invocationOutcome).toBe("read_failed");
    expect(wire.slice(beforePage).filter(item => item.method === "GET" && item.path.startsWith("/api/v1/me/webhooks"))).toHaveLength(2);
    expect(wire.slice(beforePage).filter(item => item.method !== "GET")).toHaveLength(0);
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
  if (process.env.DAYNIGHT_WEBHOOK_WIRE_EVIDENCE !== undefined) try {
    const evidence = process.env.DAYNIGHT_WEBHOOK_WIRE_EVIDENCE;
    if (!path.isAbsolute(evidence)) throw new Error("Webhook wire evidence path must be absolute.");
    const safe = (bytes: Buffer) => ({ length: bytes.length, sha256: digest(bytes), base64: bytes.includes(Buffer.from(pat)) ? null : bytes.toString("base64") });
    const material = { source: receipt.source, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256 }, fixture: { ...info, originalHostSha256: originalHash, adaptedHostSha256: adaptedHash, adapter: "copied T05 host with production request logging and controlled retained-body fixtures; only the indented real event is sent over TLS" }, passed: failure === undefined && cleanup.length === 0, cleanupErrors: cleanup.length, snapshots, faults, calls: calls.map(call => ({ args: call.args, status: call.status, stdout: safe(call.stdout), stderr: safe(call.stderr) })), requests: wire.map(record => ({ method: record.method, path: record.path, status: record.status, body: safe(record.body), response: safe(Buffer.concat(record.response)) })), controls: controls.map(record => ({ method: record.method, path: record.path, status: record.status, body: safe(record.body), response: safe(record.response) })) };
    await writeFile(evidence, `${JSON.stringify(material, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (cause) { cleanup.push(cause); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Webhook wire acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 180_000);
