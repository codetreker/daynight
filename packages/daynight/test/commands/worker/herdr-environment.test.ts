import { afterEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ preflight: vi.fn(), manager: vi.fn() }));
vi.mock("../../../src/commands/worker/herdr/instance.js", async original => ({
  ...await original<object>(),
  createHerdrInstance: () => ({ rpc: {}, paths: {}, assertIntegrationEnvironment: () => {}, ensure: () => {}, stop: () => {} }),
}));
vi.mock("../../../src/commands/worker/herdr/preflight.js", () => ({ createHerdrPreflight: captured.preflight.mockReturnValue({ verifyStart: () => {} }) }));
vi.mock("../../../src/commands/worker/herdr/agents.js", async original => ({ ...await original<object>(), createHerdrAgentManager: captured.manager.mockReturnValue({}) }));
import { createWorkerHerdr } from "../../../src/commands/worker/herdr.js";

afterEach(() => vi.clearAllMocks());

it("uses the same explicit Agent PATH and configuration root for native preflight and workspace launch", () => {
  createWorkerHerdr({
    paths: { herdrDirectory: "/private/herdr", logsDirectory: "/private/logs" } as Parameters<typeof createWorkerHerdr>[0]["paths"],
    homeDirectory: "/home/user",
    environment: { PATH: "/parent/bin", HOME: "/home/user", CODEX_HOME: "/native/codex" },
    agentEnvironment: { PATH: "/private/aliases:/checked/bin", DN_CONFIG_DIR: "/private/config" },
  });
  expect(captured.preflight.mock.calls[0]![0].environment).toMatchObject({ PATH: "/private/aliases:/checked/bin", DN_CONFIG_DIR: "/private/config", CODEX_HOME: "/native/codex", HOME: "/home/user" });
  expect(captured.manager.mock.calls[0]![0].workspaceEnvironment).toMatchObject({ PATH: "/private/aliases:/checked/bin", DN_CONFIG_DIR: "/private/config" });
});
