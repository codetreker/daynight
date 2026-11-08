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

// The copied T05 host adds request logging and a read-only database observation.
// Endpoint changes, redelivery, capture, admission and HTTP sends remain production operations.
it.skipIf(database === undefined)("enforces busy, destination and manual-budget fences through the installed CLI", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const root = path.join(receipt.root, "webhook-redelivery");
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
    const value = await control("GET", `/__fixture/redelivery/state/${id}`); snapshots.push({ label, value }); return value;
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
    adapted = replaceOnce(adapted, 'authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"', '"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"\n\tauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"');
    const marker = '\tmux.HandleFunc("POST /__fixture/runner/start", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {';
    const addition = `\tmux.HandleFunc("GET /__fixture/redelivery/state/{id}", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w, "forbidden", 403); return }; id:=r.PathValue("id"); var state,event string; var generation,manual,automatic,attempts,revision int64; var occurred time.Time; var body []byte; if e:=f.db.Pool.QueryRow(r.Context(), "SELECT state,generation,manual_operation_count,automatic_attempt_count,attempt_sequence,destination_revision,event_id::text,occurred_at,body FROM webhook_deliveries WHERE id=$1", id).Scan(&state,&generation,&manual,&automatic,&attempts,&revision,&event,&occurred,&body); e!=nil { http.Error(w,"missing delivery",404); return }; var operations int; if e:=f.db.Pool.QueryRow(r.Context(),"SELECT count(*) FROM webhook_operations WHERE delivery_id=$1",id).Scan(&operations); e!=nil { http.Error(w,"operation read failed",500); return }; var postgresVersion string; if e:=f.db.Pool.QueryRow(r.Context(),"SHOW server_version").Scan(&postgresVersion); e!=nil { http.Error(w,"version read failed",500); return }; w.Header().Set("Content-Type","application/json"); json.NewEncoder(w).Encode(map[string]any{"postgresVersion":postgresVersion,"state":state,"generation":fmt.Sprint(generation),"manual":manual,"automatic":automatic,"attempts":attempts,"destinationRevision":fmt.Sprint(revision),"eventId":event,"occurredAt":occurred.UTC(),"body":body,"operations":operations}) }))\n`;
    adapted = replaceOnce(adapted, marker, addition + marker);
    adapted = replaceOnce(adapted, "\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    originalHash = digest(Buffer.from(original)); adaptedHash = digest(Buffer.from(adapted));
    await writeFile(filename, adapted);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: serverCopy, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: pat, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: secret("dnpat_") } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const line = new Promise<string>((resolve, reject) => {
      let text = ""; host!.once("error", reject); host!.stderr!.resume();
      host!.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); const newline = text.indexOf("\n"); if (newline >= 0) resolve(text.slice(0, newline)); });
      host!.once("close", () => reject(new Error("Redelivery fixture exited before readiness.")));
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try { info = JSON.parse(await Promise.race([line, new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Redelivery fixture did not become ready.")), 60_000); })])) as Info; }
    finally { if (startupTimer !== undefined) clearTimeout(startupTimer); }
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (address === null || typeof address === "string") throw new Error("Missing proxy address.");
    await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${pat}\n`, { mode: 0o600 });
    const input = (name: string) => JSON.stringify({ name, enabled: true, destination: { kind: "http", adapterVersion: "1", configuration: { url: info!.receiverUrl } }, subscriptions: [{ id: null, projectId: info!.projectId, eventTypes: ["task.created"] }] });
    const a = await success(["create", "--personal", "--stdin", "--confirm"], input("Manual budget"));
    const b = await success(["create", "--personal", "--stdin", "--confirm"], input("Destination change"));
    const endpoint = a.endpoint.id as string, other = b.endpoint.id as string;
    await control("POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "Redelivery source" });
    const first = (await success(["delivery", "list", endpoint, "--personal"])).items[0];
    const second = (await success(["delivery", "list", other, "--personal"])).items[0];
    const id = first.id as string, otherId = second.id as string;
    const payload = await success(["delivery", "payload", endpoint, id, "--personal"]);
    const before = await observe("before-first", id);
    const prepared = path.join(root, "manual.json");
    const initialArgs = ["delivery", "redeliver", endpoint, id, "--personal", "--if-version", a.endpoint.configVersion, "--if-generation", first.generation, "--confirm"];
    const registered = await success([...initialArgs, "--operation-out", prepared]);
    const afterFirst = await observe("manual-queued", id);
    expect(afterFirst.manual).toBe(1); expect(afterFirst.operations).toBe(1); expect(afterFirst.state).toBe("pending");
    expect(afterFirst.generation).toBe(registered.operation.generationAfter);
    expect(afterFirst.attempts).toBe(before.attempts); expect(afterFirst.body).toBe(before.body);
    const resumeBefore = wire.length;
    const resumed = await success([...initialArgs, "--resume-operation", prepared]);
    expect(resumed.operation.operationId).toBe(registered.operation.operationId);
    expect(wire.slice(resumeBefore).filter(item => item.method === "POST")).toHaveLength(0);
    expect(await observe("after-resume", id)).toEqual(afterFirst);
    const busyBefore = wire.length;
    const busy = await invoke(["delivery", "redeliver", endpoint, id, "--personal", "--if-version", a.endpoint.configVersion, "--if-generation", afterFirst.generation, "--confirm"]);
    expect(busy.status).toBe(1); expect(busy.stdout.length).toBe(0); expect(JSON.parse(busy.stderr.toString()).error.code).toBe("delivery_busy");
    const busyWrites = wire.slice(busyBefore).filter(item => item.method === "POST" && item.path.endsWith("/redeliveries"));
    expect(busyWrites).toHaveLength(1); expect(busyWrites[0]!.status).toBe(409);
    expect(await observe("after-busy", id)).toEqual(afterFirst);
    expect(await control("GET", "/__fixture/receiver")).toEqual([]);
    await control("POST", "/__fixture/runner/start");
    const waitFor = async (wanted: number) => {
      let deliveries: any[] = [];
      for (let i = 0; i < 160; i++) {
        deliveries = await control("GET", "/__fixture/receiver");
        const state = await observe(`wait-${wanted}-${i}`, id);
        if (deliveries.length >= wanted && state.state === "delivered" && state.attempts >= wanted - 1) return deliveries;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("The real runner did not complete its admitted delivery.");
    };
    let received = await waitFor(2);
    const firstDelivered = await success(["delivery", "show", endpoint, id, "--personal"]);
    expect(firstDelivered.manualOperationCount).toBe(1);
    for (let number = 2; number <= 3; number++) {
      const prior = await success(["delivery", "show", endpoint, id, "--personal"]);
      const args = ["delivery", "redeliver", endpoint, id, "--personal", "--if-version", a.endpoint.configVersion, "--if-generation", prior.generation, "--confirm"];
      if (number === 2) {
        const result = await invoke(args, undefined, false);
        expect(result.status).toBe(0); expect(result.stderr.length).toBe(0); expect(result.stdout.toString()).toContain("Redelivery registered");
      } else await success(args);
      received = await waitFor(number + 1);
      const state = await observe(`after-manual-${number}`, id);
      expect(state.manual).toBe(number); expect(state.operations).toBe(number);
      expect(state.body).toBe(before.body); expect(state.eventId).toBe(before.eventId); expect(state.occurredAt).toBe(before.occurredAt); expect(state.destinationRevision).toBe(before.destinationRevision); expect(state.automatic).toBe(before.automatic);
    }
    const exhausted = await observe("before-exhausted", id);
    const beforeLaterResume = wire.length;
    const laterResume = await success([...initialArgs, "--resume-operation", prepared]);
    expect(laterResume.operation.operationId).toBe(registered.operation.operationId);
    expect(laterResume.operation.generationAfter).toBe(afterFirst.generation);
    expect(exhausted.generation).not.toBe(laterResume.operation.generationAfter);
    expect(wire.slice(beforeLaterResume).filter(item => item.path.includes("/operations/") && item.method === "GET")).toHaveLength(1);
    expect(wire.slice(beforeLaterResume).filter(item => item.method === "POST")).toHaveLength(0);
    expect(await observe("after-later-resume", id)).toEqual(exhausted);
    const budgetBefore = wire.length;
    const budget = await invoke(["delivery", "redeliver", endpoint, id, "--personal", "--if-version", a.endpoint.configVersion, "--if-generation", exhausted.generation, "--confirm"]);
    expect(budget.status).toBe(1); expect(budget.stdout.length).toBe(0); expect(JSON.parse(budget.stderr.toString()).error.code).toBe("delivery_stopped");
    const budgetWrites = wire.slice(budgetBefore).filter(item => item.method === "POST" && item.path.endsWith("/redeliveries"));
    expect(budgetWrites).toHaveLength(1); expect(budgetWrites[0]!.status).toBe(409);
    expect(await observe("after-exhausted", id)).toEqual(exhausted);
    expect(received).toHaveLength(4);
    for (const item of received) { expect(item.eventId).toBe(before.eventId); expect(Buffer.from(item.body, "base64")).toEqual(Buffer.from(payload.body, "base64")); }
    let otherBefore = await observe("target-before", otherId);
    for (let i = 0; i < 160 && otherBefore.state !== "delivered"; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      otherBefore = await observe(`target-wait-${i}`, otherId);
    }
    expect(otherBefore.state).toBe("delivered");
    const change = await success(["update", other, "--personal", "--stdin", "--if-version", b.endpoint.configVersion, "--confirm"], JSON.stringify({ destination: { kind: "http", adapterVersion: "1", configuration: { url: `${info.receiverUrl}?new=1` } } }));
    expect(change.endpoint.destinationRevision).not.toBe(otherBefore.destinationRevision);
    const targetBefore = wire.length;
    const target = await invoke(["delivery", "redeliver", other, otherId, "--personal", "--if-version", change.endpoint.configVersion, "--if-generation", otherBefore.generation, "--confirm"]);
    expect(target.status).toBe(1); expect(target.stdout.length).toBe(0); expect(JSON.parse(target.stderr.toString()).error.code).toBe("target_changed");
    const targetWrites = wire.slice(targetBefore).filter(item => item.method === "POST" && item.path.endsWith("/redeliveries"));
    expect(targetWrites).toHaveLength(1); expect(targetWrites[0]!.status).toBe(409);
    expect(await observe("target-after", otherId)).toEqual(otherBefore);
    expect(await control("GET", "/__fixture/receiver")).toHaveLength(4);
    await control("POST", "/__fixture/runner/stop");
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
  if (process.env.DAYNIGHT_WEBHOOK_REDELIVERY_EVIDENCE !== undefined) try {
    const evidence = process.env.DAYNIGHT_WEBHOOK_REDELIVERY_EVIDENCE;
    if (!path.isAbsolute(evidence)) throw new Error("Webhook redelivery evidence path must be absolute.");
    const safe = (bytes: Buffer) => ({ length: bytes.length, sha256: digest(bytes), base64: bytes.includes(Buffer.from(pat)) ? null : bytes.toString("base64") });
    const material = { source: receipt.source, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256 }, fixture: { ...info, originalHostSha256: originalHash, adaptedHostSha256: adaptedHash, adapter: "copied T05 host with production request logging and read-only database observation" }, passed: failure === undefined && cleanup.length === 0, cleanupErrors: cleanup.length, snapshots, calls: calls.map(call => ({ args: call.args, status: call.status, stdout: safe(call.stdout), stderr: safe(call.stderr) })), requests: wire.map(record => ({ method: record.method, path: record.path, status: record.status, body: safe(record.body), response: safe(Buffer.concat(record.response)) })), controls: controls.map(record => ({ method: record.method, path: record.path, status: record.status, body: safe(record.body), response: safe(record.response) })) };
    await writeFile(evidence, `${JSON.stringify(material, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (cause) { cleanup.push(cause); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Webhook redelivery acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 180_000);
