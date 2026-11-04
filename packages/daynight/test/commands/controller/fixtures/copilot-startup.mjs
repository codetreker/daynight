import { createServer } from "node:net";
import { appendFileSync } from "node:fs";

const mode = process.env.DAYNIGHT_TEST_STARTUP_MODE;
const server = createServer(socket => {
  let buffer = Buffer.alloc(0);
  const respond = (id, value) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id, ...value });
    socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  socket.on("error", () => {});
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
      if (!Number.isSafeInteger(length)) throw new Error("Invalid fixture frame.");
      if (buffer.length < end + 4 + length) return;
      const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
      buffer = buffer.subarray(end + 4 + length);
      appendFileSync(process.env.DAYNIGHT_TEST_STARTUP_LOG, `${request.method}\n`);
      if (request.method === "connect") {
        if (request.params.token !== process.env.COPILOT_CONNECTION_TOKEN) throw new Error("Wrong runtime token.");
        respond(request.id, mode === "reject-connect" ? { error: { code: -32602, message: "Fixture handshake rejected" } } : { result: { protocolVersion: 3 } });
      } else if (request.method === "skills.getDiscoveryPaths") respond(request.id, { result: { paths: [] } });
      else if (request.method === "session.getMetadata") respond(request.id, { result: { session: { sessionId: request.params.sessionId, isRemote: false, context: { cwd: process.cwd() } } } });
      else if (request.method === "sessions.checkInUse") respond(request.id, { result: { inUse: [] } });
      else if (request.method === "session.create" || request.method === "session.resume") {
        if (mode === "reject" || mode === "reject-resume") respond(request.id, { error: { code: -32602, message: "Fixture initialization rejected" } });
        else if (mode === "disconnect") process.exit(1);
        else if (mode !== "timeout") throw new Error("Unknown fixture mode.");
      } else if (request.method === "runtime.shutdown") respond(request.id, { result: {} });
      else respond(request.id, { error: { code: -32601, message: `Unexpected fixture request: ${request.method}` } });
    }
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`Listening on port ${server.address().port}\n`));
