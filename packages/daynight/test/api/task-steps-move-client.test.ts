import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, createOperation, parseApiJson, stringifyApiJson } from "../../src/api/index.js";
import type { MoveTaskStepInput, StepsResource, TaskStep } from "../../src/api/types.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111", taskId = "bbbbbbbb-2222-4222-8222-222222222222", userId = "cccccccc-3333-4333-8333-333333333333";
const requestId = "12345678-1111-4111-8111-111111111111";
const time = "2026-11-04T10:11:12.123456Z";
const step = (id: string): TaskStep => ({ id, title: "same", description: "# retained", status: "skipped", createdAt: time, updatedAt: time });
const previous: StepsResource = { projectId, taskId, version: 9_007_199_254_740_993n, steps: [step("00000000"), step("00abcdef"), step("fedcba98"), step("12345678")] };
const moved: StepsResource = { ...previous, version: previous.version + 1n, steps: [previous.steps[1]!, previous.steps[0]!, previous.steps[2]!, previous.steps[3]!] };
const input: MoveTaskStepInput = { version: previous.version, position: "first" };
const json = (value: unknown) => new Response(stringifyApiJson(value), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); });
const fixture = (result: unknown) => { const operation = createOperation(); disposals.push(() => operation.dispose()); const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(result)); return { fetch, api: createApiClient({ serverUrl: "http://localhost:8787", operation, fetch }) }; };

describe("Step Move receipt validation", () => {
  it("confirms one canonical correlated PUT and exact int64 payload", async () => {
    const f = fixture(moved); expect(await f.api.moveTaskStep(projectId.toUpperCase(), taskId.toUpperCase(), "00ABCDEF", input, { requestId, previous })).toEqual(moved);
    expect(f.fetch).toHaveBeenCalledOnce(); const [url, options] = f.fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://localhost:8787/api/v1/projects/${projectId}/tasks/${taskId}/steps/00abcdef/position`); expect(options!.method).toBe("PUT"); expect(new Headers(options!.headers).get("X-Request-ID")).toBe(requestId); expect(parseApiJson(String(options!.body))).toEqual(input);
  });
  it.each([{ before: "00000000" }, { after: "FEDCBA98" }, { position: "first" }, { position: "last" }] as const)("confirms only requested placement %#", async (placement) => {
    const steps = "after" in placement || ("position" in placement && placement.position === "last") ? [previous.steps[0]!, previous.steps[2]!, previous.steps[1]!, previous.steps[3]!] : moved.steps;
    const expected = "position" in placement && placement.position === "last" ? { ...moved, steps: [previous.steps[0]!, previous.steps[2]!, previous.steps[3]!, previous.steps[1]!] } : { ...moved, steps };
    const f = fixture(expected); expect(await f.api.moveTaskStep(projectId, taskId, "00abcdef", { version: previous.version, ...placement }, { requestId, previous })).toEqual(expected);
  });
  it.each([{ before: "fedcba98" }, { after: "00000000" }] as const)("confirms adjacent no-op without version or content changes %#", async (placement) => {
    const f = fixture(previous); expect(await f.api.moveTaskStep(projectId, taskId, "00abcdef", { version: previous.version, ...placement }, { requestId, previous })).toEqual(previous);
  });
  it("allows maximum-version no-op with a single Step", async () => {
    const baseline = { ...previous, version: 9_223_372_036_854_775_807n, steps: [previous.steps[1]!] };
    const f = fixture(baseline); expect(await f.api.moveTaskStep(projectId, taskId, "00abcdef", { version: baseline.version, position: "last" }, { requestId, previous: baseline })).toEqual(baseline);
  });
  it.each([
    { version: previous.version }, { version: previous.version + 2n }, { projectId: taskId }, { steps: [] }, { steps: previous.steps },
    { steps: [moved.steps[0], moved.steps[1], moved.steps[3], moved.steps[2]] },
    { steps: moved.steps.slice(0, 3) }, { steps: [...moved.steps, step("aaaaaaaa")] },
    ...[{ title: "changed" }, { description: "changed" }, { status: "done" }, { createdAt: "2026-01-01T00:00:00Z" }, { updatedAt: "2026-01-01T00:00:00Z" }].map((changes) => ({ steps: [{ ...moved.steps[0], ...changes }, ...moved.steps.slice(1)] })),
    { steps: [moved.steps[0], { ...moved.steps[1], description: "changed survivor" }, ...moved.steps.slice(2)] },
  ])("rejects malformed or mismatched full receipts as unknown %#", async (changes) => {
    const f = fixture({ ...moved, ...changes }); await expect(f.api.moveTaskStep(projectId, taskId, "00abcdef", input, { requestId, previous })).rejects.toMatchObject({ sentRequestId: requestId, stepId: "00abcdef", phase: "protocol", outcomeUnconfirmed: true }); expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { version: 0n, position: "first" }, { version: 1n }, { version: 1n, position: "middle" }, { version: 1n, before: "bad" }, { version: 1n, before: "00ABCDEF" }, { version: 1n, after: "00abcdef" }, { version: 1n, before: "00000000", after: "fedcba98" }, { version: 1n, before: "00000000", position: "first" },
  ])("rejects invalid typed preparation without dispatch %#", async (invalid) => {
    const f = fixture(moved); await expect(f.api.moveTaskStep(projectId, taskId, "00abcdef", invalid as MoveTaskStepInput, { requestId })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, sentRequestId: requestId }); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not invent a pre-read for explicit version, accepting only version/no-op + position facts", async () => {
    for (const version of [previous.version, previous.version + 1n]) {
      const f = fixture({ ...moved, version }); expect((await f.api.moveTaskStep(projectId, taskId, "00abcdef", input, { requestId })).version).toBe(version); expect(f.fetch).toHaveBeenCalledOnce();
    }
  });
  it.each([{ position: "last" }, { before: "ffffffff" }, { after: "fedcba98" }] as const)("rejects absent/nonadjacent/wrong endpoint position without baseline %#", async (placement) => {
    const f = fixture(moved); await expect(f.api.moveTaskStep(projectId, taskId, "00abcdef", { version: previous.version, ...placement }, { requestId })).rejects.toMatchObject({ outcomeUnconfirmed: true });
  });
  it("rejects an incremented no-op and a mismatched baseline before dispatch", async () => {
    const f = fixture({ ...previous, version: previous.version + 1n }); await expect(f.api.moveTaskStep(projectId, taskId, "00abcdef", { version: previous.version, after: "00000000" }, { requestId, previous })).rejects.toMatchObject({ outcomeUnconfirmed: true });
    const g = fixture(moved); await expect(g.api.moveTaskStep(projectId, taskId, "00abcdef", input, { requestId, previous: { ...previous, version: 1n } })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false }); expect(g.fetch).not.toHaveBeenCalled();
  });
});
