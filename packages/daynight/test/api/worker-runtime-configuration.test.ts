import { describe, expect, it } from "vitest";
import { parseWorkerRuntimeConfiguration } from "../../src/api/worker-runtime-configuration.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const native = { agent: "codex", model: { value: "gpt-model", source: "local" }, reasoningEffort: { value: null, source: "native" } };
const report = () => ({ schemaVersion: 1, native: structuredClone(native), projects: [{ projectId, native: null }] });

describe("effective Worker runtime configuration", () => {
  it("preserves independent values and sources, including unavailable project configuration", () => {
    expect(parseWorkerRuntimeConfiguration(report())).toEqual(report());
    const cloud = { ...report(), native: { ...native, reasoningEffort: { value: "high", source: "cloud" } } };
    expect(parseWorkerRuntimeConfiguration(cloud)).toEqual(cloud);
    expect(parseWorkerRuntimeConfiguration({ schemaVersion: 1, native: null, projects: [] })).toEqual({ schemaVersion: 1, native: null, projects: [] });
  });

  it.each([
    null, {}, { ...report(), schemaVersion: 2 }, { ...report(), unknown: true },
    { ...report(), projects: null }, { ...report(), projects: [{ projectId: "bad", native: null }] },
    { ...report(), projects: [report().projects[0], report().projects[0]] },
    { ...report(), projects: Array.from({ length: 1025 }, (_, i) => ({ projectId: `${i.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`, native: null })) },
    ...["", " ", "a\n", "\ud800", "x".repeat(257)].map(value => ({ ...report(), native: { ...native, model: { value, source: "local" } } })),
    ...[{ value: null, source: "local" }, { value: "x", source: "native" }, { value: "x", source: "unknown" }, { source: "cloud" }, { value: "x", source: "cloud", extra: true }].map(model => ({ ...report(), native: { ...native, model } })),
    { ...report(), native: { ...native, agent: "other" } },
    { ...report(), native: { ...native, reasoningEffort: { value: "x".repeat(65), source: "cloud" } } },
  ])("rejects malformed or unbounded runtime reports %#", value => {
    expect(() => parseWorkerRuntimeConfiguration(value)).toThrow();
  });
});
