import { describe, expect, it } from "vitest";
import { createLocalImageProofSequence, parseLocalImageCheckpoint } from "../../../../src/commands/controller/markdown/local-source-proof.js";

const root = { kind: "posix", dev: "1", ino: "2" } as const, file = { kind: "posix", dev: "1", ino: "3" } as const;
const initial = () => ({ stage: "initial", proof: { requested: { locator: "image%20one", path: "image one" }, root: { cwd: "/root", identity: root, traversal: [] }, traversal: [], opened: null } });
const opened = () => ({ stage: "opened", proof: { ...initial().proof, traversal: [{ kind: "open", parent: root, name: "image one", object: file, directory: false }], opened: file } });
const sequence = () => createLocalImageProofSequence({ locator: "image%20one", path: "image one", cwd: "/root", platform: "linux", root });

describe("internal local-source evidence validation", () => {
  it("retains immutable source evidence for one ordered copy", () => {
    const state = sequence(), source = opened(); state.accept(initial()); const checked = state.accept(source);
    source.proof.traversal[0]!.name = "changed";
    expect(checked.proof.traversal[0]).toMatchObject({ name: "image one" });
    expect(Object.isFrozen(checked.proof.root.identity)).toBe(true); expect(Object.isFrozen(checked.proof.traversal)).toBe(true);
    state.accept({ stage: "block", proof: checked.proof }); state.accept({ stage: "final", proof: checked.proof }); expect(() => state.complete()).not.toThrow();
  });
  it.each([
    { ...initial(), proof: { ...initial().proof, opened: file } },
    { ...opened(), proof: { ...opened().proof, opened: null } },
    { ...opened(), proof: { ...opened().proof, opened: { ...file, ino: "18446744073709551616" } } },
    { ...opened(), proof: { ...opened().proof, opened: { ...file, ino: 3 } } },
    { ...opened(), proof: { ...opened().proof, extra: "unbounded" } },
    { ...initial(), stage: "unknown" },
    { ...initial(), proof: { ...initial().proof, root: { ...initial().proof.root, cwd: "\ud800" } } },
    { ...initial(), proof: { ...initial().proof, requested: { locator: "a\u0000b", path: "x" } } },
  ])("rejects malformed or ambiguous evidence", value => { expect(() => parseLocalImageCheckpoint(value)).toThrow(); });
  it("rejects foreign identity kinds and a final object absent from traversal", () => {
    const value = opened();
    expect(() => parseLocalImageCheckpoint({ ...value, proof: { ...value.proof, opened: { kind: "windows", dev: "1", ino: "3", fileId: "0".repeat(48) } } })).toThrow();
    expect(() => parseLocalImageCheckpoint({ ...value, proof: { ...value.proof, opened: { ...file, ino: "4" } } })).toThrow();
    expect(() => parseLocalImageCheckpoint({ ...value, proof: { ...value.proof, traversal: [] } })).toThrow();
    expect(() => parseLocalImageCheckpoint({ ...value, proof: { ...value.proof, traversal: [{ ...value.proof.traversal[0], name: "x/y" }] } })).toThrow();
  });
  it("bounds UTF-8 strings, collection size and the combined IPC envelope", () => {
    expect(() => parseLocalImageCheckpoint({ ...initial(), proof: { ...initial().proof, requested: { locator: "中".repeat(3000), path: "image one" } } })).toThrow();
    const item = opened().proof.traversal[0]!;
    expect(() => parseLocalImageCheckpoint({ ...opened(), proof: { ...opened().proof, traversal: Array.from({ length: 4097 }, () => item) } })).toThrow();
    const link = { kind: "link", parent: root, name: "link", object: file, target: "x".repeat(4000), relative: true };
    // Both arrays fit independently; their combined envelope does not.
    expect(() => parseLocalImageCheckpoint({ ...opened(), proof: { ...opened().proof, root: { ...initial().proof.root, traversal: Array.from({ length: 32 }, () => link) }, traversal: [...Array.from({ length: 32 }, () => link), item] } })).toThrow();
  });
  it("binds raw and parsed locators, root and platform to the copy request", () => {
    for (const proof of [
      { ...initial().proof, requested: { locator: "image one", path: "image one" } },
      { ...initial().proof, requested: { locator: "image%20one", path: "other" } },
      { ...initial().proof, root: { ...initial().proof.root, cwd: "/other" } },
      { ...initial().proof, root: { ...initial().proof.root, identity: { ...root, ino: "4" } } },
      { ...initial().proof, root: { ...initial().proof.root, identity: { kind: "windows", dev: "1", ino: "2", fileId: "0".repeat(48) } } },
    ]) expect(() => sequence().accept({ stage: "initial", proof })).toThrow();
  });
  it("rejects duplicate, missing and out-of-order checkpoints or premature results", () => {
    expect(() => sequence().complete()).toThrow(); expect(() => sequence().accept(opened())).toThrow();
    const state = sequence(); state.accept(initial()); expect(() => state.accept(initial())).toThrow(); expect(() => state.complete()).toThrow();
    state.accept(opened()); expect(() => state.accept(opened())).toThrow(); expect(() => state.accept({ ...opened(), stage: "final" })).toThrow();
    state.accept({ ...opened(), stage: "block" }); state.accept({ ...opened(), stage: "final" }); expect(() => state.accept({ ...opened(), stage: "block" })).toThrow();
  });
  it("rejects changed source identity, expansion evidence or root after opened", () => {
    const state = sequence(); state.accept(initial()); state.accept(opened());
    for (const proof of [
      { ...opened().proof, opened: { ...file, ino: "4" }, traversal: [{ ...opened().proof.traversal[0], object: { ...file, ino: "4" } }] },
      { ...opened().proof, traversal: [{ ...opened().proof.traversal[0], name: "other" }] },
      { ...opened().proof, root: { ...initial().proof.root, identity: { ...root, ino: "4" } } },
    ]) expect(() => state.accept({ stage: "block", proof })).toThrow();
  });
});
