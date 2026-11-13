import type { Page } from "@playwright/test";
import { cli, expect, topology } from "./fixtures.ts";

type Fact = { id: string; status: string; completedAt: string | null; version: number };

// The same persisted facts are read by the CLI and the production Web, including
// the distinct scopes of a chain that crosses the Goal boundary.
export const verifyCompletionFlow = async (page: Page, projectId: string, standaloneId: string) => {
  const read = async (id: string): Promise<Fact> => JSON.parse((await cli(["task", "show", id, "--project", projectId, "--json"])).stdout) as Fact;
  const create = async (...args: string[]): Promise<string> => {
    const result = await cli(["task", "create", "--project", projectId, ...args]);
    const id = result.stdout.match(/^ID: ([0-9a-f-]{36})$/m)?.[1];
    expect(id).toBeDefined();
    return id!;
  };
  const transition = async (id: string, status: "todo" | "done", goal = false): Promise<Fact> => {
    const before = await read(id);
    await cli(["task", "set-status", id, status, "--project", projectId, "--if-version", String(before.version), ...(goal && status === "done" ? ["--force"] : [])]);
    const after = await read(id);
    expect(after.status).toBe(status);
    expect(after.completedAt === null).toBe(status !== "done");
    return after;
  };
  const goalId = await create("--type", "goal", "--title", "Completion Goal");
  const rootId = await create("--title", "Completion chain", "--status", "todo");
  const childId = await create("--title", "Goal chain member", "--status", "todo", "--parent", goalId, "--depends-on", rootId);
  const root = await transition(rootId, "done");
  const firstGoal = await transition(goalId, "done", true);
  const firstTask = await read(standaloneId);
  expect(firstTask.status).toBe("done");
  expect(firstTask.completedAt).not.toBeNull();

  const openProject = async () => {
    await page.goto(`${topology.baseURL}/projects/${projectId}`);
    await page.getByRole("tab", { name: "Task list" }).click();
  };
  const goalCard = page.locator(`[data-goal-id="${goalId}"]`);
  await openProject();
  await page.getByRole("tab", { name: "Goals", exact: true }).click();
  await expect(goalCard.locator(".goal-list-row time.completion-time-label")).toHaveAttribute("datetime", firstGoal.completedAt!);
  await goalCard.locator(".goal-list-toggle").click();
  const childRow = goalCard.locator(`#chain-task-goal-${goalId}-${childId}`);
  await expect(childRow.locator("time.completion-time-label")).toHaveCount(0);
  await expect(childRow).toBeVisible();
  await expect(childRow).toHaveAttribute("data-task-status", "todo");

  const child = await transition(childId, "done");
  await openProject();
  await page.getByRole("tab", { name: "Standalone tasks" }).click();
  await expect(page.locator(`#standalone-task-${standaloneId} time.completion-time-label`)).toHaveAttribute("datetime", firstTask.completedAt!);
  await page.getByRole("tab", { name: "Task chains" }).click();
  await expect(page.locator(`[data-chain-id="${rootId}"] .goal-header time.completion-time-label`)).toHaveAttribute("datetime", root.completedAt!);
  await page.getByRole("tab", { name: "Goals", exact: true }).click();
  await expect(goalCard.locator(".goal-list-row time.completion-time-label")).toHaveAttribute("datetime", firstGoal.completedAt!);
  await goalCard.locator(".goal-list-toggle").click();
  await expect(childRow.locator("time.completion-time-label")).toHaveAttribute("datetime", child.completedAt!);
  await goalCard.locator(`#project-goal-detail-${goalId}`).click();
  const dialog = page.getByRole("dialog", { name: "Completion Goal", exact: true });
  await expect(dialog.locator(`.goal-detail-meta time[datetime="${firstGoal.completedAt}"]`)).toBeVisible();
  await expect(dialog.getByRole("tab")).toHaveText(["Description", "Attachments", "Discussion"]);
  await expect(dialog.locator("[data-goal-task-id]")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close task details" }).click();
  await expect(childRow.locator("time.completion-time-label")).toHaveAttribute("datetime", child.completedAt!);

  await transition(standaloneId, "todo");
  await transition(goalId, "todo", true);
  await openProject();
  await page.getByRole("tab", { name: "Standalone tasks" }).click();
  await expect(page.locator(`#standalone-task-${standaloneId} time.completion-time-label`)).toHaveCount(0);
  await page.getByRole("tab", { name: "Goals", exact: true }).click();
  await expect(goalCard.locator(".goal-list-row time.completion-time-label")).toHaveCount(0);

  const nextTask = await transition(standaloneId, "done");
  const nextGoal = await transition(goalId, "done", true);
  expect(nextTask.completedAt).not.toBe(firstTask.completedAt);
  expect(nextGoal.completedAt).not.toBe(firstGoal.completedAt);
  await openProject();
  await page.getByRole("tab", { name: "Standalone tasks" }).click();
  await expect(page.locator(`#standalone-task-${standaloneId} time.completion-time-label`)).toHaveAttribute("datetime", nextTask.completedAt!);
  await page.getByRole("tab", { name: "Goals", exact: true }).click();
  await expect(goalCard.locator(".goal-list-row time.completion-time-label")).toHaveAttribute("datetime", nextGoal.completedAt!);
  await goalCard.locator(`#project-goal-detail-${goalId}`).click();
  await expect(page.getByRole("dialog", { name: "Completion Goal", exact: true }).locator(`.goal-detail-meta time[datetime="${nextGoal.completedAt}"]`)).toBeVisible();
};
