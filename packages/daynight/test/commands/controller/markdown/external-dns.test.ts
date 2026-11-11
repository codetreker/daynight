import { afterEach, expect, test, vi } from "vitest";
import { createSocket, type Socket } from "node:dgram";
import { Resolver } from "node:dns/promises";
import { resolveExternalImageAddresses } from "../../../../src/commands/controller/markdown/external-source.js";

const servers: Socket[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function dnsServer(answer: (type: number) => Buffer | null | undefined) {
  const server = createSocket("udp4"), types: number[] = []; servers.push(server);
  server.on("message", (question, sender) => {
    let end = 12; while (question[end] !== 0) end += question[end]! + 1; end++;
    const type = question.readUInt16BE(end); types.push(type);
    const data = answer(type); if (data === undefined) return;
    const header = Buffer.alloc(12); question.copy(header, 0, 0, 2); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(data ? 1 : 0, 6);
    const record = Buffer.alloc(12); record.writeUInt16BE(0xc00c); record.writeUInt16BE(type, 2); record.writeUInt16BE(1, 4); record.writeUInt32BE(10, 6); record.writeUInt16BE(data?.length ?? 0, 10);
    const response = Buffer.concat([header, question.subarray(12, end + 4), ...(data ? [record, data] : [])]); server.send(response, sender.port, sender.address);
  });
  await new Promise<void>(resolve => server.bind(0, "127.0.0.1", resolve));
  const resolver = new Resolver({ timeout: 3000, tries: 1 }); resolver.setServers([`127.0.0.1:${server.address().port}`]);
  return { resolver, types };
}

test("real DNS transport gathers both families and CNAME NODATA before approving a public address", async () => {
  const f = await dnsServer(type => type === 1 ? Buffer.from([8, 8, 8, 8]) : null);
  await expect(resolveExternalImageAddresses("origin.example", new AbortController().signal, f.resolver)).resolves.toEqual(["8.8.8.8"]);
  expect(f.types.sort((a, b) => a - b)).toEqual([1, 5, 28]);
});

test("a real mixed-family DNS response containing loopback refuses the entire origin", async () => {
  const loopback = Buffer.alloc(16); loopback[15] = 1;
  const f = await dnsServer(type => type === 1 ? Buffer.from([8, 8, 8, 8]) : type === 28 ? loopback : null);
  await expect(resolveExternalImageAddresses("origin.example", new AbortController().signal, f.resolver)).rejects.toMatchObject({ code: "source_forbidden" });
});

test("the DNS deadline cancels all real outstanding resolver queries before returning", async () => {
  const f = await dnsServer(() => undefined);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = expect(resolveExternalImageAddresses("origin.example", new AbortController().signal, f.resolver)).rejects.toMatchObject({ code: "source_timeout" });
  await vi.advanceTimersByTimeAsync(3001); await result;
});
