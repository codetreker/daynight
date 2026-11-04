import type { Operation } from "../../api/operation.js";
import { hasHerdrCommandCleanupFailure } from "./herdr/command.js";

type CodexInvocation = { file: string; environment: NodeJS.ProcessEnv; workingDirectory: string };
export type CodexProbeOwner = { observe<T>(invocation: CodexInvocation, operation: Operation, probe: () => Promise<T>): Promise<T> };

/** Capture bare Codex search keys with Node's Windows environment selection before launching or matching. */
export const captureCodexProbeEnvironment = (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv => {
  const captured = { ...environment };
  if (platform === "win32") {
    const keys = Object.keys(captured).sort();
    for (const name of ["PATH", "PATHEXT"]) {
      const matches = keys.filter(key => key.toUpperCase() === name);
      if (matches.length === 0) continue;
      const value = captured[matches[0]!];
      for (const key of matches) delete captured[key];
      captured[name] = value;
    }
  }
  return captured;
};

const searchValue = (environment: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = process.platform === "win32" ? Object.keys(environment).filter(key => key.toUpperCase() === name).sort()[0] : name;
  return key === undefined ? undefined : environment[key];
};

/** Own matching Codex PATH observations; compare the captured search environment used by their commands. */
export const createCodexProbeOwner = (environment: NodeJS.ProcessEnv, workingDirectory: string): CodexProbeOwner => {
  const search = searchValue(environment, "PATH");
  const extensions = searchValue(environment, "PATHEXT");
  let pending: Promise<void> = Promise.resolve();
  let cleanupFailure: { error: unknown } | undefined;
  return {
    observe: async (invocation, operation, probe) => {
      // Matching search inputs and startup directory share the existing resolver; no new host lookup is needed.
      if (invocation.file !== "codex" || invocation.workingDirectory !== workingDirectory || searchValue(invocation.environment, "PATH") !== search ||
        (process.platform === "win32" && searchValue(invocation.environment, "PATHEXT") !== extensions)) return probe();
      const previous = pending;
      let release!: () => void;
      pending = new Promise<void>(resolve => { release = resolve; });
      try {
        await previous;
        if (cleanupFailure !== undefined) throw cleanupFailure.error;
        operation.check();
        try { return await probe(); }
        catch (error) { if (hasHerdrCommandCleanupFailure(error)) cleanupFailure = { error }; throw error; }
      } finally { release(); }
    },
  };
};
