import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { startCommand } from "../src/command.ts";
import { cliEnvironment, expect, topology } from "./fixtures.ts";

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
    cwd: topology.cliConfigDirectory, env: cliEnvironment, timeoutMs: 150_000,
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

    const webRead = page.waitForResponse(response => response.url().endsWith(`${root}/monitoring`) && response.request().method() === "GET");
    await page.goto(`${topology.baseURL}/workers/${workerId}`);
    const response = await webRead;
    expect(response.status(), await response.text()).toBe(200);
    const observation = await response.json() as Monitoring;
    expect(observation.state).toBe("available");
    expect(["starting", "running"]).toContain(observation.data.lifecycle);
    expect(observation.data.reservations).toEqual([]);
    const captured = Date.parse(observation.data.capturedAt), received = Date.parse(observation.receivedAt), expires = Date.parse(observation.expiresAt);
    expect(captured).toBeGreaterThanOrEqual(startedAt - 5_000);
    expect(captured).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(received).toBeGreaterThanOrEqual(startedAt - 5_000);
    expect(received).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(expires - received).toBe(3_600_000);
    await expect(page.locator(".worker-id")).toContainText(workerId!);
    await expect(page.locator(".monitoring-time time").last()).toHaveAttribute("datetime", observation.data.capturedAt);
    await expect(page.locator(".monitoring-time time").first()).toHaveAttribute("datetime", observation.receivedAt);
    const capacity = page.locator(".monitoring-card").filter({ has: page.getByRole("heading", { name: "Execution capacity", exact: true }) });
    if (observation.data.capacity === null) await expect(capacity).toContainText("Capacity has not been observed.");
    else {
      await expect(capacity).toContainText(`${observation.data.capacity.occupied} / ${observation.data.capacity.limit}`);
      await expect(capacity).toContainText(`${observation.data.capacity.available} available`);
    }
  } finally {
    if (!exited) process.kill(worker.pid, "SIGINT");
    try {
      const result = await worker.finished;
      expect(result.exitCode, result.stderr).toBe(0);
    } finally { await worker.stop(); }
  }
};
