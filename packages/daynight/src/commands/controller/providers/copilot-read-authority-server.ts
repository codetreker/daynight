import { bindCopilotRead, checkCopilotRead, copilotCorrelationKey, copilotSourcePath, type CopilotAuthorityNative } from "./copilot-read-authority-check.js";
import { copilotReadMarker } from "./copilot-read-authority-correlation.js";
import { copilotAuthorityProtocol, parseCopilotReadRequest } from "./copilot-read-authority.js";

/** Fixed operations only. No RPC, policy mutation or hook command crosses IPC. */
export function installCopilotReadAuthorityServer(native: CopilotAuthorityNative, execution: string): void {
  let bound: { sessionId: string; cwd: string; auth: string; key: string } | undefined, sequence = 0, busy = false, closed = false;
  const fail = () => { closed = true; };
  process.once("disconnect", fail);
  process.on("message", async value => {
    if (closed) return;
    let request;
    try {
      request = parseCopilotReadRequest(value);
      if (busy || request.execution !== execution || request.sequence !== sequence++ || bound && (request.sessionId !== bound.sessionId || request.cwd !== bound.cwd)) return fail();
    } catch { return fail(); }
    busy = true;
    let allowed = false;
    try {
      if (request.checkpoint === null) {
        const auth = await bindCopilotRead(native, request.sessionId, request.cwd);
        const key = await copilotCorrelationKey(native, request.sessionId);
        bound = { sessionId: request.sessionId, cwd: request.cwd, auth, key }; allowed = true;
      } else if (bound) {
        const intention = copilotReadMarker(bound.key, bound.sessionId, execution, request.sequence, request.digest, copilotSourcePath(request.checkpoint, bound.cwd));
        await checkCopilotRead(native, bound.sessionId, bound.cwd, request.checkpoint, bound.auth, intention); allowed = true;
      }
    } catch { /* Only a bounded refusal crosses the private channel. */ }
    busy = false;
    if (!closed && process.connected) process.send!({ protocol: copilotAuthorityProtocol, execution, sequence: request.sequence, digest: request.digest, allowed, key: request.sequence === 0 && allowed ? bound!.key : null });
  });
}
