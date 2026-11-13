import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it.each(["complete", "failed"] as const)("settles the real asset download script after a %s response body", async mode => {
  const project = path.resolve(import.meta.dirname, "../../../../..");
  const scratch = path.join(project, ".tmp");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "herdr-download-"));
  try {
    const scripts = path.join(root, "packages/daynight/scripts");
    await mkdir(scripts, { recursive: true });
    const entry = path.join(scripts, "prepare-herdr-platform.mjs");
    await copyFile(path.join(project, "packages/daynight/scripts/prepare-herdr-platform.mjs"), entry);
    const preload = path.join(root, "response.mjs");
    await writeFile(preload, mode === "complete"
      ? 'globalThis.fetch = async () => new Response("deliberately invalid official asset");\n'
      : 'globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("isolated response failure")); } }));\n');
    const result = await new Promise<{ code: number | null; signal: string | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, entry], { stdio: ["ignore", "ignore", "pipe"], timeout: 5000 });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stderr }));
    });
    expect(result.signal, result.stderr).toBeNull();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain(mode === "complete" ? "Official herdr asset digest differs" : "isolated response failure");
    expect(result.stderr).not.toContain("unsettled top-level await");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
