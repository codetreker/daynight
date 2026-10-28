import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { herdrExecutionAgentName, herdrExecutionLabel, parseHerdrExecutionLabel } from "../../../src/commands/worker/herdr/agents.js";
import { canonicalResourceOwner, parseResourceOwner, resourceOwnerKey, sameResourceOwner } from "../../../src/commands/worker/resource-owner.js";

const owner = {
  projectId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  claimId: "33333333-3333-4333-8333-333333333333",
  worktreeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

describe("stable resource ownership and workspace presentation", () => {
  it("serializes exactly four canonical coordinates independently of their input property order", () => {
    const reversed = { worktreeId: owner.worktreeId.toUpperCase(), claimId: owner.claimId, taskId: owner.taskId, projectId: owner.projectId };
    expect(resourceOwnerKey(reversed)).toBe(JSON.stringify(owner));
    expect(canonicalResourceOwner(reversed)).toEqual(owner);
    expect(parseResourceOwner(resourceOwnerKey(reversed))).toEqual(owner);
    expect(herdrExecutionAgentName(owner)).toBe(`dn_${createHash("sha256").update(JSON.stringify(owner)).digest("hex").slice(0, 24)}`);
    expect(sameResourceOwner(owner, { ...owner })).toBe(true);
    expect(sameResourceOwner(owner, { ...owner, claimId: owner.projectId })).toBe(false);
  });

  it.each([
    "{}", "null", "[]", JSON.stringify({ ...owner, serverOrigin: "https://example.com" }),
    JSON.stringify({ ...owner, worktreeId: owner.worktreeId.toUpperCase() }),
    JSON.stringify({ ...owner, taskId: "prefix" }), JSON.stringify({ ...owner, taskId: null }),
    ` ${JSON.stringify(owner)}`, JSON.stringify(owner, null, 2),
    JSON.stringify({ worktreeId: owner.worktreeId, claimId: owner.claimId, taskId: owner.taskId, projectId: owner.projectId }),
    JSON.stringify(owner).replace('{', `{"projectId":"${owner.projectId}",`),
  ])("rejects noncanonical or ambiguous resource identity %s", (serialized) => {
    expect(() => parseResourceOwner(serialized)).toThrow();
  });

  it.each([
    "修复任务 👨‍👩‍👧‍👦", 'literal | daynight:{"taskId":"another"}', "daynight:task title", "长标题".repeat(500),
  ])("preserves a complete readable title while parsing its final identity suffix: %s", (title) => {
    const label = herdrExecutionLabel(owner, title);
    expect(label).toBe(`${title} | daynight:${JSON.stringify(owner)}`);
    expect(parseHerdrExecutionLabel(label)).toEqual(owner);
  });

  it("escapes control, line separator and bidi characters without altering ZWJ emoji", () => {
    const label = herdrExecutionLabel(owner, "👨‍👩‍👧‍👦\n\t\x1b[31m\u2028\u202e");
    expect(label.startsWith("👨‍👩‍👧‍👦\\u{a}\\u{9}\\u{1b}[31m\\u{2028}\\u{202e} | daynight:")).toBe(true);
    expect(parseHerdrExecutionLabel(label)).toEqual(owner);
  });

  it.each([
    undefined, null, false, 1, {}, [], "human workspace", "",
    ` | daynight:${JSON.stringify(owner)}`, `bad\nname | daynight:${JSON.stringify(owner)}`,
    `name | daynight:${JSON.stringify(owner)} trailing`, "name | daynight:{broken",
    `name | daynight:${JSON.stringify({ ...owner, serverOrigin: "https://example.com" })}`,
    `name | daynight:${JSON.stringify({ ...owner, worktreeId: owner.worktreeId.toUpperCase() })}`,
  ])("leaves unfamiliar workspace labels unrecognized: %j", (label) => {
    expect(parseHerdrExecutionLabel(label)).toBeNull();
  });

  it("requires a valid title when creating managed labels", () => {
    expect(() => herdrExecutionLabel(owner, "\n\t")).toThrow("nonempty");
  });
});
