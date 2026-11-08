import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

const database = process.env.DAYNIGHT_TEST_DATABASE_URL;
const enabled = database !== undefined && process.env.DAYNIGHT_WEBHOOK_RESUME_MISMATCH === "1";
const token = (prefix: string): string => prefix + randomBytes(32).toString("base64url");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const canary = "resume-private-canary";
type HostInfo = { url: string; userId: string; memberId: string; teamId: string; projectId: string; receiverUrl: string; schema: string };
type Trace = { proxy: string; method: string; path: string; status: number; bodyBase64: string; responseBase64: string; forwardedResponseBase64?: string; fault: string | null };
type Observation = { name: string; status: number | null; preparedBefore: string; preparedAfter: string; preparedBeforeBase64: string; preparedAfterBase64: string; stdoutBase64: string; stderrBase64: string; trace: Trace[] };

it.skipIf(!enabled)("rejects mismatched prepared writes and altered receipts without resubmitting", async () => {
  const installed = await createAcceptanceCli(), artifact = installed.receipt;
  const root = path.join(artifact.root, "webhook-resume-mismatch"), configA = path.join(root, "config-a"), configB = path.join(root, "config-b"), configMember = path.join(root, "config-member"), home = path.join(root, "home"), tmp = path.join(root, "tmp");
  const originalServer = path.resolve(import.meta.dirname, "../../../daynight-server"), copiedServer = path.join(root, "server");
  const admin = token("dnpat_"), member = token("dnpat_");
  const records: Trace[] = [], observations: Observation[] = [];
  const laterResumes: { leaf: string; originalRequest: Trace; originalOperation: unknown; changedEndpoint: unknown; preparedBase64: string; stdoutBase64: string; stderrBase64: string; trace: Trace[] }[] = [];
  const children = new Map<ChildProcess, Promise<unknown>>();
  let info: HostInfo | undefined, host: ChildProcess | undefined, hostClosed: Promise<unknown> | undefined;
  let failure: unknown, originalHostSha256 = "", adaptedHostSha256 = "", databaseChecks: unknown = null, baseline: unknown = null;
  let tamper: "issuedAt" | "requestSha256" | undefined;
  const makeProxy = (label: string) => createServer((incoming, outgoing) => {
    const requestParts: Buffer[] = []; incoming.on("data", (part: Buffer) => requestParts.push(part));
    incoming.on("end", () => {
      const body = Buffer.concat(requestParts), target = new URL(incoming.url!, info!.url);
      const upstream = httpRequest(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
        const parts: Buffer[] = []; response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => {
          const bytes = Buffer.concat(parts), selected = tamper !== undefined && incoming.method === "GET" && incoming.url!.includes("/operations/") && response.statusCode === 200 ? tamper : undefined;
          if (selected !== undefined) tamper = undefined;
          const record: Trace = { proxy: label, method: incoming.method!, path: incoming.url!, status: response.statusCode!, bodyBase64: body.toString("base64"), responseBase64: bytes.toString("base64"), fault: selected ?? null };
          records.push(record);
          if (selected === undefined) { outgoing.writeHead(response.statusCode!, response.headers); outgoing.end(bytes); return; }
          const changed = JSON.parse(bytes.toString());
          if (selected === "issuedAt") changed.issuedAt = new Date(Date.parse(changed.issuedAt) - 1_000).toISOString();
          else changed.requestSha256 = changed.requestSha256 === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
          const mutated = Buffer.from(JSON.stringify(changed)); record.forwardedResponseBase64 = mutated.toString("base64");
          outgoing.writeHead(response.statusCode!, { ...response.headers, "content-length": mutated.length }); outgoing.end(mutated);
        });
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); upstream.end(body);
    });
  });
  const proxyA = makeProxy("a"), proxyB = makeProxy("b");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(root, "xdg"), XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: tmp, TMP: tmp, TEMP: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const control = async (method: string, route: string, body?: unknown): Promise<any> => {
    const response = await fetch(info!.url + route, { method, headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`Real fixture request ${method} ${route} failed with ${response.status}.`);
    return bytes.length === 0 ? undefined : JSON.parse(bytes.toString());
  };
  const invoke = async (args: string[], input: string | undefined, selectedConfig = configA, alias = false): Promise<{ status: number | null; stdout: Buffer; stderr: Buffer }> => {
    const launcher = alias ? path.join(path.dirname(artifact.launcherPath), process.platform === "win32" ? "dn.cmd" : "dn") : artifact.launcherPath;
    const child = crossSpawn(launcher, ["webhook", ...args, "--json"], { cwd: root, env: { ...env, DN_CONFIG_DIR: selectedConfig }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; child.stdout!.on("data", (part: Buffer) => stdout.push(part)); child.stderr!.on("data", (part: Buffer) => stderr.push(part));
    let launchError: unknown; child.once("error", error => { launchError = error; });
    const closed = new Promise<number | null>(resolve => child.once("close", code => { children.delete(child); resolve(code); })); children.set(child, closed); child.stdin!.end(input);
    let timer: NodeJS.Timeout | undefined;
    try {
      const status = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 15_000); })]);
      if (status === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed resume command timed out."); }
      if (launchError !== undefined) throw launchError;
      return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const expectMismatch = async (name: string, args: string[], prepared: string, input: string | undefined, selectedConfig = configA): Promise<void> => {
    const beforeBytes = await readFile(prepared), before = records.length;
    const result = await invoke([...args, "--resume-operation", prepared, "--confirm"], input, selectedConfig, observations.length % 2 === 1);
    const trace = records.slice(before), afterBytes = await readFile(prepared);
    observations.push({ name, status: result.status, preparedBefore: sha(beforeBytes), preparedAfter: sha(afterBytes), preparedBeforeBase64: beforeBytes.toString("base64"), preparedAfterBase64: afterBytes.toString("base64"), stdoutBase64: result.stdout.toString("base64"), stderrBase64: result.stderr.toString("base64"), trace });
    expect(result.status).toBe(1); expect(result.stdout.length).toBe(0); expect(result.stderr.toString()).not.toContain(canary);
    const error = JSON.parse(result.stderr.toString()).error;
    expect(error.code).toBe("operation_receipt_mismatch"); expect(error.operationOutcome).toBe("unknown"); expect(error.invocationOutcome).toBe("not_submitted");
    expect(trace.filter(record => record.path.includes("/webhooks"))).toHaveLength(0);
    expect(afterBytes).toEqual(beforeBytes);
  };
  try {
    await Promise.all([home, configA, configB, configMember, tmp].map(dir => mkdir(dir, { recursive: true })));
    await cp(originalServer, copiedServer, { recursive: true });
    const sourcePath = path.join(copiedServer, "testdata/webhook-host/main.go"), original = await readFile(sourcePath, "utf8");
    const adapted = original.replace('authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"', '"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"\n\tauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"').replace("\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    if (adapted === original || !adapted.includes("httpx.RequestLogging(logger, mux).ServeHTTP(w, r)")) throw new Error("Could not apply production middleware to the fixture copy.");
    originalHostSha256 = sha(Buffer.from(original)); adaptedHostSha256 = sha(Buffer.from(adapted)); await writeFile(sourcePath, adapted);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: copiedServer, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: admin, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: member } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const line = new Promise<string>((resolve, reject) => { let text = ""; host!.once("error", reject); host!.stderr!.resume(); host!.stdout!.on("data", (part: Buffer) => { text += part.toString(); const end = text.indexOf("\n"); if (end >= 0) resolve(text.slice(0, end)); }); host!.once("close", () => reject(new Error("Webhook fixture exited before readiness."))); });
    let startupTimer: NodeJS.Timeout | undefined;
    try { info = JSON.parse(await Promise.race([line, new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Webhook fixture readiness timed out.")), 60_000); })])) as HostInfo; }
    finally { if (startupTimer !== undefined) clearTimeout(startupTimer); }
    const listen = async (server: ReturnType<typeof createServer>): Promise<string> => {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address(); if (address === null || typeof address === "string") throw new Error("Proxy address unavailable."); return `http://127.0.0.1:${address.port}`;
    };
    const originA = await listen(proxyA), originB = await listen(proxyB);
    await writeFile(path.join(configA, "config.yml"), `serverUrl: ${originA}\nserverToken: ${admin}\n`, { mode: 0o600 });
    await writeFile(path.join(configB, "config.yml"), `serverUrl: ${originB}\nserverToken: ${admin}\n`, { mode: 0o600 });
    await writeFile(path.join(configMember, "config.yml"), `serverUrl: ${originA}\nserverToken: ${member}\n`, { mode: 0o600 });
    const createInput = { operationId: randomUUID(), issuedAt: new Date().toISOString(), expectedUserId: info.userId, name: "Resume fixture", enabled: true, destination: { kind: "http", adapterVersion: "1", configuration: { url: `${info.receiverUrl}?${canary}` } }, subscriptions: [{ id: null, projectId: info.projectId, eventTypes: ["task.created"] }] };
    const created = await control("POST", "/api/v1/me/webhooks", createInput), endpointId = created.endpoint.id as string;
    const originalInput = JSON.stringify({ name: `Updated ${canary}` });
    const updatePath = path.join(root, "update-prepared.json"), beforeUpdate = records.length;
    const update = await invoke(["update", endpointId, "--personal", "--if-version", "1", "--stdin", "--confirm", "--operation-out", updatePath], originalInput);
    expect(update.status).toBe(0); expect(update.stderr.length).toBe(0);
    const updateOperation = JSON.parse(update.stdout.toString()).operation;
    const updateRequest = records.slice(beforeUpdate).find(record => record.method === "PATCH");
    expect(updateRequest).toBeDefined(); expect(updateOperation.requestSha256).toBe(sha(Buffer.from(updateRequest!.bodyBase64, "base64")));
    const originalPreparedBytes = await readFile(updatePath), prepared = JSON.parse(originalPreparedBytes.toString());
    expect(prepared.operationId).toBe(updateOperation.operationId); expect(prepared.requestSha256).toBe(updateOperation.requestSha256);
    const updateArgs = ["update", endpointId, "--personal", "--if-version", "1", "--stdin"];
    await expectMismatch("actual-server", updateArgs, updatePath, originalInput, configB);
    await expectMismatch("actual-account", updateArgs, updatePath, originalInput, configMember);
    const teamCreated = await control("POST", `/api/v1/teams/${info.teamId}/webhooks`, { ...createInput, operationId: randomUUID(), issuedAt: new Date().toISOString(), name: "Team identity fixture", subscriptions: [] });
    const teamEndpoint = teamCreated.endpoint.id as string, teamPath = path.join(root, "team-prepared.json"), beforeTeamUpdate = records.length;
    const teamArgs = ["update", teamEndpoint, "--team", info.teamId, "--if-version", "1", "--stdin"];
    const teamUpdate = await invoke([...teamArgs, "--confirm", "--operation-out", teamPath], originalInput);
    expect(teamUpdate.status).toBe(0); expect(teamUpdate.stderr.length).toBe(0);
    const teamOperation = JSON.parse(teamUpdate.stdout.toString()).operation, teamPrepared = JSON.parse((await readFile(teamPath)).toString());
    const teamRequest = records.slice(beforeTeamUpdate).find(record => record.method === "PATCH");
    expect(teamRequest).toBeDefined(); expect(teamOperation.requestSha256).toBe(sha(Buffer.from(teamRequest!.bodyBase64, "base64")));
    await expectMismatch("actual-account-same-team", teamArgs, teamPath, originalInput, configMember);
    await expectMismatch("actual-owner", ["update", endpointId, "--team", info.teamId, "--if-version", "1", "--stdin"], updatePath, originalInput);
    await expectMismatch("actual-kind", ["delete", endpointId, "--personal", "--if-version", "1"], updatePath, undefined);
    await expectMismatch("actual-endpoint", ["update", randomUUID(), "--personal", "--if-version", "1", "--stdin"], updatePath, originalInput);
    await expectMismatch("actual-version", ["update", endpointId, "--personal", "--if-version", "2", "--stdin"], updatePath, originalInput);
    await expectMismatch("actual-body", updateArgs, updatePath, JSON.stringify({ name: `Different ${canary}` }));
    const patches: [string, Record<string, unknown>][] = [
      ["prepared-server", { serverOrigin: originB }], ["prepared-actor", { actorUserId: info.memberId }],
      ["prepared-owner", { owner: { kind: "team", id: info.teamId } }], ["prepared-kind", { kind: "endpoint.delete" }],
      ["prepared-endpoint", { endpointId: randomUUID() }], ["prepared-version", { ifVersion: "2" }],
      ["prepared-hash", { requestSha256: prepared.requestSha256 === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64) }],
    ];
    for (const [name, patch] of patches) {
      const file = path.join(root, `${name}.json`); await writeFile(file, JSON.stringify({ ...prepared, ...patch }), { mode: 0o600 });
      await expectMismatch(name, updateArgs, file, originalInput);
    }
    await control("POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "Resume redelivery source" });
    const page = await control("GET", `/api/v1/me/webhooks/${endpointId}/deliveries`);
    expect(page.items).toHaveLength(1);
    const delivery = page.items[0], deliveryId = delivery.id as string;
    const redeliveryPath = path.join(root, "redelivery-prepared.json"), beforeRedelivery = records.length;
    const redeliveryArgs = ["delivery", "redeliver", endpointId, deliveryId, "--personal", "--if-version", updateOperation.configVersionAfter, "--if-generation", delivery.generation];
    const redelivery = await invoke([...redeliveryArgs, "--confirm", "--operation-out", redeliveryPath], undefined);
    expect(redelivery.status).toBe(0); expect(redelivery.stderr.length).toBe(0);
    const redeliveryOperation = JSON.parse(redelivery.stdout.toString()).operation;
    const redeliveryRequest = records.slice(beforeRedelivery).find(record => record.method === "POST");
    expect(redeliveryRequest).toBeDefined(); expect(redeliveryOperation.requestSha256).toBe(sha(Buffer.from(redeliveryRequest!.bodyBase64, "base64")));
    const redeliveryPrepared = JSON.parse((await readFile(redeliveryPath)).toString());
    await expectMismatch("actual-delivery", ["delivery", "redeliver", endpointId, randomUUID(), "--personal", "--if-version", updateOperation.configVersionAfter, "--if-generation", delivery.generation], redeliveryPath, undefined);
    await expectMismatch("actual-generation", ["delivery", "redeliver", endpointId, deliveryId, "--personal", "--if-version", updateOperation.configVersionAfter, "--if-generation", "2"], redeliveryPath, undefined);
    for (const [name, patch] of [["prepared-delivery", { deliveryId: randomUUID() }], ["prepared-generation", { ifGeneration: "2" }]] as const) {
      const file = path.join(root, `${name}.json`); await writeFile(file, JSON.stringify({ ...redeliveryPrepared, ...patch }), { mode: 0o600 });
      await expectMismatch(name, redeliveryArgs, file, undefined);
    }
    for (const fault of ["issuedAt", "requestSha256"] as const) {
      const fileBefore = await readFile(updatePath), before = records.length; tamper = fault;
      const response = await invoke([...updateArgs, "--resume-operation", updatePath, "--confirm"], originalInput);
      expect(tamper).toBeUndefined(); const trace = records.slice(before), after = await readFile(updatePath);
      observations.push({ name: `receipt-${fault}`, status: response.status, preparedBefore: sha(fileBefore), preparedAfter: sha(after), preparedBeforeBase64: fileBefore.toString("base64"), preparedAfterBase64: after.toString("base64"), stdoutBase64: response.stdout.toString("base64"), stderrBase64: response.stderr.toString("base64"), trace });
      expect(response.status).toBe(1); expect(response.stdout.length).toBe(0); expect(response.stderr.toString()).not.toContain(canary);
      const error = JSON.parse(response.stderr.toString()).error; expect(error.code).toBe("operation_receipt_mismatch"); expect(error.operationOutcome).toBe("unknown");
      expect(trace.filter(record => record.path.includes(`/operations/${prepared.operationId}`))).toHaveLength(1);
      expect(trace.filter(record => record.method !== "GET")).toHaveLength(0); expect(after).toEqual(fileBefore);
    }
    const originalUpdate = await control("GET", `/api/v1/me/webhooks/operations/${prepared.operationId}`);
    const originalRedelivery = await control("GET", `/api/v1/me/webhooks/operations/${redeliveryPrepared.operationId}`);
    const originalTeam = await control("GET", `/api/v1/teams/${info.teamId}/webhooks/operations/${teamPrepared.operationId}`);
    expect(originalUpdate.requestSha256).toBe(prepared.requestSha256); expect(originalUpdate.issuedAt).toBe(prepared.issuedAt);
    expect(originalRedelivery.requestSha256).toBe(redeliveryPrepared.requestSha256); expect(originalRedelivery.issuedAt).toBe(redeliveryPrepared.issuedAt);
    expect(originalTeam.requestSha256).toBe(teamPrepared.requestSha256); expect(originalTeam.issuedAt).toBe(teamPrepared.issuedAt);
    const finalDelivery = await control("GET", `/api/v1/me/webhooks/${endpointId}/deliveries/${deliveryId}`);
    expect(finalDelivery.manualOperationCount).toBe(1); expect(finalDelivery.generation).toBe(redeliveryOperation.generationAfter);
    baseline = { updateRequest, teamRequest, redeliveryRequest, originalUpdate, originalTeam, originalRedelivery, finalDelivery: { generation: finalDelivery.generation, manualOperationCount: finalDelivery.manualOperationCount, state: finalDelivery.state } };
    expect(await readFile(updatePath)).toEqual(originalPreparedBytes);
    for (const leaf of ["update", "enable", "disable", "replace", "reconfirm"] as const) {
      const fixtureEndpoint = await control("POST", "/api/v1/me/webhooks", { ...createInput, operationId: randomUUID(), issuedAt: new Date().toISOString(), name: `Later ${leaf}`, enabled: leaf !== "enable" });
      const target = fixtureEndpoint.endpoint.id as string, recordPath = path.join(root, `later-${leaf}.json`);
      const input = leaf === "update" ? JSON.stringify({ name: "Original update" }) : leaf === "replace" ? "[]" : undefined;
      const args = leaf === "update" ? ["update", target, "--personal", "--if-version", "1", "--stdin"]
        : leaf === "replace" ? ["subscription", "replace", target, "--personal", "--if-version", "1", "--stdin"]
        : leaf === "reconfirm" ? ["subscription", "reconfirm", target, "--personal", "--if-version", "1", "--project", info.projectId]
        : [leaf, target, "--personal", "--if-version", "1"];
      const beforeOriginal = records.length;
      const first = await invoke([...args, "--confirm", "--operation-out", recordPath], input);
      expect(first.status, `${leaf} original`).toBe(0); expect(first.stderr.length).toBe(0);
      const originalOperation = JSON.parse(first.stdout.toString()).operation;
      const originalWrites = records.slice(beforeOriginal).filter(record => record.method === "PATCH");
      expect(originalWrites).toHaveLength(1); expect(originalWrites[0]!.status).toBe(200);
      const preparedBytes = await readFile(recordPath), binding = JSON.parse(preparedBytes.toString());
      expect(binding.operationId).toBe(originalOperation.operationId);
      expect(binding.requestSha256).toBe(sha(Buffer.from(originalWrites[0]!.bodyBase64, "base64")));
      const changed = await control("PATCH", `/api/v1/me/webhooks/${target}`, { operationId: randomUUID(), issuedAt: new Date().toISOString(), expectedUserId: info.userId, ifVersion: originalOperation.configVersionAfter, name: `Later change ${leaf}` });
      expect(BigInt(changed.endpoint.configVersion)).toBeGreaterThan(BigInt(originalOperation.configVersionAfter));
      const beforeResume = records.length;
      const resumed = await invoke([...args, "--confirm", "--resume-operation", recordPath], input);
      expect(resumed.status, `${leaf} resume`).toBe(0); expect(resumed.stderr.length).toBe(0);
      expect(JSON.parse(resumed.stdout.toString()).operation).toEqual(originalOperation);
      const trace = records.slice(beforeResume);
      expect(trace.filter(record => record.method !== "GET")).toHaveLength(0);
      expect(trace.filter(record => record.path.includes(`/operations/${binding.operationId}`))).toHaveLength(1);
      expect(await readFile(recordPath)).toEqual(preparedBytes);
      const current = await control("GET", `/api/v1/me/webhooks/${target}`);
      expect(current).toEqual(changed.endpoint);
      laterResumes.push({ leaf, originalRequest: originalWrites[0]!, originalOperation, changedEndpoint: current, preparedBase64: preparedBytes.toString("base64"), stdoutBase64: resumed.stdout.toString("base64"), stderrBase64: resumed.stderr.toString("base64"), trace });
    }
    const probe = path.join(root, "receipt-probe.go");
    await writeFile(probe, `package main
import("context";"encoding/json";"fmt";"os";"github.com/jackc/pgx/v5")
type Row struct{ ID string \`json:"id"\`; Count int \`json:"count"\`; Hash string \`json:"hash"\`; Issued string \`json:"issuedAt"\` }
func main(){ctx:=context.Background();cfg,e:=pgx.ParseConfig(os.Getenv("DAYNIGHT_TEST_DATABASE_URL"));if e!=nil{panic("database config failed")};cfg.RuntimeParams["search_path"]=os.Getenv("WEBHOOK_FIXTURE_SCHEMA");c,e:=pgx.ConnectConfig(ctx,cfg);if e!=nil{panic("database failed")};defer c.Close(ctx);var ids []string;if json.Unmarshal([]byte(os.Getenv("WEBHOOK_OPERATION_IDS")),&ids)!=nil{panic("ids failed")};var version string;if c.QueryRow(ctx,"SHOW server_version").Scan(&version)!=nil{panic("version failed")};rows:=make([]Row,0,len(ids));for _,id:=range ids{var r Row;r.ID=id;if c.QueryRow(ctx,"SELECT count(*),coalesce(max(encode(request_sha256,'hex')),''),coalesce(max(issued_at_lexeme),'') FROM webhook_operations WHERE operation_id=$1",id).Scan(&r.Count,&r.Hash,&r.Issued)!=nil{panic("receipt read failed")};rows=append(rows,r)};b,e:=json.Marshal(map[string]any{"databaseVersion":version,"rows":rows});if e!=nil{panic("encoding failed")};fmt.Println(string(b))}
`, { mode: 0o600 });
    const pg = spawn("go", ["run", probe], { cwd: copiedServer, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, WEBHOOK_FIXTURE_SCHEMA: info.schema, WEBHOOK_OPERATION_IDS: JSON.stringify([prepared.operationId, redeliveryPrepared.operationId, teamPrepared.operationId]) } });
    const parts: Buffer[] = []; pg.stdout!.on("data", (part: Buffer) => parts.push(part)); pg.stderr!.resume(); let pgError: unknown; pg.once("error", error => { pgError = error; });
    const pgClosed = new Promise<number | null>(resolve => pg.once("close", code => { children.delete(pg); resolve(code); })); children.set(pg, pgClosed);
    let pgTimer: NodeJS.Timeout | undefined;
    try {
      const status = await Promise.race([pgClosed, new Promise<"timeout">(resolve => { pgTimer = setTimeout(() => resolve("timeout"), 60_000); })]);
      if (status === "timeout") { await terminateInstalledProcess(pg, pgClosed); throw new Error("PostgreSQL receipt probe timed out."); }
      if (pgError !== undefined || status !== 0) throw new Error("PostgreSQL receipt probe failed.");
      const checked = JSON.parse(Buffer.concat(parts).toString()) as { rows: { id: string; count: number; hash: string; issuedAt: string }[] };
      expect(checked.rows).toHaveLength(3);
      for (const [index, item] of [prepared, redeliveryPrepared, teamPrepared].entries()) { expect(checked.rows[index]).toMatchObject({ id: item.operationId, count: 1, hash: item.requestSha256, issuedAt: item.issuedAt }); }
      databaseChecks = checked;
    } finally { if (pgTimer !== undefined) clearTimeout(pgTimer); }
    expect(observations).toHaveLength(21);
  } catch (cause) { failure = cause; }
  const cleanup: unknown[] = [];
  for (const [child, closed] of children) try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanup.push(cause); }
  if (info !== undefined) try { await control("POST", "/__fixture/shutdown"); } catch (cause) { cleanup.push(cause); }
  if (host !== undefined && hostClosed !== undefined) try {
    let timer: NodeJS.Timeout | undefined;
    try { if (await Promise.race([hostClosed.then(() => "closed"), new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10_000); })]) === "timeout") await terminateInstalledProcess(host, hostClosed); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  } catch (cause) { cleanup.push(cause); }
  for (const proxy of [proxyA, proxyB]) try { proxy.closeAllConnections(); if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); } catch (cause) { cleanup.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanup.push(cause); }
  if (process.env.DAYNIGHT_WEBHOOK_RESUME_EVIDENCE !== undefined) try {
    const output = process.env.DAYNIGHT_WEBHOOK_RESUME_EVIDENCE;
    if (!path.isAbsolute(output)) throw new Error("Resume evidence path must be absolute.");
    await writeFile(output, `${JSON.stringify({ source: artifact.source, artifact: { packageVersion: artifact.packageVersion, tarballSha256: artifact.tarballSha256, entrySha256: artifact.entrySha256 }, fixture: { ...info, originalHostSha256, adaptedHostSha256, adaptation: "T05 fixture plus production request logging middleware" }, passed: failure === undefined && cleanup.length === 0, cleanupErrors: cleanup.length, baseline, observations, laterResumes, databaseChecks }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (cause) { cleanup.push(cause); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Webhook resume mismatch acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 240_000);
