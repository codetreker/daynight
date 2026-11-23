import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Agent, request as httpsRequest } from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { test, expect, topology, cliEnvironment, startOwnedCommand } from "./fixtures.ts";

test.use({ trace: "off", screenshot: "off" });

type Catalog = { catalogRevision: string; defaultScopes: string[]; groups: { id: string; scopeIds: string[] }[] };
type Policy = { scopes: string[]; scopeVersion: string };
type Credential = { id: string; name: string; scopePolicy: Policy };
type Grant = { id: string; clientId: string; scopePolicy: Policy };
type Task = { id: string; projectId: string; title: string; version: number };
const selected = ["project:read", "task:read", "task:write"];
const sorted = (scopes: string[]) => [...scopes].sort();
const group = (root: Locator, id: string) => root.locator(".credential-scope-group").filter({ has: root.page().locator("summary code", { hasText: new RegExp(`^${id}$`) }) });
const checkbox = (root: Locator, id: string) => root.locator("label.credential-scope-option").filter({ has: root.page().locator("code", { hasText: new RegExp(`^${id}$`) }) }).locator("input");

function verifyDefaults(catalog: Catalog, kind: "pat" | "mcp"): void {
  expect(catalog.groups.some(item => item.id === "team" && item.scopeIds.includes("team:read"))).toBe(true);
  expect(catalog.groups.some(item => item.id === "worker-execution")).toBe(true);
  const expected = catalog.groups.flatMap(item => item.scopeIds.filter(id =>
    item.id === "team" ? id === "team:read" : kind !== "mcp" || item.id !== "worker-execution"));
  expect(sorted(catalog.defaultScopes)).toEqual(sorted(expected));
}

async function choose(page: Page, catalog: Catalog): Promise<void> {
  const root = page.locator(".credential-scopes");
  await expect(root.locator(".credential-scope-group")).toHaveCount(catalog.groups.length);
  await expect(root.locator(".credential-scope-group[open]")).toHaveCount(0);
  for (const entry of catalog.groups) {
    const item = group(root, entry.id);
    await item.locator("summary").click();
    for (const scope of entry.scopeIds) {
      const input = checkbox(item, scope);
      if (catalog.defaultScopes.includes(scope)) await expect(input).toBeChecked();
      else await expect(input).not.toBeChecked();
      if (selected.includes(scope)) await input.check();
      else await input.uncheck();
    }
  }
  await expect(root.locator("output")).toHaveText("Selected 3");
}

async function deviceLogin(page: Page, directory: string, catalog: Catalog, restricted: boolean): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "config.yml"), `serverUrl: ${topology.baseURL}\n`, { mode: 0o600 });
  let output = "";
  let publish: (value: { uri: string; code: string }) => void = () => {};
  const authorization = new Promise<{ uri: string; code: string }>(resolve => { publish = resolve; });
  const login = await startOwnedCommand(process.execPath, [topology.cliEntry, "login", "--no-browser"], {
    cwd: directory, env: { ...cliEnvironment, DN_CONFIG_DIR: directory }, timeoutMs: 120_000,
    onOutput: (_channel, chunk) => {
      output += chunk;
      const uri = output.match(/^Open (\S+)$/m)?.[1], code = output.match(/^Enter code: (\S+)$/m)?.[1];
      if (uri && code) publish({ uri, code });
    },
  });
  let stage = "await device instructions", status: number | null = null;
  try {
    const device = await Promise.race([authorization, login.finished.then(() => { throw new Error("Device login exited before authorization."); })]);
    stage = "open device page";
    await page.goto(device.uri);
    await page.locator("#scoped-device-code").waitFor({ state: "visible" });
    await page.evaluate(code => {
      const input = document.querySelector<HTMLInputElement>("#scoped-device-code");
      if (!input) throw new Error("Device code field missing");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, code);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, device.code);
    stage = "inspect device request";
    await page.getByRole("button", { name: "Review request", exact: true }).click();
    stage = "select device permissions";
    if (restricted) await choose(page, catalog);
    await page.getByRole("checkbox", { name: "This code matches the one in my terminal", exact: true }).check();
    stage = "approve device request";
    await page.getByRole("button", { name: "Authorize CLI", exact: true }).click();
    status = (await login.finished).exitCode;
    expect(status).toBe(0);
    stage = "leave device page";
    await page.goto(`${topology.baseURL}/account`);
  } catch {
    await page.close().catch(() => {});
    throw new Error(`Device authorization failed at ${stage} (exit=${status ?? "unavailable"}); sensitive diagnostics suppressed.`);
  } finally { await login.stop(); }
  const modulePath = pathToFileURL(path.join(path.dirname(topology.cliEntry), "config/server.js")).href;
  const { loadServerConfiguration } = await import(modulePath) as { loadServerConfiguration(paths: { stateDirectory: string; configFile: string }): Promise<{ serverToken?: string }> };
  const result = await loadServerConfiguration({ stateDirectory: directory, configFile: path.join(directory, "config.yml") });
  if (!result.serverToken) throw new Error("Device authorization did not persist a PAT.");
  return result.serverToken;
}

async function edit(page: Page, button: Locator, save: string): Promise<string | null> {
  await button.click();
  const dialog = page.getByRole("dialog");
  const task = group(dialog, "task");
  await task.locator("summary").click();
  await checkbox(task, "task:write").uncheck();
  await expect(dialog.getByRole("region", { name: "Permission changes" })).toContainText("task:write");
  const saved = page.waitForResponse(response => response.url().endsWith("/scopes") && response.request().method() === "PATCH");
  await dialog.getByRole("button", { name: save, exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  return response.headers()["x-request-id"] ?? null;
}

async function mcpRequest(token: string, body: object, agent?: Agent, reused = false): Promise<{ status: number; body: string }> {
  try { return await new Promise((resolve, reject) => {
    const request = httpsRequest(`${topology.baseURL}/mcp`, {
      method: "POST", agent, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    }, response => {
      if (reused && !request.reusedSocket) { response.resume(); reject(new Error("MCP connection was not reused")); return; }
      let text = "";
      response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  }); } catch { throw new Error("MCP request failed or the connection was not reused."); }
}

async function secureRequest(url: string, options: { method: string; token?: string; body?: string; contentType?: string }): Promise<{ status: number; requestId: string | null; scopeStatus: string | null; body: string }> {
  try {
    return await new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      if (options.contentType) headers["Content-Type"] = options.contentType;
      const request = httpsRequest(url, { method: options.method, headers, signal: AbortSignal.timeout(30_000) }, response => {
        let body = "";
        response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, requestId: typeof response.headers["x-request-id"] === "string" ? response.headers["x-request-id"] : null, scopeStatus: typeof response.headers["daynight-scope-status"] === "string" ? response.headers["daynight-scope-status"] : null, body }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end(options.body);
    });
  } catch { throw new Error("Secure HTTP request failed."); }
}

function safeJSON<T>(body: string): T {
  try { return JSON.parse(body) as T; }
  catch { throw new Error("Secure HTTP response was not JSON."); }
}

async function browserRequest<T>(page: Page, path: string, mode: "me" | "catalog" | "tokens" | "grants" | "project" | "task", data?: object): Promise<{ status: number; value: T | null }> {
  try {
    return await page.evaluate(async ({ path, mode, data }) => {
      const response = await fetch(path, data === undefined ? { credentials: "same-origin" } : {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      if (!response.ok) return { status: response.status, value: null };
      const raw = await response.json();
      const policy = (item: { scopePolicy: { scopes: string[]; scopeVersion: string } }) => ({ scopes: item.scopePolicy.scopes, scopeVersion: item.scopePolicy.scopeVersion });
      let value: unknown;
      if (mode === "me") value = { id: raw.id };
      else if (mode === "catalog") {
        const catalog = (item: Catalog) => ({ catalogRevision: item.catalogRevision, defaultScopes: item.defaultScopes, groups: item.groups.map(group => ({ id: group.id, scopeIds: group.scopeIds })) });
        value = { pat: catalog(raw.pat), mcp: catalog(raw.mcp) };
      } else if (mode === "tokens") value = { items: raw.items.map((item: Credential) => ({ id: item.id, name: item.name, scopePolicy: policy(item) })) };
      else if (mode === "grants") value = { userId: raw.userId, grants: raw.grants.map((item: Grant) => ({ id: item.id, clientId: item.clientId, scopePolicy: item.scopePolicy === null ? null : policy(item) })) };
      else if (mode === "project") value = { id: raw.id };
      else value = { id: raw.id, projectId: raw.projectId, title: raw.title, version: raw.version };
      return { status: response.status, value };
    }, { path, mode, data }) as { status: number; value: T | null };
  } catch { throw new Error(`Browser request failed (${mode}).`); }
}

async function mcp(token: string, name: string, args: Record<string, string>, denied = false, agent?: Agent): Promise<Record<string, unknown> | undefined> {
  const response = await mcpRequest(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, agent, agent !== undefined);
  expect(response.status, `${name} HTTP status`).toBe(200);
  const rpc = safeJSON<{ result?: { isError?: boolean; structuredContent?: { data?: Record<string, unknown>; error?: { code?: string } } } }>(response.body);
  if (denied) {
    expect(rpc.result?.isError).toBe(true);
    expect(rpc.result?.structuredContent?.error?.code).toBe("insufficient_scope");
    return;
  }
  expect(rpc.result?.isError).not.toBe(true);
  expect(rpc.result?.structuredContent?.data).toBeDefined();
  return rpc.result!.structuredContent!.data!;
}

test("device PAT and OAuth grant apply independent scope changes across clients", async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto(`${topology.baseURL}/login`);
  await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
  await page.getByRole("button", { name: "Authorize collaborator identity", exact: true }).click();
  await expect(page.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
  const meResponse = await browserRequest<{ id: string }>(page, "/api/v1/me", "me");
  expect(meResponse.status).toBe(200);
  const me = meResponse.value!;
  const catalogResponse = await browserRequest<{ pat: Catalog; mcp: Catalog }>(page, "/api/v1/me/credential-scope-catalog", "catalog");
  expect(catalogResponse.status).toBe(200);
  const catalog = catalogResponse.value!;
  verifyDefaults(catalog.pat, "pat");
  verifyDefaults(catalog.mcp, "mcp");
  const readTokens = async () => {
    const response = await browserRequest<{ items: Credential[] }>(page, "/api/v2/me/tokens", "tokens");
    expect(response.status).toBe(200);
    return response.value!.items;
  };
  const readGrants = async () => {
    const response = await browserRequest<{ userId: string; grants: Grant[] }>(page, "/api/v3/oauth/grants", "grants");
    expect(response.status).toBe(200);
    const result = response.value!;
    expect(result.userId).toBe(me.id);
    return result.grants;
  };
  const before = await readTokens();
  const control = await deviceLogin(page, path.join(topology.cliConfigDirectory, "scope-control"), catalog.pat, false);
  const afterControl = await readTokens();
  const controlRow = afterControl.find(item => !before.some(old => old.id === item.id));
  expect(controlRow).toBeDefined();
  const pat = await deviceLogin(page, path.join(topology.cliConfigDirectory, "scope-target"), catalog.pat, true);
  const afterPat = await readTokens();
  const patRow = afterPat.find(item => !afterControl.some(old => old.id === item.id));
  expect(patRow).toBeDefined();
  expect(sorted(patRow!.scopePolicy.scopes)).toEqual(sorted(selected));
  expect(patRow!.scopePolicy.scopeVersion).toBe("1");

  const issueGrant = async () => {
  let stage = "register client", status: number | null = null;
  try {
  const clientName = `Scope E2E ${randomUUID()}`, callback = "http://localhost:9012/callback";
  const register = await secureRequest(`${topology.baseURL}/oauth/register`, { method: "POST", contentType: "application/json", body: JSON.stringify({ client_name: clientName, redirect_uris: ["http://localhost/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  status = register.status;
  expect(status).toBe(201);
  const { client_id: clientId } = safeJSON<{ client_id: string }>(register.body);
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code", scope: "daynight:mcp", resource: `${topology.baseURL}/mcp`, state: randomUUID(), code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  stage = "open consent"; status = null;
  await page.goto(`${topology.baseURL}/oauth/authorize?${query}`);
  stage = "select OAuth permissions";
  await choose(page, catalog.mcp);
  const decision = page.waitForResponse(response => /\/api\/v2\/oauth\/requests\/[^/]+\/decision$/.test(response.url()) && response.request().method() === "POST");
  stage = "approve OAuth request";
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  const approved = await decision;
  status = approved.status();
  expect(status).toBe(200);
  const redirect = new URL((await approved.json() as { redirectUri: string }).redirectUri);
  expect(redirect.searchParams.get("state")).toBe(query.get("state"));
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("OAuth approval did not return a code.");
  stage = "exchange OAuth code"; status = null;
  const tokenResponse = await secureRequest(`${topology.baseURL}/oauth/token`, { method: "POST", contentType: "application/x-www-form-urlencoded", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: callback, resource: `${topology.baseURL}/mcp`, code_verifier: verifier }).toString() });
  status = tokenResponse.status;
  expect(status).toBe(200);
  const tokens = safeJSON<{ access_token: string; refresh_token: string; scope: string }>(tokenResponse.body);
  expect(tokens.scope).toBe("daynight:mcp");
  stage = "leave consent page"; status = null;
  await page.goto(`${topology.baseURL}/account`);
  return { clientId, tokens };
  } catch {
    await page.close().catch(() => {});
    throw new Error(`OAuth authorization failed at ${stage} (status=${status ?? "unavailable"}); sensitive diagnostics suppressed.`);
  }
  };
  const { clientId, tokens } = await issueGrant();
  const controlGrant = await issueGrant();
  const grants = await readGrants();
  const grant = grants.find(item => item.clientId === clientId);
  const controlGrantRow = grants.find(item => item.clientId === controlGrant.clientId);
  expect(grant).toBeDefined();
  expect(controlGrantRow).toBeDefined();
  expect(sorted(grant!.scopePolicy.scopes)).toEqual(sorted(selected));
  expect(grant!.scopePolicy.scopeVersion).toBe("1");
  expect(sorted(controlGrantRow!.scopePolicy.scopes)).toEqual(sorted(selected));

  const projects: string[] = [], tasks: Task[] = [];
  for (let i = 0; i < 2; i++) {
    const projectResponse = await browserRequest<{ id: string }>(page, "/api/v1/projects", "project", { name: `Scope ${randomUUID()}`, repoUrl: `https://example.test/${randomUUID()}.git`, expectedUserId: me.id });
    expect(projectResponse.status).toBe(201);
    const project = projectResponse.value!;
    projects.push(project.id);
    const taskResponse = await browserRequest<Task>(page, `/api/v1/projects/${project.id}/tasks`, "task", { title: `Scope task ${i}` });
    expect(taskResponse.status).toBe(201);
    tasks.push(taskResponse.value!);
  }
  const pathFor = (task: Task) => `${topology.baseURL}/api/v1/projects/${task.projectId}/tasks/${task.id}`;
  const restRead = async (token: string, task: Task) => {
    const response = await secureRequest(pathFor(task), { method: "GET", token });
    expect(response.status).toBe(200);
    return safeJSON<Task>(response.body);
  };
  const restWrite = async (token: string, task: Task, title: string, status = 200) => {
    const response = await secureRequest(pathFor(task), { method: "PATCH", token, contentType: "application/json", body: JSON.stringify({ version: task.version, title }) });
    expect(response.status).toBe(status);
    if (status === 200) return safeJSON<Task>(response.body);
    expect(response.scopeStatus).toBe("insufficient_scope");
    expect(safeJSON<{ error: { code: string } }>(response.body).error.code).toBe("forbidden");
    return task;
  };
  tasks[0] = await restWrite(pat, tasks[0]!, "PAT before edit");
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
  const initialized = await mcpRequest(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "scope-e2e", version: "1" } } }, agent);
  expect(initialized.status).toBe(200);
  const initialization = safeJSON<{ jsonrpc?: string; id?: number; result?: { protocolVersion?: string } }>(initialized.body);
  expect(initialization.jsonrpc).toBe("2.0");
  expect(initialization.id).toBe(1);
  expect(initialization.result?.protocolVersion).toBe("2025-11-25");
  const notification = await mcpRequest(tokens.access_token, { jsonrpc: "2.0", method: "notifications/initialized" }, agent, true);
  expect(notification.status).toBe(202);
  const original = await mcp(tokens.access_token, "task_show", { projectId: projects[1]!, taskId: tasks[1]!.id, view: "full" }, false, agent);
  expect(original).toMatchObject({ id: tasks[1]!.id, title: tasks[1]!.title });
  await mcp(tokens.access_token, "task_update", { projectId: projects[1]!, taskId: tasks[1]!.id, ifVersion: String(tasks[1]!.version), title: "Grant before edit" }, false, agent);
  tasks[1] = await restRead(control, tasks[1]!);
  expect(tasks[1]!.title).toBe("Grant before edit");

  await page.goto(`${topology.baseURL}/account`);
  await page.getByRole("link", { name: "Access credentials", exact: true }).click();
  const tokenIndex = (await readTokens()).findIndex(item => item.id === patRow!.id);
  const patEditRequestId = await edit(page, page.locator(".token-row").nth(tokenIndex).getByRole("button", { name: /^Edit permissions:/ }), "Save");
  const afterPatEdit = await readTokens();
  expect(afterPatEdit.find(item => item.id === patRow!.id)?.scopePolicy).toEqual({ scopes: patRow!.scopePolicy.scopes.filter(id => id !== "task:write"), scopeVersion: "2" });
  expect(afterPatEdit.find(item => item.id === controlRow!.id)?.scopePolicy).toEqual(controlRow!.scopePolicy);
  await restWrite(pat, tasks[0]!, "PAT denied", 403);
  await mcp(pat, "task_update", { projectId: projects[0]!, taskId: tasks[0]!.id, ifVersion: String(tasks[0]!.version), title: "PAT MCP denied" }, true);
  expect((await restRead(pat, tasks[0]!)).title).toBe("PAT before edit");
  expect(await mcp(pat, "task_show", { projectId: projects[0]!, taskId: tasks[0]!.id, view: "full" })).toMatchObject({ title: "PAT before edit" });
  tasks[0] = await restWrite(control, tasks[0]!, "Control still works");

  await page.locator(`[data-scope-grant-edit="${grant!.id}"]`).waitFor();
  const grantEditRequestId = await edit(page, page.locator(`[data-scope-grant-edit="${grant!.id}"]`), "Save permissions");
  const afterGrantEdit = await readGrants();
  const narrowed = afterGrantEdit.find(item => item.id === grant!.id);
  expect(narrowed?.scopePolicy).toEqual({ scopes: grant!.scopePolicy.scopes.filter(id => id !== "task:write"), scopeVersion: "2" });
  expect(afterGrantEdit.find(item => item.id === controlGrantRow!.id)?.scopePolicy).toEqual(controlGrantRow!.scopePolicy);
  await mcp(tokens.access_token, "task_update", { projectId: projects[1]!, taskId: tasks[1]!.id, ifVersion: String(tasks[1]!.version), title: "Grant denied" }, true, agent);
  expect(await mcp(tokens.access_token, "task_show", { projectId: projects[1]!, taskId: tasks[1]!.id, view: "full" }, false, agent)).toMatchObject({ title: "Grant before edit" });
  expect((await restRead(control, tasks[1]!)).title).toBe("Grant before edit");
  await mcp(controlGrant.tokens.access_token, "task_update", { projectId: projects[1]!, taskId: tasks[1]!.id, ifVersion: String(tasks[1]!.version), title: "Control grant still works" });
  tasks[1] = await restRead(control, tasks[1]!);
  expect(tasks[1]!.title).toBe("Control grant still works");
  const refresh = await secureRequest(`${topology.baseURL}/oauth/token`, { method: "POST", contentType: "application/x-www-form-urlencoded", body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, resource: `${topology.baseURL}/mcp`, refresh_token: tokens.refresh_token }).toString() });
  expect(refresh.status).toBe(200);
  const renewed = safeJSON<{ access_token: string; refresh_token: string; scope: string }>(refresh.body);
  expect(renewed.scope).toBe(tokens.scope);
  if (!renewed.access_token || !renewed.refresh_token || renewed.access_token === tokens.access_token || renewed.refresh_token === tokens.refresh_token) throw new Error("OAuth refresh did not rotate both credentials.");
  expect((await readGrants()).find(item => item.id === grant!.id)?.scopePolicy).toEqual(narrowed!.scopePolicy);
  expect(await mcp(renewed.access_token, "task_show", { projectId: projects[1]!, taskId: tasks[1]!.id, view: "full" })).toMatchObject({ title: "Control grant still works" });
  await mcp(renewed.access_token, "task_update", { projectId: projects[1]!, taskId: tasks[1]!.id, ifVersion: String(tasks[1]!.version), title: "Refreshed denied" }, true);
  await test.info().attach("credential-scope-evidence.json", { contentType: "application/json", body: Buffer.from(JSON.stringify({ userId: me.id, catalog, projects, tasks: tasks.map(({ id, projectId, title, version }) => ({ id, projectId, title, version })), pat: { id: patRow!.id, before: patRow!.scopePolicy, after: afterPatEdit.find(item => item.id === patRow!.id)?.scopePolicy }, controlPat: { id: controlRow!.id, policy: controlRow!.scopePolicy }, grant: { id: grant!.id, before: grant!.scopePolicy, after: narrowed!.scopePolicy }, controlGrant: { id: controlGrantRow!.id, policy: controlGrantRow!.scopePolicy }, requestIds: { patEdit: patEditRequestId, grantEdit: grantEditRequestId, refresh: refresh.requestId } }, null, 2)) });
  } finally { agent.destroy(); }
});
