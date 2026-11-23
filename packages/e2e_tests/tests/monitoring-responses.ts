import { setTimeout as delay } from "node:timers/promises";
import type { Page, Request, Response } from "@playwright/test";

type RecordEntry = {
  id: number;
  state: "started" | "finished" | "failed";
  status: number | null;
  failure: string | null;
  body: "pending" | "available" | "empty" | "unavailable" | "invalid-json";
  value?: unknown;
};

// Register before navigation: response headers can precede cancellation, and a
// later request can supply the observation that the page actually renders.
export const observeMonitoringResponses = (page: Page, pathname: string) => {
  const records = new Map<Request, RecordEntry>();
  let dropped = 0;
  const started = (request: Request) => {
    if (request.method() !== "GET" || new URL(request.url()).pathname !== pathname) return;
    if (records.size >= 50) { dropped++; return; }
    records.set(request, { id: records.size + 1, state: "started", status: null, failure: null, body: "pending" });
  };
  const response = (response: Response) => {
    const record = records.get(response.request());
    if (record) record.status = response.status();
  };
  const failed = (request: Request) => {
    const record = records.get(request);
    if (record) { record.state = "failed"; record.failure = request.failure()?.errorText ?? "unknown"; record.body = "unavailable"; }
  };
  const finished = (request: Request) => {
    const record = records.get(request);
    if (!record) return;
    record.state = "finished";
    void (async () => {
      try {
        const response = await request.response();
        if (response === null) { record.body = "unavailable"; return; }
        record.status = response.status();
        const text = await response.text();
        if (text.length === 0) { record.body = "empty"; return; }
        try { record.value = JSON.parse(text) as unknown; record.body = "available"; }
        catch { record.body = "invalid-json"; }
      } catch { record.body = "unavailable"; }
    })();
  };
  page.on("request", started);
  page.on("response", response);
  page.on("requestfailed", failed);
  page.on("requestfinished", finished);
  return {
    observations: () => [...records.values()].filter(record => record.state === "finished" && record.status === 200 && record.body === "available").map(record => ({ body: record.value })),
    diagnostics: () => JSON.stringify({ requests: [...records.values()].map(({ value: _value, ...record }) => record), dropped }),
    close: () => {
      page.off("request", started);
      page.off("response", response);
      page.off("requestfailed", failed);
      page.off("requestfinished", finished);
    },
  };
};

// Match the completed response to the observation the page actually shows.
export const waitForRenderedMonitoring = async (page: Page, reads: ReturnType<typeof observeMonitoringResponses>, timeoutMs: number): Promise<unknown> => {
  const deadline = Date.now() + timeoutMs;
  do {
    const timestamps = await page.locator(".monitoring-time time").evaluateAll(elements => elements.map(element => element.getAttribute("datetime")));
    if (timestamps.length >= 2) {
      const match = reads.observations().find(({ body }) => {
        if (body === null || typeof body !== "object") return false;
        const candidate = body as { state?: unknown; receivedAt?: unknown; data?: { capturedAt?: unknown } | null };
        return candidate.state === "available" && candidate.data?.capturedAt === timestamps.at(-1) && candidate.receivedAt === timestamps[0];
      });
      if (match) return match.body;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(100, remaining));
  } while (true);
  throw new Error(`No completed Worker monitoring response matched the rendered observation: ${reads.diagnostics()}`);
};
