import { expect, test, vi } from "vitest";
import { readCopilotRuntimeVersion } from "../../../src/commands/controller/providers/copilot-status.js";
import type { ResolvedToolLaunch } from "../../../src/platform/tool-executables.js";

test("Copilot software version comes from the connected runtime status", async () => {
  const getStatus = vi.fn(async () => ({ version: "2.3.4-preview.1", protocolVersion: 3 }));
  expect(await readCopilotRuntimeVersion({ getStatus })).toBe("2.3.4-preview.1");
  expect(getStatus).toHaveBeenCalledOnce();
});

test.each([{ version: "package-version", protocolVersion: 3 }, { version: "1.0.105", protocolVersion: 0 }, { version: "1.0.105", protocolVersion: 1.5 }])("rejects malformed or unavailable runtime status %#", async status => {
  await expect(readCopilotRuntimeVersion({ getStatus: async () => status })).rejects.toMatchObject({ code: "capability_error" });
});

test("a frozen authority profile refuses a different runtime version before creating a native Session", async () => {
  const launch = { tool: "copilot", context: "web", runtimeProfile: { kind: "copilot-read-authority-v1" } } as ResolvedToolLaunch;
  await expect(readCopilotRuntimeVersion({ getStatus: async () => ({ version: "1.0.106", protocolVersion: 3 }) }, launch)).rejects.toMatchObject({ code: "incompatible_runtime" });
});
