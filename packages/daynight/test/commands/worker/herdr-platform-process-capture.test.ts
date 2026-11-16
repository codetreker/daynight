import { describe, expect, it } from "vitest";
import { createPlatformProcessCapture, type PlatformProcessIdentity } from "./herdr-platform-process-capture.fixtures.js";

const birth = 639301707654999820n;
const row = (pid: number, parent: number, offset = 0n): PlatformProcessIdentity => ({ pid, parent, token: String(birth + offset) });

describe("Herdr platform process ownership capture", () => {
  it("accepts Windows system PID zero in the inventory without treating it as owned", () => {
    const system = row(0, 0), daemon = row(8112, 100), shell = row(9000, 8112, 10n);
    const capture = createPlatformProcessCapture();
    expect(capture.capture([system, daemon, shell], [8112, 9000], 8112)).toEqual([daemon, shell]);
    expect(() => capture.capture([system, daemon, shell], [0])).toThrow("positive PIDs");
    expect(() => createPlatformProcessCapture().capture([system], [], 0)).toThrow("positive PIDs");
  });

  it("excludes pre-daemon PID descendants while capturing the actual shell/helper/native tree", () => {
    const daemon = row(8112, 100), shell = row(9000, 8112, 10n), helper = row(9001, 9000, 20n), native = row(9002, 9001, 30n);
    const old = [row(8124, 8112, -1_347_000_000n), row(8172, 8112, -1_347_000_000n), row(5196, 8124, -1_346_000_000n), row(7392, 8172, -1_346_000_000n)];
    const capture = createPlatformProcessCapture();
    expect(capture.capture([native, ...old, helper, shell, daemon], [8112, 9000, 9001, 9002], 8112)).toEqual([daemon, shell, helper, native]);
  });

  it("checks birth order at every ancestor edge with full tick precision", () => {
    const daemon = row(1, 0), shell = row(2, 1, 20n), olderChild = row(3, 2, 10n), invalidDescendant = row(4, 3, 30n);
    const capture = createPlatformProcessCapture();
    expect(capture.capture([invalidDescendant, olderChild, shell, daemon], [1, 2], 1)).toEqual([daemon, shell]);
    expect(() => capture.capture([daemon, shell, olderChild, invalidDescendant], [4])).toThrow("no verified ownership chain");
  });

  it("accepts equal-resolution parent and child births", () => {
    const daemon = row(1, 0), child = row(2, 1);
    expect(createPlatformProcessCapture().capture([child, daemon], [1, 2], 1)).toEqual([daemon, child]);
  });

  it("does not traverse an unrelated replacement incarnation of the captured root", () => {
    const daemon = row(1, 0), shell = row(2, 1, 10n), native = row(3, 2, 20n);
    const capture = createPlatformProcessCapture();
    expect(capture.capture([daemon, shell, native], [1, 2, 3], 1)).toEqual([daemon, shell, native]);
    const replacement = row(1, 0, 100n), unrelated = row(4, 1, 110n);
    const current = [replacement, unrelated, shell, native];
    expect(capture.capture(current, [1, 2, 3])).toEqual([daemon, shell, native]);
  });

  it("captures every owned incarnation when a live original ancestor creates a child with a retained PID", () => {
    const daemon = row(1, 0), shell = row(2, 1, 10n), replacement = row(2, 1, 20n), native = row(3, 2, 30n);
    const capture = createPlatformProcessCapture();
    capture.capture([daemon, shell], [1, 2], 1);
    expect(capture.capture([native, replacement, daemon], [1, 2, 3])).toEqual([daemon, shell, replacement, native]);
    expect(capture.capture([daemon, replacement, native], [1, 2, 3])).toEqual([daemon, shell, replacement, native]);
    expect(capture.capture([], [1, 2, 3])).toEqual([daemon, shell, replacement, native]);
  });

  it("does not give an unrelated reused descendant PID ownership of its new subtree", () => {
    const daemon = row(1, 0), child = row(2, 1, 10n), replacement = row(2, 99, 20n), unrelated = row(3, 2, 30n);
    const capture = createPlatformProcessCapture();
    capture.capture([daemon, child], [1, 2], 1);
    expect(capture.capture([daemon, replacement, unrelated], [1, 2])).toEqual([daemon, child]);
    expect(() => capture.capture([daemon, replacement, unrelated], [3])).toThrow("no verified ownership chain");
  });

  it("continues capturing descendants of original processes after an ancestor exits", () => {
    const daemon = row(1, 0), shell = row(2, 1, 10n), native = row(3, 2, 20n), lateChild = row(4, 3, 30n);
    const capture = createPlatformProcessCapture();
    capture.capture([daemon, shell, native], [1, 2, 3], 1);
    expect(capture.capture([native, lateChild], [1, 2, 3])).toEqual([daemon, shell, native, lateChild]);
  });

  it("requires a captured root and ownership evidence for every explicit process", () => {
    const capture = createPlatformProcessCapture();
    expect(() => capture.capture([row(1, 0)], [1])).toThrow("root has not been captured");
    expect(() => capture.capture([], [1], 1)).toThrow("root 1 is missing");
    capture.capture([row(1, 0)], [1], 1);
    expect(() => capture.capture([row(1, 0), row(2, 99)], [2])).toThrow("no verified ownership chain");
    expect(() => capture.capture([row(1, 0)], [1], 1)).toThrow("already captured");
  });

  it.each(["", "unknown", "-1", "1.5"])("rejects an unknown birth token %j", token => {
    const capture = createPlatformProcessCapture();
    expect(() => capture.capture([row(1, 0), { ...row(2, 1), token }], [1], 1)).toThrow("unknown identity");
  });

  it("rejects contradictory inventory identities without publishing a capture", () => {
    const capture = createPlatformProcessCapture();
    expect(() => capture.capture([row(1, 0), row(1, 0, 10n)], [1], 1)).toThrow("conflicting identities");
    expect(capture.capture([row(1, 0)], [1], 1)).toEqual([row(1, 0)]);
  });

  it("rejects a changed Windows parent for the same birth identity", () => {
    const capture = createPlatformProcessCapture();
    capture.capture([row(1, 0), row(2, 1, 10n)], [1, 2], 1);
    expect(() => capture.capture([row(1, 0), row(2, 9, 10n)], [1, 2])).toThrow("contradictory parent evidence");
    expect(capture.capture([row(1, 0), row(2, 1, 10n)], [1, 2])).toEqual([row(1, 0), row(2, 1, 10n)]);
  });

  it("retains Linux original identity through legitimate reparenting", () => {
    const capture = createPlatformProcessCapture({ immutableParents: false });
    capture.capture([row(1, 0), row(2, 1, 10n)], [1, 2], 1);
    expect(capture.capture([row(2, 99, 10n), row(3, 2, 20n)], [1, 2])).toEqual([row(1, 0), row(2, 1, 10n), row(3, 2, 20n)]);
  });

  it("leaves a failed initial capture available for a fresh root observation", () => {
    const capture = createPlatformProcessCapture();
    expect(() => capture.capture([row(1, 0)], [1, 2], 1)).toThrow("no verified ownership chain");
    expect(capture.capture([row(1, 0, 100n), row(2, 1, 110n)], [1, 2], 1)).toEqual([row(1, 0, 100n), row(2, 1, 110n)]);
  });
});
