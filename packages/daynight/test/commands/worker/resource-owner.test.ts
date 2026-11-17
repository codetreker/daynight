import { describe, expect, it } from "vitest";
import { canonicalResourceOwner, parseResourceOwner, resourceOwnerKey, sameResourceOwner } from "../../../src/commands/worker/resource-owner.js";

const owner = {
  projectId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  claimId: "33333333-3333-4333-8333-333333333333",
  worktreeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

describe("stable resource ownership", () => {
  it("serializes exactly four canonical coordinates independently of their input property order", () => {
    const reversed = { worktreeId: owner.worktreeId.toUpperCase(), claimId: owner.claimId, taskId: owner.taskId, projectId: owner.projectId };
    expect(resourceOwnerKey(reversed)).toBe(JSON.stringify(owner));
    expect(canonicalResourceOwner(reversed)).toEqual(owner);
    expect(parseResourceOwner(resourceOwnerKey(reversed))).toEqual(owner);
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

});
