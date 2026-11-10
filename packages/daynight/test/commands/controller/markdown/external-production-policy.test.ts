import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as os from "node:os";
import * as configuration from "../../../../src/config/external-images.js";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { createExternalImagePolicyProducer } from "../../../../src/commands/controller/markdown/external-policy.js";
import { copyExternalImage, createExternalImagePolicy, resolveExternalImageAddresses, type ExternalImageDnsResolver } from "../../../../src/commands/controller/markdown/external-source.js";

vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), networkInterfaces: vi.fn() }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const interface4 = (address = "11.12.13.14") => ({ address, family: "IPv4", netmask: "255.255.255.0", cidr: `${address}/24`, internal: false, mac: "00:11:22:33:44:55" } as const);
async function fixture() {
  vi.mocked(os.networkInterfaces).mockReturnValue({ eth0: [interface4()] });
  const base = path.resolve(import.meta.dirname, "../../../../../../.tmp/external-production-policy-tests"); await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, "case-")), configFile = path.join(stateDirectory, "config.yml");
  const profile = { schemaVersion: 1, profileId: "fixture-deployment", protectedCidrs: ["8.8.8.0/24", "2606:4700:1::/48"], protectedDomains: ["private.example"], egress: { mode: "direct", nat64Prefixes: ["2003:abcd::/32"] } };
  const write = () => writeFile(configFile, JSON.stringify({ controller: { externalImages: profile } })); await write();
  cleanups.push(() => rm(stateDirectory, { recursive: true, force: true }));
  const producer = createExternalImagePolicyProducer({ paths: { stateDirectory, configFile } }); cleanups.push(() => producer.close());
  return { producer, configFile, profile, write };
}

test("the production guard rejects local public networks, deployment targets, NAT64 and platform addresses", async () => {
  const f = await fixture(), lease = await f.producer.acquire();
  try {
    for (const address of ["11.12.13.14", "11.12.13.99", "::ffff:11.12.13.14", "8.8.8.8", "2606:4700:1::99", "2003:abcd::a00:1", "168.63.129.16", "::ffff:168.63.129.16", "::ffff:a83f:8110", "169.254.169.254"]) await expect(lease.assertTarget({ hostname: "images.example", address })).rejects.toMatchObject({ code: "source_forbidden" });
    for (const hostname of ["private.example", "sub.private.example"]) await expect(lease.assertTarget({ hostname })).rejects.toMatchObject({ code: "source_forbidden" });
    for (const address of ["1.1.1.1", "2606:4700:4700::1111"]) await expect(lease.assertTarget({ hostname: "public.example", address })).resolves.toBeUndefined();
    await expect(lease.assertTarget({ hostname: "notprivate.example" })).resolves.toBeUndefined();
  } finally { lease.release(); }
});

test("the production guard checks every DNS answer and each CNAME before further resolution", async () => {
  const f = await fixture(), lease = await f.producer.acquire();
  for (const variant of ["mixed", "alias"] as const) {
    const names: string[] = [];
    const resolver: ExternalImageDnsResolver = {
      resolve4: async host => { names.push(host); return variant === "mixed" ? ["1.1.1.1", "8.8.8.8"] : ["1.1.1.1"]; },
      resolve6: async () => [], resolveCname: async () => variant === "alias" ? ["sub.private.example"] : [], cancel() {},
    };
    await expect(resolveExternalImageAddresses("origin.example", lease.signal, resolver, lease.assertTarget)).rejects.toMatchObject({ code: "source_forbidden" });
    expect(names).toEqual(["origin.example"]);
  }
  lease.release();
});

test.each(["headers", "body"] as const)("profile revocation cancels and joins a real socket waiting for %s", async stage => {
  const f = await fixture(), lease = await f.producer.acquire(), sockets = new Set<Socket>();
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const server = createServer((_req, res) => { if (stage === "body") { res.writeHead(200); res.write("first"); } started(); });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); lease.release(); });
  const port = (server.address() as { port: number }).port, outputPath = `${f.configFile}.output`; await writeFile(outputPath, "");
  // The socket is an isolated transport fixture. Its loopback allowance proves
  // cancellation plumbing, independently of the production target guard above.
  const policy = createExternalImagePolicy({ assertEgressPolicy: lease.assertEgressPolicy, signal: lease.signal, beforeRequest() {}, controlledNetworkBoundary: { hostname: "fixture.example", address: "127.0.0.1", port } });
  const copying = copyExternalImage({ url: `http://fixture.example:${port}/`, outputPath, policy });
  const result = expect(copying).rejects.toMatchObject({ code: "policy_restricted" });
  await ready; f.profile.profileId = "replacement-profile"; await f.write(); await result;
  await vi.waitFor(() => expect(sockets.size).toBe(0));
});

test("replacement with identical profile content invalidates the old generation permanently", async () => {
  const f = await fixture(), old = await f.producer.acquire();
  const replacement = `${f.configFile}.new`; await writeFile(replacement, JSON.stringify({ controller: { externalImages: f.profile } })); await rename(replacement, f.configFile);
  await expect(old.assertEgressPolicy()).rejects.toMatchObject({ code: "policy_restricted" }); expect(old.signal.aborted).toBe(true);
  const fresh = await f.producer.acquire();
  expect(fresh.revision).toBe(old.revision); expect(fresh.generation).not.toBe(old.generation);
  await expect(old.assertEgressPolicy()).rejects.toMatchObject({ code: "policy_restricted" }); await expect(fresh.assertEgressPolicy()).resolves.toBeUndefined();
  old.release(); fresh.release();
});

test("an interface change revokes a generation and the next generation guards its new network", async () => {
  const f = await fixture(), old = await f.producer.acquire();
  vi.mocked(os.networkInterfaces).mockReturnValue({ eth0: [interface4("1.1.1.2")] });
  await expect(old.assertEgressPolicy()).rejects.toMatchObject({ code: "policy_restricted" });
  const fresh = await f.producer.acquire(); await expect(fresh.assertTarget({ hostname: "images.example", address: "1.1.1.1" })).rejects.toMatchObject({ code: "source_forbidden" });
  old.release(); fresh.release();
});

test("missing configuration aborts idle leases; restoring it only enables new acquisition", async () => {
  const f = await fixture(), old = await f.producer.acquire(); await rm(f.configFile);
  await vi.waitFor(() => expect(old.signal.aborted).toBe(true), { timeout: 2000 });
  await expect(f.producer.acquire()).rejects.toMatchObject({ code: "policy_restricted" });
  await f.write(); const fresh = await f.producer.acquire();
  await expect(old.assertEgressPolicy()).rejects.toMatchObject({ code: "policy_restricted" });
  await f.producer.close(); expect(fresh.signal.aborted).toBe(true);
  await expect(f.producer.acquire()).rejects.toMatchObject({ code: "policy_restricted" }); old.release(); fresh.release();
});

test("a stalled configuration read revokes the generation without accumulating more reads", async () => {
  const f = await fixture(), lease = await f.producer.acquire();
  const snapshot = await configuration.readExternalImageConfiguration({ stateDirectory: path.dirname(f.configFile), configFile: f.configFile });
  let release!: (value: typeof snapshot) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<typeof snapshot>(resolve => { release = resolve; });
  const read = vi.spyOn(configuration, "readExternalImageConfiguration").mockImplementation(() => { entered(); return held; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const failed = expect(lease.assertEgressPolicy()).rejects.toMatchObject({ code: "policy_restricted" });
    await started; await vi.advanceTimersByTimeAsync(1001); await failed; expect(lease.signal.aborted).toBe(true);
    await expect(f.producer.acquire()).rejects.toMatchObject({ code: "policy_restricted" }); expect(read).toHaveBeenCalledOnce();
    await f.producer.close();
  } finally { release(snapshot); await held; lease.release(); }
});

test("closing the producer interrupts pending admission without adopting a late filesystem result", async () => {
  const f = await fixture(), lease = await f.producer.acquire();
  const snapshot = await configuration.readExternalImageConfiguration({ stateDirectory: path.dirname(f.configFile), configFile: f.configFile });
  let release!: (value: typeof snapshot) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<typeof snapshot>(resolve => { release = resolve; });
  vi.spyOn(configuration, "readExternalImageConfiguration").mockImplementation(() => { entered(); return held; });
  const failed = expect(lease.assertEgressPolicy()).rejects.toMatchObject({ code: "policy_restricted" }); await started;
  try { await f.producer.close(); await failed; expect(lease.signal.aborted).toBe(true); }
  finally { release(snapshot); await held; lease.release(); }
  await expect(f.producer.acquire()).rejects.toMatchObject({ code: "policy_restricted" });
});

test("unknown, unavailable and inconsistent interface structure fails closed", async () => {
  const f = await fixture();
  for (const interfaces of [{}, { eth0: undefined }, { eth0: [{ ...interface4(), cidr: null }] }, { eth0: [{ ...interface4(), netmask: "255.0.255.0" }] }, { eth0: [{ ...interface4(), family: "other" }] }, { eth0: [{ ...interface4(), cidr: "1.2.3.4/24" }] }]) {
    vi.mocked(os.networkInterfaces).mockReturnValue(interfaces as ReturnType<typeof os.networkInterfaces>);
    await expect(f.producer.acquire()).rejects.toMatchObject({ code: "policy_restricted" });
  }
  vi.mocked(os.networkInterfaces).mockImplementation(() => { throw new Error("unavailable"); }); await expect(f.producer.acquire()).rejects.toMatchObject({ code: "policy_restricted" });
});

test("IPv6 zones and mapped IPv4 interfaces retain their full local subnet exclusion", async () => {
  const f = await fixture();
  vi.mocked(os.networkInterfaces).mockReturnValue({ eth0: [
    { address: "2606:4700:3::1%eth0", family: "IPv6", netmask: "ffff:ffff:ffff:ffff::", cidr: "2606:4700:3::1%eth0/64", scopeid: 3, internal: false, mac: "00:11:22:33:44:55" },
    { address: "::ffff:11.12.13.14", family: "IPv6", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ff00", cidr: "::ffff:11.12.13.14/120", scopeid: 0, internal: false, mac: "00:11:22:33:44:55" },
  ] });
  const lease = await f.producer.acquire();
  for (const address of ["2606:4700:3::99", "11.12.13.99"]) await expect(lease.assertTarget({ hostname: "images.example", address })).rejects.toMatchObject({ code: "source_forbidden" }); lease.release();
});
