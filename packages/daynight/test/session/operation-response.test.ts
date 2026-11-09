import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOperationResponse, parseTaskOperationResponse } from "../../src/session/controller-protocol.js";
import type { SessionOperation } from "../../src/session/protocol.js";

const operation: SessionOperation = JSON.parse(readFileSync(new URL("./fixtures/operation.json", import.meta.url), "utf8"));
const { claimId: _claim, ...original } = operation;
const testOperation = { ...original, testExecutionId: "00000010-1111-4111-8111-111111111111" };

describe("Task operation response", () => {
  it.each([true, false])("preserves the original receipt and currentBinding=%s", currentBinding => {
    expect(parseTaskOperationResponse({ operation, currentBinding })).toEqual({ operation, currentBinding });
  });
  it.each([undefined, null, "true", 0, {}])("rejects currentBinding=%j", currentBinding => {
    expect(() => parseTaskOperationResponse({ operation, currentBinding })).toThrow();
  });
  it.each([
    ["missing currentBinding", { operation }],
    ["missing operation", { currentBinding: true }],
    ["unknown envelope field", { operation, currentBinding: true, extra: true }],
    ["invalid operation", { operation: { ...operation, state: "sent" }, currentBinding: true }],
    ["Test execution binding", { operation: testOperation, currentBinding: true }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseTaskOperationResponse(value)).toThrow();
  });
});

it("keeps the independent operation envelope unchanged", () => {
  expect(parseOperationResponse({ operation: testOperation })).toEqual({ operation: testOperation });
  expect(() => parseOperationResponse({ operation: testOperation, currentBinding: true })).toThrow();
});
