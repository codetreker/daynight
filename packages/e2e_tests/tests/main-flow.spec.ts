import { randomUUID } from "node:crypto";
import { test, expect, topology, cli, cliEnvironment } from "./fixtures.ts";
import { startCommand } from "../src/command.ts";

type Task = { id: string; title: string; description: string; status: string; version: number };
type SearchItem = { id: string; title: string; match: { fields: string[]; descriptionSnippet: string | null } };

test("compiled CLI and production Web share a normal task lifecycle", async ({ page }) => {
  await page.goto(`${topology.baseURL}/login`);
  await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
  await page.getByRole("button", { name: "Authorize local identity", exact: true }).click();
  await expect(page.getByRole("link", { name: "My projects", exact: true })).toBeVisible();

  let output = "";
  let resolveAuthorization: (value: { uri: string; code: string }) => void = () => {};
  const authorization = new Promise<{ uri: string; code: string }>((resolve) => { resolveAuthorization = resolve; });
  const login = startCommand(process.execPath, [topology.cliEntry, "login", "--no-browser"], {
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

  const name = `Product E2E ${randomUUID()}`;
  const project = await cli(["project", "create", name, "--repo", `https://example.test/e2e/${randomUUID()}.git`, "--team", "personal", "--confirm"]);
  const projectId = project.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
  expect(projectId).toBeDefined();
  const creation = await cli(["task", "create", "--project", projectId!, "--title", name, "--description", "Shared E2E content"]);
  const taskId = creation.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
  expect(taskId).toBeDefined();
  const task = JSON.parse((await cli(["task", "show", taskId!, "--project", projectId!, "--json"])).stdout) as Task;

  const referenceTitle = `Reference ${task.id}`;
  const referenceCreation = await cli(["task", "create", "--project", projectId!, "--title", referenceTitle]);
  const referenceId = referenceCreation.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
  expect(referenceId).toBeDefined();
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
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText("Shared E2E content", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "To do", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "In progress", exact: true }).click();
  await page.getByRole("button", { name: "Confirm status", exact: true }).click();
  await expect.poll(async () => JSON.parse((await cli(["task", "show", task.id, "--project", projectId!, "--json"])).stdout).status).toBe("in_progress");
  const observed = JSON.parse((await cli(["task", "show", task.id, "--project", projectId!, "--json"])).stdout) as Task;
  expect(observed).toMatchObject({ id: task.id, title: name, description: "Shared E2E content" });
  await cli(["task", "set-status", task.id, "done", "--project", projectId!, "--if-version", String(observed.version)]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
});
