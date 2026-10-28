import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { parseWorkerConfiguration } from "../../../src/commands/worker/config.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const paths = resolveWorkerPaths("/home/worker-user", path.posix);
const parse = (repositoryRoot: unknown) => parseWorkerConfiguration(stringify({ worker: { repositoryRoot } }), paths, path.posix);

describe("worker clone root", () => {
  it("defaults independently of review settings without expanding the current home", () => {
    expect(parseWorkerConfiguration("{}", paths, path.posix).repositoryRoot).toBe("~/daynights");
    expect(parseWorkerConfiguration(stringify({ review: { repositoryRoot: "/review-only" } }), paths, path.posix).repositoryRoot).toBe("~/daynights");
  });

  it.each(["~/clones", "~", "../clones", "/clones"])("retains the configured raw root %s", (root) => {
    expect(parse(root).repositoryRoot).toBe(root);
    expect(parse(root).repositories).toEqual([]);
  });

  it.each([null, false, 1, [], {}, "", "  ", "root\0suffix", "root\nsuffix", "root\tsuffix", "~someone/clones"])("rejects an invalid explicit root %j", (root) => {
    expect(() => parse(root)).toThrow("worker.repositoryRoot");
  });

  it("uses explicit Windows path rules for native home and drive-relative roots", () => {
    const windows = resolveWorkerPaths("C:\\Users\\worker", path.win32);
    expect(parseWorkerConfiguration(stringify({ worker: { repositoryRoot: "~\\clones" } }), windows, path.win32).repositoryRoot).toBe("~\\clones");
    expect(() => parseWorkerConfiguration(stringify({ worker: { repositoryRoot: "C:clones" } }), windows, path.win32)).toThrow("worker.repositoryRoot");
  });
});
