import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

// The full matrix is intentionally separate from routine suites; it waits for
// the unscaled five-second output deadline for each mutation leaf.
const database = process.env.DAYNIGHT_TEST_DATABASE_URL;
const enabled = database !== undefined && process.env.DAYNIGHT_WEBHOOK_MUTATION_FAULTS === "1";
const token = (prefix: string): string => prefix + randomBytes(32).toString("base64url");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const secretCanary = "canary-secret-whsec-private-body-url";
type HostInfo = { url: string; userId: string; teamId: string; projectId: string; receiverUrl: string; schema: string };
type Fault = "server-5xx" | "malformed" | "cancel" | "render" | "stdout" | "cleanup" | "deadline";
type Leaf = "create" | "update" | "enable" | "disable" | "delete" | "replace" | "reconfirm" | "rotate" | "redeliver";
type Observation = { leaf: Leaf; fault: Fault; operationId: string; endpointId: string; deliveryId: string | null; durationMs: number; status: number | null; stdoutBase64: string; stderrBase64: string; requestBase64: string; requestSha256: string; upstreamStatus: number; receipt: unknown; effect: unknown; writeCount: number; reconcileCount: number };

it.skipIf(!enabled)("preserves each real webhook mutation across response and confirmed-output failures", async () => {
  const installed = await createAcceptanceCli();
  const { receipt: artifact } = installed;
  const root = path.join(artifact.root, "webhook-mutation-faults"), config = path.join(root, "config"), tmp = path.join(root, "tmp"), home = path.join(root, "home");
  const originalServer = path.resolve(import.meta.dirname, "../../../daynight-server"), copiedServer = path.join(root, "server");
  const admin = token("dnpat_"), member = token("dnpat_");
  const children = new Map<ChildProcess, Promise<unknown>>();
  const observations: Observation[] = [];
  let info: HostInfo | undefined, host: ChildProcess | undefined, hostClosed: Promise<unknown> | undefined;
  let failure: unknown, originalHostSha256 = "", adaptedHostSha256 = "", databaseChecks: unknown = null;
  const records: { method: string; path: string; body: Buffer; status: number; upstream: Buffer; injected: Fault | null }[] = [];
  let pending: { method: string; route: string; fault: Fault; child: ChildProcess } | undefined;
  const proxy = createServer((incoming, outgoing) => {
    const input: Buffer[] = []; incoming.on("data", (part: Buffer) => input.push(part));
    incoming.on("end", () => {
      const body = Buffer.concat(input), target = new URL(incoming.url!, info!.url);
      const upstream = httpRequest(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
        const parts: Buffer[] = []; response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => {
          const bytes = Buffer.concat(parts), active = pending;
          const selected = active !== undefined && active.method === incoming.method && active.route === incoming.url ? active : undefined;
          records.push({ method: incoming.method!, path: incoming.url!, body, status: response.statusCode!, upstream: bytes, injected: selected?.fault ?? null });
          if (selected !== undefined) {
            pending = undefined;
            if (!(response.statusCode! >= 200 && response.statusCode! < 300)) { outgoing.writeHead(response.statusCode!, response.headers); outgoing.end(bytes); return; }
            if (selected.fault === "cancel") { selected.child.kill("SIGINT"); outgoing.destroy(); return; }
            if (selected.fault === "server-5xx") {
              const error = Buffer.from(JSON.stringify({ error: { code: "write_outcome_unknown", message: `Injected ${secretCanary}`, requestId: response.headers["x-request-id"] } }));
              outgoing.writeHead(503, { ...response.headers, "content-length": error.length }); outgoing.end(error); return;
            }
            if (selected.fault === "malformed") {
              const broken = Buffer.from(`{"private":"${secretCanary}"`);
              outgoing.writeHead(response.statusCode!, { ...response.headers, "content-length": broken.length }); outgoing.end(broken); return;
            }
          }
          outgoing.writeHead(response.statusCode!, response.headers); outgoing.end(bytes);
        });
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.end(body);
    });
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, DN_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(root, "xdg"), XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: tmp, TMP: tmp, TEMP: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const control = async (method: string, route: string, body?: unknown): Promise<any> => {
    const response = await fetch(info!.url + route, { method, headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`Real fixture request ${method} ${route} failed with ${response.status}.`);
    return bytes.length === 0 ? undefined : JSON.parse(bytes.toString());
  };
  const prepareEndpoint = async (leaf: Leaf): Promise<{ id: string; version: string; deliveryId?: string; generation?: string }> => {
    const wantsSubscription = leaf === "reconfirm" || leaf === "redeliver";
    const input = { operationId: randomUUID(), issuedAt: new Date().toISOString(), expectedUserId: info!.userId, name: `Mutation ${leaf}`, enabled: leaf === "disable" || leaf === "redeliver", destination: { kind: "http", adapterVersion: "1", configuration: { url: `${info!.receiverUrl}?${secretCanary}` } }, subscriptions: wantsSubscription ? [{ id: null, projectId: info!.projectId, eventTypes: ["task.created"] }] : [] };
    const result = await control("POST", "/api/v1/me/webhooks", input);
    const endpoint = result.endpoint;
    if (leaf !== "redeliver") return { id: endpoint.id, version: endpoint.configVersion };
    await control("POST", `/api/v1/projects/${info!.projectId}/tasks`, { title: `Mutation ${randomUUID()}` });
    const history = await control("GET", `/api/v1/me/webhooks/${endpoint.id}/deliveries`);
    if (history.items.length !== 1) throw new Error("Expected exactly one real pending delivery.");
    return { id: endpoint.id, version: endpoint.configVersion, deliveryId: history.items[0].id, generation: history.items[0].generation };
  };
  const createBase = (): Record<string, unknown> => ({ name: "Mutation create", enabled: false, destination: { kind: "http", adapterVersion: "1", configuration: { url: `${info!.receiverUrl}?${secretCanary}` } }, subscriptions: [] });
  const leafArguments = (leaf: Leaf, endpoint: { id: string; version: string; deliveryId?: string; generation?: string }): { args: string[]; method: string; route: string; input?: string } => {
    const base = `/api/v1/me/webhooks/${endpoint.id}`, owner = ["--personal", "--confirm"];
    if (leaf === "create") return { args: ["create", ...owner, "--stdin"], method: "POST", route: "/api/v1/me/webhooks", input: JSON.stringify(createBase()) };
    if (leaf === "update") return { args: ["update", endpoint.id, ...owner, "--if-version", endpoint.version, "--stdin"], method: "PATCH", route: base, input: JSON.stringify({ name: "Mutation changed" }) };
    if (leaf === "enable" || leaf === "disable") return { args: [leaf, endpoint.id, ...owner, "--if-version", endpoint.version], method: "PATCH", route: base };
    if (leaf === "delete") return { args: ["delete", endpoint.id, ...owner, "--if-version", endpoint.version], method: "DELETE", route: base };
    if (leaf === "replace") return { args: ["subscription", "replace", endpoint.id, ...owner, "--if-version", endpoint.version, "--stdin"], method: "PATCH", route: base, input: JSON.stringify([{ id: null, projectId: info!.projectId, eventTypes: ["task.created"] }]) };
    if (leaf === "reconfirm") return { args: ["subscription", "reconfirm", endpoint.id, ...owner, "--if-version", endpoint.version, "--project", info!.projectId], method: "PATCH", route: base };
    if (leaf === "rotate") return { args: ["secret", "rotate", endpoint.id, ...owner, "--if-version", endpoint.version, "--mode", "immediate"], method: "POST", route: `${base}/signing-secret/rotations` };
    return { args: ["delivery", "redeliver", endpoint.id, endpoint.deliveryId!, ...owner, "--if-version", endpoint.version, "--if-generation", endpoint.generation!], method: "POST", route: `${base}/deliveries/${endpoint.deliveryId}/redeliveries` };
  };
  const verifyEffect = async (leaf: Leaf, endpointId: string, deliveryId: string | null, operation: any): Promise<unknown> => {
    if (leaf === "redeliver") {
      const delivery = await control("GET", `/api/v1/me/webhooks/${endpointId}/deliveries/${deliveryId}`);
      expect(delivery.generation).toBe(operation.generationAfter); expect(delivery.manualOperationCount).toBe(1);
      return { generation: delivery.generation, manualOperationCount: delivery.manualOperationCount, state: delivery.state };
    }
    const endpoint = await control("GET", `/api/v1/me/webhooks/${endpointId}`);
    expect(endpoint.configVersion).toBe(operation.configVersionAfter);
    if (leaf === "create") expect(endpoint.name).toBe("Mutation create");
    if (leaf === "update") expect(endpoint.name).toBe("Mutation changed");
    if (leaf === "enable") expect(endpoint.enabled).toBe(true);
    if (leaf === "disable") expect(endpoint.enabled).toBe(false);
    if (leaf === "delete") expect(endpoint.lifecycle).toBe("deleted");
    if (leaf === "replace" || leaf === "reconfirm") expect(endpoint.subscriptions).toHaveLength(1);
    if (leaf === "reconfirm") expect(operation.effect).toBe("unchanged");
    if (leaf === "rotate") expect(endpoint.signing.activeKeyId).toBe(operation.keyId);
    return { lifecycle: endpoint.lifecycle, configVersion: endpoint.configVersion, enabled: endpoint.enabled ?? null, name: endpoint.name ?? null, subscriptions: endpoint.subscriptions?.length ?? null, activeKeyId: endpoint.signing?.activeKeyId ?? null };
  };
  const preload = path.join(root, "output-preload.cjs"), helper = path.join(root, "output-helper.cjs");
  try {
    await Promise.all([home, config, tmp].map(dir => mkdir(dir, { recursive: true })));
    await writeFile(helper, `const fault=process.env.WEBHOOK_OUTPUT_FAULT;let buffer=Buffer.alloc(0);process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length<4||buffer.length<4+buffer.readUInt32BE(0))return;const bytes=buffer.subarray(4,4+buffer.readUInt32BE(0));buffer=Buffer.alloc(0);if(fault==='stdout'){process.send({type:'error',message:'${secretCanary} https://secret.invalid/private?token=payload',code:'EIO'});return;}if(fault==='deadline'){process.kill(process.ppid,'SIGTERM');setInterval(()=>{},1000);return;}process.stdout.write(bytes,()=>process.send({type:'written'}));});process.stdin.on('end',()=>{if(fault==='cleanup'){process.exitCode=17;if(process.connected)process.disconnect();}});`, { mode: 0o600 });
    await writeFile(preload, `const cp=require('node:child_process');const mod=require('node:module');const original=cp.spawn;const fault=process.env.WEBHOOK_OUTPUT_FAULT;cp.spawn=function(command,args,options){if(fault!=='cleanup'&&Array.isArray(args)&&String(args[0]).endsWith('byte-output-helper.js'))args=[process.env.WEBHOOK_OUTPUT_HELPER];return original.call(this,command,args,options)};mod.syncBuiltinESMExports();if(fault==='cleanup'){const off=process.off;process.off=function(event,listener){if(event==='SIGTERM')throw new Error('${secretCanary} https://secret.invalid/private?token=payload');return off.call(this,event,listener)}}if(fault==='render'){const stringify=JSON.stringify;JSON.stringify=function(value,...args){if(value&&typeof value==='object'&&value.operation&&typeof value.operation==='object')throw new Error('${secretCanary} https://secret.invalid/private?token=payload');return stringify.call(this,value,...args)}}`, { mode: 0o600 });
    await cp(originalServer, copiedServer, { recursive: true });
    const fixtureSource = path.join(copiedServer, "testdata/webhook-host/main.go");
    const original = await readFile(fixtureSource, "utf8");
    const adapted = original.replace('authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"', '"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"\n\tauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"').replace("\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    if (adapted === original || !adapted.includes("httpx.RequestLogging(logger, mux).ServeHTTP(w, r)")) throw new Error("Could not apply production middleware to the fixture copy.");
    originalHostSha256 = sha(Buffer.from(original)); adaptedHostSha256 = sha(Buffer.from(adapted)); await writeFile(fixtureSource, adapted);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: copiedServer, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: admin, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: member } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const infoLine = new Promise<string>((resolve, reject) => { let text = ""; host!.once("error", reject); host!.stderr!.resume(); host!.stdout!.on("data", (part: Buffer) => { text += part.toString(); const end = text.indexOf("\n"); if (end >= 0) resolve(text.slice(0, end)); }); host!.once("close", () => reject(new Error("Webhook fixture exited before readiness."))); });
    let startupTimer: NodeJS.Timeout | undefined;
    try { info = JSON.parse(await Promise.race([infoLine, new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Webhook fixture readiness timed out.")), 60_000); })])) as HostInfo; }
    finally { if (startupTimer !== undefined) clearTimeout(startupTimer); }
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (address === null || typeof address === "string") throw new Error("Proxy address unavailable.");
    await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${admin}\n`, { mode: 0o600 });

    const leaves: Leaf[] = ["create", "update", "enable", "disable", "delete", "replace", "reconfirm", "rotate", "redeliver"];
    const faults: Fault[] = ["server-5xx", "malformed", "cancel", "render", "stdout", "cleanup", "deadline"];
    for (const leaf of leaves) for (const fault of faults) {
      const endpoint = leaf === "create" ? { id: "", version: "" } : await prepareEndpoint(leaf);
      const input = leafArguments(leaf, endpoint), operationId = randomUUID(), issuedAt = new Date().toISOString(), prepared = path.join(root, `prepared-${leaf}-${fault}.json`);
      const alias = observations.length % 2 === 1;
      const launcher = alias ? path.join(path.dirname(artifact.launcherPath), process.platform === "win32" ? "dn.cmd" : "dn") : artifact.launcherPath;
      const args = ["webhook", ...input.args, "--operation-id", operationId, "--issued-at", issuedAt, "--operation-out", prepared, "--json"];
      const outputFault = fault === "render" || fault === "stdout" || fault === "cleanup" || fault === "deadline";
      const child = crossSpawn(launcher, args, { cwd: root, env: outputFault ? { ...env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, WEBHOOK_OUTPUT_HELPER: helper, WEBHOOK_OUTPUT_FAULT: fault } : env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [], err: Buffer[] = []; child.stdout!.on("data", (part: Buffer) => out.push(part)); child.stderr!.on("data", (part: Buffer) => err.push(part));
      let launchError: unknown; child.once("error", error => { launchError = error; });
      const closed = new Promise<number | null>(resolve => child.once("close", code => { children.delete(child); resolve(code); })); children.set(child, closed);
      const before = records.length, started = performance.now();
      pending = { method: input.method, route: input.route, fault, child };
      child.stdin!.end(input.input);
      let timer: NodeJS.Timeout | undefined;
      let status: number | null;
      try {
        const ended = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 15_000); })]);
        if (ended === "timeout") { await terminateInstalledProcess(child, closed); throw new Error(`${leaf}/${fault} exceeded its execution limit.`); }
        if (launchError !== undefined) throw launchError;
        status = ended;
      } finally { if (timer !== undefined) clearTimeout(timer); }
      const durationMs = Math.round(performance.now() - started), stdout = Buffer.concat(out), stderr = Buffer.concat(err), trace = records.slice(before);
      if (pending !== undefined) throw new Error(`${leaf}/${fault} did not reach its real write response.`);
      const writes = trace.filter(record => record.method === input.method && record.path === input.route);
      expect(writes).toHaveLength(1); expect(writes[0]!.status).toBe(leaf === "create" ? 201 : leaf === "redeliver" ? 202 : 200);
      const reconciles = trace.filter(record => record.method === "GET" && record.path.endsWith(`/operations/${operationId}`));
      expect(reconciles.length).toBeLessThanOrEqual(1);
      expect(stderr.toString()).not.toContain(secretCanary); expect(stderr.toString()).not.toContain("secret.invalid");
      if (fault === "server-5xx" || fault === "malformed") { expect(status).toBe(0); expect(stderr.length).toBe(0); expect(JSON.parse(stdout.toString()).operation.operationId).toBe(operationId); }
      else {
        expect(status).toBe(1);
        const error = JSON.parse(stderr.toString()).error;
        if (fault === "cancel") { expect(stdout.length).toBe(0); expect(error.operationOutcome).toBe("unknown"); expect(error.invocationOutcome).toBe("unknown"); }
        else { expect(error.phase).toBe("output"); expect(error.operationOutcome).toBe("confirmed"); expect(error.invocationOutcome).toBe("confirmed"); }
      }
      if (fault === "render" || fault === "stdout") expect(stdout.length).toBe(0);
      if (fault === "deadline") { expect(durationMs).toBeGreaterThanOrEqual(4_500); expect(durationMs).toBeLessThan(12_000); expect(stdout.length).toBe(0); }
      const record = JSON.parse((await readFile(prepared)).toString());
      expect(record.operationId).toBe(operationId); expect(record.requestSha256).toBe(sha(writes[0]!.body));
      const operation = await control("GET", `/api/v1/me/webhooks/operations/${operationId}`);
      expect(operation.requestSha256).toBe(record.requestSha256); expect(operation.issuedAt).toBe(issuedAt); expect(operation.operationId).toBe(operationId);
      const endpointId = operation.endpointId as string, deliveryId = leaf === "redeliver" ? endpoint.deliveryId! : null;
      const effect = await verifyEffect(leaf, endpointId, deliveryId, operation);
      observations.push({ leaf, fault, operationId, endpointId, deliveryId, durationMs, status, stdoutBase64: stdout.toString("base64"), stderrBase64: stderr.toString("base64"), requestBase64: writes[0]!.body.toString("base64"), requestSha256: record.requestSha256, upstreamStatus: writes[0]!.status, receipt: operation, effect, writeCount: writes.length, reconcileCount: reconciles.length });
      if (fault === "deadline") console.log(`Webhook mutation fault acceptance: ${leaf} completed.`);
      if (leaf !== "delete") {
        const current = await control("GET", `/api/v1/me/webhooks/${endpointId}`);
        await control("DELETE", `/api/v1/me/webhooks/${endpointId}`, { operationId: randomUUID(), issuedAt: new Date().toISOString(), expectedUserId: info.userId, ifVersion: current.configVersion });
      }
    }
    expect(observations).toHaveLength(63);
    const probeSource = path.join(root, "receipt-probe.go");
    await writeFile(probeSource, `package main
import("context";"encoding/json";"fmt";"os";"github.com/jackc/pgx/v5")
type Row struct{ ID string \`json:"id"\`; Count int \`json:"count"\`; Hash string \`json:"hash"\`; Kind string \`json:"kind"\`; Effect string \`json:"effect"\` }
func main(){ctx:=context.Background();cfg,e:=pgx.ParseConfig(os.Getenv("DAYNIGHT_TEST_DATABASE_URL"));if e!=nil{panic("database config failed")};cfg.RuntimeParams["search_path"]=os.Getenv("WEBHOOK_FIXTURE_SCHEMA");c,e:=pgx.ConnectConfig(ctx,cfg);if e!=nil{panic("database failed")};defer c.Close(ctx);var ids []string;if json.Unmarshal([]byte(os.Getenv("WEBHOOK_OPERATION_IDS")),&ids)!=nil{panic("ids failed")};var version string;if c.QueryRow(ctx,"SHOW server_version").Scan(&version)!=nil{panic("version failed")};rows:=make([]Row,0,len(ids));for _,id:=range ids{var r Row;r.ID=id;if c.QueryRow(ctx,"SELECT count(*),coalesce(max(encode(request_sha256,'hex')),''),coalesce(max(kind),''),coalesce(max(effect),'') FROM webhook_operations WHERE operation_id=$1",id).Scan(&r.Count,&r.Hash,&r.Kind,&r.Effect)!=nil{panic("receipt read failed")};rows=append(rows,r)};b,e:=json.Marshal(map[string]any{"databaseVersion":version,"rows":rows});if e!=nil{panic("encoding failed")};fmt.Println(string(b))}
`, { mode: 0o600 });
    const probe = spawn("go", ["run", probeSource], { cwd: copiedServer, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, WEBHOOK_FIXTURE_SCHEMA: info.schema, WEBHOOK_OPERATION_IDS: JSON.stringify(observations.map(item => item.operationId)) } });
    const parts: Buffer[] = []; probe.stdout!.on("data", (part: Buffer) => parts.push(part)); probe.stderr!.resume(); let probeError: unknown; probe.once("error", error => { probeError = error; });
    const probeClosed = new Promise<number | null>(resolve => probe.once("close", code => { children.delete(probe); resolve(code); })); children.set(probe, probeClosed);
    let probeTimer: NodeJS.Timeout | undefined;
    try {
      const status = await Promise.race([probeClosed, new Promise<"timeout">(resolve => { probeTimer = setTimeout(() => resolve("timeout"), 60_000); })]);
      if (status === "timeout") { await terminateInstalledProcess(probe, probeClosed); throw new Error("PostgreSQL receipt probe timed out."); }
      if (probeError !== undefined || status !== 0) throw new Error("PostgreSQL receipt probe failed.");
      const checked = JSON.parse(Buffer.concat(parts).toString()) as { databaseVersion: string; rows: { id: string; count: number; hash: string; kind: string; effect: string }[] };
      expect(checked.rows).toHaveLength(observations.length);
      for (const [index, row] of checked.rows.entries()) { const observed = observations[index]!; const receipt = observed.receipt as { kind: string; effect: string }; expect(row.id).toBe(observed.operationId); expect(row.count).toBe(1); expect(row.hash).toBe(observed.requestSha256); expect(row.kind).toBe(receipt.kind); expect(row.effect).toBe(receipt.effect); }
      databaseChecks = checked;
    } finally { if (probeTimer !== undefined) clearTimeout(probeTimer); }
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); }
  if (info !== undefined) try { await control("POST", "/__fixture/shutdown"); } catch (cause) { cleanup.push(cause); }
  if (host !== undefined && hostClosed !== undefined) try {
    let timer: NodeJS.Timeout | undefined;
    try { if (await Promise.race([hostClosed.then(() => "closed"), new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10_000); })]) === "timeout") await terminateInstalledProcess(host, hostClosed); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  } catch (cause) { cleanup.push(cause); }
  try { proxy.closeAllConnections(); if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  if (process.env.DAYNIGHT_WEBHOOK_MUTATION_EVIDENCE !== undefined) try {
    const output = process.env.DAYNIGHT_WEBHOOK_MUTATION_EVIDENCE;
    if (!path.isAbsolute(output)) throw new Error("Mutation evidence path must be absolute.");
    await writeFile(output, `${JSON.stringify({ source: artifact.source, artifact: { packageVersion: artifact.packageVersion, tarballSha256: artifact.tarballSha256, entrySha256: artifact.entrySha256 }, fixture: { ...info, originalHostSha256, adaptedHostSha256, adaptation: "T05 fixture plus production request logging middleware" }, passed: failure === undefined && cleanup.length === 0, cleanupErrors: cleanup.length, observations, databaseChecks }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (cause) { cleanup.push(cause); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Webhook mutation failure acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 420_000);
