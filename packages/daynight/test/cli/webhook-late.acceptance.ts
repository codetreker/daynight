import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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

// The copied host only adds a receiver barrier and controls around the real runner.
// The production routes, transport, authorization and DAO remain unchanged.
it.skipIf(database === undefined)("projects recovered unknown and late observations from a real runner through the installed CLI", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const root = path.join(receipt.root, "webhook-late");
  const home = path.join(root, "home"), config = path.join(root, "config"), tmp = path.join(root, "tmp");
  const serverSource = path.resolve(import.meta.dirname, "../../../daynight-server");
  const serverCopy = path.join(root, "server");
  const token = secret("dnpat_");
  const controls: { method: string; path: string; status: number; response: Buffer }[] = [];
  const calls: Observation[] = [], wire: Wire[] = [];
  const children = new Map<ChildProcess, Promise<unknown>>();
  let info: Info | undefined, host: ChildProcess | undefined, hostClosed: Promise<unknown> | undefined;
  let originalHash: string | undefined, adaptedHash: string | undefined, failure: unknown;
  const proxy = createServer((incoming, outgoing) => {
    const body: Buffer[] = []; incoming.on("data", (part: Buffer) => body.push(part));
    incoming.on("end", () => {
      const target = new URL(incoming.url!, info!.url), bytes = Buffer.concat(body);
      const upstream = request(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
        const observed: Wire = { method: incoming.method!, path: incoming.url!, status: response.statusCode!, body: bytes, response: [] };
        wire.push(observed); response.on("data", (part: Buffer) => observed.response.push(part));
        outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing);
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); upstream.end(bytes);
    });
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, DN_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(root, "xdg"), XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: tmp, TMP: tmp, TEMP: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const invoke = async (args: string[], input?: string): Promise<any> => {
    const child = spawn(receipt.launcherPath, ["webhook", ...args, "--json"], { cwd: root, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
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
      expect(status, `webhook ${args.slice(0, 2).join(" ")} exited ${status}`).toBe(0);
      expect(observed.stderr.length).toBe(0); expect(observed.stdout.at(-1)).toBe(10);
      return JSON.parse(observed.stdout.toString());
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const control = async (method: string, route: string, value?: unknown) => {
    const response = await fetch(info!.url + route, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const bytes = Buffer.from(await response.arrayBuffer()); controls.push({ method, path: route, status: response.status, response: bytes });
    if (!response.ok) throw new Error(`Fixture control failed: ${method} ${route} (${response.status}).`);
    return bytes.length ? JSON.parse(bytes.toString()) : undefined;
  };
  const replaceOnce = (source: string, from: string, to: string): string => {
    if (source.indexOf(from) < 0 || source.indexOf(from) !== source.lastIndexOf(from)) throw new Error("Unexpected T05 fixture source; late-observation adapter was not applied.");
    return source.replace(from, to);
  };
  try {
    await Promise.all([home, config, tmp].map(dir => mkdir(dir, { recursive: true })));
    await cp(serverSource, serverCopy, { recursive: true });
    const filename = path.join(serverCopy, "testdata/webhook-host/main.go");
    const original = await readFile(filename, "utf8"); let adapted = original;
    adapted = replaceOnce(adapted, 'authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"', '"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"\n\tauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"');
    adapted = replaceOnce(adapted, "\trunner            *webhook.Runner", "\trunner            *webhook.Runner\n\trecovery          *webhook.Runner\n\tlateRelease       chan struct{}\n\tlateReleaseOnce   sync.Once\n\tthirdRelease      chan struct{}\n\tthirdReleaseOnce  sync.Once");
    adapted = replaceOnce(adapted, 'f = &fixture{admin: admin, status: http.StatusAccepted, done: make(chan struct{}), schema:', 'f = &fixture{admin: admin, status: http.StatusAccepted, done: make(chan struct{}), lateRelease: make(chan struct{}), thirdRelease: make(chan struct{}), schema:');
    adapted = replaceOnce(adapted, "\t\tstatus := f.status\n\t\tf.mu.Unlock()\n\t\tw.WriteHeader(status)", "\t\tstatus := f.status\n\t\tfirst := len(f.receipts) == 1\n\t\tthird := len(f.receipts) == 3\n\t\tf.mu.Unlock()\n\t\tif first { select { case <-f.lateRelease: case <-r.Context().Done(): return }; status = http.StatusAccepted }\n\t\tif third { select { case <-f.thirdRelease: case <-r.Context().Done(): return } }\n\t\tw.WriteHeader(status)");
    const marker = '\tmux.HandleFunc("POST /__fixture/runner/start", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {';
    const addition = `\tmux.HandleFunc("GET /__fixture/late/state/{id}", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w, "forbidden", 403); return }; id:=r.PathValue("id"); var state string; var generation int64; var manual int; if e:=f.db.Pool.QueryRow(r.Context(), "SELECT state,generation,manual_operation_count FROM webhook_deliveries WHERE id=$1", id).Scan(&state,&generation,&manual); e!=nil { http.Error(w,"missing delivery",404); return }; rows,e:=f.db.Pool.Query(r.Context(), "SELECT id::text,outcome,recovered_unknown_at,late_observed_at,late_outcome,late_http_status,admitted_at,finished_at,http_status FROM webhook_attempts WHERE delivery_id=$1 ORDER BY generation,sequence,id",id); if e!=nil { http.Error(w,"attempt read failed",500); return }; defer rows.Close(); items:=[]map[string]any{}; for rows.Next() { var aid string; var outcome,late *string; var recovered,observed,admitted,finished *time.Time; var status,httpStatus *int16; if rows.Scan(&aid,&outcome,&recovered,&observed,&late,&status,&admitted,&finished,&httpStatus)!=nil { http.Error(w,"attempt scan failed",500); return }; items=append(items,map[string]any{"id":aid,"outcome":outcome,"recoveredUnknownAt":recovered,"lateObservedAt":observed,"lateOutcome":late,"lateHTTPStatus":status,"admittedAt":admitted,"finishedAt":finished,"httpStatus":httpStatus}) }; if rows.Err()!=nil { http.Error(w,"attempt read failed",500); return }; w.Header().Set("Content-Type","application/json"); json.NewEncoder(w).Encode(map[string]any{"state":state,"generation":fmt.Sprint(generation),"manualOperationCount":manual,"attempts":items}) }))
\tmux.HandleFunc("POST /__fixture/late/release-third", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w, "forbidden", 403); return }; f.thirdReleaseOnce.Do(func(){ close(f.thirdRelease) }); w.WriteHeader(204) }))
\tmux.HandleFunc("POST /__fixture/late/release", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w, "forbidden", 403); return }; f.lateReleaseOnce.Do(func(){ close(f.lateRelease) }); w.WriteHeader(204) }))
\tmux.HandleFunc("POST /__fixture/late/expire", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w, "forbidden", 403); return }; var input struct { ID string ` + '`json:"id"`' + ` }; if json.NewDecoder(r.Body).Decode(&input) != nil { http.Error(w, "invalid", 400); return }; tag,e:=f.db.Pool.Exec(r.Context(), "UPDATE webhook_deliveries SET lease_claimed_at=now()-interval '46 seconds',lease_until=now()-interval '1 second' WHERE id=$1 AND state='leased'", input.ID); if e!=nil || tag.RowsAffected()!=1 { http.Error(w, "lease unavailable", 409); return }; w.WriteHeader(204) }))
\tmux.HandleFunc("POST /__fixture/late/recovery-start", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w, "forbidden", 403); return }; if f.recovery != nil { http.Error(w, "already started", 409); return }; f.recovery=webhook.NewRunner(f.db,svc,false); if f.recovery.Start(context.Background())!=nil { http.Error(w, "recovery unavailable", 503); return }; w.WriteHeader(204) }))
\tmux.HandleFunc("POST /__fixture/late/recovery-stop", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w, "forbidden", 403); return }; if f.recovery == nil { http.Error(w, "not started", 409); return }; c,cancel:=context.WithTimeout(r.Context(),5*time.Second); defer cancel(); if f.recovery.Stop(c)!=nil { http.Error(w, "recovery stop failed", 503); return }; f.recovery=nil; w.WriteHeader(204) }))
`;
    adapted = replaceOnce(adapted, marker, addition + marker);
    adapted = replaceOnce(adapted, "\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    adapted = replaceOnce(adapted, "\tif f.runner != nil {\n\t\tif err := f.runner.Stop(cleanup); err != nil {", "\tf.lateReleaseOnce.Do(func(){ close(f.lateRelease) })\n\tf.thirdReleaseOnce.Do(func(){ close(f.thirdRelease) })\n\tif f.recovery != nil { if err := f.recovery.Stop(cleanup); err != nil { return err }; f.recovery=nil }\n\tif f.runner != nil {\n\t\tif err := f.runner.Stop(cleanup); err != nil {");
    originalHash = digest(Buffer.from(original)); adaptedHash = digest(Buffer.from(adapted));
    await writeFile(filename, adapted);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: serverCopy, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: token, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: secret("dnpat_") } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const line = new Promise<string>((resolve, reject) => {
      let text = ""; host!.once("error", reject); host!.stderr!.resume();
      host!.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); const newline = text.indexOf("\n"); if (newline >= 0) resolve(text.slice(0, newline)); });
      host!.once("close", () => reject(new Error("Late fixture exited before readiness.")));
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try { info = JSON.parse(await Promise.race([line, new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Late fixture did not become ready.")), 60_000); })])) as Info; }
    finally { if (startupTimer !== undefined) clearTimeout(startupTimer); }
    expect(info.schema).toBeTruthy();
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (address === null || typeof address === "string") throw new Error("Missing proxy address.");
    await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${token}\n`, { mode: 0o600 });
    const created = await invoke(["create", "--personal", "--stdin", "--confirm"], JSON.stringify({ name: "Late observation", enabled: true, destination: { kind: "http", adapterVersion: "1", configuration: { url: info.receiverUrl } }, subscriptions: [{ id: null, projectId: info.projectId, eventTypes: ["task.created"] }] }));
    const endpoint = created.endpoint.id as string;
    await control("POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "Late observation source" });
    const page = await invoke(["delivery", "list", endpoint, "--personal"]); expect(page.items).toHaveLength(1);
    const delivery = page.items[0].id as string;
    await control("POST", "/__fixture/runner/start");
    let receiver: any[] = [];
    for (let i = 0; i < 80 && receiver.length < 1; i++) { receiver = await control("GET", "/__fixture/receiver"); if (!receiver.length) await new Promise(resolve => setTimeout(resolve, 50)); }
    expect(receiver).toHaveLength(1);
    const first = await invoke(["attempt", "list", endpoint, delivery, "--personal"]);
    expect(first.items).toHaveLength(1); expect(first.items[0].outcome).toBeNull();
    await control("POST", "/__fixture/late/expire", { id: delivery });
    await control("POST", "/__fixture/late/recovery-start");
    let recovered = first;
    for (let i = 0; i < 80 && recovered.items[0].outcome !== "unknown"; i++) {
      await new Promise(resolve => setTimeout(resolve, 50)); recovered = await invoke(["attempt", "list", endpoint, delivery, "--personal"]);
    }
    expect(recovered.items[0].outcome).toBe("unknown"); expect(recovered.items[0].recoveredUnknownAt).not.toBeNull();
    await control("POST", "/__fixture/late/recovery-stop");
    await control("PUT", "/__fixture/receiver/status", { status: 503 });
    const beforeRetry = await invoke(["delivery", "show", endpoint, delivery, "--personal"]);
    const registered = await invoke(["delivery", "redeliver", endpoint, delivery, "--personal", "--if-version", created.endpoint.configVersion, "--if-generation", beforeRetry.generation, "--confirm"]);
    expect(registered.operation.generationAfter).not.toBe(beforeRetry.generation);
    let attempts = recovered;
    for (let i = 0; i < 80 && (attempts.items.length < 2 || attempts.items[1].outcome !== "http_error"); i++) {
      await new Promise(resolve => setTimeout(resolve, 50)); attempts = await invoke(["attempt", "list", endpoint, delivery, "--personal"]);
    }
    expect(attempts.items).toHaveLength(2); expect(attempts.items[1].outcome).toBe("http_error"); expect(attempts.items[1].httpStatus).toBe(503);
    await control("POST", "/__fixture/late/release");
    for (let i = 0; i < 80 && attempts.items[0].lateResult === null; i++) {
      await new Promise(resolve => setTimeout(resolve, 50)); attempts = await invoke(["attempt", "list", endpoint, delivery, "--personal"]);
    }
    expect(attempts.items[0].outcome).toBe("unknown"); expect(attempts.items[0].recoveredUnknownAt).not.toBeNull();
    expect(attempts.items[0].lateResult.outcome).toBe("acknowledged"); expect(attempts.items[0].lateResult.httpStatus).toBe(202);
    const shown = await invoke(["delivery", "show", endpoint, delivery, "--personal"]);
    expect(shown.lastAcknowledgedAt).toBe(attempts.items[0].lateResult.observedAt); expect(shown.lastResult.category).toBe("http_error"); expect(shown.lastResult.httpStatus).toBe(503);
    const summary = (await invoke(["list", "--personal"])).items.find((item: any) => item.id === endpoint);
    expect(summary.lastAttemptAt).toBe(attempts.items[1].admittedAt);
    expect(summary.lastResult.category).toBe("http_error"); expect(summary.lastResult.httpStatus).toBe(503);
    const databaseState = await control("GET", `/__fixture/late/state/${delivery}`);
    expect(databaseState.generation).toBe(shown.generation); expect(databaseState.manualOperationCount).toBe(1);
    expect(databaseState.attempts).toHaveLength(2); expect(databaseState.attempts[0].id).toBe(attempts.items[0].id);
    expect(databaseState.attempts[0].outcome).toBe("unknown"); expect(databaseState.attempts[0].recoveredUnknownAt).not.toBeNull();
    expect(databaseState.attempts[0].lateOutcome).toBe("acknowledged"); expect(databaseState.attempts[0].lateHTTPStatus).toBe(202);
    expect(databaseState.attempts[1].outcome).toBe("http_error");
    receiver = await control("GET", "/__fixture/receiver"); expect(receiver).toHaveLength(2);
    expect(receiver.map(item => item.eventId)).toEqual([shown.eventId, shown.eventId]);
    expect(Buffer.from(receiver[0].body, "base64")).toEqual(Buffer.from(receiver[1].body, "base64"));
    await control("PUT", "/__fixture/receiver/status", { status: 202 });
    const next = await invoke(["delivery", "redeliver", endpoint, delivery, "--personal", "--if-version", created.endpoint.configVersion, "--if-generation", shown.generation, "--confirm"]);
    expect(next.operation.generationAfter).not.toBe(shown.generation);
    for (let i = 0; i < 80 && receiver.length < 3; i++) { receiver = await control("GET", "/__fixture/receiver"); if (receiver.length < 3) await new Promise(resolve => setTimeout(resolve, 50)); }
    expect(receiver).toHaveLength(3);
    const unfinished = await invoke(["attempt", "list", endpoint, delivery, "--personal"]);
    expect(unfinished.items).toHaveLength(3); expect(unfinished.items[2].outcome).toBeNull();
    expect(unfinished.items[2].finishedAt).toBeNull(); expect(unfinished.items[2].admittedAt).not.toBeNull();
    const pendingSummary = (await invoke(["list", "--personal"])).items.find((item: any) => item.id === endpoint);
    expect(pendingSummary.lastAttemptAt).toBe(unfinished.items[2].admittedAt); expect(pendingSummary.lastResult).toBeNull();
    const pendingDelivery = await invoke(["delivery", "show", endpoint, delivery, "--personal"]);
    expect(pendingDelivery.lastAcknowledgedAt).toBe(shown.lastAcknowledgedAt);
    const pendingDatabase = await control("GET", `/__fixture/late/state/${delivery}`);
    expect(pendingDatabase.manualOperationCount).toBe(2); expect(pendingDatabase.attempts).toHaveLength(3);
    expect(pendingDatabase.attempts[2].id).toBe(unfinished.items[2].id);
    expect(pendingDatabase.attempts[2].outcome).toBeNull(); expect(pendingDatabase.attempts[2].finishedAt).toBeNull();
    expect(new Date(pendingDatabase.attempts[2].admittedAt).getTime()).toBe(new Date(unfinished.items[2].admittedAt).getTime());
    expect(receiver.map(item => item.eventId)).toEqual([shown.eventId, shown.eventId, shown.eventId]);
    expect(Buffer.from(receiver[2].body, "base64")).toEqual(Buffer.from(receiver[0].body, "base64"));
    await control("POST", "/__fixture/late/release-third");
    await control("POST", "/__fixture/runner/stop");
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); }
  if (info !== undefined) {
    try { await control("POST", "/__fixture/late/release"); } catch (cause) { cleanup.push(cause); }
    try { await control("POST", "/__fixture/late/release-third"); } catch (cause) { cleanup.push(cause); }
    try { await control("POST", "/__fixture/shutdown"); } catch (cause) { cleanup.push(cause); }
  }
  if (host !== undefined && hostClosed !== undefined) try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { const result = await Promise.race([hostClosed.then(() => "closed"), new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10_000); })]); if (result === "timeout") await terminateInstalledProcess(host, hostClosed); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  } catch (cause) { cleanup.push(cause); }
  try { proxy.closeAllConnections(); if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  if (process.env.DAYNIGHT_WEBHOOK_LATE_EVIDENCE !== undefined) try {
    const evidence = process.env.DAYNIGHT_WEBHOOK_LATE_EVIDENCE;
    if (!path.isAbsolute(evidence)) throw new Error("Webhook late evidence path must be absolute.");
    const safe = (bytes: Buffer) => ({ length: bytes.length, sha256: digest(bytes), base64: bytes.includes(Buffer.from(token)) ? null : bytes.toString("base64") });
    const material = { source: receipt.source, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256 }, fixture: { ...info, originalHostSha256: originalHash, adaptedHostSha256: adaptedHash, adapter: "copied T05 fixture with production request logging, held first receiver and recovery-only runner" }, passed: failure === undefined && cleanup.length === 0, cleanupErrors: cleanup.length, calls: calls.map(call => ({ args: call.args, status: call.status, stdout: safe(call.stdout), stderr: safe(call.stderr) })), requests: wire.map(record => ({ method: record.method, path: record.path, status: record.status, body: safe(record.body), response: safe(Buffer.concat(record.response)) })), controls: controls.map(record => ({ ...record, response: safe(record.response) })) };
    await writeFile(evidence, `${JSON.stringify(material, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (cause) { cleanup.push(cause); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Webhook late acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 180_000);
