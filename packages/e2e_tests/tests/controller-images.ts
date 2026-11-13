import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { startCommand } from "../src/command.ts";
import { cliEnvironment, expect, topology } from "./fixtures.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgZGL+DwABFAEG9O6t0QAAAABJRU5ErkJggg==", "base64");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type TimelineEntry = Record<string, unknown>;
type SessionArchiveManifest = { schemaVersion: number; recordId: string; completeness: string; timeline: { fileId: string; sha256: string }; resources: { resource: { resourceId: string } }[] };
const imageParts = (entries: readonly TimelineEntry[]): { imageId: string; resourceId: string }[] => {
  const images: { imageId: string; resourceId: string }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (item.type === "image") images.push({ imageId: item.imageId as string, resourceId: item.resourceId as string });
    Object.values(item).forEach(visit);
  };
  visit(entries); return images;
};

// Only the upstream native agent is controlled. The compiled Controller, relay,
// Server, database, image decoder and archive writer execute their real paths.
export const verifyControllerImages = async (page: Page): Promise<void> => {
  const directory = await mkdtemp(path.join(topology.cliConfigDirectory, "controller-image-"));
  const binaries = path.join(directory, "bin"); await mkdir(binaries);
  const peer = path.join(binaries, "codex");
  await copyFile(path.join(import.meta.dirname, "native-image-peer.mjs"), peer); await chmod(peer, 0o700);
  await writeFile(path.join(directory, "plot.png"), png, { mode: 0o600 });
  let output = "", sessionId: string | undefined;
  const command = startCommand(process.execPath, [topology.cliEntry, "controller", "codex", "--sandbox", "danger-full-access", "--ask-for-approval", "never", "Render and save the local plot"], {
    cwd: directory, env: { ...cliEnvironment, PATH: `${binaries}${path.delimiter}${process.env.PATH}`, CODEX_HOME: path.join(directory, "native") }, timeoutMs: 120_000,
    onOutput: (_channel, chunk) => { output += chunk; sessionId = output.match(/Test Session: .*\/test-sessions\/([0-9a-f-]{36})/)?.[1]; },
  });
  let exited = false;
  void command.finished.then(() => { exited = true; }, () => { exited = true; });
  try {
    await expect.poll(() => { if (exited) throw new Error(`Controller exited before its Session was ready: ${output}`); return sessionId; }, { timeout: 60_000 }).toBeDefined();
    const root = `/api/v1/test-sessions/${sessionId}`;
    let entries: TimelineEntry[] = [];
    await expect.poll(async () => {
      const response = await page.request.get(`${root}/timeline?direction=tail&limit=100`);
      expect(response.status(), await response.text()).toBe(200);
      entries = (await response.json() as { items: TimelineEntry[] }).items;
      return new Set(imageParts(entries).map(part => part.imageId)).size;
    }, { timeout: 60_000 }).toBe(2);
    const images = imageParts(entries);
    expect(new Set(images.map(part => part.resourceId)).size).toBe(2);
    const readOriginal = async (resourceId: string): Promise<void> => {
      const response = await page.request.get(`${root}/resources/${resourceId}/content?offset=0&limit=524288`, { headers: { "Daynight-Session-Content-Revision": "2" } });
      expect(response.status(), await response.text()).toBe(200);
      const chunk = await response.json() as { resourceId: string; sha256: string; byteLength: string; offset: string; data: string; eof: boolean };
      expect(chunk).toMatchObject({ resourceId, sha256: digest(png), byteLength: String(png.length), offset: "0", eof: true });
      expect(Buffer.from(chunk.data, "base64")).toEqual(png);
    };
    for (const { resourceId } of images) await readOriginal(resourceId);
    await page.goto(`${topology.baseURL}/test-sessions/${sessionId}`);
    await expect(page.locator(".session-timeline img")).toHaveCount(2);
    await unlink(path.join(directory, "plot.png"));
    process.kill(command.pid, "SIGINT");
    const result = await command.finished;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Test Session stopped and archived.");
    const statusResponse = await page.request.get(`${root}/archive`);
    expect(statusResponse.status(), await statusResponse.text()).toBe(200);
    const { archive: status } = await statusResponse.json() as { archive: { state: string; schemaVersion: number; completeness: string; sha256: string } };
    expect(status).toMatchObject({ state: "ready", schemaVersion: 3, completeness: "complete" });
    const manifestResponse = await page.request.get(`${root}/archive/content`);
    expect(manifestResponse.status(), await manifestResponse.text()).toBe(200);
    const manifestBytes = await manifestResponse.body(), manifest = JSON.parse(manifestBytes.toString()) as SessionArchiveManifest;
    expect(digest(manifestBytes)).toBe(status.sha256);
    expect(manifest).toMatchObject({ schemaVersion: 3, recordId: sessionId, completeness: "complete" });
    expect(manifest.resources.map(({ resource }) => resource.resourceId).sort()).toEqual(images.map(part => part.resourceId).sort());
    const timelineResponse = await page.request.get(`${root}/archive/files/${manifest.timeline.fileId}`);
    expect(timelineResponse.status(), await timelineResponse.text()).toBe(200);
    const timelineBytes = await timelineResponse.body();
    expect(digest(timelineBytes)).toBe(manifest.timeline.sha256);
    expect(imageParts((JSON.parse(timelineBytes.toString()) as { entries: TimelineEntry[] }).entries)).toEqual(images);
    for (const { resourceId } of images) await readOriginal(resourceId);
    await page.reload();
    await expect(page.locator(".session-timeline img")).toHaveCount(2);
  } finally {
    if (!exited) { process.kill(command.pid, "SIGINT"); await command.finished; }
    await command.stop();
    await rm(directory, { recursive: true, force: true });
  }
};
