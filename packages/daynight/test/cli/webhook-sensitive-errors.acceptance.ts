import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

// This fixture runs only when an isolated PostgreSQL database is explicitly enabled.
const database = process.env.DAYNIGHT_TEST_DATABASE_URL;
const enabled = database !== undefined && process.env.DAYNIGHT_WEBHOOK_SENSITIVE_ERRORS === "1";
const token = (prefix: string): string => prefix + randomBytes(32).toString("base64url");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const secretCanary = "canary-secret-whsec-private-body-url";
type HostInfo = { url: string; userId: string; teamId: string; projectId: string; receiverUrl: string; schema: string };

it.skipIf(!enabled)("redacts sensitive input and read output failures", async () => {
  const installed = await createAcceptanceCli();
  const { receipt: artifact } = installed;
  const root = path.join(artifact.root, "webhook-sensitive-errors"), config = path.join(root, "config"), tmp = path.join(root, "tmp"), home = path.join(root, "home");
  const originalServer = path.resolve(import.meta.dirname, "../../../daynight-server"), copiedServer = path.join(root, "server");
  const admin = token("dnpat_"), member = token("dnpat_");
  const children = new Map<ChildProcess, Promise<unknown>>();
  const observations: unknown[] = [];
  let info: HostInfo | undefined, host: ChildProcess | undefined, hostClosed: Promise<unknown> | undefined;
  let failure: unknown, originalHostSha256 = "", adaptedHostSha256 = "";
  const records: { method: string; path: string; status: number }[] = [];
  const proxy = createServer((incoming, outgoing) => {
    const input: Buffer[] = []; incoming.on("data", (part: Buffer) => input.push(part));
    incoming.on("end", () => {
      const target = new URL(incoming.url!, info!.url);
      const upstream = httpRequest(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
        records.push({ method: incoming.method!, path: incoming.url!, status: response.statusCode! });
        outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing);
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.end(Buffer.concat(input));
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
  const preload = path.join(root, "output-preload.cjs"), helper = path.join(root, "output-helper.cjs");
  try {
    await Promise.all([home, config, tmp].map(dir => mkdir(dir, { recursive: true })));
    await writeFile(helper, `const fault=process.env.WEBHOOK_OUTPUT_FAULT;let buffer=Buffer.alloc(0);process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length<4||buffer.length<4+buffer.readUInt32BE(0))return;const bytes=buffer.subarray(4,4+buffer.readUInt32BE(0));buffer=Buffer.alloc(0);if(fault==='stdout'){process.send({type:'error',message:'${secretCanary} https://secret.invalid/private?token=payload',code:'EIO'});return;}process.stdout.write(bytes,()=>process.send({type:'written'}));});process.stdin.on('end',()=>{if(fault==='cleanup'){process.exitCode=17;if(process.connected)process.disconnect();}});`, { mode: 0o600 });
    await writeFile(preload, `const cp=require('node:child_process');const mod=require('node:module');const original=cp.spawn;const fault=process.env.WEBHOOK_OUTPUT_FAULT;const fs=require('node:fs/promises');const open=fs.open;fs.open=async function(path,...args){if(fault==='input'&&String(path).endsWith('sensitive-input.json')){const cause=new Error('${secretCanary} https://secret.invalid/private?token=payload');cause.cause=new Error('${secretCanary} nested');throw cause}return open.call(this,path,...args)};cp.spawn=function(command,args,options){if(fault!=='cleanup'&&Array.isArray(args)&&String(args[0]).endsWith('byte-output-helper.js'))args=[process.env.WEBHOOK_OUTPUT_HELPER];return original.call(this,command,args,options)};mod.syncBuiltinESMExports();if(fault==='cleanup'){const off=process.off;process.off=function(event,listener){if(event==='SIGTERM')throw new Error('${secretCanary} https://secret.invalid/private?token=payload');return off.call(this,event,listener)}}`, { mode: 0o600 });
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

    const inputFile = path.join(root, "sensitive-input.json");
    const definition = { name: "Sensitive input", enabled: true, destination: { kind: "http", adapterVersion: "1", configuration: { url: `${info.receiverUrl}?${secretCanary}` } }, subscriptions: [{ id: null, projectId: info.projectId, eventTypes: ["task.created"] }] };
    await writeFile(inputFile, JSON.stringify(definition), { mode: 0o600 });
    const created = await control("POST", "/api/v1/me/webhooks", { ...definition, operationId: randomUUID(), issuedAt: new Date().toISOString(), expectedUserId: info.userId });
    const endpoint = created.endpoint.id as string;
    await control("POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "Sensitive payload source" });
    const history = await control("GET", `/api/v1/me/webhooks/${endpoint}/deliveries`);
    expect(history.items).toHaveLength(1);
    const delivery = history.items[0].id as string;
    const payload = await control("GET", `/api/v1/me/webhooks/${endpoint}/deliveries/${delivery}/payload`);
    const payloadBytes = Buffer.from(payload.body, "base64");
    const actualSecret = (await control("GET", `/api/v1/me/webhooks/${endpoint}/signing-secret`)).secret as string;
    const sensitive = [secretCanary, "secret.invalid", actualSecret, info.receiverUrl, payloadBytes.toString()];
    const cases = [
      { name: "input", args: ["create", "--personal", "--file", inputFile, "--confirm", "--json"], fault: "input", phase: "input", outcome: "not_submitted", path: null },
      { name: "secret-stdout", args: ["secret", "show", endpoint, "--personal", "--reveal", "--json"], fault: "stdout", phase: "output", outcome: "read_failed", path: `/api/v1/me/webhooks/${endpoint}/signing-secret` },
      { name: "secret-cleanup", args: ["secret", "show", endpoint, "--personal", "--reveal", "--json"], fault: "cleanup", phase: "output", outcome: "read_failed", path: `/api/v1/me/webhooks/${endpoint}/signing-secret` },
      { name: "payload-json-stdout", args: ["delivery", "payload", endpoint, delivery, "--personal", "--json"], fault: "stdout", phase: "output", outcome: "read_failed", path: `/api/v1/me/webhooks/${endpoint}/deliveries/${delivery}/payload` },
      { name: "payload-json-cleanup", args: ["delivery", "payload", endpoint, delivery, "--personal", "--json"], fault: "cleanup", phase: "output", outcome: "read_failed", path: `/api/v1/me/webhooks/${endpoint}/deliveries/${delivery}/payload` },
      { name: "payload-raw-stdout", args: ["delivery", "payload", endpoint, delivery, "--personal"], fault: "stdout", phase: "output", outcome: "read_failed", path: `/api/v1/me/webhooks/${endpoint}/deliveries/${delivery}/payload` },
      { name: "payload-raw-cleanup", args: ["delivery", "payload", endpoint, delivery, "--personal"], fault: "cleanup", phase: "output", outcome: "read_failed", path: `/api/v1/me/webhooks/${endpoint}/deliveries/${delivery}/payload` },
    ];
    for (const item of cases) {
      const before = records.length;
      const child = crossSpawn(artifact.launcherPath, ["webhook", ...item.args], { cwd: root, env: { ...env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, WEBHOOK_OUTPUT_HELPER: helper, WEBHOOK_OUTPUT_FAULT: item.fault }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [], err: Buffer[] = []; child.stdout!.on("data", (part: Buffer) => out.push(part)); child.stderr!.on("data", (part: Buffer) => err.push(part));
      let launchError: unknown; child.once("error", error => { launchError = error; });
      const closed = new Promise<number | null>(resolve => child.once("close", code => { children.delete(child); resolve(code); })); children.set(child, closed);
      let timer: NodeJS.Timeout | undefined;
      try {
        const status = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 15_000); })]);
        if (status === "timeout") { await terminateInstalledProcess(child, closed); throw new Error(`${item.name} timed out.`); }
        if (launchError !== undefined) throw launchError;
        const stdout = Buffer.concat(out), stderr = Buffer.concat(err), trace = records.slice(before);
        expect(status, item.name).toBe(1);
        if (item.fault !== "cleanup") expect(stdout.length, item.name).toBe(0);
        else if (item.name === "payload-raw-cleanup") expect(stdout).toEqual(payloadBytes);
        else if (item.name === "secret-cleanup") expect(JSON.parse(stdout.toString()).secret).toBe(actualSecret);
        else if (item.name === "payload-json-cleanup") expect(JSON.parse(stdout.toString())).toEqual(payload);
        const stderrText = stderr.toString();
        for (const secret of sensitive) expect(stderrText, item.name).not.toContain(secret);
        let error: unknown = null;
        if (item.args.includes("--json")) {
          error = JSON.parse(stderrText).error;
          expect(error).toMatchObject({ phase: item.phase, invocationOutcome: item.outcome, operationOutcome: null });
          for (const secret of sensitive) expect(JSON.stringify(error), item.name).not.toContain(secret);
        }
        expect(trace.filter(record => record.method !== "GET")).toHaveLength(0);
        if (item.path === null) expect(trace.filter(record => record.path.startsWith("/api/v1/me/webhooks"))).toHaveLength(0);
        else expect(trace.filter(record => record.path === item.path && record.method === "GET" && record.status === 200)).toHaveLength(1);
        observations.push({ name: item.name, fault: item.fault, expectedPhase: item.phase, expectedOutcome: item.outcome, status, stdoutLength: stdout.length, stdoutSha256: sha(stdout), stderrBase64: stderr.toString("base64"), error, requests: trace.map(record => ({ method: record.method, path: record.path, status: record.status })) });
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    expect(observations).toHaveLength(cases.length);
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
  if (process.env.DAYNIGHT_WEBHOOK_SENSITIVE_EVIDENCE !== undefined) try {
    const output = process.env.DAYNIGHT_WEBHOOK_SENSITIVE_EVIDENCE;
    if (!path.isAbsolute(output)) throw new Error("Sensitive evidence path must be absolute.");
    await writeFile(output, `${JSON.stringify({ source: artifact.source, artifact: { packageVersion: artifact.packageVersion, tarballSha256: artifact.tarballSha256, entrySha256: artifact.entrySha256 }, fixture: { ...info, originalHostSha256, adaptedHostSha256, adaptation: "T05 fixture plus production request logging middleware" }, passed: failure === undefined && cleanup.length === 0, cleanupErrors: cleanup.length, observations }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (cause) { cleanup.push(cause); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Webhook sensitive error acceptance or cleanup failed.");
  if (failure !== undefined) throw failure;
}, 420_000);
