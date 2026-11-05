import { afterAll, vi } from "vitest";
import { testIsolation } from "../../scripts/test-bootstrap.js";

vi.mock("../../src/config/paths.js", async original => {
  const actual = await original<typeof import("../../src/config/paths.js")>();
  return {
    ...actual,
    resolveConfigurationPaths: (...arguments_: Parameters<typeof actual.resolveConfigurationPaths>) => {
      const paths = actual.resolveConfigurationPaths(...arguments_);
      testIsolation.registerStateDirectory(paths.stateDirectory);
      return paths;
    },
  };
});

afterAll(() => testIsolation.cleanupIpc());
