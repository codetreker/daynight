import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { startCommand } from "../src/command.ts";
import { cliEnvironment, expect, topology } from "./fixtures.ts";
import { observeMonitoringResponses, waitForRenderedMonitoring } from "./monitoring-responses.ts";

type Monitoring = {
  state: "available";
  receivedAt: string;
  expiresAt: string;
  data: {
    capturedAt: string;
    lifecycle: "starting" | "running";
    scheduler: { phase: string };
    capacity: { occupied: number; limit: number; available: number } | null;
    reservations: unknown[];
  };
};

// A fresh configuration has no selected Projects or assistants, so the real
// Worker can report without claiming work or starting a native agent.
export const verifyWorkerMonitoring = async (page: Page): Promise<void> => {
  const startedAt = Date.now();
  let output = "", exited = false;
  const worker = startCommand(process.execPath, [topology.cliEntry, "worker", "run"], {
    cwd: topology.cliConfigDirectory, env: cliEnvironment, timeoutMs: 300_000,
    onOutput: (_channel, chunk) => { output += chunk; },
  });
  void worker.finished.then(() => { exited = true; }, () => { exited = true; });
  try {
    let workerId: string | undefined;
    await expect.poll(async () => {
      if (exited) throw new Error(`Worker exited before reporting:\n${output}`);
      const config = await readFile(path.join(topology.cliConfigDirectory, "config.yml"), "utf8");
      workerId = config.match(/^workerId:\s*([0-9a-f-]{36})\s*$/m)?.[1];
      return workerId;
    }, { timeout: 60_000 }).toBeDefined();
    const root = `/api/v1/me/workers/${workerId}`;
    await expect.poll(async () => {
      if (exited) throw new Error(`Worker exited before monitoring became available:\n${output}`);
      const response = await page.request.get(`${root}/monitoring`);
      if (response.status() === 404) return "unregistered";
      expect(response.status(), await response.text()).toBe(200);
      return (await response.json() as { state: string }).state;
    }, { timeout: 90_000, intervals: [1_000] }).toBe("available");

    const webReads = observeMonitoringResponses(page, `${root}/monitoring`);
    try {
      await page.goto(`${topology.baseURL}/workers/${workerId}`);
      const rendered = await waitForRenderedMonitoring(page, webReads, 45_000) as Monitoring;
      expect(["starting", "running"]).toContain(rendered.data.lifecycle);
      expect(rendered.data.reservations).toEqual([]);
      const captured = Date.parse(rendered.data.capturedAt), received = Date.parse(rendered.receivedAt), expires = Date.parse(rendered.expiresAt);
      expect(captured).toBeGreaterThanOrEqual(startedAt - 5_000);
      expect(captured).toBeLessThanOrEqual(Date.now() + 5_000);
      expect(received).toBeGreaterThanOrEqual(startedAt - 5_000);
      expect(received).toBeLessThanOrEqual(Date.now() + 5_000);
      expect(expires - received).toBe(3_600_000);
      await expect(page.locator(".worker-id")).toContainText(workerId!);
      await expect(page.locator(".monitoring-time time").last()).toHaveAttribute("datetime", rendered.data.capturedAt);
      await expect(page.locator(".monitoring-time time").first()).toHaveAttribute("datetime", rendered.receivedAt);
      const capacity = page.locator(".monitoring-card").filter({ has: page.getByRole("heading", { name: "Execution capacity", exact: true }) });
      if (rendered.data.capacity === null) await expect(capacity).toContainText("Capacity has not been observed.");
      else {
        await expect(capacity).toContainText(`${rendered.data.capacity.occupied} / ${rendered.data.capacity.limit}`);
        await expect(capacity).toContainText(`${rendered.data.capacity.available} available`);
      }
    } catch (error) {
      throw new Error(`Worker monitoring browser requests: ${webReads.diagnostics()}`, { cause: error });
    } finally { webReads.close(); }

    // The browser and the independent reads use the same authenticated Worker
    // resource. Do not intercept this route: the real service owns persistence.
    const participationPath = `${root}/review-participation`;
    const readParticipation = async () => {
      const response = await page.request.get(participationPath);
      expect(response.status(), await response.text()).toBe(200);
      return await response.json() as { enabled: boolean; version: string };
    };
    const initialParticipation = await readParticipation();
    expect(initialParticipation).toEqual({ enabled: false, version: "1" });
    await page.locator('[data-worker-tab="configuration"]:visible').click();
    const participation = page.getByRole("switch", { name: "Participate in PR review", exact: true });
    await expect(participation).toBeEnabled();
    await expect(participation).not.toBeChecked();
    for (const [enabled, version] of [[true, "2"], [false, "3"]] as const) {
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === participationPath && response.request().method() === "PUT");
      await participation.click();
      expect((await saved).status()).toBe(200);
      await expect(participation).toHaveAttribute("aria-checked", String(enabled));
      expect(await readParticipation()).toEqual({ enabled, version });
      await page.reload();
      await page.locator('[data-worker-tab="configuration"]:visible').click();
      await expect(participation).toHaveAttribute("aria-checked", String(enabled));
    }

    const readWorker = async () => {
      const response = await page.request.get(root, { headers: { "Daynight-Worker-Alias": "1", "Daynight-Worker-Tool-Paths": "2" } });
      expect(response.status(), await response.text()).toBe(200);
      return await response.json() as { worker: { workerId: string; machine: { id: string; name: string }; lastReportedAt: string; alias: { value: string | null; version: string } } };
    };
    const original = (await readWorker()).worker;
    await page.getByRole("button", { name: "Set alias", exact: true }).click();
    await page.getByRole("textbox", { name: "Worker alias", exact: true }).fill("办公室 Windows");
    await page.getByRole("button", { name: "Save alias", exact: true }).click();
    await expect(page.getByRole("heading", { name: "办公室 Windows", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "办公室 Windows", exact: true })).toBeVisible();
    await expect.poll(async () => {
      if (exited) throw new Error(`Worker exited before its next report:\n${output}`);
      const current = (await readWorker()).worker;
      expect(current.workerId).toBe(original.workerId);
      expect(current.machine).toEqual(original.machine);
      expect(current.alias.value).toBe("办公室 Windows");
      return Date.parse(current.lastReportedAt) > Date.parse(original.lastReportedAt);
    }, { timeout: 45_000, intervals: [1_000] }).toBe(true);
    await page.getByRole("link", { name: "Back to my Workers" }).click();
    await expect(page.locator(`a.worker-card[href="/workers/${workerId}"]`)).toContainText("办公室 Windows");
    await page.locator(`a.worker-card[href="/workers/${workerId}"]`).click();
    await page.getByRole("button", { name: "Edit alias", exact: true }).click();
    await page.getByRole("textbox", { name: "Worker alias", exact: true }).fill("家里 Mac mini");
    await page.getByRole("button", { name: "Save alias", exact: true }).click();
    await expect(page.getByRole("heading", { name: "家里 Mac mini", exact: true })).toBeVisible();
    expect((await readWorker()).worker.alias.value).toBe("家里 Mac mini");
    await page.getByRole("button", { name: "Edit alias", exact: true }).click();
    await page.getByRole("button", { name: "Clear alias", exact: true }).click();
    await expect(page.getByRole("heading", { name: original.machine.name, exact: true })).toBeVisible();
    const cleared = (await readWorker()).worker;
    expect(cleared.alias.value).toBeNull();
    expect(cleared.machine).toEqual(original.machine);
    expect(cleared.workerId).toBe(original.workerId);
  } finally {
    if (!exited) process.kill(worker.pid, "SIGINT");
    try {
      const result = await worker.finished;
      expect(result.exitCode, result.stderr).toBe(0);
    } finally { await worker.stop(); }
  }
};
