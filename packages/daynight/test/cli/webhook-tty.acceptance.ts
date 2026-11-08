import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as pty from "node-pty";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";
import { createSkillFixture } from "../fixtures/skill-terminal.js";

const database = process.env.DAYNIGHT_TEST_DATABASE_URL;
const token = (prefix: string) => prefix + randomBytes(32).toString("base64url");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Host = { url: string; userId: string; teamId: string; projectId: string; receiverUrl: string; schema: string };
type Request = { method: string; path: string; body: Buffer; status: number };

// The terminal bridge keeps stdin and stderr on the PTY while preserving stdout bytes separately.
it.skipIf(database === undefined || process.platform === "win32")("uses the installed CLI's explicit Webhook confirmation and cancellation against production routes", async () => {
  const installed = await createAcceptanceCli();
  const fixture = await createSkillFixture(installed.receipt.root, []);
  const config = path.join(fixture.root, "webhook-config");
  const serverCopy = path.join(fixture.root, "server");
  const requests: Request[] = [];
  const results: { args: string[]; answer: string; promptAt: string; exitCode: number | null; transcript: string; stdoutSha256: string; stdoutBytes: number; stdoutBase64: string; preparedBase64?: string; preparedMode?: number }[] = [];
  const pipeResults: { args: string[]; status: number | null; stdoutBase64: string; stderrBase64: string }[] = [];
  const preparationCases: { leaf: string; scenario: string; status: number | null; businessWrites: number; marker?: unknown }[] = [];
  const pending = new Map<ChildProcess, Promise<unknown>>();
  let host: ChildProcess | undefined, hostClosed: Promise<unknown> | undefined, info: Host | undefined;
  let primary: unknown;
  const pat = token("dnpat_");
  const secretCanary = "prompt-private-token";
  const proxy = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (value: Buffer) => chunks.push(value));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      const target = new URL(incoming.url!, info!.url);
      const upstream = httpRequest(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
        requests.push({ method: incoming.method!, path: incoming.url!, body, status: response.statusCode! });
        outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing);
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.end(body);
    });
  });
  let sequence = 0;
  const terminal = async (args: string[], answer: "y" | "n" | "interrupt", alias = false) => {
    const id = sequence++, output = path.join(fixture.root, `tty-${id}.out`), result = path.join(fixture.root, `tty-${id}.json`);
    const preparedPath = path.join(fixture.root, `tty-${id}-prepared.json`);
    const actualArgs = answer === "y" ? [...args, "--operation-out", preparedPath] : args;
    const launcherPath = alias ? path.join(path.dirname(installed.receipt.launcherPath), "dn") : installed.receipt.launcherPath;
    const p = pty.spawn(process.execPath, [path.join(import.meta.dirname, "../fixtures/skill-terminal-bridge.mjs"), JSON.stringify({ launcherPath, args: actualArgs, cwd: fixture.root, stdoutPath: output, resultPath: result })], { name: "xterm-256color", cols: 120, rows: 35, cwd: fixture.root, env: fixture.environment });
    let transcript = "", exited = false;
    const listener = p.onData(data => { transcript += data; });
    const closed = new Promise<void>(resolve => p.onExit(() => { exited = true; resolve(); }));
    const deadline = Date.now() + 30_000;
    const wait = async (predicate: () => boolean) => { while (!predicate()) { if (exited || Date.now() >= deadline) throw new Error("Terminal confirmation did not complete."); await delay(20); } };
    let completed = false;
    try {
      const before = requests.filter(r => r.method !== "GET").length;
      await wait(() => stripVTControlCharacters(transcript).includes("[y/N]:"));
      const promptAt = new Date().toISOString();
      expect(requests.filter(r => r.method !== "GET")).toHaveLength(before);
      expect(transcript).not.toContain(secretCanary); expect(transcript).not.toContain(info!.receiverUrl); expect(transcript).not.toContain(pat);
      p.write(answer === "interrupt" ? "\x03" : `${answer}\r`);
      await wait(() => exited);
      const bridge = JSON.parse(await readFile(result, "utf8")) as { code: number | null; signal: string | null; stdinTerminal: boolean; stderrTerminal: boolean; stdoutTerminal: boolean; failure?: string };
      expect(bridge.failure).toBeUndefined(); expect(bridge.stdinTerminal).toBe(true); expect(bridge.stderrTerminal).toBe(true); expect(bridge.stdoutTerminal).toBe(false);
      const stdout = await readFile(output);
      let preparedBase64: string | undefined, preparedMode: number | undefined;
      if (answer !== "y") { expect(bridge.code).toBe(1); expect(stdout.length).toBe(0); expect(requests.filter(r => r.method !== "GET")).toHaveLength(before); }
      else {
        expect(bridge.code).toBe(0);
        const writes = requests.filter(r => r.method !== "GET").slice(before); expect(writes).toHaveLength(1);
        const body = JSON.parse(writes[0]!.body.toString()) as { operationId: string; issuedAt: string };
        expect(body.operationId).toMatch(/^[a-f0-9-]{36}$/); expect(Date.parse(body.issuedAt)).toBeGreaterThanOrEqual(Date.parse(promptAt));
        const preparedBytes = await readFile(preparedPath), prepared = JSON.parse(preparedBytes.toString());
        preparedMode = (await stat(preparedPath)).mode & 0o777; preparedBase64 = preparedBytes.toString("base64");
        expect(preparedMode).toBe(0o600); expect(prepared.operationId).toBe(body.operationId); expect(prepared.issuedAt).toBe(body.issuedAt);
        expect(prepared.requestSha256).toBe(sha(writes[0]!.body)); expect(preparedBytes.toString()).not.toContain(secretCanary); expect(preparedBytes.toString()).not.toContain(info!.receiverUrl);
      }
      results.push({ args: actualArgs, answer, promptAt, exitCode: bridge.code, transcript, stdoutSha256: sha(stdout), stdoutBytes: stdout.length, stdoutBase64: stdout.toString("base64"), ...(preparedBase64 === undefined || preparedMode === undefined ? {} : { preparedBase64, preparedMode }) });
      completed = true;
      return stdout.length ? JSON.parse(stdout.toString()) : undefined;
    } finally {
      listener.dispose();
      if (!completed && !exited) { try { process.kill(-p.pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } p.kill(); await Promise.race([closed, delay(5_000)]); }
    }
  };
  const pipe = async (args: string[], input: Buffer | undefined, interrupt = false, preload?: string) => {
    const env = preload === undefined ? fixture.environment : { ...fixture.environment, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
    const child = spawn(installed.receipt.launcherPath, args, { cwd: fixture.root, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let launchError: unknown; child.once("error", error => { launchError = error; });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout!.on("data", (part: Buffer) => stdout.push(part)); child.stderr!.on("data", (part: Buffer) => stderr.push(part));
    const closed = new Promise<number | null>(resolve => child.once("close", code => { pending.delete(child); resolve(code); })); pending.set(child, closed);
    if (!interrupt) child.stdin!.end(input);
    else {
      const before = requests.length, limit = Date.now() + 15_000;
      while (requests.slice(before).every(r => r.path !== "/api/v1/me")) { if (Date.now() >= limit) throw new Error("Pipe command did not authenticate."); await delay(20); }
      child.kill("SIGINT");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 30_000); })]);
      if (status === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed pipe command timed out."); }
      if (launchError !== undefined) throw launchError;
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
      pipeResults.push({ args, status, stdoutBase64: out.toString("base64"), stderrBase64: err.toString("base64") });
      return { status, stdout: out, stderr: err };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const control = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(info!.url + route, { method, headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`Fixture control returned ${response.status}.`);
    const text = await response.text(); return text ? JSON.parse(text) : undefined;
  };
  try {
    await mkdir(config, { recursive: true });
    const originalServer = path.resolve(import.meta.dirname, "../../../daynight-server");
    await cp(originalServer, serverCopy, { recursive: true });
    const fixtureSource = path.join(serverCopy, "testdata/webhook-host/main.go");
    const original = await readFile(fixtureSource, "utf8");
    const withMiddleware = original.replace('authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"', '"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"\n\tauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"').replace("\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    if (withMiddleware === original || !withMiddleware.includes("httpx.RequestLogging(logger, mux).ServeHTTP(w, r)")) throw new Error("Fixture middleware preparation failed.");
    await writeFile(fixtureSource, withMiddleware);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: serverCopy, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: pat, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: token("dnpat_") } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const ready = new Promise<string>((resolve, reject) => {
      let text = ""; host!.once("error", reject); host!.stdout!.on("data", (part: Buffer) => { text += part.toString(); const n = text.indexOf("\n"); if (n >= 0) resolve(text.slice(0, n)); }); host!.once("close", () => reject(new Error("Webhook fixture exited before readiness."))); host!.stderr!.resume();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { info = JSON.parse(await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Webhook fixture startup timed out.")), 60_000); })])) as Host; }
    finally { if (timer !== undefined) clearTimeout(timer); }
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (address === null || typeof address === "string") throw new Error("Proxy address missing.");
    fixture.environment.DN_CONFIG_DIR = config;
    await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${pat}\n`, { mode: 0o600 });
    const input = { name: "PTY input", enabled: true, destination: { kind: "http", adapterVersion: "1", configuration: { url: `${info.receiverUrl}?token=${secretCanary}` } }, subscriptions: [{ id: null, projectId: info.projectId, eventTypes: ["task.created"] }] };
    const inputPath = path.join(fixture.root, "create.json"); await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    const emptyFile = path.join(fixture.root, "empty-subscriptions.json"); await writeFile(emptyFile, "[]", { mode: 0o600 });
    const updateFile = path.join(fixture.root, "update.json"); await writeFile(updateFile, JSON.stringify({ name: "PTY changed" }), { mode: 0o600 });
    const dummyEndpoint = randomUUID(), dummyDelivery = randomUUID(), personal = "--personal";
    const cancelled = [
      ["create", personal, "--file", inputPath], ["update", dummyEndpoint, personal, "--if-version", "1", "--file", updateFile],
      ["enable", dummyEndpoint, personal, "--if-version", "1"], ["disable", dummyEndpoint, personal, "--if-version", "1"], ["delete", dummyEndpoint, personal, "--if-version", "1"],
      ["subscription", "replace", dummyEndpoint, personal, "--if-version", "1", "--file", emptyFile], ["subscription", "reconfirm", dummyEndpoint, personal, "--if-version", "1", "--project", info.projectId],
      ["secret", "rotate", dummyEndpoint, personal, "--if-version", "1", "--mode", "immediate"], ["delivery", "redeliver", dummyEndpoint, dummyDelivery, personal, "--if-version", "1", "--if-generation", "1"],
    ];
    for (const [index, args] of cancelled.entries()) await terminal(["webhook", ...args, "--json"], "n", index % 2 === 1);
    const preload = path.join(fixture.root, "prepared-fault.cjs");
    await writeFile(preload, `const fs=require('node:fs'), p=require('node:fs/promises'), m=require('node:module');
const open=p.open;
p.open=async function(path,...args){const file=await open.call(this,path,...args),name=String(path);if(name.includes('prepare-fault-write-')){const write=file.writeFile.bind(file);file.writeFile=async()=>{await write(Buffer.from('partial'));const s=await file.stat();fs.writeFileSync(name+'.marker',JSON.stringify({mode:s.mode&0o777,bytes:s.size}));throw new Error('injected prepared write failure')};}else if(name.includes('prepare-fault-close-')){const close=file.close.bind(file);file.close=async()=>{const s=await file.stat();await close();fs.writeFileSync(name+'.marker',JSON.stringify({mode:s.mode&0o777,bytes:s.size}));throw new Error('injected prepared close failure')};}return file};
m.syncBuiltinESMExports();`, { mode: 0o600 });
    const existing = path.join(fixture.root, "existing-prepared.json"), sentinel = "existing prepared sentinel";
    await writeFile(existing, sentinel, { mode: 0o600 });
    const now = new Date().toISOString(), selectedId = randomUUID(), missing = path.join(fixture.root, "missing-prepared.json");
    for (const [index, args] of cancelled.entries()) {
      const leaf = args.slice(0, args[0] === "subscription" || args[0] === "secret" || args[0] === "delivery" ? 2 : 1).join(" ");
      const cases: { scenario: string; extra: string[]; expected: number; fault?: string }[] = [
        { scenario: "non-tty-no-confirm", extra: [], expected: 2 },
        { scenario: "operation-id-only", extra: ["--confirm", "--operation-id", selectedId], expected: 2 },
        { scenario: "issued-at-only", extra: ["--confirm", "--issued-at", now], expected: 2 },
        { scenario: "resume-and-identity", extra: ["--confirm", "--resume-operation", missing, "--operation-id", selectedId, "--issued-at", now], expected: 2 },
        { scenario: "resume-and-output", extra: ["--confirm", "--resume-operation", missing, "--operation-out", existing], expected: 2 },
        { scenario: "existing-output", extra: ["--confirm", "--operation-out", existing], expected: 1 },
        ...["write", "close"].map(fault => ({ scenario: `prepared-${fault}-failure`, extra: ["--confirm", "--operation-out", path.join(fixture.root, `prepare-fault-${fault}-${index}`)], expected: 1, fault })),
      ];
      for (const item of cases) {
        const before = requests.length;
        const result = await pipe(["webhook", ...args, ...item.extra, "--json"], undefined, false, item.fault === undefined ? undefined : preload);
        expect(result.status, `${leaf}/${item.scenario}`).toBe(item.expected); expect(result.stdout.length).toBe(0);
        const writes = requests.slice(before).filter(r => r.method !== "GET"); expect(writes).toHaveLength(0);
        let marker: unknown;
        if (item.fault !== undefined) {
          const target = item.extra[item.extra.length - 1]!;
          marker = JSON.parse(await readFile(`${target}.marker`, "utf8"));
          expect(marker).toMatchObject({ mode: 0o600 }); expect((marker as { bytes: number }).bytes).toBeGreaterThan(0);
          await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
        }
        preparationCases.push({ leaf, scenario: item.scenario, status: result.status, businessWrites: writes.length, ...(marker === undefined ? {} : { marker }) });
      }
      expect(await readFile(existing, "utf8")).toBe(sentinel);
    }
    await terminal(["webhook", "create", personal, "--file", inputPath, "--json"], "interrupt");
    const beforePipe = requests.length;
    const denied = await pipe(["webhook", "create", personal, "--stdin", "--json"], Buffer.from(JSON.stringify(input)));
    expect(denied.status).toBe(2); expect(denied.stdout.length).toBe(0); expect(requests).toHaveLength(beforePipe);
    const stalled = await pipe(["webhook", "create", personal, "--stdin", "--confirm", "--json"], undefined, true);
    expect(stalled.status).toBe(1); expect(stalled.stdout.length).toBe(0); expect(requests.slice(beforePipe).filter(r => r.method !== "GET")).toHaveLength(0);
    const submitted = await pipe(["webhook", "create", personal, "--stdin", "--confirm", "--json"], Buffer.from(JSON.stringify(input)));
    expect(submitted.status).toBe(0); expect(submitted.stderr.length).toBe(0); expect(JSON.parse(submitted.stdout.toString()).endpoint.owner.id).toBe(info.userId);
    const received = requests.findLast(r => r.method === "POST" && r.path === "/api/v1/me/webhooks")!;
    expect(JSON.parse(received.body.toString()).destination.configuration.url).toBe(input.destination.configuration.url);
    const created = await terminal(["webhook", "create", personal, "--file", inputPath, "--json"], "y");
    const endpoint = created.endpoint.id as string;
    let version = created.endpoint.configVersion as string;
    const update = await terminal(["webhook", "update", endpoint, personal, "--if-version", version, "--file", updateFile, "--json"], "y", true); version = update.endpoint.configVersion;
    const disabled = await terminal(["webhook", "disable", endpoint, personal, "--if-version", version, "--json"], "y"); version = disabled.endpoint.configVersion;
    const enabled = await terminal(["webhook", "enable", endpoint, personal, "--if-version", version, "--json"], "y", true); version = enabled.endpoint.configVersion;
    const subs = await control("GET", `/api/v1/me/webhooks/${endpoint}`);
    const subscriptionsPath = path.join(fixture.root, "subscriptions.json"); await writeFile(subscriptionsPath, JSON.stringify(subs.subscriptions.map((s: { id: string; projectId: string; eventTypes: string[] }) => ({ id: s.id, projectId: s.projectId, eventTypes: s.eventTypes }))));
    const replace = await terminal(["webhook", "subscription", "replace", endpoint, personal, "--if-version", version, "--file", subscriptionsPath, "--json"], "y"); version = replace.endpoint.configVersion;
    const reconfirm = await terminal(["webhook", "subscription", "reconfirm", endpoint, personal, "--if-version", version, "--project", info.projectId, "--json"], "y"); version = reconfirm.endpoint.configVersion;
    const rotation = await terminal(["webhook", "secret", "rotate", endpoint, personal, "--if-version", version, "--mode", "immediate", "--json"], "y"); version = rotation.operation.configVersionAfter;
    await control("POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "PTY source" });
    await control("POST", "/__fixture/runner/start");
    const deadline = Date.now() + 15_000;
    while ((await control("GET", "/__fixture/receiver")).length < 1) { if (Date.now() > deadline) throw new Error("The controlled receiver did not observe the source event."); await delay(50); }
    await control("POST", "/__fixture/runner/stop");
    const history = await control("GET", `/api/v1/me/webhooks/${endpoint}/deliveries`);
    const delivery = history.items[0];
    const redelivery = await terminal(["webhook", "delivery", "redeliver", endpoint, delivery.id, personal, "--if-version", version, "--if-generation", delivery.generation, "--json"], "y");
    expect(redelivery.operation.deliveryId).toBe(delivery.id);
    const deleted = await terminal(["webhook", "delete", endpoint, personal, "--if-version", version, "--json"], "y", true);
    expect(deleted.endpoint.lifecycle).toBe("deleted");
    if (process.env.DAYNIGHT_WEBHOOK_TTY_EVIDENCE) await writeFile(process.env.DAYNIGHT_WEBHOOK_TTY_EVIDENCE, JSON.stringify({ source: installed.receipt.source, packageSha256: installed.receipt.tarballSha256, entrySha256: installed.receipt.entrySha256, fixtureHostSha256: sha(Buffer.from(withMiddleware)), scenarios: results, pipeResults, preparationCases, requests: requests.map(r => ({ method: r.method, path: r.path, status: r.status, bodySha256: sha(r.body), bodyBytes: r.body.length, bodyBase64: r.body.toString("base64") })) }, null, 2), { mode: 0o600 });
  } catch (error) { primary = error; throw error; }
  finally {
    const failures: unknown[] = [];
    for (const [child, closed] of pending) { try { await terminateInstalledProcess(child, closed); } catch (error) { failures.push(error); } }
    if (info !== undefined && host !== undefined) {
      try { await control("POST", "/__fixture/shutdown"); } catch (error) { failures.push(error); }
    }
    if (host !== undefined && hostClosed !== undefined) {
      try { const finished = await Promise.race([hostClosed.then(() => true), delay(10_000).then(() => false)]); if (!finished) await terminateInstalledProcess(host, hostClosed); } catch (error) { failures.push(error); }
    }
    try { proxy.closeAllConnections(); if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); } catch (error) { failures.push(error); }
    try { await installed.cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures], "Webhook terminal fixture cleanup failed.");
  }
});
