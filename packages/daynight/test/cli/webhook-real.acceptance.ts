import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import crossSpawn from "cross-spawn";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

// This suite uses the production route fixture and an explicitly supplied isolated database.
// Fault injection belongs in separate tests; this proxy records and forwards unmodified traffic.
type HostInfo = { url: string; userId: string; memberId: string; teamId: string; projectId: string; receiverUrl: string; schema: string };
type RequestRecord = { method: string; path: string; sha256: string; bytes: number; status: number; body: Buffer; headers: Record<string, string | string[] | undefined>; response: Buffer[] };
const token = (prefix: string): string => prefix + randomBytes(32).toString("base64url");
const digest = (body: Uint8Array): string => createHash("sha256").update(body).digest("hex");
const database = process.env.DAYNIGHT_TEST_DATABASE_URL;

it.skipIf(database === undefined)("runs installed webhook commands against production routes, authentication and PostgreSQL", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const fixture = path.join(receipt.root, "webhook-real");
  const home = path.join(fixture, "home");
  const config = path.join(fixture, "config");
  const temporary = path.join(fixture, "tmp");
  const originalServer = path.resolve(import.meta.dirname, "../../../daynight-server");
  const copiedServer = path.join(fixture, "server");
  let originalHostHash: string | undefined, adaptedHostHash: string | undefined;
  const admin = token("dnpat_");
  const member = token("dnpat_");
  const children = new Map<ChildProcess, Promise<unknown>>();
  let host: ChildProcess | undefined;
  let hostClosed: Promise<unknown> | undefined;
  let hostInfo: HostInfo | undefined;
  let failure: unknown;
  const records: RequestRecord[] = [];
  const controls: { method: string; path: string; status: number; body: Buffer; response: Buffer }[] = [];
  const calls: { args: string[]; alias: boolean; cwd: string; closeOutput: boolean; injectedFiles: boolean; status: number | null; stdout: Buffer; stderr: Buffer }[] = [];
  const databaseChecks: { deliveryId: string; days: number; retainedBody: boolean; payloadExpired: boolean; metadataExpired: boolean }[] = [];
  const createDatabaseChecks: unknown[] = [];
  const boundaryInputs: unknown[] = [];
  const directoryChecks: unknown[] = [];
  const sensitive = [admin, member, "canary-private"];
  const terminals: { answer: string; exitCode: number; prompt: string; output: string }[] = [];
  let loseNextWriteResponse: { method: string; path: string } | undefined;
  let loseBeforeDispatch = false;
  let receiptHashFault = false;
  let receiptFailureStatus: 401 | 403 | 503 | undefined;
  let strip401Principal = false;
  let payloadFault: string | undefined;
  let oversizedCatalog = false;
  const faults: { kind: string; path: string; response?: Buffer; status?: number }[] = [];
  let pageFault: "status" | "principal" | undefined;
  const proxy = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (value: Buffer) => chunks.push(value));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      if (loseBeforeDispatch && incoming.method === "POST" && incoming.url!.endsWith("/webhooks")) {
        loseBeforeDispatch = false;
        faults.push({ kind: "drop-before-forward", path: incoming.url! });
        records.push({ method: incoming.method, path: incoming.url!, sha256: digest(body), bytes: body.length, status: 0, body, headers: {}, response: [] });
        outgoing.destroy();
        return;
      }
      const target = new URL(incoming.url!, hostInfo!.url);
      const upstream = httpRequest(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, (response) => {
        const observed: RequestRecord = { method: incoming.method!, path: incoming.url!, sha256: digest(body), bytes: body.length, status: response.statusCode!, body, headers: { "content-type": response.headers["content-type"], "daynight-user-id": response.headers["daynight-user-id"], "x-request-id": response.headers["x-request-id"] }, response: [] };
        records.push(observed);
        response.on("data", (part: Buffer) => observed.response.push(part));
        if (loseNextWriteResponse !== undefined && incoming.method === loseNextWriteResponse.method && incoming.url === loseNextWriteResponse.path && response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300) {
          loseNextWriteResponse = undefined;
          faults.push({ kind: "drop-after-commit-response", path: incoming.url! });
          response.resume();
          outgoing.destroy();
          return;
        }
        if (oversizedCatalog && incoming.method === "GET" && incoming.url === "/api/v1/webhook-event-types" && response.statusCode === 200) {
          oversizedCatalog = false;
          const parts: Buffer[] = []; response.on("data", (part: Buffer) => parts.push(part));
          response.on("end", () => {
            const original = Buffer.concat(parts); const changed = Buffer.concat([original, Buffer.alloc(1_048_577 - original.length, 32)]);
            faults.push({ kind: "catalog-over-1m", path: incoming.url!, status: 200, response: changed });
            outgoing.writeHead(200, { ...response.headers, "content-length": changed.length }); outgoing.end(changed);
          });
          return;
        }
        if (payloadFault !== undefined && incoming.method === "GET" && incoming.url!.endsWith("/payload") && response.statusCode === 200) {
          const fault = payloadFault; payloadFault = undefined;
          const parts: Buffer[] = [];
          response.on("data", (part: Buffer) => parts.push(part));
          response.on("end", () => {
            const value = JSON.parse(Buffer.concat(parts).toString());
            switch (fault) {
              case "base64": value.body = "!"; break;
              case "bytes": value.bytes++; break;
              case "hash": value.sha256 = "0".repeat(64); break;
              case "media": value.mediaType = "text/html"; break;
              case "encoding": value.encoding = "hex"; break;
              case "owner": value.owner.id = "00000000-0000-4000-8000-000000000001"; break;
              case "endpoint": value.endpointId = "00000000-0000-4000-8000-000000000001"; break;
              case "delivery": value.deliveryId = "00000000-0000-4000-8000-000000000001"; break;
              case "event": value.eventId = "invalid"; break;
              case "oversize": { const decoded = Buffer.alloc(65537, 7); value.body = decoded.toString("base64"); value.bytes = decoded.length; value.sha256 = digest(decoded); break; }
              case "boundary": { const decoded = Buffer.alloc(65536, 7); value.body = decoded.toString("base64"); value.bytes = decoded.length; value.sha256 = digest(decoded); break; }
            }
            const original = Buffer.from(JSON.stringify(value));
            const changed = fault === "over-1m" ? Buffer.concat([original, Buffer.alloc(1_048_577 - original.length, 32)]) : original;
            faults.push({ kind: `payload-${fault}`, path: incoming.url!, status: 200, response: changed });
            outgoing.writeHead(200, { ...response.headers, "content-length": changed.length });
            outgoing.end(changed);
          });
          return;
        }
        if (receiptFailureStatus !== undefined && incoming.method === "GET" && incoming.url!.includes("/operations/") && response.statusCode === 200) {
          const status = receiptFailureStatus; receiptFailureStatus = undefined;
          response.resume();
          const code = status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : "dependency_unavailable";
          const body = Buffer.from(JSON.stringify({ error: { code, message: "Injected receipt failure.", requestId: response.headers["x-request-id"] } }));
          const headers: Record<string, string | string[] | number | undefined> = { ...response.headers, "content-length": body.length };
          const stripped = status === 401 && strip401Principal;
          if (stripped) { delete headers["daynight-user-id"]; strip401Principal = false; }
          faults.push({ kind: `receipt-${status}${stripped ? "-no-principal" : ""}`, path: incoming.url!, status, response: body });
          outgoing.writeHead(status, headers); outgoing.end(body);
          return;
        }
        if (receiptHashFault && incoming.method === "GET" && incoming.url!.includes("/operations/") && response.statusCode === 200) {
          receiptHashFault = false;
          const parts: Buffer[] = [];
          response.on("data", (part: Buffer) => parts.push(part));
          response.on("end", () => {
            const value = JSON.parse(Buffer.concat(parts).toString()); value.requestSha256 = "0".repeat(64);
            const changed = Buffer.from(JSON.stringify(value));
            faults.push({ kind: "receipt-hash", path: incoming.url!, status: 200, response: changed });
            outgoing.writeHead(200, { ...response.headers, "content-length": changed.length });
            outgoing.end(changed);
          });
          return;
        }
        if (pageFault !== undefined && incoming.method === "GET" && incoming.url!.includes("/webhooks?") && incoming.url!.includes("cursor=")) {
          const fault = pageFault; pageFault = undefined;
          faults.push({ kind: `page-${fault}`, path: incoming.url! });
          if (fault === "status") {
            response.resume();
            outgoing.writeHead(503, { "content-type": "application/json", "daynight-user-id": hostInfo!.userId });
            outgoing.end(JSON.stringify({ error: { code: "fixture_page_failure", message: "Injected page failure.", requestId: randomUUID() } }));
            return;
          }
          outgoing.writeHead(response.statusCode!, { ...response.headers, "daynight-user-id": "00000000-0000-4000-8000-000000000001" });
          response.pipe(outgoing);
          return;
        }
        outgoing.writeHead(response.statusCode!, response.headers);
        response.pipe(outgoing);
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.end(body);
    });
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, DN_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(fixture, "xdg"), XDG_CACHE_HOME: path.join(fixture, "cache"), TMPDIR: temporary, TMP: temporary, TEMP: temporary, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(fixture, "gitconfig"), GIT_CEILING_DIRECTORIES: path.dirname(receipt.root), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const invoke = async (args: string[], alias = false, input?: string | Uint8Array, closeOutput = false, preload?: string, cwd = fixture) => {
    const launcher = alias ? path.join(path.dirname(receipt.launcherPath), process.platform === "win32" ? "dn.cmd" : "dn") : receipt.launcherPath;
    const child = crossSpawn(launcher, args, { cwd, env: preload === undefined ? env : { ...env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout!.on("data", (b: Buffer) => out.push(b)); child.stderr!.on("data", (b: Buffer) => err.push(b));
    if (closeOutput) child.stdout!.destroy();
    let launchError: unknown; child.once("error", cause => { launchError = cause; });
    const closed = new Promise<number | null>(resolve => child.once("close", code => { children.delete(child); resolve(code); }));
    children.set(child, closed); child.stdin!.end(input);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 30_000); })]);
      if (result === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed webhook command timed out."); }
      if (launchError !== undefined) throw launchError;
      const observation = { args, alias, cwd, closeOutput, injectedFiles: preload !== undefined, status: result, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
      calls.push(observation);
      return observation;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const call = async (args: string[], alias = false, input?: string, cwd = fixture): Promise<any> => {
    const result = await invoke(["webhook", ...args, "--json"], alias, input, false, undefined, cwd);
    expect(result.status, `webhook ${args.slice(0, 2).join(" ")} exited ${result.status}`).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.at(-1)).toBe(10);
    return JSON.parse(result.stdout.toString());
  };
  const reconcileLost = async (args: string[], method: string, route: string, filename: string, input?: string): Promise<any> => {
    const preparedPath = path.join(fixture, filename);
    const before = records.length;
    loseNextWriteResponse = { method, path: route };
    const first = await invoke(["webhook", ...args, "--operation-out", preparedPath, "--json"], false, input);
    expect(loseNextWriteResponse).toBeUndefined();
    const submission = records.slice(before).filter(record => record.method === method && record.path === route);
    expect(submission).toHaveLength(1);
    expect(records.slice(before).filter(record => record.path.includes("/operations/")).length).toBeLessThanOrEqual(1);
    if (first.status !== 0) expect(["unknown", "confirmed"]).toContain(JSON.parse(first.stderr.toString()).error.operationOutcome);
    const identity = JSON.parse((await readFile(preparedPath)).toString());
    expect(submission[0]!.sha256).toBe(identity.requestSha256);
    const beforeResume = records.length;
    const result = await call([...args, "--resume-operation", preparedPath], false, input);
    expect(result.operation.operationId).toBe(identity.operationId);
    expect(records.slice(beforeResume).filter(record => record.method === method && record.path === route)).toHaveLength(0);
    return result;
  };
  const control = async (method: string, route: string, value?: unknown, actor = admin) => {
    const response = await fetch(hostInfo!.url + route, { method, headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    controls.push({ method, path: route, status: response.status, body: Buffer.from(value === undefined ? "" : JSON.stringify(value)), response: bytes });
    if (!response.ok) throw new Error(`Fixture control failed: ${method} ${route} (${response.status}).`);
    return bytes.length ? JSON.parse(bytes.toString()) : undefined;
  };
  const ageDelivery = async (deliveryId: string, days: 8 | 31) => {
    const sourcePath = path.join(fixture, "retention-probe.go");
    const source = [
      "package main",
      'import ("context"; "encoding/json"; "os"; "github.com/jackc/pgx/v5")',
      "func main() {",
      'ctx := context.Background(); cfg, err := pgx.ParseConfig(os.Getenv("DAYNIGHT_TEST_DATABASE_URL")); if err != nil { panic("invalid database configuration") }',
      'cfg.RuntimeParams["search_path"] = os.Getenv("WEBHOOK_FIXTURE_SCHEMA"); db, err := pgx.ConnectConfig(ctx, cfg); if err != nil { panic("database connection failed") }; defer db.Close(ctx)',
      'id, delta := os.Getenv("WEBHOOK_DELIVERY_ID"), os.Getenv("WEBHOOK_SHIFT"); tx, err := db.Begin(ctx); if err != nil { panic("transaction failed") }; defer tx.Rollback(ctx)',
      '_, err = tx.Exec(ctx, "UPDATE webhook_events SET occurred_at=occurred_at-$2::interval WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)", id, delta); if err != nil { panic("event shift failed") }',
      'q := "UPDATE webhook_deliveries SET occurred_at=occurred_at-$2::interval,automatic_schedule_at=ARRAY(SELECT x-$2::interval FROM unnest(automatic_schedule_at) x),automatic_expires_at=automatic_expires_at-$2::interval,payload_expires_at=payload_expires_at-$2::interval,expires_at=expires_at-$2::interval"',
      `if delta == "31 days" { q += ",last_activity_at=occurred_at-$2::interval,metadata_expires_at=occurred_at-interval '1 day'" }; q += " WHERE id=$1"`,
      'tag, err := tx.Exec(ctx, q, id, delta); if err != nil || tag.RowsAffected()!=1 { panic("delivery shift failed") }',
      'if delta == "31 days" { _, err = tx.Exec(ctx, "UPDATE webhook_attempts SET claimed_at=claimed_at-$2::interval,admitted_at=admitted_at-$2::interval,dispatched_at=dispatched_at-$2::interval,finished_at=finished_at-$2::interval,late_observed_at=late_observed_at-$2::interval,recovered_unknown_at=recovered_unknown_at-$2::interval WHERE delivery_id=$1", id, delta); if err != nil { panic("attempt shift failed") } }; if err = tx.Commit(ctx); err != nil { panic("commit failed") }',
      'var body, payload, metadata bool; err = db.QueryRow(ctx, "SELECT body IS NOT NULL,payload_expires_at<=clock_timestamp(),metadata_expires_at<=clock_timestamp() FROM webhook_deliveries WHERE id=$1", id).Scan(&body,&payload,&metadata); if err != nil { panic("retention observation failed") }',
      'json.NewEncoder(os.Stdout).Encode(map[string]bool{"retainedBody":body,"payloadExpired":payload,"metadataExpired":metadata})',
      "}",
    ].join("\n");
    await writeFile(sourcePath, source, { mode: 0o600 });
    const child = spawn("go", ["run", sourcePath], { cwd: path.resolve(import.meta.dirname, "../../../daynight-server"), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, WEBHOOK_FIXTURE_SCHEMA: hostInfo!.schema, WEBHOOK_DELIVERY_ID: deliveryId, WEBHOOK_SHIFT: `${days} days` } });
    const stdout: Buffer[] = []; child.stdout!.on("data", (part: Buffer) => stdout.push(part)); child.stderr!.resume();
    let launchError: unknown; child.once("error", cause => { launchError = cause; });
    const closed = new Promise<number | null>(resolve => child.once("close", code => { children.delete(child); resolve(code); }));
    children.set(child, closed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 60_000); })]);
      if (status === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Retention database probe timed out."); }
      if (launchError !== undefined) throw launchError;
      if (status !== 0) throw new Error("Retention database probe failed.");
      const result = JSON.parse(Buffer.concat(stdout).toString()) as { retainedBody: boolean; payloadExpired: boolean; metadataExpired: boolean };
      databaseChecks.push({ deliveryId, days, ...result });
      return result;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const setLargeVersion = async (endpointId: string): Promise<void> => {
    const sourcePath = path.join(fixture, "version-probe.go");
    const source = [
      "package main",
      'import ("context"; "os"; "github.com/jackc/pgx/v5")',
      'func main() { ctx:=context.Background(); cfg,err:=pgx.ParseConfig(os.Getenv("DAYNIGHT_TEST_DATABASE_URL")); if err!=nil { panic("invalid database configuration") }; cfg.RuntimeParams["search_path"]=os.Getenv("WEBHOOK_FIXTURE_SCHEMA"); db,err:=pgx.ConnectConfig(ctx,cfg); if err!=nil { panic("connection failed") }; defer db.Close(ctx); tag,err:=db.Exec(ctx,"UPDATE webhook_endpoints SET config_version=9007199254740993 WHERE id=$1",os.Getenv("WEBHOOK_ENDPOINT_ID")); if err!=nil || tag.RowsAffected()!=1 { panic("version setup failed") } }',
    ].join("\n");
    await writeFile(sourcePath, source, { mode: 0o600 });
    const child = spawn("go", ["run", sourcePath], { cwd: originalServer, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, WEBHOOK_FIXTURE_SCHEMA: hostInfo!.schema, WEBHOOK_ENDPOINT_ID: endpointId } });
    child.stderr!.resume(); let launchError: unknown; child.once("error", cause => { launchError = cause; });
    const closed = new Promise<number | null>(resolve => child.once("close", code => { children.delete(child); resolve(code); })); children.set(child, closed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 60_000); })]);
      if (status === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Version database probe timed out."); }
      if (launchError !== undefined) throw launchError;
      if (status !== 0) throw new Error("Version database probe failed.");
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const checkCreateDatabase = async (endpointId: string, operationId: string, ownerKind: string, ownerId: string, subscriptionId: string, requestHash: string): Promise<void> => {
    const sourcePath = path.join(fixture, "create-probe.go");
    await writeFile(sourcePath, `package main
import("context";"encoding/json";"os";"github.com/jackc/pgx/v5")
func main(){ctx:=context.Background();cfg,e:=pgx.ParseConfig(os.Getenv("DAYNIGHT_TEST_DATABASE_URL"));if e!=nil{panic("config")};cfg.RuntimeParams["search_path"]=os.Getenv("WEBHOOK_FIXTURE_SCHEMA");db,e:=pgx.ConnectConfig(ctx,cfg);if e!=nil{panic("connect")};defer db.Close(ctx);var ownerKind,ownerID,version,effect,hash,project,subscription string;var endpoints,operations,subs,bindings,activeBindings int;e=db.QueryRow(ctx,"SELECT count(*),coalesce(max(owner_kind),''),coalesce(max(owner_id::text),''),coalesce(max(config_version)::text,'') FROM webhook_endpoints WHERE id=$1",os.Getenv("WEBHOOK_ENDPOINT_ID")).Scan(&endpoints,&ownerKind,&ownerID,&version);if e!=nil{panic("endpoint")};e=db.QueryRow(ctx,"SELECT count(*),coalesce(max(effect),''),coalesce(max(encode(request_sha256,'hex')),'') FROM webhook_operations WHERE endpoint_id=$1 AND operation_id=$2",os.Getenv("WEBHOOK_ENDPOINT_ID"),os.Getenv("WEBHOOK_OPERATION_ID")).Scan(&operations,&effect,&hash);if e!=nil{panic("operation")};e=db.QueryRow(ctx,"SELECT count(*),coalesce(max(id::text),''),coalesce(max(project_id::text),'') FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL",os.Getenv("WEBHOOK_ENDPOINT_ID")).Scan(&subs,&subscription,&project);if e!=nil{panic("subscriptions")};e=db.QueryRow(ctx,"SELECT count(*) FILTER (WHERE event_type='task.created'),count(*) FROM webhook_bindings WHERE subscription_id=$1 AND deleted_at IS NULL",os.Getenv("WEBHOOK_SUBSCRIPTION_ID")).Scan(&bindings,&activeBindings);if e!=nil{panic("bindings")};json.NewEncoder(os.Stdout).Encode(map[string]any{"endpoints":endpoints,"ownerKind":ownerKind,"ownerId":ownerID,"version":version,"operations":operations,"effect":effect,"hash":hash,"subscriptions":subs,"subscriptionId":subscription,"projectId":project,"bindings":bindings,"activeBindings":activeBindings})}
`, { mode: 0o600 });
    const child = spawn("go", ["run", sourcePath], { cwd: originalServer, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, WEBHOOK_FIXTURE_SCHEMA: hostInfo!.schema, WEBHOOK_ENDPOINT_ID: endpointId, WEBHOOK_OPERATION_ID: operationId, WEBHOOK_SUBSCRIPTION_ID: subscriptionId } });
    const out: Buffer[] = []; child.stdout!.on("data", (part: Buffer) => out.push(part)); child.stderr!.resume();
    let launchError: unknown; child.once("error", error => { launchError = error; });
    const closed = new Promise<number | null>(resolve => child.once("close", code => { children.delete(child); resolve(code); })); children.set(child, closed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 60_000); })]);
      if (status === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Create database probe timed out."); }
      if (launchError !== undefined || status !== 0) throw new Error("Create database probe failed.");
      const result = JSON.parse(Buffer.concat(out).toString());
      expect(result).toMatchObject({ endpoints: 1, ownerKind, ownerId, version: "1", operations: 1, effect: "applied", hash: requestHash, subscriptions: 1, subscriptionId, projectId: hostInfo!.projectId, bindings: 1, activeBindings: 1 });
      createDatabaseChecks.push({ endpointId, operationId, ...result });
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  try {
    await Promise.all([home, config, temporary].map(dir => mkdir(dir, { recursive: true })));
    await cp(originalServer, copiedServer, { recursive: true });
    const fixtureSource = path.join(copiedServer, "testdata/webhook-host/main.go");
    const originalHost = await readFile(fixtureSource, "utf8");
    const adaptedHost = originalHost
      .replace('authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"', '"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"\n\tauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"')
      .replace("\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    if (adaptedHost === originalHost || !adaptedHost.includes("httpx.RequestLogging(logger, mux).ServeHTTP(w, r)")) throw new Error("Could not apply the production request logging middleware to the fixture copy.");
    originalHostHash = digest(Buffer.from(originalHost)); adaptedHostHash = digest(Buffer.from(adaptedHost));
    await writeFile(fixtureSource, adaptedHost);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: copiedServer, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: admin, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: member } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const infoLine = new Promise<string>((resolve, reject) => {
      let text = "";
      host!.once("error", reject);
      host!.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); const newline = text.indexOf("\n"); if (newline >= 0) resolve(text.slice(0, newline)); });
      host!.once("close", () => reject(new Error("Webhook fixture exited before readiness.")));
      host!.stderr!.resume();
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try { hostInfo = JSON.parse(await Promise.race([infoLine, new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Webhook fixture did not become ready.")), 60_000); })])) as HostInfo; }
    finally { if (startupTimer !== undefined) clearTimeout(startupTimer); }
    expect(hostInfo.schema).toBeTruthy();
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (address === null || typeof address === "string") throw new Error("Missing proxy address.");
    const origin = `http://127.0.0.1:${address.port}`;
    await writeFile(path.join(config, "config.yml"), `serverUrl: ${origin}\nserverToken: ${admin}\nteamDefaults:\n  ${JSON.stringify(origin)}:\n    ${hostInfo.userId}: 00000000-0000-4000-8000-000000000001\n`, { mode: 0o600 });
    const beforeCatalog = records.length;
    const catalog = await call(["catalog"]);
    const aliasCatalog = await call(["catalog"], true);
    const catalogRequests = records.slice(beforeCatalog).filter(record => record.path === "/api/v1/webhook-event-types");
    expect(catalog.items).toHaveLength(6); expect(aliasCatalog).toEqual(catalog);
    expect(catalogRequests).toHaveLength(2);
    for (const record of catalogRequests) expect(JSON.parse(Buffer.concat(record.response).toString())).toEqual(catalog);
    expect(catalog.limits).toEqual({ policyVersion: "1", requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 10, automaticWindowSeconds: 259200, maxManualOperations: 3, payloadRetentionSeconds: 604800, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 });
    const beforeOversized = records.length;
    oversizedCatalog = true;
    const tooLarge = await invoke(["webhook", "catalog", "--json"]);
    expect(oversizedCatalog).toBe(false); expect(tooLarge.status).toBe(1); expect(tooLarge.stdout.length).toBe(0);
    expect(records.slice(beforeOversized).filter(record => record.path === "/api/v1/webhook-event-types")).toHaveLength(1);
    const definition = { name: "Real fixture", enabled: true, destination: { kind: "http", adapterVersion: "1", configuration: { url: hostInfo.receiverUrl } }, subscriptions: [{ id: null, projectId: hostInfo.projectId, eventTypes: ["task.created"] }] };
    const inputFile = path.join(fixture, "input.json");
    await writeFile(inputFile, JSON.stringify(definition), { mode: 0o600 });
    const prepared = path.join(fixture, "prepared.json");
    for (const invalid of [
      ["list"], ["list", "--personal", "--team", hostInfo.teamId], ["list", "--personal", "--personal"],
      ["list", "--team", "personal"], ["catalog", "--personal"],
      ["update", "bad-uuid", "--personal", "--stdin", "--if-version", "1", "--confirm"],
      ["create", "--personal", "--stdin"],
      ["create", "--personal", "--stdin", "--confirm", "--operation-id", randomUUID()],
      ["create", "--personal", "--stdin", "--confirm", "--issued-at", new Date().toISOString()],
      ["update", randomUUID(), "--personal", "--stdin", "--if-version", "9007199254740993e0", "--confirm"],
      ["update", randomUUID(), "--personal", "--stdin", "--if-version", "9223372036854775808", "--confirm"],
    ]) {
      const before = records.filter(record => record.path.includes("/webhook")).length;
      const refused = await invoke(["webhook", ...invalid], false, "{}");
      expect(refused.status).toBe(2);
      expect(refused.stdout.length).toBe(0);
      expect(records.filter(record => record.path.includes("/webhook"))).toHaveLength(before);
    }
    const opaqueEndpoint = randomUUID(), opaqueDelivery = randomUUID(), opaqueOperation = randomUUID();
    const ownerLeaves = [
      ["list"], ["show", opaqueEndpoint], ["create", "--stdin", "--confirm"],
      ["update", opaqueEndpoint, "--stdin", "--if-version", "1", "--confirm"],
      ...["enable", "disable", "delete"].map(name => [name, opaqueEndpoint, "--if-version", "1", "--confirm"]),
      ["subscription", "list", opaqueEndpoint], ["subscription", "replace", opaqueEndpoint, "--stdin", "--if-version", "1", "--confirm"],
      ["subscription", "reconfirm", opaqueEndpoint, "--project", hostInfo.projectId, "--if-version", "1", "--confirm"],
      ["secret", "show", opaqueEndpoint], ["secret", "rotate", opaqueEndpoint, "--mode", "immediate", "--if-version", "1", "--confirm"],
      ["delivery", "list", opaqueEndpoint], ["delivery", "show", opaqueEndpoint, opaqueDelivery], ["delivery", "payload", opaqueEndpoint, opaqueDelivery],
      ["delivery", "redeliver", opaqueEndpoint, opaqueDelivery, "--if-version", "1", "--if-generation", "1", "--confirm"],
      ["attempt", "list", opaqueEndpoint, opaqueDelivery], ["operation", "show", opaqueOperation],
    ];
    for (const leaf of ownerLeaves) for (const selector of [[], ["--personal", "--team", hostInfo.teamId], ["--personal", "--personal"], ["--team", "personal"]]) {
      const before = records.length;
      const refused = await invoke(["webhook", ...leaf, ...selector], false, "[]");
      expect(refused.status, `${leaf.join(" ")} owner selector`).toBe(2);
      expect(refused.stdout.length).toBe(0);
      expect(records.slice(before)).toHaveLength(0);
    }
    const invalidLeaves: string[][] = [["catalog", "--json", "--json"]];
    for (const leaf of ownerLeaves) {
      invalidLeaves.push([...leaf, "--personal", "--json", "--json"]);
      invalidLeaves.push([...leaf, "--team", "bad-uuid"]);
      if (leaf.includes("--confirm")) {
        invalidLeaves.push([...leaf, "--personal", "--confirm"]);
        invalidLeaves.push([...leaf, "--personal", "--operation-id", "bad-uuid", "--issued-at", new Date().toISOString()]);
      }
      for (const invalidId of [opaqueEndpoint, opaqueDelivery, opaqueOperation, hostInfo.projectId]) {
        if (leaf.includes(invalidId)) invalidLeaves.push([...leaf.map(part => part === invalidId ? "bad-uuid" : part), "--personal"]);
      }
      for (const option of ["--if-version", "--if-generation"]) {
        const index = leaf.indexOf(option);
        if (index >= 0) {
          const invalid = [...leaf]; invalid[index + 1] = "9223372036854775808";
          invalidLeaves.push([...invalid, "--personal"]);
          invalidLeaves.push([...leaf, "--personal", option, "1"]);
        }
      }
    }
    for (const invalid of invalidLeaves) {
      const before = records.length;
      const refused = await invoke(["webhook", ...invalid], false, "[]");
      expect(refused.status, invalid.join(" ")).toBe(2); expect(refused.stdout.length).toBe(0);
      expect(records.slice(before)).toHaveLength(0);
    }
    if (process.platform !== "win32") {
      const pty = await import("node-pty");
      for (const answer of ["n", "y"]) {
        const beforePrompt = records.length;
        const preparedPath = path.join(fixture, `pty-${answer}.json`);
        const terminal = pty.spawn(receipt.launcherPath, ["webhook", "create", "--personal", "--file", inputFile, "--operation-out", preparedPath, "--json"], { name: "xterm-256color", cols: 120, rows: 30, cwd: fixture, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
        let output = "", promptText = "", exited = false;
        let promptResolve!: () => void;
        const prompted = new Promise<void>(resolve => { promptResolve = resolve; });
        terminal.onData(chunk => { output += chunk; if (output.includes("[y/N]: ")) { promptText = output; promptResolve(); } });
        const closed = new Promise<number>(resolve => terminal.onExit(({ exitCode }) => { exited = true; resolve(exitCode); }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Webhook confirmation terminal timed out.")), 30_000); });
        try {
          await Promise.race([prompted, closed.then(code => { throw new Error(`Webhook confirmation exited before prompt (${code}).`); }), timeout]);
          expect(records.slice(beforePrompt).filter(record => record.method === "POST")).toHaveLength(0);
          expect(promptText).not.toContain(hostInfo.receiverUrl); expect(promptText).not.toContain(admin);
          const confirmedAt = Date.now();
          terminal.write(`${answer}\r`);
          const exitCode = await Promise.race([closed, timeout]);
          terminals.push({ answer, exitCode, prompt: promptText, output });
          expect(exitCode).toBe(answer === "y" ? 0 : 1);
          const writes = records.slice(beforePrompt).filter(record => record.method === "POST" && record.path === "/api/v1/me/webhooks");
          expect(writes).toHaveLength(answer === "y" ? 1 : 0);
          if (answer === "y") expect(Date.parse(JSON.parse(writes[0]!.body.toString()).issuedAt)).toBeGreaterThanOrEqual(confirmedAt - 1000);
          else await expect(readFile(preparedPath)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (!exited) { terminal.kill("SIGKILL"); await closed; }
        }
      }
    }
    const beforeCreate = records.length;
    const created = await call(["create", "--personal", "--file", inputFile, "--confirm", "--operation-out", prepared]);
    const id = created.endpoint.id as string;
    expect(created.endpoint.configVersion).toBe("1");
    expect(created.endpoint.owner).toEqual({ kind: "personal", id: hostInfo.userId });
    expect(created.operation.effect).toBe("applied"); expect(created.endpoint.subscriptions).toHaveLength(1);
    expect(created.endpoint.subscriptions[0].projectId).toBe(hostInfo.projectId);
    expect(created.endpoint.subscriptions[0].eventTypes).toEqual(["task.created"]);
    const write = records.slice(beforeCreate).find(r => r.method === "POST" && r.path === "/api/v1/me/webhooks")!;
    expect(write.status).toBe(201);
    expect(created.operation.requestSha256).toBe(write.sha256);
    await checkCreateDatabase(id, created.operation.operationId, "personal", hostInfo.userId, created.endpoint.subscriptions[0].id, write.sha256);
    const preparedBytes = await readFile(prepared);
    expect(JSON.parse(preparedBytes.toString()).requestSha256).toBe(write.sha256);
    expect(preparedBytes.toString()).not.toContain(hostInfo.receiverUrl);
    if (process.platform !== "win32") expect((await stat(prepared)).mode & 0o777).toBe(0o600);
    const existingBefore = records.filter(record => record.method === "POST" && record.path === "/api/v1/me/webhooks").length;
    const collision = await invoke(["webhook", "create", "--personal", "--file", inputFile, "--confirm", "--operation-out", prepared, "--json"]);
    expect(collision.status).not.toBe(0); expect(collision.stdout.length).toBe(0);
    expect(records.filter(record => record.method === "POST" && record.path === "/api/v1/me/webhooks")).toHaveLength(existingBefore);
    expect(await readFile(prepared)).toEqual(preparedBytes);
    const lostCreatePrepared = path.join(fixture, "lost-create.json");
    const lostCreateInput = JSON.stringify({ ...definition, name: "Create response loss", subscriptions: [] });
    const beforeLostCreate = records.length;
    loseNextWriteResponse = { method: "POST", path: "/api/v1/me/webhooks" };
    await invoke(["webhook", "create", "--personal", "--stdin", "--confirm", "--operation-out", lostCreatePrepared, "--json"], false, lostCreateInput);
    expect(loseNextWriteResponse).toBeUndefined();
    expect(records.slice(beforeLostCreate).filter(record => record.method === "POST" && record.path === "/api/v1/me/webhooks")).toHaveLength(1);
    const lostCreateIdentity = JSON.parse((await readFile(lostCreatePrepared)).toString());
    const lostCreateReceipt = await call(["operation", "show", lostCreateIdentity.operationId, "--personal"]);
    expect(lostCreateReceipt.requestSha256).toBe(lostCreateIdentity.requestSha256);
    const beforeCreateResume = records.length;
    const createResume = await call(["create", "--personal", "--stdin", "--confirm", "--resume-operation", lostCreatePrepared], false, lostCreateInput);
    expect(createResume.operation.operationId).toBe(lostCreateIdentity.operationId);
    expect(records.slice(beforeCreateResume).filter(record => record.method === "POST")).toHaveLength(0);
    const outputFailurePrepared = path.join(fixture, "output-failure.json");
    const beforeOutputFailure = records.length;
    const outputFailure = await invoke(["webhook", "update", lostCreateReceipt.endpointId, "--personal", "--stdin", "--if-version", "1", "--confirm", "--operation-out", outputFailurePrepared, "--json"], false, JSON.stringify({ name: "Confirmed output failure" }), true);
    expect(outputFailure.status).toBe(1);
    const outputError = JSON.parse(outputFailure.stderr.toString()).error;
    expect(outputError.phase).toBe("output"); expect(outputError.invocationOutcome).toBe("confirmed"); expect(outputError.operationOutcome).toBe("confirmed");
    expect(records.slice(beforeOutputFailure).filter(record => record.method === "PATCH")).toHaveLength(1);
    const outputFailureIdentity = JSON.parse((await readFile(outputFailurePrepared)).toString());
    const outputFailureReceipt = await call(["operation", "show", outputFailureIdentity.operationId, "--personal"]);
    expect(outputFailureReceipt.configVersionAfter).toBe("2");
    const lostDeletePrepared = path.join(fixture, "lost-delete.json");
    const beforeLostDelete = records.length;
    loseNextWriteResponse = { method: "DELETE", path: `/api/v1/me/webhooks/${lostCreateReceipt.endpointId}` };
    await invoke(["webhook", "delete", lostCreateReceipt.endpointId, "--personal", "--if-version", "2", "--confirm", "--operation-out", lostDeletePrepared, "--json"]);
    expect(loseNextWriteResponse).toBeUndefined();
    expect(records.slice(beforeLostDelete).filter(record => record.method === "DELETE")).toHaveLength(1);
    const lostDeleteIdentity = JSON.parse((await readFile(lostDeletePrepared)).toString());
    const beforeDeleteResume = records.length;
    const deleteResume = await call(["delete", lostCreateReceipt.endpointId, "--personal", "--if-version", "2", "--confirm", "--resume-operation", lostDeletePrepared]);
    expect(deleteResume.operation.operationId).toBe(lostDeleteIdentity.operationId);
    expect(records.slice(beforeDeleteResume).filter(record => record.method === "DELETE")).toHaveLength(0);
    const beforeTeamCreate = records.length;
    const teamCreated = await call(["create", "--team", hostInfo.teamId, "--stdin", "--confirm"], true, JSON.stringify(definition));
    expect(teamCreated.endpoint.owner).toEqual({ kind: "team", id: hostInfo.teamId });
    expect(teamCreated.endpoint.configVersion).toBe("1"); expect(teamCreated.operation.effect).toBe("applied");
    expect(teamCreated.endpoint.subscriptions).toHaveLength(1); expect(teamCreated.endpoint.subscriptions[0].projectId).toBe(hostInfo.projectId);
    expect(teamCreated.endpoint.subscriptions[0].eventTypes).toEqual(["task.created"]);
    const teamWrite = records.slice(beforeTeamCreate).filter(record => record.method === "POST" && record.path === `/api/v1/teams/${hostInfo!.teamId}/webhooks`);
    expect(teamWrite).toHaveLength(1); expect(teamWrite[0]!.status).toBe(201); expect(teamCreated.operation.requestSha256).toBe(teamWrite[0]!.sha256);
    await checkCreateDatabase(teamCreated.endpoint.id, teamCreated.operation.operationId, "team", hostInfo.teamId, teamCreated.endpoint.subscriptions[0].id, teamWrite[0]!.sha256);
    const boundarySource = JSON.stringify({ name: definition.name });
    const boundaryInput = boundarySource + " ".repeat(262144 - Buffer.byteLength(boundarySource));
    expect(Buffer.byteLength(boundaryInput)).toBe(262144);
    const boundaryFile = path.join(fixture, "input-boundary.json"); await writeFile(boundaryFile, boundaryInput);
    for (const mode of ["file", "stdin"] as const) {
      const before = records.length;
      const args = ["update", teamCreated.endpoint.id, "--team", hostInfo.teamId, "--if-version", "1", "--confirm", ...(mode === "file" ? ["--file", boundaryFile] : ["--stdin"])];
      const result = await call(args, false, mode === "stdin" ? boundaryInput : undefined);
      expect(result.operation.effect).toBe("unchanged"); expect(result.endpoint.configVersion).toBe("1");
      const writes = records.slice(before).filter(record => record.method === "PATCH");
      expect(writes).toHaveLength(1); expect(writes[0]!.status).toBe(200); expect(writes[0]!.bytes).toBeLessThanOrEqual(262144);
      boundaryInputs.push({ mode, inputBytes: Buffer.byteLength(boundaryInput), inputSha256: digest(Buffer.from(boundaryInput)), requestSha256: writes[0]!.sha256, requestBytes: writes[0]!.bytes, operationId: result.operation.operationId, effect: result.operation.effect });
    }
    const personalList = await call(["list", "--personal"], true);
    const teamList = await call(["list", "--team", hostInfo.teamId]);
    const unrelated = path.join(fixture, "unrelated-git"); await mkdir(unrelated);
    execFileSync("git", ["init", "-q", unrelated], { env, timeout: 10_000 });
    execFileSync("git", ["-C", unrelated, "remote", "add", "origin", "https://example.invalid/unrelated.git"], { env, timeout: 10_000 });
    expect(() => execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: fixture, env, stdio: "ignore", timeout: 10_000 })).toThrow();
    expect(execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: unrelated, env, timeout: 10_000 }).toString().trim()).toBe("true");
    expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: unrelated, env, timeout: 10_000 }).toString().trim()).toBe("https://example.invalid/unrelated.git");
    directoryChecks.push({ cwd: fixture, insideGit: false }, { cwd: unrelated, insideGit: true, origin: "https://example.invalid/unrelated.git" });
    for (const scope of [
      { owner: ["--personal"], endpoint: id, base: "/api/v1/me/webhooks" },
      { owner: ["--team", hostInfo.teamId], endpoint: teamCreated.endpoint.id, base: `/api/v1/teams/${hostInfo.teamId}/webhooks` },
    ]) for (const verb of ["list", "show"] as const) {
      let reference: unknown;
      for (const cwd of [fixture, unrelated]) for (const alias of [false, true]) {
        const before = records.length;
        const args = verb === "list" ? [verb, ...scope.owner] : [verb, scope.endpoint, ...scope.owner];
        const actual = await call(args, alias, undefined, cwd);
        if (reference === undefined) reference = actual; else expect(actual).toEqual(reference);
        const business = records.slice(before).filter(record => record.path.startsWith(scope.base));
        expect(business).toHaveLength(1); expect(business[0]!.method).toBe("GET");
      }
    }
    const adminConfig = await readFile(path.join(config, "config.yml"));
    await writeFile(path.join(config, "config.yml"), `serverUrl: ${origin}\nserverToken: ${member}\n`, { mode: 0o600 });
    const memberView = await call(["show", teamCreated.endpoint.id, "--team", hostInfo.teamId]);
    expect(memberView.destination.url).toBeNull();
    for (const action of ["enable", "delete"]) {
      const before = records.length;
      const denied = await invoke(["webhook", action, teamCreated.endpoint.id, "--team", hostInfo.teamId, "--if-version", "1", "--confirm", "--json"]);
      expect(denied.status).toBe(1); expect(denied.stdout.length).toBe(0);
      const writes = records.slice(before).filter(record => record.method !== "GET");
      expect(writes).toHaveLength(1); expect(writes[0]!.status).toBe(403);
    }
    const deniedSecret = await invoke(["webhook", "secret", "show", teamCreated.endpoint.id, "--team", hostInfo.teamId, "--reveal", "--json"]);
    expect(deniedSecret.status).toBe(1); expect(deniedSecret.stdout.length).toBe(0);
    const deniedOperation = await invoke(["webhook", "operation", "show", teamCreated.operation.operationId, "--team", hostInfo.teamId, "--json"]);
    expect(deniedOperation.status).toBe(1); expect(deniedOperation.stdout.length).toBe(0);
    await writeFile(path.join(config, "config.yml"), adminConfig, { mode: 0o600 });
    expect(await call(["show", teamCreated.endpoint.id, "--team", hostInfo.teamId])).toEqual(teamCreated.endpoint);
    expect(personalList.items.map((item: any) => item.id)).toContain(id);
    expect(teamList.items.map((item: any) => item.id)).toContain(teamCreated.endpoint.id);
    for (let i = 0; i < 50; i++) {
      await control("POST", `/api/v1/teams/${hostInfo.teamId}/webhooks`, { operationId: randomUUID(), issuedAt: new Date().toISOString(), expectedUserId: hostInfo.userId, name: `Paged ${i}`, enabled: false, destination: definition.destination, subscriptions: [] });
    }
    const beforePages = records.length;
    const fullList = await call(["list", "--team", hostInfo.teamId]);
    expect(fullList.items).toHaveLength(51);
    expect(new Set(fullList.items.map((item: any) => item.id)).size).toBe(51);
    expect(records.slice(beforePages).filter(record => record.path.startsWith(`/api/v1/teams/${hostInfo!.teamId}/webhooks`))).toHaveLength(2);
    for (const fault of ["status", "principal"] as const) {
      pageFault = fault;
      const beforeFault = records.length;
      const failedList = await invoke(["webhook", "list", "--team", hostInfo.teamId, "--json"]);
      expect(pageFault).toBeUndefined();
      expect(failedList.status).toBe(1); expect(failedList.stdout.length).toBe(0);
      expect(records.slice(beforeFault).filter(record => record.path.startsWith(`/api/v1/teams/${hostInfo!.teamId}/webhooks`))).toHaveLength(2);
    }
    const pathForPrepared = (expired: boolean): string => path.join(fixture, expired ? "expired-original.json" : "fresh-original.json");
    for (const expired of [false, true]) {
      const originalId = randomUUID();
      const originalTime = new Date(Date.now() - (expired ? 10 * 60_000 : 0)).toISOString();
      const path = pathForPrepared(expired);
      const fileInput = JSON.stringify({ ...definition, name: expired ? "Expired original" : "Resume original", subscriptions: [] });
      const original = ["webhook", "create", "--team", hostInfo.teamId, "--stdin", "--confirm", "--operation-id", originalId, "--issued-at", originalTime, "--operation-out", path, "--json"];
      const beforeUnknown = records.length;
      loseBeforeDispatch = true;
      const unknown = await invoke(original, false, fileInput);
      expect(loseBeforeDispatch).toBe(false); expect(unknown.status).toBe(1);
      expect(JSON.parse(unknown.stderr.toString()).error.operationOutcome).toBe("unknown");
      expect(records.slice(beforeUnknown).filter(record => record.method === "POST" && record.path.endsWith("/webhooks"))).toHaveLength(1);
      expect(records.slice(beforeUnknown).filter(record => record.path.includes("/operations/")).length).toBeLessThanOrEqual(1);
      const beforeRetry = records.length;
      const retry = await invoke(["webhook", "create", "--team", hostInfo.teamId, "--stdin", "--confirm", "--resume-operation", path, "--json"], false, fileInput);
      expect(retry.status).toBe(expired ? 1 : 0);
      expect(records.slice(beforeRetry).filter(record => record.method === "POST" && record.path.endsWith("/webhooks"))).toHaveLength(expired ? 0 : 1);
      if (!expired) expect(JSON.parse(retry.stdout.toString()).operation.operationId).toBe(originalId);
      else expect(JSON.parse(retry.stderr.toString()).error.operationOutcome).toBe("unknown");
    }
    const writesBeforeBadInput = records.filter(record => record.method !== "GET").length;
    const invalidObjectInputs = [
      '{"name":"canary-private","name":"duplicate"}', '{"operationId":"canary-private"}', '{"name":null}', '{"unknown":"canary-private"}',
      '{"name":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}', '{"name":"' + 'x'.repeat(262_090) + '"}',
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    ];
    const invalidArrayInputs = [
      '[{"id":null,"id":null,"projectId":"' + hostInfo.projectId + '","eventTypes":["task.created"]}]',
      '[{"id":null,"projectId":"' + hostInfo.projectId + '","eventTypes":["task.created"],"operationId":"canary-private"}]',
      '[null]', '[{"unknown":"canary-private"}]', '['.repeat(33) + '0' + ']'.repeat(33), '[' + ' '.repeat(262_144) + ']',
      Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]),
    ];
    for (const leaf of ["create", "update", "replace"] as const) for (const mode of ["stdin", "file"] as const) {
      const values = leaf === "replace" ? invalidArrayInputs : invalidObjectInputs;
      for (let index = 0; index < values.length; index++) {
        const source = values[index]!, inputPath = path.join(fixture, `invalid-${leaf}-${mode}-${index}.json`);
        if (mode === "file") await writeFile(inputPath, source);
        const args = leaf === "create" ? ["create"] : leaf === "update" ? ["update", id, "--if-version", "1"] : ["subscription", "replace", id, "--if-version", "1"];
        const refused = await invoke(["webhook", ...args, "--personal", ...(mode === "file" ? ["--file", inputPath] : ["--stdin"]), "--confirm", "--json"], false, mode === "stdin" ? source : undefined);
        expect(refused.status).not.toBe(0); expect(refused.stdout.length).toBe(0);
        expect(refused.stderr.toString()).not.toContain("canary-private");
      }
    }
    if (process.platform !== "win32") {
      const fifo = path.join(fixture, "input.fifo");
      execFileSync("mkfifo", [fifo], { timeout: 2_000 });
      for (const special of [fifo, "/dev/null"]) for (const leaf of ["create", "update", "replace"] as const) {
        const args = leaf === "create" ? ["create"] : leaf === "update" ? ["update", id, "--if-version", "1"] : ["subscription", "replace", id, "--if-version", "1"];
        const refused = await invoke(["webhook", ...args, "--personal", "--file", special, "--confirm", "--json"]);
        expect(refused.status).not.toBe(0); expect(refused.stdout.length).toBe(0);
      }
    }
    expect(records.filter(record => record.method !== "GET")).toHaveLength(writesBeforeBadInput);
    if (process.platform !== "win32") {
      const beforeCancellation = records.length;
      const child = spawn(receipt.launcherPath, ["webhook", "update", id, "--personal", "--stdin", "--if-version", "1", "--confirm", "--json"], { cwd: fixture, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [], err: Buffer[] = [];
      child.stdout!.on("data", (part: Buffer) => out.push(part)); child.stderr!.on("data", (part: Buffer) => err.push(part));
      const closed = new Promise<number | null>(resolve => child.once("close", code => { children.delete(child); resolve(code); })); children.set(child, closed);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        child.stdin!.write('{"name":"unfinished');
        for (let i = 0; i < 100 && !records.slice(beforeCancellation).some(record => record.path === "/api/v1/me"); i++) await new Promise(resolve => setTimeout(resolve, 50));
        expect(records.slice(beforeCancellation).some(record => record.path === "/api/v1/me")).toBe(true);
        child.kill("SIGINT");
        const status = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10_000); })]);
        if (status === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Cancelled webhook input did not exit."); }
        calls.push({ args: ["webhook", "update", id, "--personal", "--stdin", "--if-version", "1", "--confirm", "--json", "[SIGINT while stdin open]"], alias: false, cwd: fixture, closeOutput: false, injectedFiles: false, status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
        expect(status).toBe(1); expect(Buffer.concat(out).length).toBe(0);
        expect(records.slice(beforeCancellation).filter(record => record.method === "PATCH")).toHaveLength(0);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    const lostPrepared = path.join(fixture, "lost-prepared.json");
    const beforeLoss = records.length;
    loseNextWriteResponse = { method: "PATCH", path: `/api/v1/me/webhooks/${id}` };
    const lost = await invoke(["webhook", "update", id, "--personal", "--stdin", "--if-version", "1", "--confirm", "--operation-out", lostPrepared, "--json"], false, JSON.stringify({ name: "Loss fixture" }));
    const lostRequests = records.slice(beforeLoss);
    expect(lostRequests.filter(record => record.method === "PATCH")).toHaveLength(1);
    expect(lostRequests.filter(record => record.path.includes("/operations/")).length).toBeLessThanOrEqual(1);
    expect(loseNextWriteResponse).toBeUndefined();
    const lostIdentity = JSON.parse((await readFile(lostPrepared)).toString());
    const observed = await call(["operation", "show", lostIdentity.operationId, "--personal"]);
    expect(observed.requestSha256).toBe(lostIdentity.requestSha256);
    if (lost.status !== 0) {
      const error = JSON.parse(lost.stderr.toString()).error;
      expect(["unknown", "confirmed"]).toContain(error.operationOutcome);
    }
    const beforeResume = records.length;
    const recovered = await call(["update", id, "--personal", "--stdin", "--if-version", "1", "--confirm", "--resume-operation", lostPrepared], false, JSON.stringify({ name: "Loss fixture" }));
    expect(recovered.operation.operationId).toBe(lostIdentity.operationId);
    expect(records.slice(beforeResume).filter(record => record.method === "PATCH")).toHaveLength(0);
    const originalPrepared = await readFile(lostPrepared);
    const beforeMismatch = records.length;
    const mismatch = await invoke(["webhook", "update", id, "--personal", "--stdin", "--if-version", "1", "--confirm", "--resume-operation", lostPrepared, "--json"], false, JSON.stringify({ name: "Different fixture" }));
    expect(mismatch.status).toBe(1); expect(mismatch.stdout.length).toBe(0);
    expect(JSON.parse(mismatch.stderr.toString()).error.operationOutcome).toBe("unknown");
    expect(records.slice(beforeMismatch).filter(record => record.method === "PATCH")).toHaveLength(0);
    expect(await readFile(lostPrepared)).toEqual(originalPrepared);
    receiptHashFault = true;
    const beforeHashMismatch = records.length;
    const receiptMismatch = await invoke(["webhook", "update", id, "--personal", "--stdin", "--if-version", "1", "--confirm", "--resume-operation", lostPrepared, "--json"], false, JSON.stringify({ name: "Loss fixture" }));
    expect(receiptHashFault).toBe(false); expect(receiptMismatch.status).toBe(1); expect(receiptMismatch.stdout.length).toBe(0);
    expect(JSON.parse(receiptMismatch.stderr.toString()).error.operationOutcome).toBe("unknown");
    expect(records.slice(beforeHashMismatch).filter(record => record.method === "PATCH")).toHaveLength(0);
    for (const scenario of ["401", "401-no-principal", "403", "503"] as const) {
      const status = Number(scenario.slice(0, 3)) as 401 | 403 | 503;
      receiptFailureStatus = status; strip401Principal = scenario === "401-no-principal";
      const beforeFailure = records.length;
      const refused = await invoke(["webhook", "update", id, "--personal", "--stdin", "--if-version", "1", "--confirm", "--resume-operation", lostPrepared, "--json"], false, JSON.stringify({ name: "Loss fixture" }));
      expect(receiptFailureStatus).toBeUndefined(); expect(strip401Principal).toBe(false); expect(refused.status).toBe(1); expect(refused.stdout.length).toBe(0);
      expect(JSON.parse(refused.stderr.toString()).error.operationOutcome).toBe("unknown");
      expect(records.slice(beforeFailure).filter(record => record.method === "PATCH")).toHaveLength(0);
    }
    const shown = await call(["show", id, "--personal"]);
    expect(shown.id).toBe(id);
    const unchanged = await call(["update", id, "--personal", "--stdin", "--if-version", shown.configVersion, "--confirm"], false, JSON.stringify({ name: "Loss fixture" }));
    expect(unchanged.operation.effect).toBe("unchanged"); expect(unchanged.endpoint.configVersion).toBe(shown.configVersion); expect(unchanged.endpoint.updatedAt).toBe(shown.updatedAt);
    const beforeStale = records.length;
    const stale = await invoke(["webhook", "update", id, "--personal", "--stdin", "--if-version", "1", "--confirm", "--json"], false, JSON.stringify({ name: "Loss fixture" }));
    expect(stale.status).toBe(1); expect(stale.stdout.length).toBe(0);
    expect(records.slice(beforeStale).find(record => record.method === "PATCH")?.status).toBe(409);
    const subs = await call(["subscription", "list", id, "--personal"]);
    expect(subs.subscriptions).toHaveLength(1);
    const secret = await call(["secret", "show", id, "--personal"]);
    expect(secret.signing).toBeDefined(); expect(secret.secret).toBeUndefined();
    const revealed = await call(["secret", "show", id, "--personal", "--reveal"]);
    expect(revealed.secret).toBeTruthy(); sensitive.push(revealed.secret);
    const operation = await call(["operation", "show", created.operation.operationId, "--personal"]);
    expect(operation.requestSha256).toBe(write.sha256);
    const resumed = await call(["create", "--personal", "--file", inputFile, "--confirm", "--resume-operation", prepared]);
    expect(resumed.operation.operationId).toBe(created.operation.operationId);
    expect(records.filter(r => r.method === "POST" && r.path === "/api/v1/me/webhooks" && r.sha256 === write.sha256)).toHaveLength(1);
    const replacement = subs.subscriptions.map((s: any) => ({ id: s.id, projectId: s.projectId, eventTypes: s.eventTypes }));
    const endpointPath = `/api/v1/me/webhooks/${id}`;
    const replaced = await reconcileLost(["subscription", "replace", id, "--personal", "--stdin", "--if-version", shown.configVersion, "--confirm"], "PATCH", endpointPath, "lost-replace.json", JSON.stringify(replacement));
    let version = replaced.operation.configVersionAfter as string;
    const reconfirmed = await reconcileLost(["subscription", "reconfirm", id, "--personal", "--project", hostInfo.projectId, "--if-version", version, "--confirm"], "PATCH", endpointPath, "lost-reconfirm.json");
    version = reconfirmed.operation.configVersionAfter;
    const rotatePrepared = path.join(fixture, "lost-rotate.json");
    const rotateArgs = ["secret", "rotate", id, "--personal", "--mode", "immediate", "--if-version", version, "--confirm"];
    const beforeRotate = records.length;
    loseNextWriteResponse = { method: "POST", path: `/api/v1/me/webhooks/${id}/signing-secret/rotations` };
    await invoke(["webhook", ...rotateArgs, "--operation-out", rotatePrepared, "--json"]);
    expect(loseNextWriteResponse).toBeUndefined();
    expect(records.slice(beforeRotate).filter(record => record.method === "POST")).toHaveLength(1);
    const rotateIdentity = JSON.parse((await readFile(rotatePrepared)).toString());
    const beforeRotateResume = records.length;
    const rotated = await call([...rotateArgs, "--resume-operation", rotatePrepared]);
    expect(rotated.operation.operationId).toBe(rotateIdentity.operationId);
    expect(records.slice(beforeRotateResume).filter(record => record.method === "POST")).toHaveLength(0);
    version = rotated.operation.configVersionAfter;
    const disabled = await reconcileLost(["disable", id, "--personal", "--if-version", version, "--confirm"], "PATCH", endpointPath, "lost-disable.json");
    const enabled = await reconcileLost(["enable", id, "--personal", "--if-version", disabled.operation.configVersionAfter, "--confirm"], "PATCH", endpointPath, "lost-enable.json");
    const updated = await call(["update", id, "--personal", "--stdin", "--if-version", enabled.operation.configVersionAfter, "--confirm"], false, JSON.stringify({ name: "Updated fixture" }));
    version = updated.endpoint.configVersion;
    for (let i = 0; i < 3; i++) await control("POST", `/api/v1/projects/${hostInfo.projectId}/tasks`, { title: `Webhook source ${i}` });
    const beforeHistory = records.length;
    const deliveries = await call(["delivery", "list", id, "--personal", "--limit", "1", "--event-type", "task.created", "--project", hostInfo.projectId]);
    expect(deliveries.items).toHaveLength(1);
    expect(deliveries.nextCursor).toBeTruthy();
    expect(records.slice(beforeHistory).filter(record => record.path.includes("/deliveries"))).toHaveLength(1);
    const nextPage = await call(["delivery", "list", id, "--personal", "--limit", "1", "--event-type", "task.created", "--project", hostInfo.projectId, "--cursor", deliveries.nextCursor]);
    expect(nextPage.items).toHaveLength(1); expect(nextPage.items[0].id).not.toBe(deliveries.items[0].id);
    expect(nextPage.nextCursor).toBeTruthy();
    const thirdPage = await call(["delivery", "list", id, "--personal", "--limit", "1", "--event-type", "task.created", "--project", hostInfo.projectId, "--cursor", nextPage.nextCursor]);
    expect(thirdPage.items).toHaveLength(1);
    const deliveryId = deliveries.items[0].id as string;
    const delivery = await call(["delivery", "show", id, deliveryId, "--personal"]);
    const attempts = await call(["attempt", "list", id, deliveryId, "--personal"]);
    expect(attempts.items).toEqual([]);
    const payload = await call(["delivery", "payload", id, deliveryId, "--personal"]);
    const raw = await invoke(["webhook", "delivery", "payload", id, deliveryId, "--personal"]);
    expect(raw.status).toBe(0); expect(raw.stderr.length).toBe(0);
    expect(raw.stdout).toEqual(Buffer.from(payload.body, "base64"));
    expect(digest(raw.stdout)).toBe(payload.sha256); expect(raw.stdout.at(-1)).not.toBe(10);
    const beforeExclusive = records.length;
    const both = await invoke(["webhook", "delivery", "payload", id, deliveryId, "--personal", "--json", "--output", path.join(fixture, "impossible.bin")]);
    expect(both.status).toBe(2); expect(both.stdout.length).toBe(0);
    expect(records.slice(beforeExclusive).filter(record => record.path.endsWith("/payload"))).toHaveLength(0);
    for (const fault of ["base64", "bytes", "hash", "media", "encoding", "owner", "endpoint", "delivery", "event", "oversize", "over-1m"]) {
      for (const outputMode of ["raw", "json", "file"] as const) {
        const target = path.join(fixture, `invalid-${fault}.bin`);
        payloadFault = fault;
        const beforePayloadFault = records.length;
        const option = outputMode === "json" ? ["--json"] : outputMode === "file" ? ["--output", target] : [];
        const damaged = await invoke(["webhook", "delivery", "payload", id, deliveryId, "--personal", ...option]);
        expect(payloadFault).toBeUndefined(); expect(damaged.status).toBe(1); expect(damaged.stdout.length).toBe(0);
        expect(records.slice(beforePayloadFault).filter(record => record.path.endsWith("/payload"))).toHaveLength(1);
        if (outputMode === "file") await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
    payloadFault = "boundary";
    const boundary = await invoke(["webhook", "delivery", "payload", id, deliveryId, "--personal"]);
    expect(payloadFault).toBeUndefined(); expect(boundary.status).toBe(0); expect(boundary.stderr.length).toBe(0);
    expect(boundary.stdout).toEqual(Buffer.alloc(65536, 7));
    if (process.platform !== "win32") {
      const preload = path.join(fixture, "file-fault.cjs");
      await writeFile(preload, `const fs=require('node:fs'), p=require('node:fs/promises'), m=require('node:module');
const open=p.open, unlink=p.unlink;
const entry=m.createRequire(${JSON.stringify(receipt.entryPath)}).resolve('koffi');
const original=require('node:url').pathToFileURL(require('node:path').join(require('node:path').dirname(entry),'index.js')).href;
const wrapper=["import {load as realLoad} from "+JSON.stringify(original)+";", "import fs from 'node:fs';", "export function load(...a) { const lib=realLoad(...a); return {func(...fargs) { const call=lib.func(...fargs); return (...args)=>{ const name=String(args[3]); if(name.includes('fault-race')) fs.writeFileSync('/proc/self/fd/'+args[2]+'/'+name,'concurrent occupant',{flag:'wx',mode:0o600}); if(name.includes('fault-replaced')) { const source=fs.readlinkSync(args[1]); fs.renameSync(source,source+'.moved'); fs.writeFileSync(source,'replacement bytes',{flag:'wx',mode:0o600}); } if(name.includes('fault-cleanup')) return -1; return call(...args); }; }}; }"] .join('\\n');
m.registerHooks({resolve(specifier,context,next) { if(specifier==='koffi') return {url:'data:text/javascript,'+encodeURIComponent(wrapper),shortCircuit:true}; return next(specifier,context); }});
p.open=async function(path,...args) { const f=await open.call(this,path,...args); const name=String(path); if (name.includes('fault-write') || name.includes('fault-close') || name.includes('fault-cancel')) { if(name.includes('fault-cancel')) { const close=f.close.bind(f); f.close=async()=>{ await close(); process.kill(process.pid,'SIGINT'); await new Promise(resolve=>setTimeout(resolve,25)); }; } else if(name.includes('fault-write')) { const write=f.writeFile.bind(f); f.writeFile=async (...a)=>{ await write(Buffer.from('partial')); throw new Error('injected file write failure'); }; } else { const close=f.close.bind(f); f.close=async()=>{ await close(); throw new Error('injected file close failure'); }; } } return f; };
p.unlink=async function(path) { if(String(path).includes('fault-cleanup')) { const e=new Error('injected cleanup failure'); e.code='EACCES'; throw e; } return unlink.call(this,path); };
m.syncBuiltinESMExports();
`, { mode: 0o600 });
      for (const kind of ["write", "close", "race", "cleanup", "replaced"]) {
        const target = path.join(fixture, `fault-${kind}.bin`);
        const fault = await invoke(["webhook", "delivery", "payload", id, deliveryId, "--personal", "--output", target], false, undefined, false, preload);
        expect(fault.status).toBe(1); expect(fault.stdout.length).toBe(0);
        if (kind === "race") expect(await readFile(target, "utf8")).toBe("concurrent occupant");
        else if (kind === "replaced") expect(await readFile(target)).toEqual(raw.stdout);
        else await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
        const temporaries = (await readdir(fixture)).filter(name => name.startsWith(`.fault-${kind}.bin.`));
        if (kind === "cleanup" || kind === "replaced") {
          expect(temporaries).toHaveLength(kind === "cleanup" ? 1 : 2);
          expect(fault.stderr.toString()).toContain(`.fault-${kind}.bin.`);
          for (const temporary of temporaries) await unlink(path.join(fixture, temporary));
        } else expect(temporaries).toHaveLength(0);
      }
      const failedPrepared = path.join(fixture, "fault-close-prepared.json");
      const beforePrepareFailure = records.length;
      const prepareFailure = await invoke(["webhook", "create", "--personal", "--file", inputFile, "--confirm", "--operation-out", failedPrepared, "--json"], false, undefined, false, preload);
      expect(prepareFailure.status).toBe(1); expect(prepareFailure.stdout.length).toBe(0);
      expect(records.slice(beforePrepareFailure).filter(record => record.method === "POST")).toHaveLength(0);
      await expect(readFile(failedPrepared)).rejects.toMatchObject({ code: "ENOENT" });
      const cancelledPrepared = path.join(fixture, "fault-cancel-prepared.json");
      const beforeDispatchCancel = records.length;
      const cancelled = await invoke(["webhook", "create", "--personal", "--file", inputFile, "--confirm", "--operation-out", cancelledPrepared, "--json"], false, undefined, false, preload);
      expect(cancelled.status).toBe(1); expect(cancelled.stdout.length).toBe(0);
      const cancellationError = JSON.parse(cancelled.stderr.toString()).error;
      expect(cancellationError.invocationOutcome).toBe("not_submitted"); expect(cancellationError.operationOutcome).toBeNull();
      expect(records.slice(beforeDispatchCancel).filter(record => record.method === "POST")).toHaveLength(0);
    }
    const output = path.join(fixture, "payload.bin");
    const exported = await invoke(["webhook", "delivery", "payload", id, deliveryId, "--personal", "--output", output]);
    expect(exported.status).toBe(0); expect(exported.stdout.length).toBe(0); expect(await readFile(output)).toEqual(raw.stdout);
    if (process.platform !== "win32") expect((await stat(output)).mode & 0o777).toBe(0o600);
    const existingOutput = await invoke(["webhook", "delivery", "payload", id, deliveryId, "--personal", "--output", output]);
    expect(existingOutput.status).toBe(1); expect(existingOutput.stdout.length).toBe(0); expect(await readFile(output)).toEqual(raw.stdout);
    if (process.platform !== "win32") {
      const outputLink = path.join(fixture, "payload-link"); await symlink(output, outputLink);
      const existingLink = await invoke(["webhook", "delivery", "payload", id, deliveryId, "--personal", "--output", outputLink]);
      expect(existingLink.status).toBe(1); expect(existingLink.stdout.length).toBe(0); expect(await readFile(output)).toEqual(raw.stdout);
    }
    await control("POST", "/__fixture/runner/start");
    let receiver: any[] = [];
    for (let i = 0; i < 80 && !receiver.some(item => Buffer.from(item.body, "base64").equals(raw.stdout)); i++) {
      receiver = await control("GET", "/__fixture/receiver");
      if (!receiver.some(item => Buffer.from(item.body, "base64").equals(raw.stdout))) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(receiver.some(item => Buffer.from(item.body, "base64").equals(raw.stdout))).toBe(true);
    const thirdPayload = await call(["delivery", "payload", id, thirdPage.items[0].id, "--personal"]);
    const thirdBytes = Buffer.from(thirdPayload.body, "base64");
    for (let i = 0; i < 80 && !receiver.some(item => Buffer.from(item.body, "base64").equals(thirdBytes)); i++) {
      receiver = await control("GET", "/__fixture/receiver");
      if (!receiver.some(item => Buffer.from(item.body, "base64").equals(thirdBytes))) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(receiver.some(item => Buffer.from(item.body, "base64").equals(thirdBytes))).toBe(true);
    let thirdBefore = await call(["delivery", "show", id, thirdPage.items[0].id, "--personal"]);
    for (let i = 0; i < 80 && thirdBefore.lastAcknowledgedAt === null; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      thirdBefore = await call(["delivery", "show", id, thirdPage.items[0].id, "--personal"]);
    }
    expect(thirdBefore.lastAcknowledgedAt).not.toBeNull();
    await control("PUT", "/__fixture/receiver/status", { status: 503 });
    const laterRegistered = await call(["delivery", "redeliver", id, thirdPage.items[0].id, "--personal", "--if-version", version, "--if-generation", thirdBefore.generation, "--confirm"]);
    const thirdGeneration = laterRegistered.operation.generationAfter as string;
    for (let i = 0; i < 80 && !receiver.some(item => item.status === 503 && Buffer.from(item.body, "base64").equals(thirdBytes)); i++) {
      receiver = await control("GET", "/__fixture/receiver");
      if (!receiver.some(item => item.status === 503 && Buffer.from(item.body, "base64").equals(thirdBytes))) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(receiver.some(item => item.status === 503 && Buffer.from(item.body, "base64").equals(thirdBytes))).toBe(true);
    await control("POST", "/__fixture/runner/stop");
    const laterFailure = await call(["delivery", "show", id, thirdPage.items[0].id, "--personal"]);
    expect(laterFailure.lastAcknowledgedAt).toBe(thirdBefore.lastAcknowledgedAt);
    expect(laterFailure.lastResult.category).toBe("http_error"); expect(laterFailure.lastResult.httpStatus).toBe(503);
    const finalDelivery = await call(["delivery", "show", id, deliveryId, "--personal"]);
    expect(finalDelivery.lastAcknowledgedAt).not.toBeNull();
    expect(finalDelivery.generation).toBe(delivery.generation);
    const finalAttempts = await call(["attempt", "list", id, deliveryId, "--personal", "--generation", delivery.generation, "--limit", "1"]);
    expect(finalAttempts.items).toHaveLength(1);
    expect(finalAttempts.items[0].outcome).toBe("acknowledged");
    expect(finalAttempts.items[0].httpStatus).toBe(202);
    const finalEndpoints = await call(["list", "--personal"]);
    const summary = finalEndpoints.items.find((item: any) => item.id === id);
    expect(summary.lastAttemptAt).not.toBeNull();
    expect(summary.lastResult.category).toBe("http_error"); expect(summary.lastResult.httpStatus).toBe(503);
    const paused = await call(["disable", id, "--personal", "--if-version", version, "--confirm"]);
    const beforePaused = records.length;
    const refusedPaused = await invoke(["webhook", "delivery", "redeliver", id, deliveryId, "--personal", "--if-version", paused.endpoint.configVersion, "--if-generation", delivery.generation, "--confirm", "--json"]);
    expect(refusedPaused.status).toBe(1); expect(refusedPaused.stdout.length).toBe(0);
    expect(records.slice(beforePaused).find(record => record.method === "POST" && record.path.endsWith("/redeliveries"))?.status).toBe(409);
    const reenabled = await call(["enable", id, "--personal", "--if-version", paused.endpoint.configVersion, "--confirm"]);
    version = reenabled.endpoint.configVersion;
    const beforeReject = records.length;
    const rejected = await invoke(["webhook", "delivery", "redeliver", id, deliveryId, "--personal", "--if-version", version, "--if-generation", "999", "--confirm", "--json"]);
    expect(rejected.status).toBe(1); expect(rejected.stdout.length).toBe(0);
    expect(records.slice(beforeReject).filter(record => record.method === "POST" && record.path.endsWith("/redeliveries"))).toHaveLength(1);
    const stillOriginal = await call(["delivery", "show", id, deliveryId, "--personal"]);
    expect(stillOriginal.generation).toBe(delivery.generation);
    expect(stillOriginal.manualOperationCount).toBe(0);
    const redeliveryPrepared = path.join(fixture, "redelivery.json");
    const redeliveryArgs = ["delivery", "redeliver", id, deliveryId, "--personal", "--if-version", version, "--if-generation", delivery.generation, "--confirm"];
    const beforeRedelivery = records.length;
    loseNextWriteResponse = { method: "POST", path: `/api/v1/me/webhooks/${id}/deliveries/${deliveryId}/redeliveries` };
    await invoke(["webhook", ...redeliveryArgs, "--operation-out", redeliveryPrepared, "--json"]);
    expect(loseNextWriteResponse).toBeUndefined();
    expect(records.slice(beforeRedelivery).filter(record => record.method === "POST" && record.path.endsWith("/redeliveries"))).toHaveLength(1);
    const redeliveryIdentity = JSON.parse((await readFile(redeliveryPrepared)).toString());
    const beforeRedeliveryResume = records.length;
    const redeliveryResume = await call([...redeliveryArgs, "--resume-operation", redeliveryPrepared]);
    expect(redeliveryResume.operation.operationId).toBe(redeliveryIdentity.operationId);
    expect(redeliveryResume.operation.deliveryId).toBe(deliveryId);
    expect(records.slice(beforeRedeliveryResume).filter(record => record.method === "POST" && record.path.endsWith("/redeliveries"))).toHaveLength(0);
    const afterRedelivery = await call(["delivery", "show", id, deliveryId, "--personal"]);
    expect(afterRedelivery.manualOperationCount).toBe(1);
    const members = await control("GET", `/api/v1/teams/${hostInfo.teamId}/members`);
    const memberBefore = members.items.find((item: any) => item.userId === hostInfo!.memberId);
    const adminBefore = members.items.find((item: any) => item.userId === hostInfo!.userId);
    expect(memberBefore).toBeDefined(); expect(adminBefore).toBeDefined();
    await control("PATCH", `/api/v1/teams/${hostInfo.teamId}/members/${hostInfo.memberId}`, { version: memberBefore.version, role: "admin", expectedUserId: hostInfo.userId });
    await control("DELETE", `/api/v1/teams/${hostInfo.teamId}/members/${hostInfo.userId}`, { version: adminBefore.version, expectedUserId: hostInfo.memberId }, member);
    const revokedView = await call(["delivery", "show", id, thirdPage.items[0].id, "--personal"]);
    expect(revokedView.disclosure).toBe("metadata_only"); expect(revokedView.resource.projectId).toBeNull();
    const revokedPayload = await invoke(["webhook", "delivery", "payload", id, thirdPage.items[0].id, "--personal"]);
    expect(revokedPayload.status).toBe(1); expect(revokedPayload.stdout.length).toBe(0);
    const revokedRedelivery = await invoke(["webhook", "delivery", "redeliver", id, thirdPage.items[0].id, "--personal", "--if-version", version, "--if-generation", thirdGeneration, "--confirm", "--json"]);
    expect(revokedRedelivery.status).toBe(1); expect(revokedRedelivery.stdout.length).toBe(0);
    const invitation = await control("POST", `/api/v1/teams/${hostInfo.teamId}/invitations`, { expectedUserId: hostInfo.memberId }, member);
    const invitationSecret = new URL(invitation.link).hash.slice(1); sensitive.push(invitationSecret);
    await control("POST", "/api/v1/team-invitations/accept", { token: invitationSecret, expectedUserId: hostInfo.userId });
    const regained = await call(["subscription", "list", id, "--personal"]);
    expect(regained.subscriptions[0].eligibility).toBe("confirmation_required");
    const reconfirmAfterRegain = await call(["subscription", "reconfirm", id, "--personal", "--project", hostInfo.projectId, "--if-version", version, "--confirm"]);
    version = reconfirmAfterRegain.endpoint.configVersion;
    const oldProof = await invoke(["webhook", "delivery", "redeliver", id, thirdPage.items[0].id, "--personal", "--if-version", version, "--if-generation", thirdGeneration, "--confirm", "--json"]);
    expect(oldProof.status).toBe(1); expect(oldProof.stdout.length).toBe(0);
    const aged = await ageDelivery(nextPage.items[0].id, 8);
    expect(aged).toEqual({ retainedBody: true, payloadExpired: true, metadataExpired: false });
    const beforeExpired = records.length;
    const expiredPayload = await invoke(["webhook", "delivery", "payload", id, nextPage.items[0].id, "--personal", "--json"]);
    expect(expiredPayload.status).toBe(1); expect(expiredPayload.stdout.length).toBe(0);
    const expiredRequest = records.slice(beforeExpired).find(record => record.path.endsWith("/payload"));
    expect(expiredRequest?.status).toBe(410);
    const expiredError = JSON.parse(expiredPayload.stderr.toString()).error;
    expect(expiredError.code).toBe("payload_expired");
    expect(expiredError.requestId).toBe(expiredRequest?.headers["x-request-id"]);
    const expiredRedelivery = await invoke(["webhook", "delivery", "redeliver", id, nextPage.items[0].id, "--personal", "--if-version", version, "--if-generation", nextPage.items[0].generation, "--confirm", "--json"]);
    expect(expiredRedelivery.status).toBe(1); expect(expiredRedelivery.stdout.length).toBe(0);
    const agedMetadata = await ageDelivery(thirdPage.items[0].id, 31);
    expect(agedMetadata).toEqual({ retainedBody: true, payloadExpired: true, metadataExpired: true });
    const beforeExpiredMetadata = records.length;
    const hiddenExpired = await invoke(["webhook", "delivery", "show", id, thirdPage.items[0].id, "--personal", "--json"]);
    expect(hiddenExpired.status).toBe(1); expect(hiddenExpired.stdout.length).toBe(0);
    expect(records.slice(beforeExpiredMetadata).find(record => record.path.endsWith(thirdPage.items[0].id))?.status).toBe(404);
    await control("DELETE", `/api/v1/projects/${hostInfo.projectId}/tasks/${delivery.resource.taskId}`, { version: 1 });
    const hidden = await call(["delivery", "show", id, deliveryId, "--personal"]);
    expect(hidden.disclosure).toBe("metadata_only");
    expect(hidden.resource.taskId).toBeNull(); expect(hidden.resource.displayName).toBeNull();
    expect(hidden.eventType).toBeNull(); expect(hidden.payloadAvailable).toBe(false);
    const deniedPayload = await invoke(["webhook", "delivery", "payload", id, deliveryId, "--personal"]);
    expect(deniedPayload.status).toBe(1); expect(deniedPayload.stdout.length).toBe(0);
    const deniedRedelivery = await invoke(["webhook", "delivery", "redeliver", id, deliveryId, "--personal", "--if-version", version, "--if-generation", afterRedelivery.generation, "--confirm", "--json"]);
    expect(deniedRedelivery.status).toBe(1); expect(deniedRedelivery.stdout.length).toBe(0);
    await setLargeVersion(id);
    const large = await call(["show", id, "--personal"]);
    expect(large.configVersion).toBe("9007199254740993");
    const beforeLarge = records.length;
    const largeUpdate = await call(["update", id, "--personal", "--stdin", "--if-version", large.configVersion, "--confirm"], false, JSON.stringify({ name: "Precise version" }));
    expect(largeUpdate.endpoint.configVersion).toBe("9007199254740994");
    const largeCalls = records.slice(beforeLarge).filter(record => record.path.startsWith(`/api/v1/me/webhooks/${id}`));
    expect(largeCalls).toHaveLength(1); expect(largeCalls[0]!.method).toBe("PATCH");
    expect(JSON.parse(largeCalls[0]!.body.toString()).ifVersion).toBe("9007199254740993");
    const beforeLargeUnchanged = records.length;
    const largeUnchanged = await call(["update", id, "--personal", "--stdin", "--if-version", largeUpdate.endpoint.configVersion, "--confirm"], false, JSON.stringify({ name: "Precise version" }));
    expect(largeUnchanged.operation.effect).toBe("unchanged");
    expect(largeUnchanged.endpoint.configVersion).toBe("9007199254740994");
    expect(largeUnchanged.endpoint.updatedAt).toBe(largeUpdate.endpoint.updatedAt);
    const unchangedWrites = records.slice(beforeLargeUnchanged).filter(record => record.path.startsWith(`/api/v1/me/webhooks/${id}`));
    expect(unchangedWrites).toHaveLength(1); expect(unchangedWrites[0]!.method).toBe("PATCH");
    expect(JSON.parse(unchangedWrites[0]!.body.toString()).ifVersion).toBe("9007199254740994");
    const beforeLargeStale = records.length;
    const largeStale = await invoke(["webhook", "update", id, "--personal", "--stdin", "--if-version", "9007199254740993", "--confirm", "--json"], false, JSON.stringify({ name: "Precise version" }));
    expect(largeStale.status).toBe(1); expect(largeStale.stdout.length).toBe(0);
    expect(records.slice(beforeLargeStale).find(record => record.method === "PATCH")?.status).toBe(409);
    version = largeUpdate.endpoint.configVersion;
    const deleted = await call(["delete", id, "--personal", "--if-version", version, "--confirm"]);
    expect(deleted.endpoint.lifecycle).toBe("deleted");
    expect(Object.keys(deleted.endpoint).sort()).toEqual(["configVersion", "deletedAt", "id", "lifecycle", "owner"].sort());
    const beforeRevive = records.length;
    const revive = await invoke(["webhook", "enable", id, "--personal", "--if-version", deleted.endpoint.configVersion, "--confirm", "--json"]);
    expect(revive.status).toBe(1); expect(revive.stdout.length).toBe(0);
    const reviveWrites = records.slice(beforeRevive).filter(record => record.method === "PATCH");
    expect(reviveWrites).toHaveLength(1); expect(reviveWrites[0]!.status).toBeGreaterThanOrEqual(400);
    expect(await call(["show", id, "--personal"])).toEqual(deleted.endpoint);
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); }
  if (hostInfo !== undefined) try { await control("POST", "/__fixture/shutdown"); } catch (cause) { cleanup.push(cause); }
  if (host !== undefined && hostClosed !== undefined) try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([hostClosed.then(() => "closed"), new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10_000); })]);
      if (result === "timeout") await terminateInstalledProcess(host, hostClosed);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  } catch (cause) { cleanup.push(cause); }
  try { proxy.closeAllConnections(); if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  if (process.env.DAYNIGHT_WEBHOOK_EVIDENCE !== undefined) try {
    const evidence = process.env.DAYNIGHT_WEBHOOK_EVIDENCE;
    if (!path.isAbsolute(evidence)) throw new Error("Webhook evidence path must be absolute.");
    const safeBytes = (bytes: Buffer, withhold = false) => {
      const secret = withhold || sensitive.some(marker => bytes.includes(Buffer.from(marker)));
      return { length: bytes.length, sha256: digest(bytes), base64: secret ? null : bytes.toString("base64"), withheld: secret };
    };
    const material = {
      source: receipt.source, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256 },
      fixture: { ...hostInfo, originalHostSha256: originalHostHash, adaptedHostSha256: adaptedHostHash, adapter: "copy of T05 fixture with production httpx.RequestLogging around mux" }, passed: failure === undefined && cleanup.length === 0, cleanupErrors: cleanup.length,
      faults: faults.map(fault => ({ ...fault, ...(fault.response === undefined ? {} : { response: safeBytes(fault.response) }) })), databaseChecks, createDatabaseChecks, boundaryInputs, directoryChecks,
      terminals: terminals.map(terminal => ({ answer: terminal.answer, exitCode: terminal.exitCode, prompt: safeBytes(Buffer.from(terminal.prompt)), output: safeBytes(Buffer.from(terminal.output)) })),
      requests: records.map(record => ({ ...record, body: safeBytes(record.body), response: safeBytes(Buffer.concat(record.response), record.path.endsWith("/signing-secret")) })),
      controls: controls.map(record => ({ ...record, body: safeBytes(record.body, record.path.includes("invitations")), response: safeBytes(record.response, record.path.includes("invitations")) })),
      calls: calls.map(call => ({ args: call.args, alias: call.alias, cwd: call.cwd, closeOutput: call.closeOutput, injectedFiles: call.injectedFiles, status: call.status, stdout: safeBytes(call.stdout, call.args.includes("--reveal")), stderr: safeBytes(call.stderr) })),
    };
    await writeFile(evidence, `${JSON.stringify(material, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (cause) { cleanup.push(cause); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Webhook real acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 300_000);

it("exposes webhook help through both installed launchers without credentials", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const fixture = path.join(receipt.root, "webhook-help");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete env[key];
  Object.assign(env, { HOME: fixture, USERPROFILE: fixture, DN_CONFIG_DIR: path.join(fixture, "config"), NO_COLOR: "1" });
  const leaves = [
    [], ["catalog"], ["list"], ["show"], ["create"], ["update"], ["enable"], ["disable"], ["delete"],
    ["subscription", "list"], ["subscription", "replace"], ["subscription", "reconfirm"],
    ["secret", "show"], ["secret", "rotate"], ["delivery", "list"], ["delivery", "show"],
    ["delivery", "payload"], ["delivery", "redeliver"], ["attempt", "list"], ["operation", "show"],
  ];
  let failure: unknown;
  const observations: { launcher: string; leaf: string[]; status: number | null; stdout: string; stderr: string }[] = [];
  try {
    await mkdir(fixture, { recursive: true });
    for (const name of ["daynight", "dn"]) {
      const launcher = path.join(path.dirname(receipt.launcherPath), process.platform === "win32" ? `${name}.cmd` : name);
      for (const leaf of leaves) {
        const child = crossSpawn(launcher, ["webhook", ...leaf, "--help"], { cwd: fixture, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [], err: Buffer[] = [];
        child.stdout!.on("data", (value: Buffer) => out.push(value)); child.stderr!.on("data", (value: Buffer) => err.push(value));
        let launchError: unknown; child.once("error", cause => { launchError = cause; });
        const closed = new Promise<number | null>(resolve => child.once("close", resolve));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const code = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10_000); })]);
          if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed webhook help timed out."); }
          if (launchError !== undefined) throw launchError;
          observations.push({ launcher: name, leaf, status: code, stdout: Buffer.concat(out).toString("base64"), stderr: Buffer.concat(err).toString("base64") });
          expect(code, `${name} webhook ${leaf.join(" ")}`).toBe(0);
          expect(Buffer.concat(err).length).toBe(0);
          if (leaf.length === 0) {
            expect(Buffer.concat(out).toString()).toContain("catalog"); expect(Buffer.concat(out).toString()).toContain("delivery");
          } else expect(Buffer.concat(out).toString()).toContain("--json");
        } finally { if (timer !== undefined) clearTimeout(timer); }
      }
    }
  } catch (cause) { failure = cause; }
  try { await installed.cleanup(); }
  catch (cause) { throw new AggregateError(failure === undefined ? [cause] : [failure, cause], "Installed webhook help or cleanup failed."); }
  if (process.env.DAYNIGHT_WEBHOOK_HELP_EVIDENCE !== undefined) {
    const evidence = process.env.DAYNIGHT_WEBHOOK_HELP_EVIDENCE;
    if (!path.isAbsolute(evidence)) throw new Error("Webhook help evidence path must be absolute.");
    await writeFile(evidence, `${JSON.stringify({ source: receipt.source, artifact: { tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256 }, passed: failure === undefined, observations }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  if (failure !== undefined) throw failure;
}, 180_000);
