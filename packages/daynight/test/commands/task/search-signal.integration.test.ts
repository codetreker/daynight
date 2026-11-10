import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")("cancels an actual search on its second page without printing or replaying the first", async () => {
  const firstText = await readFile(new URL("../../fixtures/task-search/first-page.json", import.meta.url), "utf8");
  const first = JSON.parse(firstText) as { projectId: string; nextCursor: string };
  const temporary = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "task-search-signal-"));
  const home = path.join(root, "home"), state = path.join(home, ".daynight");
  const userId = "459052e2-186f-4a52-8a58-55425ce43631";
  const requests: { method: string | undefined; url: string | undefined; body: Record<string, unknown> }[] = [];
  let pageReceived!: () => void;
  const waiting = new Promise<void>((resolve) => { pageReceived = resolve; });
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8"); request.on("data", (part: string) => { body += part; });
    request.on("end", () => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(body) as Record<string, unknown>; }
      catch { response.writeHead(400).end(); return; }
      requests.push({ method: request.method, url: request.url, body: parsed });
      response.setHeader("Content-Type", "application/json"); response.setHeader("Daynight-User-ID", userId);
      if (requests.length === 1) response.end(firstText);
      else if (requests.length === 2) pageReceived();
      else response.writeHead(500).end();
    });
  });
  let child: ChildProcess | undefined, closed: Promise<number | null> | undefined;
  let exited = false, stdout = "", stderr = "";
  try {
    await mkdir(state, { recursive: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing fixture listener.");
    await writeFile(path.join(state, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    const executable = fileURLToPath(new URL("../../../dist/main.js", import.meta.url));
    child = spawn(process.execPath, [executable, "task", "search", "cache", "--project", first.projectId, "--json"], {
      cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, DN_CONFIG_DIR: state }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
    child.stderr!.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
    closed = new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject); child!.once("close", (code) => { exited = true; resolve(code); });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Search signal fixture timed out: ${stderr}`)), 10_000); });
    try {
      await Promise.race([waiting, closed.then((code) => { throw new Error(`Search exited before page two (${code}): ${stderr}`); }), timeout]);
      expect(child.kill("SIGINT")).toBe(true);
      expect(await Promise.race([closed, timeout])).toBe(1);
      expect(stdout).toBe(""); expect(stderr).toContain("cancelled");
      expect(requests.map(({ method, url }) => [method, url])).toEqual([
        ["POST", `/api/v1/projects/${first.projectId}/tasks/search`],
        ["POST", `/api/v1/projects/${first.projectId}/tasks/search`],
      ]);
      expect(requests[0]!.body).toEqual({ query: "cache", limit: 100 });
      expect(requests[1]!.body).toEqual({ query: "cache", limit: 100, cursor: first.nextCursor });
    } finally { if (timer !== undefined) clearTimeout(timer); }
  } finally {
    try {
      if (child !== undefined && closed !== undefined && !exited) {
        if (!child.kill("SIGKILL") && child.exitCode === null && child.signalCode === null) throw new Error("Could not terminate search fixture.");
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { stopTimer = setTimeout(() => reject(new Error("Search fixture did not close.")), 3_000); })]); }
        finally { if (stopTimer !== undefined) clearTimeout(stopTimer); }
      }
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(root, { recursive: true, force: true });
    }
  }
}, 15_000);
