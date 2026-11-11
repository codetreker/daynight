import { installCopilotReadAuthorityServer } from "../../../../dist/commands/controller/providers/copilot-read-authority-server.js";
import { once } from "node:events";
const [mode, execution] = process.argv.slice(2);
const native = {
  sessionAuthMetadataJson: () => JSON.stringify({ type: "user", host: "https://github.com", login: "fixture" }),
  hookSessionSnapshot: async sessionId => JSON.stringify({ sessionId, cwd: "/workspace", hooks: [], hookCount: 0, warnings: [], repositoryLoaded: true, repositoryDiagnostics: [] }),
  hookProcessorCallbackRegistrations: () => [],
  sessionInvokeJson: async (sessionId, method, params) => {
    if (method === "session.metadata.snapshot") return JSON.stringify({ ok: true, result: { sessionId, workingDirectory: "/workspace", isRemote: false } });
    if (method === "session.permissions.getMode") return JSON.stringify({ ok: true, result: { mode: "manual" } });
    if (method === "session.metadata.getClientMetadata") return JSON.stringify({ ok: true, result: { "daynight/local-read-authority-v1": "1".repeat(64) } });
    if (mode === "hang" || mode === "block") { process.stdout.write("checking\n"); await once(process.stdin, "data"); }
    const paths = JSON.parse(params).paths;
    return JSON.stringify({ ok: true, result: { available: true, checks: paths.map(path => ({ path, excluded: path.endsWith("denied.png") })) } });
  },
  sessionRoutePermissionJson: async (_id, params) => {
    if (mode === "permission") { process.stdout.write(JSON.stringify(JSON.parse(params).permissionRequest) + "\n"); await once(process.stdin, "data"); }
    return JSON.stringify({ route: "result", result: { kind: "approved" } });
  },
};
const send = process.send.bind(process);
process.send = message => {
  if (message.sequence > 0) {
    if (mode === "wrong-digest") message.digest = "f".repeat(64);
    if (mode === "wrong-sequence") message.sequence++;
    if (mode === "oversized") message.unexpected = "x".repeat(1024);
    if (mode === "duplicate") { send(message); send(message); return true; }
  }
  return send(message);
};
installCopilotReadAuthorityServer(native, execution);
process.stdout.write("ready\n");
