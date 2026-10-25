import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { parse } from "yaml";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createInstalledCli, terminateInstalledProcess } from "../fixtures/installed-cli.js";

let installed: Awaited<ReturnType<typeof createInstalledCli>>;
beforeAll(async () => { installed = await createInstalledCli(); });
afterAll(async () => { await installed?.cleanup(); });

it("logs in with a device code, uses its credential for service access, then revokes it through the installed launcher", async () => {
  const home = path.join(installed.receipt.root, "device login home");
  const configuration = path.join(home, ".daynight", "config.yml");
  await mkdir(path.dirname(configuration), { recursive: true });
  const calls: { path: string; body: string; authorization?: string }[] = [];
  let revoked = false;
  let origin: string;
  const token = "installed-device-credential";
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      calls.push({ path: request.url!, body, ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }) });
      const json = (value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
      if (request.url === "/api/v1/auth/device/code") {
        json({ device_code: "installed-device-secret", user_code: "BCDFG-HJKLM", verification_uri: `${origin}/device`, verification_uri_complete: `${origin}/device?user_code=BCDFG-HJKLM`, expires_in: 600, interval: 1 });
      } else if (request.url === "/api/v1/auth/device/token") {
        json({ access_token: token, token_type: "Bearer", expires_in: 2592000 });
      } else if (request.url === "/api/v1/projects?limit=100" && request.headers.authorization === `Bearer ${token}` && !revoked) {
        json({ items: [], nextCursor: null });
      } else if (request.url === "/api/v1/auth/device/logout" && request.headers.authorization === `Bearer ${token}`) {
        revoked = true; response.writeHead(204); response.end();
      } else json({ error: { code: "unauthenticated", message: "Login required", requestId: "installed-auth" } }, 401);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing device auth listener.");
  origin = `http://127.0.0.1:${address.port}`;
  await writeFile(configuration, `serverUrl: ${origin}\n`);
  const invoke = async (args: string[]) => {
    const child = crossSpawn(installed.receipt.launcherPath, args, { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" }, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr!.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    const timer = setTimeout(() => { void terminateInstalledProcess(child, closed); }, 15_000);
    try { return { code: await closed, stdout, stderr }; }
    finally { clearTimeout(timer); }
  };
  try {
    const missing = await invoke(["project", "list", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("daynight login");
    expect(calls).toEqual([]);
    const login = await invoke(["login", "--no-browser"]);
    expect(login.code, login.stderr).toBe(0);
    expect(login.stdout).toBe("");
    expect(login.stderr).toContain("BCDFG-HJKLM");
    expect(login.stderr).not.toContain("installed-device-secret");
    expect(login.stderr).not.toContain(token);
    expect(parse(await readFile(configuration, "utf8"))).toEqual({ serverUrl: origin, serverToken: token });
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ client_id: "daynight-cli" });
    expect(Object.fromEntries(new URLSearchParams(calls[1]!.body))).toEqual({ device_code: "installed-device-secret", client_id: "daynight-cli", grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_name: hostname() });
    expect(calls[0]!.authorization).toBeUndefined();
    expect(calls[1]!.authorization).toBeUndefined();
    const list = await invoke(["project", "list", "--json"]);
    expect(list.code, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([]);
    const logout = await invoke(["logout"]);
    expect(logout.code, logout.stderr).toBe(0);
    expect(revoked).toBe(true);
    expect(parse(await readFile(configuration, "utf8"))).toEqual({ serverUrl: origin });
    const again = await invoke(["logout"]);
    expect(again.code, again.stderr).toBe(0);
    expect(calls.filter((call) => call.path.endsWith("logout"))).toHaveLength(1);
    expect(await readdir(path.dirname(configuration))).toEqual(["config.yml"]);
  } finally { await new Promise<void>((resolve, reject) => { server.close((cause) => cause === undefined ? resolve() : reject(cause)); server.closeAllConnections(); }); }
}, 30_000);
