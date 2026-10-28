import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSessionCommand, parseSessionEvent, parseSessionSnapshot } from "../src/api/parse";
const fixture = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), `../daynight/test/session/fixtures/${name}.json`), "utf8"));
describe("browser session wire contract", () => {
  it("uses the same lossless command, snapshot and event codecs as the controller", () => {
    expect(parseSessionCommand(fixture("send-message"))).toEqual(fixture("send-message"));
    expect(parseSessionSnapshot(fixture("snapshot"))).toEqual(fixture("snapshot"));
    expect(parseSessionEvent(fixture("event"))).toEqual(fixture("event"));
  });
  it("rejects incompatible versions and optimistic initial-input controls", () => {
    expect(() => parseSessionCommand({ ...fixture("send-message"), protocol: "daynight.session.v2" })).toThrow();
    expect(() => parseSessionSnapshot({ ...fixture("snapshot"), initialInputState: "unknown" })).toThrow();
  });
});
