import type { Browser, Frame, Request, Response } from "@playwright/test";
import type { Environment } from "./environment.ts";

type Phase = "browser-launch" | "browser-context" | "browser-page" | "console-load" | "github-initiate" | "provider-submit" | "console-return" | "console-session" | "app-register" | "context-close";
type Route = "console" | "console-login" | "authorize" | "provider-callback" | "console-callback" | "console-session" | "console-apps" | "github-authorize" | "other";
type ObservationDetail =
  | { event: "phase"; state: "started" | "completed" | "failed"; error?: "timeout" | "error" }
  | { event: "request"; request: number; route: Route; method: "GET" | "POST" | "other"; navigation: boolean }
  | { event: "response"; request: number; route: Route; status: number }
  | { event: "request-failed"; request: number; route: Route; code: string }
  | { event: "request-finished"; request: number; route: Route }
  | { event: "navigation"; route: Route };

export type AuthBootstrapObservation = { timestamp: string; elapsedMs: number; phase: Phase } & ObservationDetail;

export const registerAuth = async (
  environment: Pick<Environment, "authURL" | "proxyURL" | "baseURL">,
  observer: (event: AuthBootstrapObservation) => void,
): Promise<{ appId: string; appSecret: string }> => {
  const { chromium, expect } = await import("@playwright/test");
  const started = performance.now();
  let phase: Phase = "browser-launch";
  const observe = (event: ObservationDetail): void => observer({ timestamp: new Date().toISOString(), elapsedMs: performance.now() - started, phase, ...event });
  const begin = (next: Phase): void => {
    phase = next;
    observe({ event: "phase", state: "started" });
  };
  const complete = (): void => observe({ event: "phase", state: "completed" });
  const authOrigin = new URL(environment.authURL).origin;
  const route = (value: string): Route => {
    const url = new URL(value);
    if (url.origin === authOrigin) {
      switch (url.pathname) {
        case "/console/": return "console";
        case "/console/api/login": return "console-login";
        case "/auth/authorize": return "authorize";
        case "/auth/callback/github": return "provider-callback";
        case "/console/auth/callback": return "console-callback";
        case "/console/api/session": return "console-session";
        case "/console/api/apps": return "console-apps";
      }
    }
    return url.origin === "https://github.com" && url.pathname === "/login/oauth/authorize" ? "github-authorize" : "other";
  };
  let launched: Browser | undefined;
  let detach: (() => void) | undefined;
  try {
    begin("browser-launch");
    const browser = await chromium.launch({ proxy: { server: environment.proxyURL, bypass: "127.0.0.1,localhost" } });
    launched = browser;
    complete();
    begin("browser-context");
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "en-US" });
    complete();
    begin("browser-page");
    const page = await context.newPage();
    complete();
    const requestIds = new WeakMap<Request, number>();
    let nextRequest = 1;
    const requestId = (request: Request): number => {
      const previous = requestIds.get(request);
      if (previous !== undefined) return previous;
      const id = nextRequest++;
      requestIds.set(request, id);
      return id;
    };
    // Only fixed route labels and transport outcomes enter retained diagnostics.
    const request = (value: Request): void => observe({ event: "request", request: requestId(value), route: route(value.url()), method: value.method() === "GET" || value.method() === "POST" ? value.method() as "GET" | "POST" : "other", navigation: value.isNavigationRequest() });
    const receivedResponse = (value: Response): void => observe({ event: "response", request: requestId(value.request()), route: route(value.url()), status: value.status() });
    const finished = (value: Request): void => observe({ event: "request-finished", request: requestId(value), route: route(value.url()) });
    const failed = (value: Request): void => {
      const text = value.failure()!.errorText;
      observe({ event: "request-failed", request: requestId(value), route: route(value.url()), code: /^net::ERR_[A-Z_0-9]+$/.test(text) ? text : "unknown" });
    };
    const navigated = (frame: Frame): void => {
      if (frame === page.mainFrame()) observe({ event: "navigation", route: route(frame.url()) });
    };
    page.on("request", request);
    page.on("response", receivedResponse);
    page.on("requestfailed", failed);
    page.on("requestfinished", finished);
    page.on("framenavigated", navigated);
    detach = () => {
      page.off("request", request);
      page.off("response", receivedResponse);
      page.off("requestfailed", failed);
      page.off("requestfinished", finished);
      page.off("framenavigated", navigated);
    };
    page.setDefaultTimeout(30_000);
    begin("console-load");
    await page.goto(`${environment.authURL}/console/`);
    complete();
    begin("github-initiate");
    await page.getByRole("button", { name: "Continue with GitHub", exact: true }).click();
    complete();
    begin("provider-submit");
    await page.getByRole("button", { name: "Authorize local identity", exact: true }).click();
    complete();
    begin("console-return");
    await expect(page).toHaveURL(`${environment.authURL}/console/`);
    complete();
    begin("console-session");
    const session = await context.request.get(`${environment.authURL}/console/api/session`);
    if (session.status() !== 200) throw new Error(`UniAuth Console session failed (${session.status()}).`);
    const user = await session.json() as { csrf_token: string };
    if (typeof user.csrf_token !== "string") throw new Error("UniAuth did not return a Console CSRF token.");
    complete();
    begin("app-register");
    const response = await context.request.post(`${environment.authURL}/console/api/apps`, {
      headers: { Origin: environment.authURL, "X-CSRF-Token": user.csrf_token },
      data: {
        name: "Product E2E",
        enabled: true,
        redirect_uris: [`${environment.baseURL}/auth/callback`],
        providers: ["github"],
        initial_secret: { name: "E2E backend" },
      },
    });
    if (response.status() !== 201) throw new Error(`UniAuth App registration failed (${response.status()}): ${await response.text()}`);
    const creation = await response.json() as { app: { id: string }; secret: string };
    if (typeof creation.app.id !== "string" || typeof creation.secret !== "string") throw new Error("UniAuth did not return the registered App credentials.");
    complete();
    begin("context-close");
    await context.close();
    complete();
    return { appId: creation.app.id, appSecret: creation.secret };
  } catch (error) {
    try { observe({ event: "phase", state: "failed", error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "error" }); }
    catch (observationError) { throw new AggregateError([error, observationError], "OAuth bootstrap and diagnostic recording failed.", { cause: error }); }
    throw error;
  } finally {
    detach?.();
    if (launched !== undefined) await launched.close();
  }
};
