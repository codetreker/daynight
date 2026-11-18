import { writeFile } from "node:fs/promises";
import type { Page, Request } from "@playwright/test";

type Phase = "launch" | "console" | "continue" | "authorize" | "console-return" | "session" | "app" | "complete";
type Endpoint = { origin: string; path: string };
type Event = { sequence: number; type: string; [key: string]: unknown };

// Only fixed protocol endpoints may enter artifacts; paths and origins are never
// copied from an arbitrary navigation, even after removing its query string.
export const bootstrapEndpoint = (value: string, authOrigin: string): Endpoint => {
  try {
    const url = new URL(value);
    const allowed = new Map<string, ReadonlySet<string>>([
      [authOrigin, new Set(["/console/", "/console/api/session", "/console/api/apps", "/auth/authorize", "/auth/callback/github", "/console/auth/callback"])],
      ["https://github.com", new Set(["/login/oauth/authorize", "/login/oauth/access_token"])],
      ["https://api.github.com", new Set(["/user", "/user/emails"])],
    ]);
    if (allowed.get(url.origin)?.has(url.pathname)) return { origin: url.origin, path: url.pathname };
  } catch { /* Invalid addresses are also unknown endpoints. */ }
  return { origin: "other", path: "other" };
};

const method = (value: string): string => value === "GET" || value === "POST" ? value : "other";
const netError = (value: string | undefined): string => /^net::ERR_[A-Z0-9_]+$/.test(value ?? "") ? value! : "other";

export class BootstrapObservation {
  private readonly events: Event[] = [];
  private readonly requests = new Map<Request, number>();
  private readonly pending = new Map<Request, number>();
  private sequence = 0;
  private nextId = 0;
  private truncated = false;
  private frozen = false;

  private readonly authOrigin: string;
  private readonly limit: number;
  constructor(authOrigin: string, limit = 512) { this.authOrigin = authOrigin; this.limit = limit; }

  private record(type: string, fields: Record<string, unknown> = {}): void {
    if (this.frozen) return;
    if (this.events.length >= this.limit) { this.truncated = true; return; }
    this.events.push({ sequence: ++this.sequence, type, ...fields });
  }

  phase(phase: Phase, outcome: "start" | "success" | "failure" = "start"): void {
    this.record("phase", { phase, outcome });
  }

  attach(page: Page): void {
    page.on("request", request => {
      if (this.frozen || request.resourceType() !== "document" || request.frame() !== page.mainFrame()) return;
      if (this.requests.size >= this.limit) { this.truncated = true; return; }
      const id = ++this.nextId;
      this.requests.set(request, id);
      this.pending.set(request, id);
      const predecessor = request.redirectedFrom();
      this.record("request", { requestId: id, redirectedFrom: predecessor === null ? null : this.requests.get(predecessor) ?? "unknown", method: method(request.method()), endpoint: bootstrapEndpoint(request.url(), this.authOrigin) });
    });
    page.on("response", response => {
      const request = response.request();
      const id = this.requests.get(request);
      if (id !== undefined) this.record("response", { requestId: id, status: response.status() });
    });
    page.on("requestfinished", request => { if (!this.frozen) this.pending.delete(request); });
    page.on("requestfailed", request => {
      const id = this.requests.get(request);
      if (id !== undefined) {
        this.record("requestfailed", { requestId: id, error: netError(request.failure()?.errorText) });
        if (!this.frozen) this.pending.delete(request);
      }
    });
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) this.record("navigation", { endpoint: bootstrapEndpoint(frame.url(), this.authOrigin) });
    });
  }

  freeze(): { complete: boolean; truncated: boolean; events: Event[]; unresolved: number[] } {
    this.frozen = true;
    return { complete: !this.truncated, truncated: this.truncated, events: this.events, unresolved: [...this.pending.values()] };
  }
}

export const writeBootstrapObservation = async (filename: string, observation: ReturnType<BootstrapObservation["freeze"]>): Promise<void> => {
  await writeFile(filename, `${JSON.stringify(observation, null, 2)}\n`);
};

// Keep business, browser-close and artifact failures separately visible.
export const throwBootstrapFailures = (failures: unknown[]): void => {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "OAuth bootstrap or diagnostic cleanup failed.");
};

export const finalizeBootstrapObservation = async (
  observation: BootstrapObservation,
  close: () => Promise<void>,
  write: (snapshot: ReturnType<BootstrapObservation["freeze"]>) => Promise<void>,
  failures: unknown[],
): Promise<void> => {
  const snapshot = observation.freeze();
  try { await close(); } catch (error) { failures.push(error); }
  try { await write(snapshot); } catch (error) { failures.push(error); }
};
