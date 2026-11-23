import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { createServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

const serviceURL = (origin: string): URL => {
  const url = new URL(origin);
  assert.equal(url.protocol, "https:"); assert.equal(url.hostname, "app.daynight.localhost"); assert(url.port);
  return url;
};

/** The namespace retains its HTTP endpoint; its only upstream is the verified local TLS service. */
export async function startForward(target: string, ca: Buffer) {
  const destination = serviceURL(target), sockets = new Set<Socket>(); let accepted = 0;
  const listener = createServer(incoming => {
    accepted++;
    const outgoing = tlsConnect({ host: "127.0.0.1", port: Number(destination.port), servername: destination.hostname, ca });
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket); socket.once("close", () => { sockets.delete(socket); });
      socket.once("error", () => { incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing).pipe(incoming);
    incoming.once("close", () => outgoing.destroy());
  });
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "0.0.0.0", resolve); });
  const address = listener.address(); assert(address && typeof address !== "string");
  return { port: address.port, accepted: () => accepted, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  } };
}

/** Use only the fixture CA and local address for the parent process's service calls. */
export async function requestService(origin: string, ca: Buffer, token: string, target: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const service = serviceURL(origin);
  return await new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: "127.0.0.1", port: service.port, servername: service.hostname, ca, path: target,
      method: body === undefined ? "GET" : "POST", signal,
      headers: { host: service.host, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => { try { assert(response.statusCode && response.statusCode >= 200 && response.statusCode < 300, `Real service ${target} returned HTTP ${response.statusCode}.`); resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
