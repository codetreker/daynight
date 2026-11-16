import path from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import type { Operation } from "../../api/operation.js";
import type { ResolvedToolLaunch } from "../../platform/tool-executables.js";
import { withinOperation } from "../../platform/tool-io.js";
import { startCopilotProcess, copilotDeadline } from "../controller/providers/copilot-owned-process.js";
export { readCopilotRuntimeVersion as inspectCopilotStatus } from "../controller/providers/copilot-status.js";

export type CopilotProbeOptions = { cwd: string; environment: NodeJS.ProcessEnv; toolLaunch?: ResolvedToolLaunch; toolRuntimeRoot?: string; sessionId?: string };
/** The outer probe supervisor owns descendants; this owner joins the exact headless child and SDK transport. */
export const withCopilotProbeClient = async <T>(options: CopilotProbeOptions, operation: Operation, read: (client: CopilotClient) => Promise<T>): Promise<T> => {
  const runtime = startCopilotProcess({ cwd: options.cwd, env: options.environment,
    ...(options.toolLaunch ? { toolLaunch: options.toolLaunch } : {}), ...(options.toolRuntimeRoot ? { toolRuntimeRoot: options.toolRuntimeRoot } : {}), onSpawn() {} }, () => {});
  let client: CopilotClient | undefined, started = false, acknowledged = false, failure: unknown;
  try {
    const { port, token } = await withinOperation(runtime.ready, operation);
    client = new CopilotClient({ workingDirectory: options.cwd, env: options.environment,
      connection: RuntimeConnection.forUri(`127.0.0.1:${port}`, { connectionToken: token }),
      ...(options.sessionId ? { sessionFs: { initialCwd: options.cwd, sessionStatePath: path.join(options.cwd, ".tmp", `native-selection-${options.sessionId}`), conventions: process.platform === "win32" ? "windows" as const : "posix" as const, capabilities: { sqlite: false } } } : {}) });
    await withinOperation(Promise.race([client.start(), runtime.failed]), operation); started = true;
    return await withinOperation(Promise.race([read(client), runtime.failed]), operation);
  } catch (error) { failure = error; throw error; }
  finally {
    const gracefulErrors: unknown[] = [], cleanupErrors: unknown[] = [];
    if (client && started) {
      try { await copilotDeadline(client.rpc.runtime.shutdown(), "Copilot probe runtime shutdown", 1500); acknowledged = true; } catch (error) { gracefulErrors.push(error); }
      try { gracefulErrors.push(...await copilotDeadline(client.stop(), "Copilot probe SDK stop", 3000)); } catch (error) { gracefulErrors.push(error); }
    }
    if (client && (!started || gracefulErrors.length)) try { await copilotDeadline(client.forceStop(), "Copilot probe SDK transport shutdown", 1000); } catch (error) { cleanupErrors.push(error); }
    try { await runtime.close(acknowledged); } catch (error) { cleanupErrors.push(error); }
    // A lost graceful shutdown response does not invalidate a completed read
    // after transport and owned-process cleanup succeed. The outer supervisor
    // still verifies the complete probe process group before accepting results.
    if (cleanupErrors.length) throw Object.assign(new AggregateError([...(failure === undefined ? [] : [failure]), ...gracefulErrors, ...cleanupErrors], "Copilot probe cleanup is unconfirmed."), { code: "cleanup_unknown" as const });
  }
};
