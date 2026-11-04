import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { selectBotRole } from "../../../../src/commands/worker/bots/instructions.js";

const frozen = (instructions = "Previously frozen role.\n", revision = "older-worker/1") => ({
  instructions, revision, digest: createHash("sha256").update(instructions).digest("hex"),
});

describe("Bot role preparation", () => {
  it("prepares a bounded Unicode role and matching digest without runtime inputs", () => {
    const role = selectBotRole({ serverRole: null, preparedRole: null });
    expect(role.instructions.trim().length).toBeGreaterThan(0);
    expect(role.instructions.isWellFormed()).toBe(true);
    expect(Buffer.byteLength(role.instructions)).toBeLessThanOrEqual(65_536);
    expect(role.revision.trim().length).toBeGreaterThan(0);
    expect(role.digest).toBe(createHash("sha256").update(role.instructions).digest("hex"));
  });

  it("recovers the exact server role when local preparation is lost", () => {
    const serverRole = frozen();
    expect(selectBotRole({ serverRole, preparedRole: null })).toEqual(serverRole);
  });

  it("retains the original preparation after an unconfirmed registration", () => {
    const preparedRole = frozen();
    expect(selectBotRole({ serverRole: null, preparedRole })).toEqual(preparedRole);
    expect(selectBotRole({ serverRole: { ...preparedRole }, preparedRole })).toEqual(preparedRole);
  });

  it.each([frozen("Different text."), frozen(undefined, "other-revision")])(
    "refuses conflicting persisted roles instead of rendering a replacement",
    preparedRole => expect(() => selectBotRole({ serverRole: frozen(), preparedRole })).toThrow(/conflict/i),
  );

  it.each([
    null, {}, { ...frozen(), extra: true }, frozen(""), frozen("  \n"),
    frozen("\ud800"), frozen("a".repeat(65_537)), frozen("语".repeat(21_846)),
    frozen(undefined, ""), frozen(undefined, "\ud800"), { ...frozen(), digest: "0".repeat(64) },
  ])("rejects malformed persisted roles without falling back to the template", role => {
    // Null means absent only in the selection envelope, not in a stored role.
    const bad = role === null ? { instructions: null, revision: "1", digest: "" } : role;
    expect(() => selectBotRole({ serverRole: bad as ReturnType<typeof frozen>, preparedRole: null })).toThrow();
    expect(() => selectBotRole({ serverRole: null, preparedRole: bad as ReturnType<typeof frozen> })).toThrow();
  });

  it("accepts the exact UTF-8 limit without trimming frozen bytes", () => {
    const role = frozen("a".repeat(65_535) + "\n");
    expect(selectBotRole({ serverRole: role, preparedRole: null })).toEqual(role);
  });

  it.each([frozen("text\0"), frozen("\u0085"), frozen(undefined, "revision\0"), frozen(undefined, "\u0085")])(
    "rejects role text that the Bot registration contract cannot accept",
    serverRole => expect(() => selectBotRole({ serverRole, preparedRole: null })).toThrow(),
  );

  it("returns an immutable copy so a caller cannot change the persisted role", () => {
    const original = frozen();
    const selected = selectBotRole({ serverRole: original, preparedRole: null });
    original.instructions = "changed";
    expect(selected.instructions).toBe("Previously frozen role.\n");
    expect(() => Object.assign(selected, { revision: "changed" })).toThrow();
  });
});
