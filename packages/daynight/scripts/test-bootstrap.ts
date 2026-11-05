import { createRequire } from "node:module";

export type TestIsolation = {
  root: string;
  assertWritablePath: (target: unknown, followLeaf?: boolean) => void;
  guardedEnvironment: (environment?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  registerStateDirectory: (directory: string) => void;
  cleanupIpc: () => void;
  cleanup: () => void;
};

export const testIsolation = createRequire(import.meta.url)("./test-isolation.cts") as TestIsolation;
