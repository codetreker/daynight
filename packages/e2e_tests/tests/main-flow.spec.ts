import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect, topology, cli, cliEnvironment, startOwnedCommand } from "./fixtures.ts";
import { verifyCompletionFlow } from "./completion-flow.ts";
import { verifyControllerImages } from "./controller-images.ts";
import { verifyTagFlow } from "./tag-flow.ts";
import { verifyWorkerPatrol } from "./worker-patrol.ts";
import { verifyPreviewFlow } from "./preview-flow.ts";
import { verifyWorkerMonitoring } from "./worker-monitoring.ts";
import { verifyTeamMemberFlow } from "./team-member-flow.ts";

type Task = { id: string; title: string; description: string; status: string; version: number };
type SearchItem = { id: string; title: string; match: { fields: string[]; descriptionSnippet: string | null } };
type Token = { id: string; name: string; lastUsedAt: string | null };

test("compiled CLI and production Web share a normal task lifecycle", async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto(`${topology.baseURL}/login`);
  await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
  await page.getByRole("button", { name: "Authorize local identity", exact: true }).click();
  await expect(page.getByRole("link", { name: "Projects", exact: true })).toBeVisible();

  let output = "";
  let resolveAuthorization: (value: { uri: string; code: string }) => void = () => {};
  const authorization = new Promise<{ uri: string; code: string }>((resolve) => { resolveAuthorization = resolve; });
  const login = await startOwnedCommand(process.execPath, [topology.cliEntry, "login", "--no-browser"], {
    cwd: topology.cliConfigDirectory,
    env: cliEnvironment,
    timeoutMs: 60_000,
    onOutput: (_channel, chunk) => {
      output += chunk;
      const uri = output.match(/^Open (\S+)$/m)?.[1];
      const code = output.match(/^Enter code: (\S+)$/m)?.[1];
      if (uri !== undefined && code !== undefined) resolveAuthorization({ uri, code });
    },
  });
  try {
    const device = await Promise.race([authorization, login.finished.then(() => { throw new Error("CLI login exited before publishing authorization instructions."); })]);
    await page.goto(`${device.uri}?user_code=${encodeURIComponent(device.code)}`);
    await page.getByRole("checkbox", { name: "This code matches the one in my terminal", exact: true }).check();
    await page.getByRole("button", { name: "Authorize CLI", exact: true }).click();
    expect((await login.finished).exitCode).toBe(0);
  } finally { await login.stop(); }

  const initialTokens = await page.request.get(`${topology.baseURL}/api/v1/me/tokens`);
  expect(initialTokens.status()).toBe(200);
  const issued = (await initialTokens.json() as { items: Token[] }).items;
  expect(issued).toHaveLength(1);
  const cliToken = issued[0]!;
  expect(cliToken).toMatchObject({ name: expect.stringMatching(/^Daynight CLI/), lastUsedAt: null });

  await verifyTeamMemberFlow(page);
  await verifyWorkerMonitoring(page);

  const name = `Product E2E ${randomUUID()}`;
  const project = await cli(["project", "create", name, "--repo", `https://example.test/e2e/${randomUUID()}.git`, "--team", "personal", "--confirm"]);
  const projectId = project.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
  expect(projectId).toBeDefined();
  await expect.poll(async () => {
    const response = await page.request.get(`${topology.baseURL}/api/v1/me/tokens`);
    expect(response.status()).toBe(200);
    return (await response.json() as { items: Token[] }).items.find(token => token.id === cliToken.id)?.lastUsedAt;
  }, { timeout: 60_000, intervals: [1_000] }).toEqual(expect.any(String));

  await page.goto(`${topology.baseURL}/account`);
  const tokenList = page.waitForResponse(response => response.url().endsWith("/api/v1/me/tokens") && response.request().method() === "GET");
  await page.getByRole("link", { name: "Access credentials", exact: true }).click();
  const tokenResponse = await tokenList;
  expect(tokenResponse.status()).toBe(200);
  const shownToken = (await tokenResponse.json() as { items: Token[] }).items.find(token => token.id === cliToken.id);
  expect(shownToken).toMatchObject({ id: cliToken.id, name: cliToken.name, lastUsedAt: expect.any(String) });
  const row = page.locator(".token-row").filter({ has: page.getByText(cliToken.name, { exact: true }) });
  await expect(row).toHaveCount(1);
  const summary = row.locator("details.credential-last-use > summary");
  await expect(summary).toContainText("Last used: About");
  await expect(summary.locator("time")).toHaveAttribute("datetime", shownToken!.lastUsedAt!);
  const fullTime = await page.evaluate(value => new Intl.DateTimeFormat("en", {
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(value)), shownToken!.lastUsedAt!);
  await expect(summary).toHaveAttribute("title", `Recorded time (approximate): ${fullTime}`);
  await summary.click();
  await expect(row.locator(".full-time")).toHaveText(`Recorded time (approximate): ${fullTime}`);

  const emptySync = page.waitForResponse(response => response.url().includes(`/api/v1/projects/${projectId}/task-sync`) && response.request().method() === "GET");
  await page.goto(`${topology.baseURL}/projects/${projectId}`);
  expect((await emptySync).status()).toBe(200);
  await page.getByRole("tab", { name: "Task list" }).click();
  await expect(page.getByRole("tab", { name: "Standalone tasks" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Task chains" })).toBeVisible();
  await page.getByRole("tab", { name: "Goals", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No goals yet" })).toBeVisible();

  const creation = await cli(["task", "create", "--project", projectId!, "--title", name, "--description", "Shared E2E content"]);
  const taskId = creation.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
  expect(taskId).toBeDefined();
  const task = JSON.parse((await cli(["task", "show", taskId!, "--project", projectId!, "--json"])).stdout) as Task;
  expect(task).toMatchObject({ id: taskId, status: "proposed", version: 1 });

  const referenceTitle = `Reference ${task.id}`;
  const referenceCreation = await cli(["task", "create", "--project", projectId!, "--title", referenceTitle, "--description", "[Open preview](index.html)", "--status", "todo"]);
  const referenceId = referenceCreation.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
  expect(referenceId).toBeDefined();
  const reference = JSON.parse((await cli(["task", "show", referenceId!, "--project", projectId!, "--json"])).stdout) as Task;
  expect(reference).toMatchObject({ id: referenceId, status: "todo", version: 1 });
  await verifyPreviewFlow(page, projectId!, [task.id, referenceId!]);
  const results = JSON.parse((await cli(["task", "search", task.id, "--project", projectId!, "--json"])).stdout) as SearchItem[];
  expect(results.map(({ id, title, match }) => ({ id, title, match }))).toEqual([
    { id: task.id, title: name, match: { fields: ["id"], descriptionSnippet: null } },
    { id: referenceId, title: referenceTitle, match: { fields: ["title"], descriptionSnippet: null } },
  ]);
  const idResults = JSON.parse((await cli(["task", "search", `id:${task.id}`, "--project", projectId!, "--json"])).stdout) as SearchItem[];
  expect(idResults.map(({ id, match }) => ({ id, match }))).toEqual([
    { id: task.id, match: { fields: ["id"], descriptionSnippet: null } },
  ]);

  await page.goto(`${topology.baseURL}/projects/${projectId}`);
  await page.getByRole("tab", { name: "Task list" }).click();
  await page.getByRole("tab", { name: "Task chains" }).click();
  const input = page.getByRole("textbox", { name: "Search task IDs, titles and descriptions" });
  await input.fill(task.id);
  const searchResponse = page.waitForResponse(response => response.url().endsWith(`/api/v1/projects/${projectId}/tasks/search`) && response.request().method() === "POST");
  await input.press("Enter");
  const response = await searchResponse;
  expect(response.status()).toBe(200);
  const searchRequestId = response.headers()["x-request-id"];
  expect(searchRequestId).toBeTruthy();
  console.log(`ID search request ID: ${searchRequestId}`);
  const webResults = (await response.json() as { items: SearchItem[] }).items;
  expect(webResults.map(({ id, title, match }) => ({ id, title, match }))).toEqual(results.map(({ id, title, match }) => ({ id, title, match })));
  const hits = page.getByRole("button", { name: /^Open task: / });
  await expect(hits).toHaveCount(2);
  await expect(hits.nth(0)).toContainText(task.id);
  await expect(hits.nth(0)).toContainText(name);
  await expect(hits.nth(0)).toContainText("ID match");
  await expect(hits.nth(1)).toContainText(referenceId!);
  await expect(hits.nth(1)).toContainText(referenceTitle);
  await expect(hits.nth(1)).toContainText("Title match");
  await hits.nth(0).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(detail.getByText("Shared E2E content", { exact: true })).toBeVisible();
  await detail.getByRole("tab", { name: "Attachments", exact: true }).click();
  await expect(detail.getByRole("tab", { name: "Attachments", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(detail.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(detail).toHaveCount(0);
  await page.goForward();
  await expect(detail.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(detail.getByText("Shared E2E content", { exact: true })).toBeVisible();
  await page.goForward();
  await expect(detail.getByRole("tab", { name: "Attachments", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(detail.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await detail.getByRole("button", { name: "Proposed", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "In progress", exact: true }).click();
  await page.getByRole("button", { name: "Confirm status", exact: true }).click();
  await expect.poll(async () => JSON.parse((await cli(["task", "show", task.id, "--project", projectId!, "--json"])).stdout).status).toBe("in_progress");
  const observed = JSON.parse((await cli(["task", "show", task.id, "--project", projectId!, "--json"])).stdout) as Task;
  expect(observed).toMatchObject({ id: task.id, title: name, description: "Shared E2E content" });

  const personalRead = page.waitForResponse(response => response.url().includes('/api/v1/me/in-progress-tasks?') && response.request().method() === 'GET');
  await page.goto(`${topology.baseURL}/my-tasks`);
  const personalResponse = await personalRead;
  expect(personalResponse.status()).toBe(200);
  const personalData = await personalResponse.json() as { items: { task: { id: string; allowAgents: boolean }; sessionRow: { state: string } }[] };
  expect(personalData.items.find(item => item.task.id === task.id)).toMatchObject({ task: { allowAgents: false }, sessionRow: { state: 'no_session' } });
  await expect(page.getByRole("heading", { name: "In-progress tasks", exact: true })).toBeVisible();
  const projectGroup = page.getByRole("region", { name: `${name} · Personal · ${projectId}` });
  await expect(projectGroup).toContainText("1 in progress");
  await expect(projectGroup.getByText(referenceTitle, { exact: true })).toHaveCount(0);
  await expect(projectGroup).not.toContainText("No current Session");
  const personalRow = projectGroup.locator('.task-row').filter({ has: page.getByRole('link', { name, exact: true }) });
  await expect(personalRow.locator('.task-row-id')).toHaveText(task.id);
  await expect(personalRow).toContainText('In progress');
  await expect(personalRow.locator('.project-session-status')).toHaveCount(0);
  const sharedFacts = await personalRow.locator('.task-row-meta > :not(.task-row-execution)').allTextContents();
  const projectRead = page.waitForResponse(response => response.url().includes(`/api/v1/projects/${projectId}/task-sync`) && response.request().method() === 'GET');
  await page.goto(`${topology.baseURL}/projects/${projectId}`);
  const projectResponse = await projectRead;
  expect(projectResponse.status()).toBe(200);
  const projectData = await projectResponse.json() as { taskObservations: Record<string, { state: string }> };
  expect(projectData.taskObservations[task.id]).toMatchObject({ state: 'no_session' });
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: 'Standalone tasks', exact: true }).click();
  const projectRow = page.locator('.task-row').filter({ has: page.getByRole('link', { name, exact: true }) });
  await expect(projectRow.locator('.task-row-id')).toHaveText(task.id);
  await expect(projectRow).toContainText('In progress');
  await expect(projectRow.locator('.task-row-meta > :not(.task-row-execution)')).toHaveText(sharedFacts);
  await expect(projectRow).not.toContainText('No current Session');
  await expect(projectRow.locator('.project-session-status')).toHaveCount(0);
  await page.goto(`${topology.baseURL}/my-tasks`);
  await projectGroup.getByRole("link", { name, exact: true }).click();
  await expect(detail.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(detail.getByText("Shared E2E content", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "In progress", exact: true })).toBeVisible();

  await cli(["task", "set-status", task.id, "done", "--project", projectId!, "--if-version", String(observed.version)]);
  await expect(projectGroup).toHaveCount(0, { timeout: 30_000 });
  await expect(detail.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.goto(`${topology.baseURL}/projects/${projectId}`);
  await page.reload();
  await page.getByRole("tab", { name: "Task list" }).click();
  const refreshedSearch = page.getByRole("textbox", { name: "Search task IDs, titles and descriptions" });
  await refreshedSearch.fill(`id:${task.id}`);
  await refreshedSearch.press("Enter");
  const refreshedHit = page.getByRole("button", { name: `Open task: ${name}` });
  await expect(refreshedHit).toContainText(task.id);
  await refreshedHit.click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Done", exact: true })).toBeVisible();

  // MCP and Session registration use the PAT issued to the CLI by device login.
  // Keep it out of the browser and Playwright traces.
  const configModule = pathToFileURL(path.join(path.dirname(topology.cliEntry), "config/server.js")).href;
  const { loadServerConfiguration } = await import(configModule) as { loadServerConfiguration(paths: { stateDirectory: string; configFile: string }): Promise<{ serverUrl: string; serverToken?: string }> };
  const { serverUrl, serverToken } = await loadServerConfiguration({ stateDirectory: topology.cliConfigDirectory, configFile: path.join(topology.cliConfigDirectory, "config.yml") });
  if (serverToken === undefined) throw new Error("CLI device login did not save its Worker credential.");

  await verifyCompletionFlow(page, projectId!, task.id);
  await verifyControllerImages(page);
  await verifyWorkerPatrol({ serverUrl, serverToken });
  await verifyTagFlow(page, projectId!, serverToken);

  // These API registrations exercise the assembled service without starting a
  // Worker process. Resource stopping and archival are owned by their modules.
  const taskRoot = `/api/v1/projects/${projectId}/tasks/${referenceId}`;
  const headers = { "Daynight-Worker-Protocol": "2", Origin: topology.baseURL };
  const patch = await page.request.patch(taskRoot, { headers, data: { version: reference.version, allowAgents: true } });
  expect(patch.status(), await patch.text()).toBe(200);
  const ready = await patch.json() as Task;
  const workerId = randomUUID(), firstClaimId = randomUUID(), firstWorktreeId = randomUUID();
  const workerRoot = `/api/v1/me/workers/${workerId}`;
  const sampledAt = new Date().toISOString();
  const probe = (value: unknown) => ({ state: "ok", checkedAt: sampledAt, value });
  const machine = { id: randomUUID(), name: "Product E2E worker" };
  const report = await fetch(`${topology.baseURL}${workerRoot}/report`, {
    method: "POST", headers: { "Content-Type": "application/json", "Daynight-Worker-Tool-Paths": "2", Authorization: `Bearer ${serverToken}` },
    body: JSON.stringify({
      machine, platform: "linux", workingDirectory: "/work", sampledAt,
      os: probe({ type: "Linux", release: "6.8", version: "kernel", arch: "x64" }),
      cpu: probe({ model: "CPU", logicalProcessors: 4, usagePercent: 1 }),
      memory: probe({ usedBytes: 4, totalBytes: 8 }), disk: probe({ availableBytes: 8, totalBytes: 16 }),
      versions: { daynight: "1.0.0", codex: probe("1.0.0"), copilot: probe("1.0.0") },
      taskInventory: null,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(report.status, await report.text()).toBe(200);
  expect(report.headers.get("Daynight-Worker-Tool-Paths")).toBe("2");
  const worker = await page.request.get(workerRoot, { headers: { "Daynight-Worker-Tool-Paths": "2" } });
  expect(worker.status(), await worker.text()).toBe(200);
  expect(worker.headers()["daynight-worker-tool-paths"]).toBe("2");
  expect(await worker.json()).toMatchObject({ worker: { workerId, machine } });
  const monitoring = await page.request.get(`${workerRoot}/monitoring`);
  expect(monitoring.status(), await monitoring.text()).toBe(200);
  expect(await monitoring.json()).toMatchObject({ state: "absent", data: null });
  const claim = async (version: number, claimId: string, worktreeId: string, machine: string) => {
    const response = await page.request.post(`${taskRoot}/worker-claim`, { headers, data: {
      version, claimId, workerId, worktreeId, machine: { id: randomUUID(), name: machine },
      platform: "linux", agent: "codex", agentControlMode: "web",
    } });
    expect(response.status(), await response.text()).toBe(200);
    return await response.json() as Task & { properties: { worker: { claimId: string; worktreeId: string } } };
  };
  const register = async (claimId: string, worktreeId: string) => {
    const response = await fetch(`${topology.baseURL}${taskRoot}/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${serverToken}` },
      body: JSON.stringify({ protocol: "daynight.session.v1", registrationId: randomUUID(), claimId, workerId, worktreeId,
        provider: "codex", controllerId: randomUUID(), controllerInstanceId: randomUUID() }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    return (JSON.parse(body) as { session: { sessionId: string; claimId: string } }).session;
  };
  const first = await claim(ready.version, firstClaimId, firstWorktreeId, "Original E2E worker");
  expect(first.properties.worker).toMatchObject({ claimId: firstClaimId, worktreeId: firstWorktreeId });
  const firstSession = await register(firstClaimId, firstWorktreeId);
  expect(firstSession.claimId).toBe(firstClaimId);
  const release = await page.request.post(`${taskRoot}/worker-claim/release`, { headers, data: {
    version: first.version, claimId: firstClaimId, stoppedConfirmed: true,
  } });
  expect(release.status(), await release.text()).toBe(200);
  const released = await release.json() as Task & { properties: Record<string, unknown> };
  expect(released.status).toBe("todo");
  expect(released.properties).not.toHaveProperty("worker");
  expect(released.properties).not.toHaveProperty("sessionStartup");
  const releasedRead = JSON.parse((await cli(["task", "show", referenceId!, "--project", projectId!, "--json"])).stdout) as Task & { properties: Record<string, unknown> };
  expect(releasedRead).toMatchObject({ id: referenceId, status: "todo", version: released.version });
  expect(releasedRead.properties).not.toHaveProperty("worker");

  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${referenceId}?tab=attachments`);
  await expect(page.getByRole("heading", { name: referenceTitle, exact: true })).toBeVisible();
  await expect(page.locator(".task-claim")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Force withdraw", exact: true })).toHaveCount(0);
  await expect(page.locator(".managed-session-list li button")).toHaveCount(1);

  const secondClaimId = randomUUID(), secondWorktreeId = randomUUID();
  const second = await claim(released.version, secondClaimId, secondWorktreeId, "New E2E worker");
  expect(second.properties.worker).toMatchObject({ claimId: secondClaimId, worktreeId: secondWorktreeId });
  const secondSession = await register(secondClaimId, secondWorktreeId);
  expect(secondSession.claimId).toBe(secondClaimId);
  expect(secondSession.sessionId).not.toBe(firstSession.sessionId);
  const directory = JSON.parse((await cli(["task", "session", "list", referenceId!, "--project", projectId!, "--json"])).stdout) as { items: { sessionId: string; claimId: string; currentBinding: boolean }[] };
  expect(directory.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ sessionId: firstSession.sessionId, claimId: firstClaimId, currentBinding: false }),
    expect.objectContaining({ sessionId: secondSession.sessionId, claimId: secondClaimId, currentBinding: true }),
  ]));
  for (const [session, currentBinding] of [[firstSession, false], [secondSession, true]] as const) {
    const inspection = JSON.parse((await cli(["task", "session", "show", referenceId!, session.sessionId, "--project", projectId!, "--json"])).stdout) as { sessionId: string; currentBinding: boolean; fence: { claimId: string } };
    expect(inspection).toMatchObject({ sessionId: session.sessionId, currentBinding, fence: { claimId: session.claimId } });
  }
  await page.reload();
  await expect(page.locator(".task-claim")).toContainText("New E2E worker");
  await expect(page.locator(".task-claim")).not.toContainText("Original E2E worker");

  const firstChain = await cli(["task", "create", "--project", projectId!, "--title", "Share chain root", "--status", "todo"]);
  const chainId = firstChain.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
  expect(chainId).toBeDefined();
  await cli(["task", "create", "--project", projectId!, "--title", "Share chain successor", "--status", "todo", "--depends-on", chainId!]);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: topology.baseURL });
  await page.goto(`${topology.baseURL}/projects/${projectId}?tab=tasks`);
  await page.getByRole("tab", { name: "Task chains", exact: true }).click();
  await page.locator(`#task-chain-graph-${chainId}`).click();
  const chain = page.locator(".task-chain-dialog");
  await chain.getByRole("button", { name: "More task chain actions" }).click();
  await chain.getByRole("menuitem", { name: "Copy link" }).click();
  const shared = `${topology.baseURL}/projects/${projectId}?tab=tasks&chain=${chainId}`;
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(shared);
  const anonymous = await page.context().browser()!.newContext({ locale: "en-US", ignoreHTTPSErrors: true, proxy: { server: topology.proxyURL, bypass: "127.0.0.1,localhost,*.localhost" } });
  try {
    const reader = await anonymous.newPage();
    await reader.goto(shared);
    await expect(reader).toHaveURL(/\/login\?returnPath=/);
    await reader.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
    await reader.getByRole("button", { name: "Authorize local identity", exact: true }).click();
    await expect(reader.locator(".task-chain-dialog .react-flow__node")).toHaveCount(2);
    await expect(reader).toHaveURL(`${topology.baseURL}/projects/${projectId}?tab=tasks`);
  } finally { await anonymous.close(); }
});
