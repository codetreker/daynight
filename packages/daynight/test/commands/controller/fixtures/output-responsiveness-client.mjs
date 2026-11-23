import path from "node:path";
import { requestController } from "../../../../dist/commands/controller/local-client.js";

process.on("message", async message => {
  if (message.kind === "close") { process.disconnect(); return; }
  if (message.kind !== "observe") throw new Error("Unexpected client command.");
  const ticket = message.ticket;
  if (process.platform !== "win32") ticket.ipcEndpoint = path.relative(process.cwd(), ticket.ipcEndpoint);
  const requestedAt = performance.timeOrigin + performance.now();
  try {
    const response = await requestController(ticket, { kind: "observe" }, { timeoutMs: 2000 });
    process.send({ kind: "response", requestedAt, respondedAt: performance.timeOrigin + performance.now(), response });
  } catch (error) {
    process.send({ kind: "failure", requestedAt, respondedAt: performance.timeOrigin + performance.now(), error: error.stack });
  }
});
process.send({ kind: "ready" });
