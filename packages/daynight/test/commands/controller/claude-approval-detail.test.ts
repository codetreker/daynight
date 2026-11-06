import { expect, test } from "vitest";
import { claudeApprovalDetail } from "../../../src/commands/controller/providers/claude-approval-detail.js";
import { parseSessionInteraction } from "../../../src/session/protocol.js";

const approval = (detail: string) => ({ interactionId: "b7c62629-9cdb-4fc7-8021-ac1a7018113a", revision: "1", state: "pending", kind: "approval", title: "Approve tool", actions: ["allow_once", "reject"], detail });

test.each([
  { input: null, expected: "null" },
  { input: ["first", "second"], expected: '[\n  "first",\n  "second"\n]' },
  { input: '{"incomplete":', expected: '{"incomplete":' },
  { input: "first\nsecond", expected: "first\nsecond" },
  { input: {}, expected: "{}" },
])("Claude retains readable unexpected input: $expected", ({ input, expected }) => {
  expect(claudeApprovalDetail("UnknownTool", input)).toBe(expected);
});

test.each([
  { name: "Bash", input: { command: null, description: "Review this request" }, expected: '{\n  "command": null,\n  "description": "Review this request"\n}' },
  { name: "Write", input: { content: "keep this" }, expected: '{\n  "content": "keep this"\n}' },
  { name: "Edit", input: { file_path: "/tmp/review", old_string: "before" }, expected: '{\n  "file_path": "/tmp/review",\n  "old_string": "before"\n}' },
  { name: "MultiEdit", input: { file_path: "/tmp/review", edits: null }, expected: '{\n  "file_path": "/tmp/review",\n  "edits": null\n}' },
])("Claude $name does not hide malformed input fields", ({ name, input, expected }) => {
  expect(claudeApprovalDetail(name, input)).toBe(expected);
});

test("Claude preserves an explicitly empty edit list", () => {
  expect(claudeApprovalDetail("MultiEdit", { file_path: "/tmp/review", edits: [] })).toBe("file_path: /tmp/review\nedits: []");
});

test.each(["\\u0000", "\\ud800", "\\udfff"])("Claude approvals safely retain JSON string escape %s", escaped => {
  const value = JSON.parse(`"before${escaped}after"`) as string;
  for (const [name, input] of [
    ["Bash", { command: value }],
    ["Write", { file_path: "/tmp/review", content: value }],
    ["Edit", { file_path: "/tmp/review", old_string: "before", new_string: value }],
    ["MultiEdit", { file_path: "/tmp/review", edits: [{ old_string: value, new_string: "after" }] }],
    ["UnknownTool", { text: value }],
  ] as const) {
    const detail = claudeApprovalDetail(name, input);
    expect(() => parseSessionInteraction(approval(detail))).not.toThrow();
    expect(JSON.parse(detail)).toEqual(input);
  }
});

test.each(["\0", "\ud800", "\udfff"])("Claude checks unsafe content before truncating a formatted approval (%j)", unsafe => {
  const detail = claudeApprovalDetail("Write", { file_path: "/tmp/review", content: "x".repeat(200_001) + unsafe });
  expect(() => parseSessionInteraction(approval(detail))).not.toThrow();
  expect(detail.startsWith('{\n  "file_path": "/tmp/review",\n  "content": ')).toBe(true);
  expect(detail.endsWith("\n[Output truncated at 200000 characters]")).toBe(true);
});
