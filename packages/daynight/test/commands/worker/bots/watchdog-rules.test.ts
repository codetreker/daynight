import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { matchingWatchdogRule, matchWatchdogRegex, watchdogRegex } from "../../../../src/commands/worker/bots/apps/watchdog-rules.js";

const portableCorpus = JSON.parse(readFileSync(new URL("../../../../../daynight-server/internal/core/assistanttask/watchdog/testdata/portable-regex.json", import.meta.url), "utf8")) as { pattern: string; accepted: boolean; matches?: string[]; misses?: string[] }[];

describe("Watchdog portable regular expressions", () => {
  const signal = () => new AbortController().signal;
  it.each(portableCorpus.filter(value => value.accepted))("executes service-approved pattern $pattern in the actual Worker", async ({ pattern, matches, misses }) => {
    const rules = [{ id: "portable", category: "stalled", match: { regex: pattern }, action: { kind: "send_message", message: "Continue." } }];
    for (const value of matches!) expect(await matchingWatchdogRule(rules, "project", value, signal())).toMatchObject({ id: "portable" });
    for (const value of misses!) expect(await matchingWatchdogRule(rules, "project", value, signal())).toBeNull();
  });
  it("treats a legacy empty object as report-only without admitting nonempty objects", async () => {
    expect(await matchingWatchdogRule({}, "project", "Please continue", signal())).toBeNull();
    await expect(matchingWatchdogRule({ rules: [] }, "project", "Please continue", signal())).rejects.toThrow("Invalid Watchdog rules");
  });
  it("uses RE2 strict end anchors and dot's newline behavior with Unicode scalars", async () => {
    expect(await matchWatchdogRegex("^end$", "end\n", signal())).toBe(false);
    expect(await matchWatchdogRegex("^end$", "end", signal())).toBe(true);
    for (const value of ["\r", "\u2028", "\u2029", "😀"]) expect(await matchWatchdogRegex("^.$", value, signal())).toBe(true);
    expect(await matchWatchdogRegex("^.$", "\n", signal())).toBe(false);
    expect(await matchWatchdogRegex("^[$.]$", "$", signal())).toBe(true);
    expect(await matchWatchdogRegex("^\\.$", ".", signal())).toBe(true);
    expect(await matchWatchdogRegex("^\\-$", "-", signal())).toBe(true);
  });
  it("rejects nonportable constructs and bounds backtracking off the host thread", async () => {
    for (const pattern of ["(?i)x", "\\d+", "[[:alpha:]]", "x".repeat(1025), "x\\"]) expect(() => watchdogRegex(pattern)).toThrow();
    expect(await matchWatchdogRegex("^(a+)+$", `${"a".repeat(100_000)}!`, signal())).toBe(false);
    const cancellation = new AbortController(); cancellation.abort();
    await expect(matchWatchdogRegex("x", "x", cancellation.signal)).rejects.toBeDefined();
  });
  it("requires all rule conditions and never matches unavailable agent text", async () => {
    const rules = [{ id: "rule", category: "stalled", match: { contains: "continue", regex: "^Please", projectIds: ["p1"] }, action: { kind: "send_message", message: "Continue." } }];
    expect(await matchingWatchdogRule(rules, "p1", "Please continue", signal())).toMatchObject({ id: "rule" });
    for (const [project, text] of [["p2", "Please continue"], ["p1", "continue"], ["p1", "Please stop"], ["p1", null]]) expect(await matchingWatchdogRule(rules, project!, text!, signal())).toBeNull();
    await expect(matchingWatchdogRule([{ id: "bad", category: "no_execution", action: { kind: "send_message", message: "Run" } }], "p1", "text", signal())).rejects.toThrow();
    expect(await matchingWatchdogRule(null, "p1", "text", signal())).toBeNull();
    expect(await matchingWatchdogRule([{ id: "all", category: "stalled", match: { projectIds: [] }, action: { kind: "send_message", message: "Continue." } }], "any-project", null, signal())).toMatchObject({ id: "all" });
  });
});
