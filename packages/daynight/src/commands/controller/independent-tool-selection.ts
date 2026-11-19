import path from "node:path";
import { createOperation } from "../../api/operation.js";
import { resolveConfigurationPaths } from "../../config/paths.js";
import { resolveToolLaunch, verifyToolLaunch, type ResolvedToolLaunch } from "../../platform/tool-executables.js";
import { withinOperation } from "../../platform/tool-io.js";
import type { SessionProvider } from "../../session/protocol.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
import { readLaunchToolSelection } from "./launch-tool-selection.js";

/** Freeze this launch without adopting Worker targets or rewriting a resumed ticket. */
export const selectIndependentToolLaunch = async (input: {
  provider: SessionProvider;
  homeDirectory: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  resumeTicket?: ControllerLaunchTicket;
}): Promise<ResolvedToolLaunch | undefined> => {
  const operation = createOperation({ signal: input.signal, limits: { totalMs: 30_000 } });
  try {
    operation.check();
    if (input.resumeTicket) {
      if (input.resumeTicket.provider !== input.provider || input.resumeTicket.testExecutionId === undefined) throw new Error("Independent tool selection requires the original Test Session ticket.");
      const saved = await withinOperation(readLaunchToolSelection(input.homeDirectory, input.resumeTicket), operation);
      if (saved !== undefined) {
        await verifyToolLaunch(saved, operation, { trustedRuntimeRoot: path.join(resolveConfigurationPaths(input.homeDirectory).stateDirectory, "worker", "tool-runtimes") });
        operation.check();
        return saved;
      }
    }
    if (input.provider === "claude" || input.provider === "copilot" && process.platform !== "win32") return undefined;
    const launch = await resolveToolLaunch({ tool: input.provider, context: "web", choice: { kind: "auto" }, cwd: input.cwd, environment: input.environment }, operation);
    operation.check();
    // Other Copilot installations still need the Provider's authority preparation.
    // A plain recipe would suppress that path without owning its materialization.
    if (input.provider === "copilot" && (launch.runtimeProfile !== undefined || launch.interpreterPath !== null || !/\.exe$/i.test(launch.executablePath) || launch.command.file !== launch.executablePath || launch.command.prefixArgs.length !== 0)) return undefined;
    return launch;
  } finally { operation.dispose(); }
};
