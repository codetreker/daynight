import { expect, test } from "vitest";
import { codexApprovalDetail } from "../../../src/commands/controller/providers/codex-approval-detail.js";

const commandMethod = "item/commandExecution/requestApproval";
const fileMethod = "item/fileChange/requestApproval";
const identity = { threadId: "thread", turnId: "turn", itemId: "item", startedAtMs: 42, environmentId: "local", availableDecisions: ["accept", "decline"], proposedExecpolicyAmendment: ["date"] };

test("command approvals put the exact shell command before its working directory and reason", () => {
  const command = "/bin/zsh -lc 'printf \"%s\\n\" hello && date'";
  const detail = codexApprovalDetail(commandMethod, { ...identity, command, cwd: "/work tree", reason: "Read the current date", commandActions: [{ type: "unknown", command: "date" }] });
  expect(detail).toBe(`${command}\ncwd: /work tree\nRead the current date`);
});

test("command item data fills omitted previews without replacing an explicit request command", () => {
  const item = { type: "commandExecution", command: "old command", cwd: "/work" };
  expect(codexApprovalDetail(commandMethod, { ...identity, command: "new command" }, item)).toBe("new command\ncwd: /work");
  expect(codexApprovalDetail(commandMethod, identity, item)).toBe("old command\ncwd: /work");
});

test("file approvals include every file and rename destination before the diff and retain the write grant", () => {
  const detail = codexApprovalDetail(fileMethod, { ...identity, reason: "Update settings", grantRoot: "/outside" }, {
    type: "fileChange", id: "item", status: "inProgress", changes: [
      { path: "/work/new.txt", kind: { type: "add" }, diff: "+hello" },
      { path: "/work/old.txt", kind: { type: "update", move_path: "/work/renamed.txt" }, diff: "-before\n+after" },
      { path: "/work/gone.txt", kind: { type: "delete" }, diff: "-gone" },
    ],
  });
  expect(detail).toContain("Add: /work/new.txt");
  expect(detail).toContain("Update: /work/old.txt → /work/renamed.txt");
  expect(detail).toContain("Delete: /work/gone.txt");
  expect(detail.indexOf("/work/gone.txt")).toBeLessThan(detail.indexOf("+hello"));
  expect(detail).toContain("Update settings");
  expect(detail).toContain("Requested write root: /outside");
  for (const key of Object.keys(identity)) expect(detail).not.toContain(key);
});

test("file approvals without item details retain the native explanation and grant root", () => {
  expect(codexApprovalDetail(fileMethod, { ...identity, reason: "Allow writing configuration", grantRoot: "/configuration" })).toBe("Allow writing configuration\nRequested write root: /configuration");
});

test("extended command approvals preserve network, permission and future decision information", () => {
  const detail = codexApprovalDetail(commandMethod, { ...identity, command: "curl https://example.com", cwd: "/work", networkApprovalContext: { host: "example.com", protocol: "https" }, additionalPermissions: { fileSystem: { write: ["/outside"] } }, futureApprovalScope: { target: "important" } });
  expect(detail.startsWith("curl https://example.com\ncwd: /work")).toBe(true);
  expect(detail).toContain("example.com");
  expect(detail).toContain("https");
  expect(detail).toContain("/outside");
  expect(detail).toContain("futureApprovalScope");
  expect(detail).toContain("important");
  for (const key of Object.keys(identity)) expect(detail).not.toContain(key);
});

test("unrecognized command payloads keep readable raw content instead of an unrelated item preview", () => {
  const detail = codexApprovalDetail(commandMethod, { ...identity, command: { argv: ["dangerous", "argument"] }, kind: "writeStdin", stdin: "yes\n" }, { type: "commandExecution", command: "unrelated preview", cwd: "/work" });
  expect(detail).toContain('"argv"');
  expect(detail).toContain("dangerous");
  expect(detail).toContain("argument");
  expect(detail).toContain("writeStdin");
  expect(detail).toContain('"stdin"');
  expect(detail).not.toContain("unrelated preview");
});

test("partially unfamiliar file changes retain readable information rather than dropping entries", () => {
  const detail = codexApprovalDetail(fileMethod, { ...identity, reason: "Change two targets" }, { type: "fileChange", changes: [{ path: "/known", kind: { type: "add" }, diff: "+ok" }, { target: "/unfamiliar", operation: "replace" }] });
  expect(detail).toContain("/known");
  expect(detail).toContain("/unfamiliar");
  expect(detail).toContain("replace");
  expect(detail).toContain("Change two targets");
});

test("file names remain ahead of long diffs and truncation stays explicit", () => {
  const detail = codexApprovalDetail(fileMethod, identity, { type: "fileChange", changes: [
    { path: "/large", kind: { type: "add" }, diff: "+" + "x".repeat(200_001) },
    { path: "/small", kind: { type: "delete" }, diff: "-small" },
  ] });
  expect(detail).toContain("/small");
  expect(detail).toContain("[Output truncated at 200000 characters]");
  expect(detail.length).toBeLessThan(200_100);
});

test("long commands retain the existing truncation notice without splitting a Unicode scalar", () => {
  const detail = codexApprovalDetail(commandMethod, { command: "x".repeat(199_999) + "😀tail", cwd: "/work" });
  expect(detail.slice(0, 199_999) === "x".repeat(199_999)).toBe(true);
  expect(detail.slice(199_999)).toBe("\n[Output truncated at 200000 characters]");
});
