import { createRequire } from "node:module";

export type TestIsolation = {
  root: string;
  assertSafePath: (target: unknown, destructive?: boolean, followLeaf?: boolean) => void;
  guardedEnvironment: (environment?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  cleanup: () => void;
};

export const testIsolation = createRequire(import.meta.url)("./test-isolation.cts") as TestIsolation;
