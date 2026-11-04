import { describe, expect, it } from "vitest";
import { stringifyApiJson } from "../../src/api/json.js";
import { canonicalStepId, decodeStepsJsonSource, parseStepResource, parseStepsResource } from "../../src/api/task-steps.js";
import type { StepResource, StepsResource, TaskStep } from "../../src/api/types.js";

const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
const otherId = "cccccccc-3333-4333-8333-333333333333";
const step: TaskStep = { id: "00abcdef", title: "  <原值&> 😀 \uFEFF  ", description: " # Markdown\n\t\"\\\u2028\u2029 �  ", status: "done", createdAt: "2026-11-03T10:11:12.123456Z", updatedAt: "2026-11-03T10:11:12Z" };
const resource: StepsResource = { projectId, taskId, version: 9_007_199_254_740_993n, steps: [step] };
const item: StepResource = { projectId, taskId, version: resource.version, step };
const collection = (value: unknown) => parseStepsResource(value, projectId, taskId);

describe("strict Task Steps resource parsing", () => {
  it("preserves every raw field and received order with exact large versions", () => {
    const steps = [step, { ...step, id: "00000000", status: "skipped" as const }, { ...step, id: "ffffffff", status: "todo" as const }, { ...step, id: "12345678", status: "in_progress" as const }];
    const expected = { ...resource, version: 9_223_372_036_854_775_807n, steps };
    expect(collection(decodeStepsJsonSource(`${stringifyApiJson(expected)}\n`))).toEqual(expected);
    expect(parseStepResource(decodeStepsJsonSource(stringifyApiJson(item)), projectId, taskId, step.id)).toEqual(item);
    expect(collection({ ...resource, steps: [] })).toEqual({ ...resource, steps: [] });
    expect(collection({ ...resource, steps: [{ ...step, title: "\uFEFF", description: "" }] }).steps[0]!.title).toBe("\uFEFF");
  });
  it.each(["00000000", "00abcdef", "00ABCDEF", "FFFFFFFF"])("normalizes only valid input identity %s", (value) => {
    expect(canonicalStepId(value)).toBe(value.toLowerCase());
  });
  it.each(["", "abc", "000000000", "0000000g", taskId, "00000000 ", " 00000000"])("rejects input identity %s", (value) => {
    expect(canonicalStepId(value)).toBeNull();
  });
  it.each([
    null, [], {}, { ...resource, projectId: otherId }, { ...resource, taskId: otherId }, { ...resource, projectId: projectId.toUpperCase() }, { ...resource, taskId: taskId.toUpperCase() },
    ...[undefined, null, "1", 1, 1.5, 0n, -1n, 9_223_372_036_854_775_808n].map((version) => ({ ...resource, version })),
    ...[undefined, null, {}, [step, step]].map((steps) => ({ ...resource, steps })), { ...resource, step }, { ...resource, position: 0 },
  ])("rejects malformed or wrong-scope collection %#", (value) => {
    expect(() => collection(value)).toThrow();
  });
  it.each([
    ...["ABCDEF00", "abc", taskId, "0000000g", null].map((id) => ({ id })),
    ...["", " \u0085\u2000\t", "\0", "\ud800", null].map((title) => ({ title })),
    ...[undefined, null, "\0", "\udfff"].map((description) => ({ description })),
    ...["DONE", "", null].map((status) => ({ status })), { createdAt: undefined }, { updatedAt: null }, { position: 0 }, { unknown: "value" },
  ])("rejects an invalid or incomplete Step %#", (changes) => {
    expect(() => collection({ ...resource, steps: [{ ...step, ...changes }] })).toThrow();
  });
  it.each([
    "2026-02-29T10:11:12Z", "2026-11-03T24:11:12Z", "2026-11-03T10:11:60Z", "2026-11-03T10:11:12+00:00",
    "2026-11-03T10:11:12.1234567Z", "2026-11-03T10:11:12.123456789Z", "2026-11-03T10:11:12.0z", "0000-01-01T00:00:00Z",
    "0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000000Z", "infinity", "",
  ])("rejects invalid calendar, non-microsecond or zero timestamp %s", (createdAt) => {
    expect(() => collection({ ...resource, steps: [{ ...step, createdAt }] })).toThrow();
  });
  it.each(["2024-02-29T00:00:00Z", "0001-01-01T00:00:00.000001Z", "2026-11-03T10:11:12.1Z", "2026-11-03T10:11:12.123000Z"])("preserves valid finite microsecond timestamp %s", (createdAt) => {
    expect(collection({ ...resource, steps: [{ ...step, createdAt }] }).steps[0]!.createdAt).toBe(createdAt);
  });
  it.each([null, {}, { ...item, step: undefined }, { ...item, step: null }, { ...item, step: { ...step, id: "00000000" } }, { ...item, steps: [step] }, { ...item, projectId: otherId }, { ...item, version: 1 }])("requires the complete exact requested item resource %#", (value) => {
    expect(() => parseStepResource(value, projectId, taskId, step.id)).toThrow();
  });
  it.each([
    `{"projectId":"${projectId}","projectId":"${projectId}","taskId":"${taskId}","version":1,"steps":[]}`,
    `{"projectId":"${projectId}","taskId":"${taskId}","version":1,"\\u0076ersion":1,"steps":[]}`,
    stringifyApiJson(resource).replace('"id":"00abcdef"', '"id":"00abcdef","id":"00000000"'),
    stringifyApiJson(resource).replace('"title":', '"\\u0074itle":"duplicate","title":'),
    stringifyApiJson(item).replace('"description":', '"description":"duplicate","description":'),
    `{"error":{"code":"not_found","code":"internal_error","message":"refused","requestId":"steps-test"}}`,
    `${stringifyApiJson(resource)} {}`, "[]", "null", "{",
  ])("rejects duplicate decoded keys or malformed original source %#", (source) => {
    expect(() => decodeStepsJsonSource(source)).toThrow();
  });
  it.each(["1.0", "1e0", "0", "9223372036854775808", '"1"'])("does not repair invalid version token %s", (version) => {
    const source = stringifyApiJson(resource).replace('"version":9007199254740993', `"version":${version}`);
    expect(() => collection(decodeStepsJsonSource(source))).toThrow();
  });
});
