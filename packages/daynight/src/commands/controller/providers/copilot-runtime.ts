import type { CopilotClient } from "@github/copilot-sdk";
import { startCopilotBridge, type CopilotBridgeMediaOptions } from "./copilot-bridge.js";
import type { ProviderOptions } from "./types.js";
import type { CopilotAuthorityArtifacts } from "./copilot-read-authority-artifacts.js";
import { copilotDeadline, startCopilotProcess } from "./copilot-owned-process.js";
export { copilotDeadline } from "./copilot-owned-process.js";
export { copilotExecutable } from "../../../platform/tool-executables.js";

export const startCopilotRuntime = (options: ProviderOptions, lost: (error: Error) => void, artifacts?: CopilotAuthorityArtifacts, media?: CopilotBridgeMediaOptions) => {
  let closing = false, client: CopilotClient | undefined, closePromise: Promise<void> | undefined;
  const owned = startCopilotProcess(options, error => { if (!closing) lost(error); }, artifacts);
  let bridge: ReturnType<typeof startCopilotBridge> | undefined;
  const ready = owned.ready.then(async ({ port, token }) => {
    if (closing) throw new Error("Copilot runtime closed during startup.");
    const bridgeEnv = { ...(options.env ?? process.env) }; delete bridgeEnv.NODE_DEBUG; delete bridgeEnv.COPILOT_CONNECTION_TOKEN;
    bridge = startCopilotBridge({ cwd: options.cwd, env: bridgeEnv, port, token, onSpawn: options.onSpawn,
      onLost: error => { if (!closing) lost(error); }, ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}), ...(media ? { media } : {}) });
    client = await copilotDeadline(Promise.race([bridge.ready, owned.failed]), "Copilot SDK connection", 15_000);
    if (closing) throw new Error("Copilot runtime closed during connection.");
    return client;
  });
  void ready.catch(() => {});
  let sdkCleanup: Promise<unknown[]> | undefined, sdkCleanupReported = false, shutdownAcknowledged = false;
  const stopSdk = (force: boolean): Promise<unknown[]> => sdkCleanup ??= (async () => {
    const errors: unknown[] = [];
    if (!client) return errors;
    if (force) {
      // Failed startup cannot establish a writable transport. Dispose it without RPCs.
      try { await copilotDeadline(client.forceStop(), "Copilot SDK transport shutdown", 1000); } catch (error) { errors.push(error); }
    } else {
      // forUri treats the runtime as external. This owner requests native stop
      // once; cleanup retries cannot dispatch it again after an unknown result.
      try { await copilotDeadline(client.rpc.runtime.shutdown(), "Copilot runtime shutdown", 1500); shutdownAcknowledged = true; } catch (error) { errors.push(error); }
      try { const result = await copilotDeadline(client.stop(), "Copilot SDK shutdown", 3000); if (result.length) errors.push(...result); }
      catch (error) { errors.push(error); }
      if (errors.length) try { await copilotDeadline(client.forceStop(), "Copilot SDK transport shutdown", 1000); } catch (error) { errors.push(error); }
    }
    return errors;
  })();
  const close = (force = false): Promise<void> => {
    if (closePromise) return closePromise;
    const attempt = (async () => {
      closing = true; owned.authority?.invalidate();
      const sdkErrors = await stopSdk(force), errors: unknown[] = [];
      // A bridge media failure cannot prevent native process cleanup. Both
      // owners retain failed work, and neither owner spawns during a retry.
      try { await bridge?.close(); } catch (error) { errors.push(error); }
      try { await owned.close(shutdownAcknowledged && !force); } catch (error) { errors.push(error); }
      if (sdkErrors.length && !sdkCleanupReported) {
        sdkCleanupReported = true;
        try { options.onDiagnostic?.(owned.stopped ? "Copilot SDK cleanup failed; the owned runtime was terminated." : "Copilot SDK cleanup failed; owned process shutdown remains unconfirmed."); }
        catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Copilot runtime cleanup did not complete.");
    })();
    closePromise = attempt;
    const settled = () => { if (closePromise === attempt) closePromise = undefined; };
    void attempt.then(settled, settled);
    return attempt;
  };
  return { get child() { return owned.child; }, ready, close, get authority() { return owned.authority; }, bridgeMetrics: () => bridge?.metrics() ?? { peakRss: 0, peakHeap: 0 } };
};
