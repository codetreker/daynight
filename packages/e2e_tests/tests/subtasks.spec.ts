import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect, topology, cli, cliEnvironment, startOwnedCommand } from "./fixtures.ts";

type Task = { id: string; title: string; status: string; version: number; parentId: string | null; parentTaskId: string | null; assignedTo: string | null; progress?: { total: number; done: number; cancelled: number; unfinished: number } };
type MCPTask = Omit<Task, "version"> & { version: string };

test("ordinary subtask: repair, reverify, cancel and delete across Web CLI MCP", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`${topology.baseURL}/login`);
  await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
  await page.getByRole("button", { name: "Authorize local identity", exact: true }).click();
  await expect(page.getByRole("link", { name: "Projects", exact: true })).toBeVisible();

  let output = "";
  let resolveDevice: (device: { uri: string; code: string }) => void = () => {};
  const instructions = new Promise<{ uri: string; code: string }>(resolve => { resolveDevice = resolve; });
  const login = await startOwnedCommand(process.execPath, [topology.cliEntry, "login", "--no-browser"], {
    cwd: topology.cliConfigDirectory, env: cliEnvironment, timeoutMs: 60_000,
    onOutput: (_channel, chunk) => {
      output += chunk;
      const uri = output.match(/^Open (\S+)$/m)?.[1], code = output.match(/^Enter code: (\S+)$/m)?.[1];
      if (uri !== undefined && code !== undefined) resolveDevice({ uri, code });
    },
  });
  try {
    const device = await Promise.race([instructions, login.finished.then(() => { throw new Error("CLI login exited before device authorization."); })]);
    await page.goto(`${device.uri}?user_code=${encodeURIComponent(device.code)}`);
    await page.getByRole("checkbox", { name: "This code matches the one in my terminal", exact: true }).check();
    await page.getByRole("button", { name: "Authorize CLI", exact: true }).click();
    expect((await login.finished).exitCode).toBe(0);
  } finally { await login.stop(); }

  const configModule = pathToFileURL(path.join(path.dirname(topology.cliEntry), "config/server.js")).href;
  const { loadServerConfiguration } = await import(configModule) as { loadServerConfiguration(paths: { stateDirectory: string; configFile: string }): Promise<{ serverToken?: string }> };
  const { serverToken } = await loadServerConfiguration({ stateDirectory: topology.cliConfigDirectory, configFile: path.join(topology.cliConfigDirectory, "config.yml") });
  if (serverToken === undefined) throw new Error("CLI device login did not save its credential.");
  const mcp = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${topology.baseURL}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", Authorization: `Bearer ${serverToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(30_000),
    });
    expect(response.status, `${name} HTTP status`).toBe(200);
    const rpc = await response.json() as { jsonrpc: string; id: number; error?: { code: number }; result?: { isError?: boolean; structuredContent?: { data?: T; error?: { code?: string } } } };
    expect(rpc.jsonrpc).toBe("2.0"); expect(rpc.id).toBe(1);
    if (rpc.error || rpc.result?.isError) throw new Error(`${name} failed: ${rpc.error?.code ?? rpc.result?.structuredContent?.error?.code ?? "unknown"}`);
    expect(rpc.result?.structuredContent?.data, `${name} data`).toBeDefined();
    return rpc.result!.structuredContent!.data!;
  };
  const name = `Ordinary subtask E2E ${randomUUID()}`;
  const team = JSON.parse((await cli(["team", "create", `Nested subtask E2E ${randomUUID()}`, "--confirm", "--json"])).stdout) as { id: string };
  const project = await cli(["project", "create", name, "--repo", `https://example.test/e2e/${randomUUID()}.git`, "--team", team.id, "--confirm"]);
  const projectId = project.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
  if (projectId === undefined) throw new Error("Project creation returned no ID.");
  const command = async (args: string[]) => cli([...args, "--project", projectId]);
  const create = async (args: string[]) => {
    const result = await command(["task", "create", ...args]);
    const id = result.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
    if (id === undefined) throw new Error("Task creation returned no ID.");
    return id;
  };
  const show = async (id: string): Promise<Task> => JSON.parse((await command(["task", "show", id, "--json"])).stdout) as Task;
  const status = async (id: string, next: string, extra: string[] = []) => {
    const current = await show(id);
    await command(["task", "set-status", id, next, "--if-version", String(current.version), ...extra]);
    const updated = await show(id);
    expect(updated).toMatchObject({ id, status: next, version: current.version + 1 });
    return updated;
  };
  const goalId = await create(["--type", "goal", "--title", "Acceptance goal", "--status", "in_progress"]);
  const parentId = await create(["--parent", goalId, "--title", "Acceptance task", "--status", "todo"]);
  const parent = await status(parentId, "in_progress");
  expect(parent.assignedTo).toEqual(expect.any(String));
  await command(["task", "thread", "post", parentId, "--body", "Initial acceptance finding"]);
  expect((await show(goalId)).progress).toMatchObject({ total: 1, done: 0, unfinished: 1 });

  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${parentId}`);
  await expect(page.getByRole("heading", { name: "Acceptance task", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Subtasks", exact: true }).click();
  const children = page.getByRole("region", { name: "Subtasks", exact: true });
  await expect(children.getByText("No subtasks", { exact: true })).toBeVisible();
  await children.getByRole("button", { name: "New subtask" }).click();
  const form = page.getByRole("dialog", { name: "New subtask" });
  await form.getByLabel("Title", { exact: true }).fill("Repair acceptance finding");
  await form.getByLabel("Description", { exact: true }).fill("Repair the reported issue");
  await form.getByRole("combobox", { name: "Status", exact: true }).selectOption("todo");
  const createdResponse = page.waitForResponse(response => response.url().endsWith(`/api/v1/projects/${projectId}/tasks`) && response.request().method() === "POST");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  const creation = await createdResponse;
  expect(creation.status()).toBe(201);
  const created = await creation.json() as Task;
  expect(created).toMatchObject({ title: "Repair acceptance finding", parentTaskId: parentId, status: "todo", assignedTo: parent.assignedTo, version: 1 });
  const childId = created.id;
  await expect(page.getByRole("tab", { name: "Subtasks", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(children.getByRole("link", { name: created.title, exact: true })).toBeVisible();
  expect(await show(parentId)).toMatchObject({ id: parentId, status: "in_progress", version: parent.version });
  expect((await show(goalId)).progress).toMatchObject({ total: 1, done: 0, unfinished: 1 });
  expect(await show(childId)).toMatchObject({ id: childId, parentTaskId: parentId, assignedTo: parent.assignedTo, version: created.version });
  const list = JSON.parse((await command(["task", "list", "--parent-task", parentId, "--all", "--json"])).stdout) as Task[];
  expect(list.map(item => item.id)).toEqual([childId]);
  const childMcp = await mcp<MCPTask>("task_show", { projectId, taskId: childId, view: "full", taskParentView: "v1" });
  expect(childMcp).toMatchObject({ id: childId, parentTaskId: parentId, assignedTo: parent.assignedTo, version: String(created.version) });
  const parentMcp = await mcp<MCPTask>("task_show", { projectId, taskId: parentId, view: "full", taskParentView: "v1" });
  expect(parentMcp).toMatchObject({ id: parentId, parentId: goalId, status: "in_progress", version: String(parent.version) });
  const mcpChildren = await mcp<{ items: MCPTask[]; nextCursor: string | null }>("task_list", { projectId, parentTaskId: parentId, all: true, view: "full", taskParentView: "v1" });
  expect(mcpChildren.nextCursor).toBeNull();
  expect(mcpChildren.items).toMatchObject([{ id: childId, parentTaskId: parentId, version: String(created.version) }]);

  const settingsPath = `/api/v1/teams/${team.id}/settings`;
  const readSettings = async () => {
    const response = await page.request.get(`${topology.baseURL}${settingsPath}`);
    expect(response.status()).toBe(200);
    return await response.json() as { version: number; allowNestedSubtask: boolean };
  };
  const initialSettings = await readSettings();
  expect(initialSettings.allowNestedSubtask).toBe(false);
  await page.goto(`${topology.baseURL}/teams/${team.id}/settings`);
  const settings = page.locator("section").filter({ has: page.getByRole("heading", { name: "Task settings", exact: true }) });
  const toggle = settings.getByRole("switch", { name: "Allow nested subtasks", exact: true });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const saveSettings = async (value: boolean, previousVersion: number) => {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", String(value));
    const result = page.waitForResponse(response => response.url().endsWith(settingsPath) && response.request().method() === "PATCH");
    await settings.getByRole("button", { name: "Save changes", exact: true }).click();
    const receipt = await result;
    expect(receipt.status()).toBe(200);
    expect(await receipt.json()).toMatchObject({ version: previousVersion + 1, allowNestedSubtask: value });
    await expect(settings.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    expect(await readSettings()).toMatchObject({ version: previousVersion + 1, allowNestedSubtask: value });
  };
  await saveSettings(true, initialSettings.version);

  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${childId}`);
  await page.getByRole("tab", { name: "Subtasks", exact: true }).click();
  const nestedChildren = page.getByRole("region", { name: "Subtasks", exact: true });
  await nestedChildren.getByRole("button", { name: "New subtask" }).click();
  const nestedForm = page.getByRole("dialog", { name: "New subtask" });
  await nestedForm.getByLabel("Title", { exact: true }).fill("Existing nested task");
  await nestedForm.getByRole("combobox", { name: "Status", exact: true }).selectOption("todo");
  const nestedResult = page.waitForResponse(response => response.url().endsWith(`/api/v1/projects/${projectId}/tasks`) && response.request().method() === "POST");
  await nestedForm.getByRole("button", { name: "Create", exact: true }).click();
  const nestedReceipt = await nestedResult;
  expect(nestedReceipt.status()).toBe(201);
  const nested = await nestedReceipt.json() as Task;
  expect(nested).toMatchObject({ title: "Existing nested task", parentTaskId: childId, status: "todo" });
  await expect(nestedChildren.getByRole("link", { name: nested.title, exact: true })).toBeVisible();

  await page.goto(`${topology.baseURL}/teams/${team.id}/settings`);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await saveSettings(false, initialSettings.version + 1);
  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${childId}`);
  await page.getByRole("tab", { name: "Subtasks", exact: true }).click();
  await expect(nestedChildren.getByRole("link", { name: nested.title, exact: true })).toBeVisible();
  await nestedChildren.getByRole("button", { name: "New subtask" }).click();
  await nestedForm.getByLabel("Title", { exact: true }).fill("Rejected nested task");
  const rejectedResult = page.waitForResponse(response => response.url().endsWith(`/api/v1/projects/${projectId}/tasks`) && response.request().method() === "POST");
  await nestedForm.getByRole("button", { name: "Create", exact: true }).click();
  const rejected = await rejectedResult;
  expect(rejected.status()).toBe(400);
  expect(await rejected.text()).toContain("Nested subtasks are disabled for this Team.");
  await expect(nestedForm.getByRole("alert")).toContainText("Nested subtasks are disabled for this Team.");
  const remainingNested = JSON.parse((await command(["task", "list", "--parent-task", childId, "--all", "--json"])).stdout) as Task[];
  expect(remainingNested.map(item => item.id)).toEqual([nested.id]);
  expect(await show(nested.id)).toMatchObject({ id: nested.id, parentTaskId: childId, status: "todo" });
  await status(nested.id, "done");
  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${parentId}`);
  await page.getByRole("tab", { name: "Subtasks", exact: true }).click();

  await page.locator(".task-status-trigger").click();
  await page.getByRole("menuitemradio", { name: "Done", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm status" }).click();
  await expect(page.getByText("Finish or cancel the unfinished direct subtasks before this operation.")).toBeVisible();
  const blocker = page.getByRole("link", { name: childId, exact: true });
  await expect(blocker).toHaveAttribute("href", `/projects/${projectId}/tasks/${childId}`);
  expect(await show(parentId)).toMatchObject({ status: "in_progress", version: parent.version });
  await blocker.click();
  await expect(page.getByRole("heading", { name: created.title, exact: true })).toBeVisible();
  await status(childId, "in_progress");
  await command(["task", "thread", "post", childId, "--body", "Repair result recorded"]);
  await status(childId, "done");
  await page.reload();
  await expect(page.locator(".task-status-trigger")).toContainText("Done");
  await page.getByRole("tab", { name: "Discussion", exact: true }).click();
  await expect(page.getByRole("region", { name: "Discussion" })).toContainText("Repair result recorded");
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.getByRole("region", { name: "Parent Task" }).getByRole("link", { name: "Acceptance task" }).click();
  await expect(page.getByRole("heading", { name: "Acceptance task", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Discussion", exact: true }).click();
  const discussion = page.getByRole("region", { name: "Discussion" });
  await expect(discussion).toContainText("Initial acceptance finding");
  await discussion.getByRole("textbox", { name: "Discussion message" }).fill("Reverification passed");
  await discussion.getByRole("button", { name: "Send", exact: true }).click();
  await expect(discussion).toContainText("Reverification passed");
  await status(parentId, "done");
  expect((await command(["task", "thread", "read", childId])).stdout).toContain("Repair result recorded");
  const parentThread = (await command(["task", "thread", "read", parentId])).stdout;
  expect(parentThread).toContain("Initial acceptance finding"); expect(parentThread).toContain("Reverification passed");
  expect((await show(goalId)).progress).toMatchObject({ total: 1, done: 1, unfinished: 0 });
  await page.reload();
  await expect(page.locator(".task-status-trigger")).toContainText("Done");
  await expect(page.getByRole("region", { name: "Discussion" })).toContainText("Reverification passed");
  await page.getByRole("tab", { name: "Subtasks", exact: true }).click();
  await expect(page.getByRole("region", { name: "Subtasks" })).toContainText("Repair acceptance finding");
  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${goalId}`);
  await expect(page.locator(".goal-information-progress")).toHaveText("1/1 completed");

  const cancelParent = await create(["--title", "Cancellation parent", "--status", "todo"]);
  const pending = await create(["--title", "Pending descendant", "--parent-task", cancelParent, "--status", "todo"]);
  const finished = await create(["--title", "Finished descendant", "--parent-task", cancelParent, "--status", "todo"]);
  const finishedBefore = await status(finished, "done");
  await status(cancelParent, "cancelled", ["--confirm"]);
  for (const id of [cancelParent, pending]) expect(await mcp<MCPTask>("task_show", { projectId, taskId: id, view: "full", taskParentView: "v1" })).toMatchObject({ id, status: "cancelled" });
  expect(await mcp<MCPTask>("task_show", { projectId, taskId: finished, view: "full", taskParentView: "v1" })).toMatchObject({ id: finished, status: "done", version: String(finishedBefore.version), parentTaskId: cancelParent });
  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${cancelParent}`);
  await expect(page.locator(".task-status-trigger")).toContainText("Cancelled");
  await page.getByRole("tab", { name: "Subtasks", exact: true }).click();
  await expect(page.getByRole("region", { name: "Subtasks" })).toContainText("Pending descendant");
  await expect(page.getByRole("region", { name: "Subtasks" })).toContainText("Finished descendant");

  const deleteParent = await create(["--title", "Deletion parent", "--status", "todo"]);
  const deleteChild = await create(["--title", "Deletion child", "--parent-task", deleteParent, "--status", "todo"]);
  await status(deleteChild, "done");
  const ended = await status(deleteParent, "done");
  const search = async (id: string, title: string, present: boolean) => {
    const input = page.getByRole("textbox", { name: "Search task IDs, titles and descriptions" });
    await input.fill(id);
    const response = page.waitForResponse(item => item.url().endsWith(`/api/v1/projects/${projectId}/tasks/search`) && item.request().method() === "POST");
    await input.press("Enter");
    expect((await response).status()).toBe(200);
    const results = page.getByRole("region", { name: "Search results", exact: true });
    await expect(results).toContainText(`Results for: ${id}`);
    await expect(results).toHaveAttribute("aria-busy", "false");
    const hit = page.getByRole("button", { name: /^Open task: / }).filter({ hasText: title });
    if (present) await expect(hit).toHaveCount(1);
    else {
      await expect(results.getByRole("heading", { name: "No matching tasks" })).toBeVisible();
      await expect(hit).toHaveCount(0);
    }
  };
  await page.goto(`${topology.baseURL}/projects/${projectId}`);
  await page.getByRole("tab", { name: "Task list" }).click();
  await search(deleteParent, "Deletion parent", true);
  await search(deleteChild, "Deletion child", true);
  await page.goto(`${topology.baseURL}/projects/${projectId}/tasks/${deleteParent}`);
  await page.getByRole("tab", { name: "Subtasks", exact: true }).click();
  await expect(page.getByRole("region", { name: "Subtasks" })).toContainText("Deletion child");
  const beforeSync = await page.request.get(`${topology.baseURL}/api/v1/projects/${projectId}/task-sync`);
  expect(beforeSync.status()).toBe(200);
  const beforeSnapshot = await beforeSync.json() as { epoch: string; coverageUpdatedAt: string; tasks: { id: string }[] };
  expect(beforeSnapshot.tasks.map(task => task.id)).toEqual(expect.arrayContaining([deleteParent, deleteChild]));
  await command(["task", "delete", deleteParent, "--if-version", String(ended.version)]);
  for (const id of [deleteParent, deleteChild]) {
    const response = await page.request.get(`${topology.baseURL}/api/v1/projects/${projectId}/tasks/${id}`);
    expect(response.status(), `deleted ${id}`).toBe(410);
  }
  const query = new URLSearchParams({ epoch: beforeSnapshot.epoch, since: beforeSnapshot.coverageUpdatedAt });
  const syncResponse = await page.request.get(`${topology.baseURL}/api/v1/projects/${projectId}/task-sync?${query}`);
  expect(syncResponse.status()).toBe(200);
  const delta = await syncResponse.json() as { mode: string; epoch: string; tasks: { id: string }[]; deletedTaskIds: string[] };
  expect(delta.mode).toBe("delta");
  expect(delta.epoch).toBe(beforeSnapshot.epoch);
  expect(delta.deletedTaskIds).toEqual(expect.arrayContaining([deleteParent, deleteChild]));
  expect(delta.tasks.map(task => task.id)).not.toContain(deleteParent);
  expect(delta.tasks.map(task => task.id)).not.toContain(deleteChild);
  await page.goto(`${topology.baseURL}/projects/${projectId}`);
  await page.reload();
  await page.getByRole("tab", { name: "Task list" }).click();
  await search(deleteParent, "Deletion parent", false);
  await search(deleteChild, "Deletion child", false);
  await search(parentId, "Acceptance task", true);
  const afterDelete = JSON.parse((await command(["task", "list", "--all", "--json"])).stdout) as Task[];
  expect(afterDelete.map(item => item.id)).not.toContain(deleteParent);
  expect(afterDelete.map(item => item.id)).not.toContain(deleteChild);
  const remainingChildren = await mcp<{ items: MCPTask[] }>("task_list", { projectId, all: true, view: "full", taskParentView: "v1" });
  expect(remainingChildren.items.map(item => item.id)).not.toContain(deleteChild);
  console.log(`ordinary subtask team=${team.id} project=${projectId} goal=${goalId} parent=${parentId} repair=${childId} nested=${nested.id} cancellation=${cancelParent} deletion=${deleteParent}`);
});
