import { expect, test } from "vitest";
import { codexUsageProviderVersion } from "../../../src/commands/controller/providers/codex-usage.js";

test.each(["0.169.0", "0.169.1"])("admits connected Codex %s for the unsupported snapshot profile", version => {
  expect(codexUsageProviderVersion({ userAgent: `daynight/${version} (Windows 11; x86_64)` })).toBe(version);
});
test.each([{}, null, { userAgent: "codex/0.169.0 (Windows)" }, { userAgent: "daynight/0.169.2 (Windows)" }, { userAgent: "daynight/0.169.0-beta (Windows)" }])("does not assign a known capability to an unverified handshake %j", input => {
  expect(codexUsageProviderVersion(input)).toBeNull();
});
