import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";
import { terminateInstalledProcess } from "../fixtures/installed-cli.js";
import { continuingWebhookEvents, webhookCatalog } from "../fixtures/webhook-catalog.js";

it("reads both catalog shapes and keeps configuration independent through the installed CLI", async () => {
  const installed = await createAcceptanceCli();
  const { receipt } = installed;
  const root = path.join(receipt.root, "webhook-catalog"), config = path.join(root, "config"), home = path.join(root, "home"), temporary = path.join(root, "tmp");
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", endpointId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const owner = { kind: "personal", id: userId };
  let catalog: unknown = webhookCatalog();
  const requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (part: Buffer) => chunks.push(part));
    request.on("end", () => {
      const bytes = Buffer.concat(chunks), body = bytes.length === 0 ? null : JSON.parse(bytes.toString()) as Record<string, unknown>;
      requests.push({ method: request.method!, path: request.url!, body });
      response.setHeader("Content-Type", "application/json"); response.setHeader("Daynight-User-ID", userId);
      if (request.method === "GET" && request.url === "/api/v1/me") {
        response.end(JSON.stringify({ id: userId, email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: projectId, kind: "personal", name: null } }));
      } else if (request.method === "GET" && request.url === "/api/v1/webhook-event-types") response.end(JSON.stringify(catalog));
      else if (request.method === "PATCH" && request.url === `/api/v1/me/webhooks/${endpointId}` && body !== null) {
        const time = new Date().toISOString();
        const operation = { operationId: body.operationId, kind: "endpoint.patch", issuedAt: body.issuedAt, requestSha256: createHash("sha256").update(bytes).digest("hex"), actorUserId: userId, owner, endpointId, effect: "applied", configVersionAfter: "2", destinationRevisionAfter: "1", deliveryId: null, generationAfter: null, keyId: null, overlapUntil: null, recordedAt: time, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
        const subscriptions = body.subscriptions === undefined ? [] : (body.subscriptions as Record<string, unknown>[]).map(item => ({ ...item, id: projectId, projectName: "Project", eligibility: "eligible" }));
        const endpoint = { id: endpointId, owner, lifecycle: "active", configVersion: "2", deletedAt: null, clientKey: null, name: body.name === undefined ? "Notifications" : body.name, enabled: false, destinationRevision: "1", destination: { kind: "http", adapterVersion: "1", url: null, displayUrl: "https://receiver.example/…" }, signing: { scheme: "standard-webhooks-v1", activeKeyId: projectId, overlapUntil: null }, subscriptions, capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: time, updatedAt: time };
        response.end(JSON.stringify({ operation, endpoint }));
      } else {
        response.writeHead(500); response.end(JSON.stringify({ error: { code: "unexpected_route", message: "Unexpected fixture request", requestId: "catalog-fixture" } }));
      }
    });
  });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|NODE_OPTIONS$|DAYNIGHT_|DN_)/i.test(key)) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, DN_CONFIG_DIR: config, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"), XDG_CONFIG_HOME: path.join(root, "xdg"), XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: temporary, TMP: temporary, TEMP: temporary, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" });
  const children = new Map<ChildProcess, Promise<unknown>>();
  const invoke = async (args: string[]) => {
    const child = crossSpawn(receipt.launcherPath, ["webhook", ...args], { cwd: root, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", launchError: unknown;
    child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.once("error", error => { launchError = error; });
    const closed = new Promise<number | null>(resolve => child.once("close", code => { children.delete(child); resolve(code); }));
    children.set(child, closed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([closed, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 20_000); })]);
      if (code === "timeout") { await terminateInstalledProcess(child, closed); throw new Error("Installed Webhook command exceeded twenty seconds."); }
      if (launchError !== undefined) throw launchError;
      return { code, stdout, stderr };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  let failure: unknown;
  try {
    await Promise.all([config, home, temporary].map(directory => mkdir(directory, { recursive: true })));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing catalog fixture listener.");
    await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    for (const keys of [continuingWebhookEvents, ["task.step_updated", ...continuingWebhookEvents].reverse()]) {
      catalog = webhookCatalog(keys);
      for (const json of [false, true]) {
        const result = await invoke(["catalog", ...(json ? ["--json"] : [])]);
        expect(result.code, result.stderr).toBe(0); expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual(catalog);
      }
    }
    for (const items of [webhookCatalog().items.slice(1), [...webhookCatalog().items, webhookCatalog().items[0]], webhookCatalog().items.map(item => ({ ...item, schemaVersion: 2 }))]) {
      catalog = { ...webhookCatalog(), items };
      const result = await invoke(["catalog", "--json"]);
      expect(result.code).toBe(1); expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toMatchObject({ phase: "read", invocationOutcome: "read_failed" });
    }
    for (const input of [{ name: "Renamed" }, { subscriptions: [{ id: null, projectId, eventTypes: ["task.step_updated", "task.created"] }] }]) {
      const filename = path.join(root, "patch.json"); await writeFile(filename, JSON.stringify(input));
      const before = requests.length;
      const result = await invoke(["update", endpointId, "--personal", "--if-version", "1", "--file", filename, "--confirm", "--json"]);
      expect(result.code, result.stderr).toBe(0); expect(result.stderr).toBe("");
      const value = JSON.parse(result.stdout);
      expect(value.operation).toMatchObject({ kind: "endpoint.patch", configVersionAfter: "2" });
      const trace = requests.slice(before);
      expect(trace.map(item => [item.method, item.path])).toEqual([["GET", "/api/v1/me"], ["PATCH", `/api/v1/me/webhooks/${endpointId}`]]);
      expect(trace[1]!.body).toMatchObject(input);
      if ("subscriptions" in input) expect(value.endpoint.subscriptions[0].eventTypes).toEqual(input.subscriptions[0]!.eventTypes);
      else expect(value.endpoint.name).toBe(input.name);
    }
  } catch (cause) { failure = cause; }
  const cleanupErrors: unknown[] = [];
  for (const [child, closed] of children) try { await terminateInstalledProcess(child, closed); } catch (cause) { cleanupErrors.push(cause); }
  try { await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); } catch (cause) { cleanupErrors.push(cause); }
  try { await installed.cleanup(); } catch (cause) { cleanupErrors.push(cause); }
  if (failure !== undefined || cleanupErrors.length > 0) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupErrors], "Webhook catalog acceptance or cleanup failed.");
}, 180_000);
