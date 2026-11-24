import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type BrowserServer } from "@playwright/test";
import { BootstrapObservation, finalizeBootstrapObservation, throwBootstrapFailures, writeBootstrapObservation } from "./auth-observation.ts";
import { beginGuardedBrowserScope, bindBrowserScope, cancelGuardedBrowserScope, finishBrowserScope, submitGuardedBrowserScope } from "./fixture-owner.ts";
import { prepareCompatBrowserScope } from "./subtask-compat-bootstrap-scope.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const runDirectory = process.env.DAYNIGHT_E2E_RUN_DIRECTORY;
if (runDirectory === undefined) throw new Error("Compatibility session requires its original run.");
const topology = JSON.parse(await readFile(path.join(runDirectory, "environment.json"), "utf8")) as { baseURL: string; authURL: string; proxyURL: string; workerVariant?: "candidate" | "npm-0.72.0" };
const cancellation = new AbortController();
const observation = new BootstrapObservation(topology.authURL);
let phase: "launch" | "console" | "continue" | "authorize" | "console-return" | "session" | "app" | "complete" = "launch";
let scope: string | undefined, bound = false, server: BrowserServer | undefined, browser: Browser | undefined;
let starting: Promise<void> | undefined, closing: Promise<void> | undefined;
const close = (): Promise<void> => closing ??= (async () => {
  const failures: unknown[] = [];
  if (starting !== undefined) try { await starting; } catch (error) { failures.push(error); }
  if (browser !== undefined) try { await browser.close(); } catch (error) { failures.push(error); }
  if (server !== undefined) try { await server.close(); } catch (error) { failures.push(error); }
  if (bound && scope !== undefined) try { await finishBrowserScope(repository, runDirectory, scope); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Bootstrap browser shutdown failed.");
})();
const cancel = (): void => {
  if (cancellation.signal.aborted) return;
  cancellation.abort(new Error("Compatibility session interrupted."));
  observation.freeze();
  void close().catch(() => {});
};
process.on("SIGINT", cancel); process.on("SIGTERM", cancel);

const start = (value: typeof phase): void => { cancellation.signal.throwIfAborted(); phase = value; observation.phase(value); };
const bootstrap = async (): Promise<{ appId: string; appSecret: string }> => {
  const errors: unknown[] = [];
  let credentials: { appId: string; appSecret: string } | undefined;
  try {
    start("launch");
    scope = await prepareCompatBrowserScope({
      signal: cancellation.signal,
      begin: () => beginGuardedBrowserScope(repository, runDirectory),
      cancel: id => cancelGuardedBrowserScope(repository, runDirectory, id),
      submit: id => submitGuardedBrowserScope(repository, runDirectory, id),
    });
    cancellation.signal.throwIfAborted();
    starting = (async () => {
      server = await chromium.launchServer({ proxy: { server: topology.proxyURL, bypass: "127.0.0.1,localhost,*.localhost" }, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      const pid = server.process().pid;
      if (pid === undefined) throw new Error("Bootstrap browser process identity is unavailable.");
      await bindBrowserScope(repository, runDirectory, scope!, pid);
      bound = true;
    })();
    await starting;
    cancellation.signal.throwIfAborted();
    browser = await chromium.connect(server!.wsEndpoint());
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "en-US" });
    const page = await context.newPage();
    observation.attach(page);
    page.setDefaultTimeout(30_000);
    start("console"); await page.goto(`${topology.authURL}/console/`);
    start("continue"); await page.getByRole("button", { name: "Continue with GitHub", exact: true }).click();
    start("authorize"); await page.getByRole("button", { name: "Authorize local identity", exact: true }).click();
    start("console-return"); await expect(page).toHaveURL(`${topology.authURL}/console/`);
    start("session");
    const session = await context.request.get(`${topology.authURL}/console/api/session`);
    if (session.status() !== 200) throw new Error("UniAuth Console session failed.");
    const user = await session.json() as { csrf_token?: unknown };
    if (typeof user.csrf_token !== "string") throw new Error("UniAuth did not return a Console CSRF token.");
    start("app");
    const response = await context.request.post(`${topology.authURL}/console/api/apps`, {
      headers: { Origin: topology.authURL, "X-CSRF-Token": user.csrf_token },
      data: { name: "Product E2E", enabled: true, redirect_uris: [`${topology.baseURL}/auth/callback`], providers: ["github"], initial_secret: { name: "E2E backend" } },
    });
    if (response.status() !== 201) throw new Error("UniAuth App registration failed.");
    const creation = await response.json() as { app?: { id?: unknown }; secret?: unknown };
    if (typeof creation.app?.id !== "string" || typeof creation.secret !== "string") throw new Error("UniAuth did not return the registered App credentials.");
    credentials = { appId: creation.app.id, appSecret: creation.secret };
    await context.close();
    start("complete"); observation.phase("complete", "success");
  } catch (error) { observation.phase(phase, "failure"); errors.push(error); }
  finally {
    await finalizeBootstrapObservation(observation, close, snapshot => writeBootstrapObservation(path.join(runDirectory, "results", "auth-bootstrap.json"), snapshot), errors);
  }
  throwBootstrapFailures(errors);
  if (credentials === undefined) throw new Error("OAuth bootstrap did not return credentials.");
  return credentials;
};

const main = async (): Promise<void> => {
  const credentials = await bootstrap();
  cancellation.signal.throwIfAborted();
  const filename = path.join(runDirectory, "private", "bootstrap-credentials.json");
  await writeFile(`${filename}.tmp`, `${JSON.stringify(credentials)}\n`, { flag: "wx", mode: 0o600 });
  await rename(`${filename}.tmp`, filename);
  const deadline = performance.now() + 120_000;
  const ready = path.join(runDirectory, "private", "bootstrap-server-ready");
  while (true) {
    cancellation.signal.throwIfAborted();
    try { if (await readFile(ready, "utf8") === "ready\n") break; throw new Error("Server readiness receipt is invalid."); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (performance.now() >= deadline) throw new Error("Server readiness was not confirmed before the deadline.");
    await delay(100, undefined, { signal: cancellation.signal });
  }
  const config = topology.workerVariant === undefined ? "subtask-compat-playwright.config.ts" : "subtask-compat-goal-worker.config.ts";
  const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("@playwright/test/cli")), "test", "--config", path.join(repository, "packages/e2e_tests/src", config)], { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  const stop = (): void => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT"); };
  cancellation.signal.addEventListener("abort", stop, { once: true });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    cancellation.signal.throwIfAborted();
    if (result.code !== 0 || result.signal !== null) throw new Error(`Playwright failed (exit=${result.code}, signal=${result.signal}).`);
  } finally { cancellation.signal.removeEventListener("abort", stop); }
};

try { await main(); }
catch { console.error(`Compatibility session failed at ${phase}; sensitive diagnostics suppressed.`); process.exitCode = 1; }
finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
