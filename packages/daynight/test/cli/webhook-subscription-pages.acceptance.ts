import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

type Info = { url: string; userId: string; projectId: string; teamId: string; receiverUrl: string; schema: string };
type Observation = { args: string[]; status: number | null; stdout: Buffer; stderr: Buffer };
type Wire = { method: string; path: string; status: number; body: Buffer; response: Buffer[] };
const digest = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const secret = (prefix: string): string => prefix + randomBytes(32).toString("base64url");
const database = process.env.DAYNIGHT_TEST_DATABASE_URL;

// The copied T05 host adds request logging and a read-only database observation.
// The production subscription writer, event capture, list queries and permissions remain unchanged.
it.skipIf(database === undefined)("retains subscription identity and rejects repeated endpoint pages through the installed CLI", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const root = path.join(receipt.root, "webhook-subscription-pages");
  const home = path.join(root, "home"), config = path.join(root, "config"), tmp = path.join(root, "tmp");
  const serverSource = path.resolve(import.meta.dirname, "../../../daynight-server");
  const serverCopy = path.join(root, "server"), pat = secret("dnpat_");
  const calls: Observation[] = [], wire: Wire[] = [], controls: { method: string; path: string; status: number; body: Buffer; response: Buffer }[] = [];
  const snapshots: { label: string; value: unknown }[] = [];
  const children = new Map<ChildProcess, Promise<unknown>>();
  let info: Info | undefined, host: ChildProcess | undefined, hostClosed: Promise<unknown> | undefined;
  let originalHash: string | undefined, adaptedHash: string | undefined, failure: unknown;
  let pageFault: "duplicate-id" | "duplicate-cursor" | undefined;
  let firstPageId = "", firstCursor = "";
  const faults: { kind: string; path: string; original: string; body: string }[] = [];
  const proxy = createServer((incoming, outgoing) => {
    const parts: Buffer[] = []; incoming.on("data", (part: Buffer) => parts.push(part));
    incoming.on("end", () => {
      const target = new URL(incoming.url!, info!.url), body = Buffer.concat(parts);
      const upstream = request(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
        const observed: Wire = { method: incoming.method!, path: incoming.url!, status: response.statusCode!, body, response: [] };
        wire.push(observed);
        const isList = incoming.method === "GET" && target.pathname === "/api/v1/me/webhooks" && response.statusCode === 200;
        if (!isList) { response.on("data", (part: Buffer) => observed.response.push(part)); outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing); return; }
        const responseParts: Buffer[] = [];
        response.on("data", (part: Buffer) => responseParts.push(part));
        response.on("end", () => {
          const bytes = Buffer.concat(responseParts), value = JSON.parse(bytes.toString());
          if (!target.searchParams.has("cursor")) { firstPageId = value.items[0]?.id ?? ""; firstCursor = value.nextCursor ?? ""; }
          else if (pageFault !== undefined) {
            const fault = pageFault; pageFault = undefined;
            if (fault === "duplicate-id") value.items[0].id = firstPageId;
            else value.nextCursor = firstCursor;
            const changed = Buffer.from(JSON.stringify(value));
            faults.push({ kind: fault, path: incoming.url!, original: bytes.toString("base64"), body: changed.toString("base64") });
            observed.response.push(changed); outgoing.writeHead(200, { ...response.headers, "content-length": changed.length }); outgoing.end(changed); return;
          }
          observed.response.push(bytes); outgoing.writeHead(response.statusCode!, response.headers); outgoing.end(bytes);
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
    const value = await control("GET", `/__fixture/subscriptions/state/${id}`); snapshots.push({ label, value }); return value;
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
    const addition = `\tmux.HandleFunc("GET /__fixture/subscriptions/state/{id}", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w, "forbidden", 403); return }; id:=r.PathValue("id"); rows,e:=f.db.Pool.Query(r.Context(), "SELECT id::text,project_id::text,authorization_state,authorization_epoch::text,deleted_at IS NOT NULL FROM webhook_subscriptions WHERE endpoint_id=$1 ORDER BY id",id); if e!=nil { http.Error(w,"subscription read failed",500); return }; subs:=[]map[string]any{}; for rows.Next() { var sid,pid,state,epoch string; var deleted bool; if rows.Scan(&sid,&pid,&state,&epoch,&deleted)!=nil { rows.Close(); http.Error(w,"subscription scan failed",500); return }; subs=append(subs,map[string]any{"id":sid,"projectId":pid,"state":state,"epoch":epoch,"deleted":deleted}) }; if rows.Err()!=nil { rows.Close(); http.Error(w,"subscription rows failed",500); return }; rows.Close(); rows,e=f.db.Pool.Query(r.Context(),"SELECT id::text,subscription_id::text,event_type,deleted_at IS NOT NULL FROM webhook_bindings WHERE subscription_id IN (SELECT id FROM webhook_subscriptions WHERE endpoint_id=$1) ORDER BY id",id); if e!=nil { http.Error(w,"binding read failed",500); return }; defer rows.Close(); bindings:=[]map[string]any{}; for rows.Next() { var bid,sid,event string; var deleted bool; if rows.Scan(&bid,&sid,&event,&deleted)!=nil { http.Error(w,"binding scan failed",500); return }; bindings=append(bindings,map[string]any{"id":bid,"subscriptionId":sid,"eventType":event,"deleted":deleted}) }; if rows.Err()!=nil { http.Error(w,"binding rows failed",500); return }; var postgresVersion string; if e:=f.db.Pool.QueryRow(r.Context(),"SHOW server_version").Scan(&postgresVersion); e!=nil { http.Error(w,"version read failed",500); return }; w.Header().Set("Content-Type","application/json"); json.NewEncoder(w).Encode(map[string]any{"postgresVersion":postgresVersion,"subscriptions":subs,"bindings":bindings}) }))\n`;
    const generationControl = `\tmux.HandleFunc("POST /__fixture/history/generation", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { if p.UserID != user { http.Error(w,"forbidden",403); return }; var input struct { ID string ` + '`json:"id"`' + ` }; if json.NewDecoder(r.Body).Decode(&input)!=nil { http.Error(w,"invalid",400); return }; tag,e:=f.db.Pool.Exec(r.Context(),"UPDATE webhook_deliveries SET generation=9007199254740993 WHERE id=$1 AND state='pending' AND trigger='automatic' AND attempt_sequence=0",input.ID); if e!=nil || tag.RowsAffected()!=1 { http.Error(w,"generation state unavailable",409); return }; w.WriteHeader(204) }))\n`;
    adapted = replaceOnce(adapted, marker, addition + generationControl + marker);
    adapted = replaceOnce(adapted, "\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    originalHash = digest(Buffer.from(original)); adaptedHash = digest(Buffer.from(adapted));
    await writeFile(filename, adapted);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: serverCopy, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: pat, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: secret("dnpat_") } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const line = new Promise<string>((resolve, reject) => {
      let text = ""; host!.once("error", reject); host!.stderr!.resume();
      host!.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); const newline = text.indexOf("\n"); if (newline >= 0) resolve(text.slice(0, newline)); });
      host!.once("close", () => reject(new Error("Subscription-pages fixture exited before readiness.")));
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try { info = JSON.parse(await Promise.race([line, new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Subscription-pages fixture did not become ready.")), 60_000); })])) as Info; }
    finally { if (startupTimer !== undefined) clearTimeout(startupTimer); }
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (address === null || typeof address === "string") throw new Error("Missing proxy address.");
    await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${pat}\n`, { mode: 0o600 });
    const project2 = await control("POST", "/api/v1/projects", { name: "Other subscription project", repoUrl: `https://example.test/${randomUUID()}`, teamId: info.teamId, expectedUserId: info.userId });
    const subscription = (id: string | null, projectId: string) => ({ id, projectId, eventTypes: ["task.created"] });
    const destination = { kind: "http", adapterVersion: "1", configuration: { url: info.receiverUrl } };
    const input = JSON.stringify({ name: "Subscription identity", enabled: true, destination, subscriptions: [subscription(null, info.projectId)] });
    const created = await success(["create", "--personal", "--stdin", "--confirm"], input);
    const endpoint = created.endpoint.id as string, s1 = created.endpoint.subscriptions[0].id as string;
    const initial = await observe("initial", endpoint);
    const s1Binding = initial.bindings.find((binding: any) => binding.subscriptionId === s1 && !binding.deleted);
    expect(s1Binding).toBeDefined();
    await control("POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "Original subscription proof" });
    const originalDelivery = (await success(["delivery", "list", endpoint, "--personal"])).items[0];
    await control("POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "Large generation source" });
    const originalPage = await success(["delivery", "list", endpoint, "--personal"]);
    expect(originalPage.items).toHaveLength(2);
    const largeDelivery = originalPage.items.find((row: any) => row.id !== originalDelivery.id);
    await control("POST", "/__fixture/history/generation", { id: largeDelivery.id });
    const largeRead = await success(["delivery", "show", endpoint, largeDelivery.id, "--personal"]);
    expect(largeRead.generation).toBe("9007199254740993");
    const beforeLargeHistory = wire.length;
    const largeAttempts = await success(["attempt", "list", endpoint, largeDelivery.id, "--personal", "--generation", largeRead.generation]);
    expect(largeAttempts.items).toEqual([]);
    const largeQuery = wire.slice(beforeLargeHistory).filter(item => item.method === "GET" && item.path.includes("/attempts?"));
    expect(largeQuery).toHaveLength(1); expect(new URL(largeQuery[0]!.path, "http://127.0.0.1").searchParams.get("generation")).toBe("9007199254740993");
    const beforeLargeRedelivery = wire.length;
    const largeIntent = await success(["delivery", "redeliver", endpoint, largeDelivery.id, "--personal", "--if-version", created.endpoint.configVersion, "--if-generation", largeRead.generation, "--confirm"]);
    expect(largeIntent.operation.generationAfter).toBe("9007199254740994");
    const largeWrites = wire.slice(beforeLargeRedelivery).filter(item => item.method === "POST" && item.path.endsWith("/redeliveries"));
    expect(largeWrites).toHaveLength(1); expect(JSON.parse(largeWrites[0]!.body.toString()).ifGeneration).toBe("9007199254740993");
    const beforeReplace = wire.length;
    const expanded = await success(["subscription", "replace", endpoint, "--personal", "--if-version", created.endpoint.configVersion, "--stdin", "--confirm"], JSON.stringify([subscription(s1, info.projectId), subscription(null, project2.id)]));
    const expansionRequests = wire.slice(beforeReplace).filter(item => item.method === "PATCH");
    expect(expansionRequests).toHaveLength(1);
    const s2 = expanded.endpoint.subscriptions.find((row: any) => row.projectId === project2.id).id as string;
    expect(s2).not.toBe(s1); expect(expanded.endpoint.subscriptions.find((row: any) => row.projectId === info!.projectId).id).toBe(s1);
    const expandedState = await observe("expanded", endpoint);
    expect(expandedState.subscriptions.find((row: any) => row.id === s1)).toEqual(initial.subscriptions.find((row: any) => row.id === s1));
    expect(expandedState.bindings.find((row: any) => row.id === s1Binding.id)).toEqual(s1Binding);
    expect(expandedState.subscriptions.find((row: any) => row.id === s2).deleted).toBe(false);
    const beforeBadProject = wire.length;
    const badProject = await invoke(["subscription", "replace", endpoint, "--personal", "--if-version", expanded.endpoint.configVersion, "--stdin", "--confirm"], JSON.stringify([subscription(s1, project2.id)]));
    expect(badProject.status).toBe(1); expect(badProject.stdout.length).toBe(0);
    expect(wire.slice(beforeBadProject).filter(item => item.method === "PATCH")).toHaveLength(1);
    expect(wire.slice(beforeBadProject).find(item => item.method === "PATCH")?.status).toBe(400);
    expect(await observe("after-project-reuse-refusal", endpoint)).toEqual(expandedState);
    const beforeDuplicate = wire.length;
    const duplicate = await invoke(["subscription", "replace", endpoint, "--personal", "--if-version", expanded.endpoint.configVersion, "--stdin", "--confirm"], JSON.stringify([subscription(s1, info.projectId), subscription(s1, info.projectId)]));
    expect(duplicate.status).toBe(1); expect(duplicate.stdout.length).toBe(0);
    expect(wire.slice(beforeDuplicate).filter(item => item.method === "PATCH")).toHaveLength(0);
    const replacement = await success(["subscription", "replace", endpoint, "--personal", "--if-version", expanded.endpoint.configVersion, "--stdin", "--confirm"], JSON.stringify([subscription(null, info.projectId), subscription(s2, project2.id)]));
    const s3 = replacement.endpoint.subscriptions.find((row: any) => row.projectId === info!.projectId).id as string;
    expect(s3).not.toBe(s1); expect(s3).not.toBe(s2);
    const replacedState = await observe("replaced", endpoint);
    expect(replacedState.subscriptions.find((row: any) => row.id === s1).deleted).toBe(true);
    expect(replacedState.subscriptions.find((row: any) => row.id === s3).deleted).toBe(false);
    expect(replacedState.bindings.find((row: any) => row.id === s1Binding.id).deleted).toBe(true);
    expect(replacedState.bindings.find((row: any) => row.subscriptionId === s3 && !row.deleted).id).not.toBe(s1Binding.id);
    expect(replacedState.subscriptions.find((row: any) => row.id === s2)).toEqual(expandedState.subscriptions.find((row: any) => row.id === s2));
    expect(replacedState.bindings.filter((row: any) => row.subscriptionId === s2)).toEqual(expandedState.bindings.filter((row: any) => row.subscriptionId === s2));
    const oldBefore = await success(["delivery", "show", endpoint, originalDelivery.id, "--personal"]);
    const beforeOldRetry = wire.length;
    const oldRetry = await invoke(["delivery", "redeliver", endpoint, originalDelivery.id, "--personal", "--if-version", replacement.endpoint.configVersion, "--if-generation", oldBefore.generation, "--confirm"]);
    expect(oldRetry.status).toBe(1); expect(oldRetry.stdout.length).toBe(0); expect(JSON.parse(oldRetry.stderr.toString()).error.code).toBe("delivery_stopped");
    expect(wire.slice(beforeOldRetry).filter(item => item.method === "POST" && item.path.endsWith("/redeliveries"))).toHaveLength(1);
    const oldAfter = await success(["delivery", "show", endpoint, originalDelivery.id, "--personal"]);
    expect(oldAfter.generation).toBe(oldBefore.generation); expect(oldAfter.manualOperationCount).toBe(oldBefore.manualOperationCount);
    await control("POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "New subscription proof" });
    const afterSource = await success(["delivery", "list", endpoint, "--personal"]);
    expect(afterSource.items).toHaveLength(3); expect(afterSource.items.map((row: any) => row.id)).toContain(originalDelivery.id);
    const beforeConfirm = wire.length;
    const confirmed = await success(["subscription", "reconfirm", endpoint, "--personal", "--project", info.projectId, "--if-version", replacement.endpoint.configVersion, "--confirm"]);
    expect(confirmed.operation.effect).toBe("unchanged"); expect(confirmed.endpoint.configVersion).toBe(replacement.endpoint.configVersion); expect(confirmed.endpoint.updatedAt).toBe(replacement.endpoint.updatedAt);
    expect(wire.slice(beforeConfirm).filter(item => item.method === "PATCH")).toHaveLength(1);
    expect(await observe("after-reconfirm", endpoint)).toEqual(replacedState);
    const beforeRepeatedProject = wire.length;
    const repeatedProject = await invoke(["subscription", "reconfirm", endpoint, "--personal", "--project", info.projectId, "--project", info.projectId, "--if-version", replacement.endpoint.configVersion, "--confirm"]);
    expect(repeatedProject.status).toBe(2); expect(repeatedProject.stdout.length).toBe(0); expect(wire.slice(beforeRepeatedProject)).toHaveLength(0);
    for (let i = 0; i < 50; i++) await control("POST", "/api/v1/me/webhooks", { operationId: randomUUID(), issuedAt: new Date().toISOString(), expectedUserId: info.userId, name: `Paged ${i}`, enabled: false, destination, subscriptions: [] });
    const beforeComplete = wire.length;
    const all = await success(["list", "--personal"]);
    expect(all.items).toHaveLength(51); expect(new Set(all.items.map((row: any) => row.id)).size).toBe(51);
    expect(wire.slice(beforeComplete).filter(item => item.method === "GET" && item.path.startsWith("/api/v1/me/webhooks"))).toHaveLength(2);
    for (const kind of ["duplicate-id", "duplicate-cursor"] as const) {
      pageFault = kind; const beforeFault = wire.length;
      const failed = await invoke(["list", "--personal"]);
      expect(pageFault).toBeUndefined(); expect(failed.status).toBe(1); expect(failed.stdout.length).toBe(0);
      expect(wire.slice(beforeFault).filter(item => item.method === "GET" && item.path.startsWith("/api/v1/me/webhooks"))).toHaveLength(2);
      expect(wire.slice(beforeFault).filter(item => item.method !== "GET")).toHaveLength(0);
    }
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
  if (process.env.DAYNIGHT_WEBHOOK_SUBSCRIPTION_PAGES_EVIDENCE !== undefined) try {
    const evidence = process.env.DAYNIGHT_WEBHOOK_SUBSCRIPTION_PAGES_EVIDENCE;
    if (!path.isAbsolute(evidence)) throw new Error("Webhook subscription-pages evidence path must be absolute.");
    const safe = (bytes: Buffer) => ({ length: bytes.length, sha256: digest(bytes), base64: bytes.includes(Buffer.from(pat)) ? null : bytes.toString("base64") });
    const material = { source: receipt.source, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256 }, fixture: { ...info, originalHostSha256: originalHash, adaptedHostSha256: adaptedHash, adapter: "copied T05 host with production request logging and read-only subscription and binding observation" }, passed: failure === undefined && cleanup.length === 0, cleanupErrors: cleanup.length, snapshots, faults, calls: calls.map(call => ({ args: call.args, status: call.status, stdout: safe(call.stdout), stderr: safe(call.stderr) })), requests: wire.map(record => ({ method: record.method, path: record.path, status: record.status, body: safe(record.body), response: safe(Buffer.concat(record.response)) })), controls: controls.map(record => ({ method: record.method, path: record.path, status: record.status, body: safe(record.body), response: safe(record.response) })) };
    await writeFile(evidence, `${JSON.stringify(material, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (cause) { cleanup.push(cause); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Webhook subscription-pages acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 180_000);
