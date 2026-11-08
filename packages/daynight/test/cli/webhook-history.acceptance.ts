import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

type Info = { url: string; userId: string; memberId: string; teamId: string; projectId: string; receiverUrl: string; schema: string };
type Observation = { args: string[]; status: number | null; stdout: Buffer; stderr: Buffer };
type Wire = { method: string; path: string; status: number; body: Buffer; response: Buffer[] };
const digest = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const secret = (prefix: string): string => prefix + randomBytes(32).toString("base64url");
const database = process.env.DAYNIGHT_TEST_DATABASE_URL;

it.skipIf(database === undefined)("preserves secret rotation receipts, Team receipt access and Step history through installed CLI", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const root = path.join(receipt.root, "webhook-history");
  const home = path.join(root, "home"), config = path.join(root, "config"), tmp = path.join(root, "tmp");
  const serverSource = path.resolve(import.meta.dirname, "../../../daynight-server");
  const serverCopy = path.join(root, "server");
  const admin = secret("dnpat_"), member = secret("dnpat_");
  const sensitive = [admin, member];
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
  const invoke = async (args: string[], input?: string) => {
    const child = spawn(receipt.launcherPath, ["webhook", ...args], { cwd: root, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
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
      const observed = { args, status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }; calls.push(observed); return observed;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const call = async (args: string[], input?: string): Promise<any> => {
    const result = await invoke([...args, "--json"], input);
    expect(result.status, `webhook ${args.slice(0, 2).join(" ")} exited ${result.status}`).toBe(0);
    expect(result.stderr.length).toBe(0); expect(result.stdout.at(-1)).toBe(10);
    return JSON.parse(result.stdout.toString());
  };
  const control = async (method: string, route: string, value?: unknown) => {
    const response = await fetch(info!.url + route, { method, headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const bytes = Buffer.from(await response.arrayBuffer()); controls.push({ method, path: route, status: response.status, response: bytes });
    if (!response.ok) throw new Error(`Fixture control failed: ${method} ${route} (${response.status}).`);
    return bytes.length ? JSON.parse(bytes.toString()) : undefined;
  };
  try {
    await Promise.all([home, config, tmp].map(dir => mkdir(dir, { recursive: true })));
    await cp(serverSource, serverCopy, { recursive: true });
    const filename = path.join(serverCopy, "testdata/webhook-host/main.go");
    const original = await readFile(filename, "utf8");
    const adapted = original.replace('authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"', '"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"\n\tauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"').replace("\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    if (adapted === original || !adapted.includes("httpx.RequestLogging(logger, mux).ServeHTTP(w, r)")) throw new Error("Could not apply request logging to the fixture copy.");
    originalHash = digest(Buffer.from(original)); adaptedHash = digest(Buffer.from(adapted)); await writeFile(filename, adapted);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: serverCopy, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: admin, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: secret("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: member } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const line = new Promise<string>((resolve, reject) => {
      let text = ""; host!.once("error", reject); host!.stderr!.resume();
      host!.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); const newline = text.indexOf("\n"); if (newline >= 0) resolve(text.slice(0, newline)); });
      host!.once("close", () => reject(new Error("History fixture exited before readiness.")));
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try { info = JSON.parse(await Promise.race([line, new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("History fixture did not become ready.")), 60_000); })])) as Info; }
    finally { if (startupTimer !== undefined) clearTimeout(startupTimer); }
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (address === null || typeof address === "string") throw new Error("Missing proxy address.");
    const setActor = (value: string) => writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${value}\n`, { mode: 0o600 });
    await setActor(admin);
    const definition = { name: "History and signing", enabled: true, destination: { kind: "http", adapterVersion: "1", configuration: { url: info.receiverUrl } }, subscriptions: [{ id: null, projectId: info.projectId, eventTypes: ["task.created", "task.step_updated"] }] };
    const created = await call(["create", "--team", info.teamId, "--stdin", "--confirm"], JSON.stringify(definition));
    const id = created.endpoint.id as string;
    const initial = await call(["secret", "show", id, "--team", info.teamId, "--reveal"]); sensitive.push(initial.secret);
    const rotationPath = path.join(root, "rotation.json");
    const beforeRotate = wire.length;
    const rotation = await call(["secret", "rotate", id, "--team", info.teamId, "--mode", "overlap", "--if-version", created.endpoint.configVersion, "--confirm", "--operation-out", rotationPath]);
    expect(rotation.signing.overlapUntil).not.toBeNull();
    expect(rotation.signing.activeKeyId).not.toBe(initial.keyId);
    expect(rotation.operation.keyId).toBe(rotation.signing.activeKeyId);
    expect(rotation.operation.destinationRevisionAfter).toBe(created.endpoint.destinationRevision);
    expect(wire.slice(beforeRotate).filter(record => record.method === "POST")).toHaveLength(1);
    expect(wire.slice(beforeRotate).some(record => record.path.endsWith("/signing-secret"))).toBe(false);
    const repeatedOverlap = await invoke(["secret", "rotate", id, "--team", info.teamId, "--mode", "overlap", "--if-version", rotation.operation.configVersionAfter, "--confirm", "--json"]);
    expect(repeatedOverlap.status).toBe(1); expect(repeatedOverlap.stdout.length).toBe(0);
    const immediate = await call(["secret", "rotate", id, "--team", info.teamId, "--mode", "immediate", "--if-version", rotation.operation.configVersionAfter, "--confirm"]);
    expect(immediate.signing.activeKeyId).not.toBe(rotation.signing.activeKeyId);
    expect(immediate.operation.destinationRevisionAfter).toBe(rotation.operation.destinationRevisionAfter);
    const current = await call(["secret", "show", id, "--team", info.teamId, "--reveal"]); sensitive.push(current.secret);
    expect(current.keyId).toBe(immediate.signing.activeKeyId);
    const originalReceipt = await call(["operation", "show", rotation.operation.operationId, "--team", info.teamId]);
    expect(originalReceipt.keyId).toBe(rotation.signing.activeKeyId);
    const beforeRotationResume = wire.length;
    const rotationResume = await call(["secret", "rotate", id, "--team", info.teamId, "--mode", "overlap", "--if-version", created.endpoint.configVersion, "--confirm", "--resume-operation", rotationPath]);
    expect(rotationResume.operation.keyId).toBe(rotation.signing.activeKeyId);
    expect(wire.slice(beforeRotationResume).filter(record => record.method === "POST")).toHaveLength(0);
    const memberships = await control("GET", `/api/v1/teams/${info.teamId}/members`);
    const memberBefore = memberships.items.find((item: any) => item.userId === info!.memberId);
    const promoted = await control("PATCH", `/api/v1/teams/${info.teamId}/members/${info.memberId}`, { version: memberBefore.version, role: "admin", expectedUserId: info.userId });
    await setActor(member);
    const memberInput = path.join(root, "member-input.json"), memberPrepared = path.join(root, "member-prepared.json");
    await writeFile(memberInput, JSON.stringify({ ...definition, name: "Member operation", subscriptions: [] }), { mode: 0o600 });
    const memberCreated = await call(["create", "--team", info.teamId, "--file", memberInput, "--confirm", "--operation-out", memberPrepared]);
    expect(memberCreated.operation.actorUserId).toBe(info.memberId);
    await unlink(memberInput);
    const beforeMissingInput = wire.length;
    const missingInput = await invoke(["create", "--team", info.teamId, "--file", memberInput, "--confirm", "--resume-operation", memberPrepared, "--json"]);
    expect(missingInput.status).toBe(1); expect(missingInput.stdout.length).toBe(0);
    expect(JSON.parse(missingInput.stderr.toString()).error.operationOutcome).toBe("unknown");
    expect(wire.slice(beforeMissingInput).filter(record => record.method === "POST")).toHaveLength(0);
    await setActor(admin);
    await control("PATCH", `/api/v1/teams/${info.teamId}/members/${info.memberId}`, { version: promoted.membership.version, role: "member", expectedUserId: info.userId });
    const adminReadsOther = await call(["operation", "show", memberCreated.operation.operationId, "--team", info.teamId]);
    expect(adminReadsOther.actorUserId).toBe(info.memberId); expect(adminReadsOther.requestSha256).toBe(memberCreated.operation.requestSha256);
    await setActor(member);
    const memberOwn = await call(["operation", "show", memberCreated.operation.operationId, "--team", info.teamId]);
    expect(memberOwn.actorUserId).toBe(info.memberId);
    const memberOther = await invoke(["operation", "show", created.operation.operationId, "--team", info.teamId, "--json"]);
    expect(memberOther.status).toBe(1); expect(memberOther.stdout.length).toBe(0);
    await setActor(admin);
    const since = new Date(Date.now() - 60_000).toISOString();
    const task = await control("POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "Parent retained" });
    const added = await control("POST", `/api/v1/projects/${info.projectId}/tasks/${task.id}/steps`, { version: task.version, id: "00000001", title: "Step retained" });
    const stepPage = await call(["delivery", "list", id, "--team", info.teamId, "--event-type", "task.step_updated"]);
    expect(stepPage.items).toHaveLength(1);
    const stepDelivery = stepPage.items[0].id as string;
    const beforePayload = await call(["delivery", "payload", id, stepDelivery, "--team", info.teamId]);
    await control("DELETE", `/api/v1/projects/${info.projectId}/tasks/${task.id}/steps/00000001`, { version: added.version });
    const afterPayload = await call(["delivery", "payload", id, stepDelivery, "--team", info.teamId]);
    expect(afterPayload.body).toBe(beforePayload.body); expect(afterPayload.sha256).toBe(beforePayload.sha256);
    const until = new Date(Date.now() + 60_000).toISOString();
    const beforeFilters = wire.length;
    const filtered = await call(["delivery", "list", id, "--team", info.teamId, "--event-type", "task.step_updated", "--state", "pending", "--project", info.projectId, "--from", since, "--to", until, "--limit", "1"]);
    expect(filtered.items).toHaveLength(1); expect(filtered.nextCursor).toBeTruthy(); expect(filtered.historyMayBeIncomplete).toBe(true);
    const queries = wire.slice(beforeFilters).filter(record => record.path.includes("/deliveries?")); expect(queries).toHaveLength(1);
    const params = new URL(queries[0]!.path, "http://127.0.0.1").searchParams;
    expect(params.get("state")).toBe("pending"); expect(params.get("from")).toBe(since); expect(params.get("to")).toBe(until); expect(params.get("eventType")).toBe("task.step_updated"); expect(params.get("projectId")).toBe(info.projectId);
    const longFrom = `${since.slice(0, -1)}000000001Z`, longTo = `${until.slice(0, -1)}000000009Z`;
    const beforeLongFilters = wire.length;
    const longFiltered = await call(["delivery", "list", id, "--team", info.teamId, "--event-type", "task.step_updated", "--from", longFrom, "--to", longTo]);
    expect(longFiltered.items.length).toBeGreaterThan(0);
    const longRequests = wire.slice(beforeLongFilters).filter(record => record.path.includes("/deliveries?"));
    expect(longRequests).toHaveLength(1); expect(longRequests[0]!.status).toBe(200);
    const longParams = new URL(longRequests[0]!.path, "http://127.0.0.1").searchParams;
    expect(longParams.get("from")).toBe(longFrom); expect(longParams.get("to")).toBe(longTo);
    const equalFrom = "2026-01-01T00:00:00.1234567899Z", equalTo = "2026-01-01T00:00:00.1234567890Z";
    const beforeEqualFilters = wire.length;
    const equal = await call(["delivery", "list", id, "--team", info.teamId, "--from", equalFrom, "--to", equalTo]);
    expect(equal.items).toEqual([]);
    const equalRequests = wire.slice(beforeEqualFilters).filter(record => record.path.includes("/deliveries?"));
    expect(equalRequests).toHaveLength(1); expect(equalRequests[0]!.status).toBe(200);
    const equalParams = new URL(equalRequests[0]!.path, "http://127.0.0.1").searchParams;
    expect(equalParams.get("from")).toBe(equalFrom); expect(equalParams.get("to")).toBe(equalTo);
    for (const invalid of [
      ["--from", "2026-01-01T00:00:00.123000002Z", "--to", "2026-01-01T00:00:00.123000001Z"],
      ["--from", "2026-01-01T00:00:00+00:00"], ["--to", "2026-01-01T00:00:00+00:00"],
    ]) {
      const beforeInvalid = wire.length;
      const result = await invoke(["delivery", "list", id, "--team", info.teamId, ...invalid, "--json"]);
      expect(result.status).toBe(2); expect(result.stdout.length).toBe(0); expect(wire.slice(beforeInvalid)).toEqual([]);
    }
    const delivered = await call(["delivery", "list", id, "--team", info.teamId, "--state", "delivered"]); expect(delivered.items).toEqual([]);
    const human = await invoke(["delivery", "list", id, "--team", info.teamId, "--event-type", "task.step_updated", "--limit", "1"]);
    expect(human.status).toBe(0); expect(human.stderr.length).toBe(0);
    expect(human.stdout.toString()).toContain("nextCursor"); expect(human.stdout.toString()).toContain("historyMayBeIncomplete");
    expect(human.stdout.toString()).not.toContain(info.receiverUrl);
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
  if (process.env.DAYNIGHT_WEBHOOK_HISTORY_EVIDENCE !== undefined) try {
    const evidence = process.env.DAYNIGHT_WEBHOOK_HISTORY_EVIDENCE;
    if (!path.isAbsolute(evidence)) throw new Error("Webhook history evidence path must be absolute.");
    const safe = (bytes: Buffer, withhold = false) => {
      const hidden = withhold || sensitive.some(marker => bytes.includes(Buffer.from(marker)));
      return { length: bytes.length, sha256: digest(bytes), base64: hidden ? null : bytes.toString("base64"), withheld: hidden };
    };
    const material = { source: receipt.source, artifact: { packageVersion: receipt.packageVersion, tarballSha256: receipt.tarballSha256, entrySha256: receipt.entrySha256 }, fixture: { ...info, originalHostSha256: originalHash, adaptedHostSha256: adaptedHash, adapter: "copy of T05 fixture with production httpx.RequestLogging around mux" }, passed: failure === undefined && cleanup.length === 0, cleanupErrors: cleanup.length, calls: calls.map(call => ({ args: call.args, status: call.status, stdout: safe(call.stdout, call.args.includes("--reveal")), stderr: safe(call.stderr) })), requests: wire.map(record => ({ method: record.method, path: record.path, status: record.status, body: safe(record.body), response: safe(Buffer.concat(record.response), record.path.endsWith("/signing-secret")) })), controls: controls.map(record => ({ ...record, response: safe(record.response) })) };
    await writeFile(evidence, `${JSON.stringify(material, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (cause) { cleanup.push(cause); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Webhook history acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 180_000);
