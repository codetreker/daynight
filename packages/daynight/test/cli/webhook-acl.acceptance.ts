import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";

const database = process.env.DAYNIGHT_TEST_DATABASE_URL;
const token = (prefix: string): string => prefix + randomBytes(32).toString("base64url");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
type Host = { url: string; userId: string; memberId: string; teamId: string; projectId: string; receiverUrl: string; schema: string };
type Observation = { actor: string; method: string; path: string; status: number; requestSha256: string; responseSha256: string; requestBytes: number; responseBytes: number; requestBase64?: string; responseBase64?: string };

// The fixture composes the production HTTP modules with real authentication and PostgreSQL.
it.skipIf(database === undefined)("enforces Project and Team webhook permissions through the installed CLI", async () => {
  const installed = await createAcceptanceCli();
  const root = path.join(installed.receipt.root, "webhook-acl");
  const serverCopy = path.join(root, "server");
  const adminToken = token("dnpat_"), memberToken = token("dnpat_");
  const observations: Observation[] = [];
  const calls: { actor: string; args: string[]; alias: boolean; status: number | null; stdoutBase64: string; stderrBase64: string }[] = [];
  const children = new Map<ChildProcess, Promise<unknown>>();
  const secrets: string[] = [adminToken, memberToken];
  let info: Host | undefined, host: ChildProcess | undefined, hostClosed: Promise<unknown> | undefined;
  let primary: unknown, originalHostSha = "", fixtureHostSha = "";
  const proxy = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (part: Buffer) => chunks.push(part));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      const upstream = httpRequest(new URL(incoming.url!, info!.url), { method: incoming.method, headers: { ...incoming.headers, host: new URL(info!.url).host } }, response => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => {
          const bytes = Buffer.concat(parts);
          observations.push({ actor: incoming.headers.authorization === `Bearer ${adminToken}` ? "user" : "member", method: incoming.method!, path: incoming.url!, status: response.statusCode!, requestSha256: sha(body), responseSha256: sha(bytes), requestBytes: body.length, responseBytes: bytes.length, requestBase64: body.toString("base64"), responseBase64: bytes.toString("base64") });
        });
        outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing);
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.end(body);
    });
  });
  const control = async (actor: "user" | "member", method: string, route: string, body?: unknown, expected = 200): Promise<any> => {
    const requestBody = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const response = await fetch(info!.url + route, { method, headers: { Authorization: `Bearer ${actor === "user" ? adminToken : memberToken}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: requestBody }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const invitation = route.includes("invitations");
    observations.push({ actor, method, path: route, status: response.status, requestSha256: sha(requestBody), responseSha256: sha(bytes), requestBytes: requestBody.length, responseBytes: bytes.length, ...(invitation ? {} : { requestBase64: requestBody.toString("base64"), responseBase64: bytes.toString("base64") }) });
    expect(response.status, `${actor} ${method} ${route}`).toBe(expected);
    return bytes.length ? JSON.parse(bytes.toString()) : undefined;
  };
  const environment = (actor: "user" | "member"): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete env[key];
    return { ...env, DN_CONFIG_DIR: path.join(root, actor), XDG_CONFIG_HOME: path.join(root, `xdg-${actor}`), XDG_CACHE_HOME: path.join(root, `cache-${actor}`), TMPDIR: path.join(root, "tmp"), NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1" };
  };
  const invoke = async (actor: "user" | "member", args: string[], input?: unknown, alias = false) => {
    const binary = alias ? path.join(path.dirname(installed.receipt.launcherPath), "dn") : installed.receipt.launcherPath;
    const child = spawn(binary, ["webhook", ...args, "--json"], { cwd: root, env: environment(actor), detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout!.on("data", (part: Buffer) => stdout.push(part)); child.stderr!.on("data", (part: Buffer) => stderr.push(part));
    let launchError: unknown; child.once("error", error => { launchError = error; });
    const closed = new Promise<number | null>(resolve => child.once("close", status => { children.delete(child); resolve(status); }));
    children.set(child, closed);
    child.stdin!.end(input === undefined ? undefined : JSON.stringify(input));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 30_000); })]);
      if (status === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Webhook ACL command timed out."); }
      if (launchError !== undefined) throw launchError;
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
      calls.push({ actor, args, alias, status, stdoutBase64: out.toString("base64"), stderrBase64: err.toString("base64") });
      for (const secret of secrets) { expect(out.includes(secret)).toBe(false); expect(err.includes(secret)).toBe(false); }
      return { status, out, err, value: status === 0 && out.length ? JSON.parse(out.toString()) : undefined };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const success = async (actor: "user" | "member", args: string[], input?: unknown, alias = false): Promise<any> => {
    const result = await invoke(actor, args, input, alias);
    expect(result.status, `${actor} webhook ${args.join(" ")}`).toBe(0); expect(result.err.length).toBe(0); expect(result.out.at(-1)).toBe(10);
    return result.value;
  };
  const denied = async (actor: "user" | "member", args: string[], input?: unknown, code = "forbidden", status = 403) => {
    const start = observations.length, result = await invoke(actor, args, input);
    expect(result.status).toBe(1); expect(result.out.length).toBe(0);
    const error = JSON.parse(result.err.toString()).error;
    expect(error.code).toBe(code);
    const writes = observations.slice(start).filter(item => item.method !== "GET");
    expect(writes.length).toBeLessThanOrEqual(1);
    if (writes.length) expect(writes[0]!.status).toBe(status);
    return error;
  };
  try {
    await mkdir(path.join(root, "tmp"), { recursive: true });
    for (const actor of ["user", "member"]) await mkdir(path.join(root, actor), { recursive: true });
    const originalServer = path.resolve(import.meta.dirname, "../../../daynight-server");
    await cp(originalServer, serverCopy, { recursive: true });
    const sourcePath = path.join(serverCopy, "testdata/webhook-host/main.go");
    const original = await readFile(sourcePath, "utf8"); originalHostSha = sha(Buffer.from(original));
    const adapted = original.replace('authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"', '"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"\n\tauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"').replace("\t\tmux.ServeHTTP(w, r)", "\t\thttpx.RequestLogging(logger, mux).ServeHTTP(w, r)");
    if (adapted === original || !adapted.includes("httpx.RequestLogging(logger, mux).ServeHTTP(w, r)")) throw new Error("Fixture middleware preparation failed.");
    fixtureHostSha = sha(Buffer.from(adapted)); await writeFile(sourcePath, adapted);
    host = spawn("go", ["run", "-tags", "webhookfixture", "./testdata/webhook-host"], { cwd: serverCopy, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DAYNIGHT_TEST_DATABASE_URL: database!, DAYNIGHT_WEBHOOK_FIXTURE_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_PAT: adminToken, DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN: token("dnst_"), DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT: memberToken } });
    hostClosed = new Promise(resolve => host!.once("close", resolve));
    const ready = new Promise<string>((resolve, reject) => {
      let text = ""; host!.once("error", reject); host!.stdout!.on("data", (part: Buffer) => { text += part.toString(); const index = text.indexOf("\n"); if (index >= 0) resolve(text.slice(0, index)); }); host!.once("close", () => reject(new Error("Webhook host exited before readiness."))); host!.stderr!.resume();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { info = JSON.parse(await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Webhook ACL host startup timed out.")), 60_000); })])) as Host; }
    finally { if (timer !== undefined) clearTimeout(timer); }
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (address === null || typeof address === "string") throw new Error("Proxy address missing.");
    const origin = `http://127.0.0.1:${address.port}`;
    await writeFile(path.join(root, "user/config.yml"), `serverUrl: ${origin}\nserverToken: ${adminToken}\nteamDefaults:\n  ${JSON.stringify(origin)}:\n    ${info.userId}: 00000000-0000-4000-8000-000000000001\n`, { mode: 0o600 });
    await writeFile(path.join(root, "member/config.yml"), `serverUrl: ${origin}\nserverToken: ${memberToken}\n`, { mode: 0o600 });

    const secondTeam = await control("member", "POST", "/api/v1/teams", { name: "Foreign team", expectedUserId: info.memberId }, 201);
    const secondProject = (await control("member", "POST", "/api/v1/projects", { name: "Direct share", repoUrl: `https://example.test/${randomBytes(8).toString("hex")}`, teamId: secondTeam.id, expectedUserId: info.memberId }, 201));
    const invitation = await control("member", "POST", `/api/v1/projects/${secondProject.id}/invitations`, { expectedUserId: info.memberId }, 201);
    const invitationSecret = new URL(invitation.link).hash.slice(1); secrets.push(invitationSecret);
    const accepted = await control("user", "POST", "/api/v1/invitations/accept", { token: invitationSecret, expectedUserId: info.userId });
    const promoted = await control("member", "PUT", `/api/v1/projects/${secondProject.id}/grants/${info.userId}`, { version: accepted.directGrant.version, role: "admin", expectedUserId: info.memberId });
    expect(promoted.grant.role).toBe("admin");
    const secondMembers = await control("member", "GET", `/api/v1/teams/${secondTeam.id}/members`);
    expect(secondMembers.items.some((item: any) => item.userId === info!.userId)).toBe(false);
    const memberDirect = await control("user", "PUT", `/api/v1/projects/${info.projectId}/grants/${info.memberId}`, { version: null, role: "admin", expectedUserId: info.userId });
    expect(memberDirect.grant.role).toBe("admin");
    const firstMembers = await control("user", "GET", `/api/v1/teams/${info.teamId}/members`);
    expect(firstMembers.items.find((item: any) => item.userId === info!.memberId).role).toBe("member");

    const destination = { kind: "http", adapterVersion: "1", configuration: { url: info.receiverUrl } };
    const subscription = (projectId: string) => ({ id: null, projectId, eventTypes: ["task.created"] });
    const createInput = (name: string, subscriptions: unknown[]) => ({ name, enabled: true, destination, subscriptions });
    const personal = await success("user", ["create", "--personal", "--stdin", "--confirm"], createInput("Personal across ownership", [subscription(info.projectId), subscription(secondProject.id)]), true);
    expect(personal.endpoint.owner).toEqual({ kind: "personal", id: info.userId });
    expect(personal.endpoint.subscriptions.map((s: any) => s.projectId).sort()).toEqual([info.projectId, secondProject.id].sort());
    expect(personal.endpoint.subscriptions.every((s: any) => s.eligibility === "eligible")).toBe(true);
    // Removing a direct grant must not invalidate an unchanged Team-based proof.
    const overlapping = await control("user", "PUT", `/api/v1/projects/${info.projectId}/grants/${info.userId}`, { version: null, role: "member", expectedUserId: info.userId });
    await control("user", "POST", `/api/v1/projects/${info.projectId}/tasks`, { title: "Overlapping access event" }, 201);
    const teamHistory = await success("user", ["delivery", "list", personal.endpoint.id, "--personal", "--project", info.projectId]);
    expect(teamHistory.items).toHaveLength(1);
    await control("user", "DELETE", `/api/v1/projects/${info.projectId}/grants/${info.userId}`, { version: overlapping.grant.version, expectedUserId: info.userId });
    const continuous = await success("user", ["show", personal.endpoint.id, "--personal"]);
    expect(continuous.subscriptions.find((s: any) => s.projectId === info!.projectId).eligibility).toBe("eligible");
    const stillEligible = await success("user", ["delivery", "redeliver", personal.endpoint.id, teamHistory.items[0].id, "--personal", "--if-version", continuous.configVersion, "--if-generation", teamHistory.items[0].generation, "--confirm"]);
    expect(stillEligible.operation.deliveryId).toBe(teamHistory.items[0].id);
    const teamEndpoint = await success("user", ["create", "--team", info.teamId, "--stdin", "--confirm"], createInput("Team owned project", [subscription(info.projectId)]));
    const foreignEndpoint = await success("member", ["create", "--team", secondTeam.id, "--stdin", "--confirm"], createInput("Foreign team endpoint", [subscription(secondProject.id)]));
    const listBefore = await success("user", ["list", "--team", info.teamId]);
    await denied("user", ["create", "--team", info.teamId, "--stdin", "--confirm"], createInput("Outside scope", [subscription(secondProject.id)]));
    const listAfter = await success("user", ["list", "--team", info.teamId]);
    expect(listAfter).toEqual(listBefore);
    await denied("member", ["disable", teamEndpoint.endpoint.id, "--team", info.teamId, "--if-version", teamEndpoint.endpoint.configVersion, "--confirm"]);
    await denied("user", ["disable", foreignEndpoint.endpoint.id, "--team", secondTeam.id, "--if-version", foreignEndpoint.endpoint.configVersion, "--confirm"]);
    const intact = await success("user", ["show", teamEndpoint.endpoint.id, "--team", info.teamId]);
    expect(intact.enabled).toBe(true); expect(intact.configVersion).toBe(teamEndpoint.endpoint.configVersion);
    const foreignIntact = await success("member", ["show", foreignEndpoint.endpoint.id, "--team", secondTeam.id]);
    expect(foreignIntact.enabled).toBe(true); expect(foreignIntact.configVersion).toBe(foreignEndpoint.endpoint.configVersion);

    await control("member", "POST", `/api/v1/projects/${secondProject.id}/tasks`, { title: "Direct grant event" }, 201);
    const history = await success("user", ["delivery", "list", personal.endpoint.id, "--personal", "--project", secondProject.id]);
    expect(history.items.length).toBe(1);
    const delivery = history.items[0];
    const visible = await success("user", ["delivery", "show", personal.endpoint.id, delivery.id, "--personal"]);
    expect(visible.disclosure).toBe("full"); expect(visible.resource.projectId).toBe(secondProject.id);
    const raw = await success("user", ["delivery", "payload", personal.endpoint.id, delivery.id, "--personal"]);
    expect(raw.endpointId).toBe(personal.endpoint.id); expect(raw.deliveryId).toBe(delivery.id);
    await control("member", "DELETE", `/api/v1/projects/${secondProject.id}/grants/${info.userId}`, { version: promoted.grant.version, expectedUserId: info.memberId });
    const hidden = await success("user", ["delivery", "show", personal.endpoint.id, delivery.id, "--personal"]);
    expect(hidden.disclosure).toBe("metadata_only"); expect(hidden.resource.projectId).toBeNull(); expect(hidden.target.url).toBeNull(); expect(hidden.payloadAvailable).toBe(false);
    await denied("user", ["delivery", "payload", personal.endpoint.id, delivery.id, "--personal"]);
    await denied("user", ["delivery", "redeliver", personal.endpoint.id, delivery.id, "--personal", "--if-version", personal.endpoint.configVersion, "--if-generation", delivery.generation, "--confirm"], undefined, "delivery_stopped", 409);
    const configured = await success("user", ["show", personal.endpoint.id, "--personal"]);
    const withdrawn = configured.subscriptions.find((s: any) => s.projectId === secondProject.id);
    expect(withdrawn.eligibility).toBe("access_revoked");
    const paused = await success("user", ["disable", personal.endpoint.id, "--personal", "--if-version", configured.configVersion, "--confirm"]);
    expect(paused.endpoint.enabled).toBe(false);
    const remaining = paused.endpoint.subscriptions.filter((s: any) => s.projectId === info!.projectId).map((s: any) => ({ id: s.id, projectId: s.projectId, eventTypes: s.eventTypes }));
    const shrunk = await success("user", ["subscription", "replace", personal.endpoint.id, "--personal", "--if-version", paused.endpoint.configVersion, "--stdin", "--confirm"], remaining);
    expect(shrunk.endpoint.subscriptions).toHaveLength(1); expect(shrunk.endpoint.subscriptions[0].projectId).toBe(info.projectId);
    const stillHidden = await success("user", ["delivery", "show", personal.endpoint.id, delivery.id, "--personal"]);
    expect(stillHidden.disclosure).toBe("metadata_only");
    const removed = await success("user", ["delete", personal.endpoint.id, "--personal", "--if-version", shrunk.endpoint.configVersion, "--confirm"]);
    expect(removed.endpoint.lifecycle).toBe("deleted");
    if (process.env.DAYNIGHT_WEBHOOK_ACL_EVIDENCE !== undefined) {
      const evidence = JSON.stringify({ source: installed.receipt.source, packageSha256: installed.receipt.tarballSha256, entrySha256: installed.receipt.entrySha256, originalHostSha, fixtureHostSha, schema: info.schema, team: info.teamId, project: info.projectId, secondTeam: secondTeam.id, secondProject: secondProject.id, personalEndpoint: personal.endpoint.id, teamEndpoint: teamEndpoint.endpoint.id, foreignEndpoint: foreignEndpoint.endpoint.id, delivery: delivery.id, calls, observations }, null, 2);
      for (const secret of secrets) expect(evidence).not.toContain(secret);
      await writeFile(process.env.DAYNIGHT_WEBHOOK_ACL_EVIDENCE, evidence, { mode: 0o600 });
    }
  } catch (error) { primary = error; throw error; }
  finally {
    const failures: unknown[] = [];
    for (const [child, closed] of children) { try { await terminateInstalledProcess(child, closed); } catch (error) { failures.push(error); } }
    if (info !== undefined && host !== undefined) { try { await control("user", "POST", "/__fixture/shutdown", undefined, 204); } catch (error) { failures.push(error); } }
    if (host !== undefined && hostClosed !== undefined) {
      try { let timer: ReturnType<typeof setTimeout> | undefined; const finished = await Promise.race([hostClosed.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 10_000); })]); if (timer !== undefined) clearTimeout(timer); if (!finished) await terminateInstalledProcess(host, hostClosed); } catch (error) { failures.push(error); }
    }
    try { proxy.closeAllConnections(); if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); } catch (error) { failures.push(error); }
    try { await installed.cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures], "Webhook ACL fixture cleanup failed.");
  }
}, 240_000);
