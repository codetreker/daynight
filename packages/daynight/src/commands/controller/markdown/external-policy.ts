import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { imageAddressInCidr, parseImageNetworkAddress, parseImageNetworkCidr, readExternalImageConfiguration, type ExternalImageConfigurationSnapshot, type ImageNetworkCidr } from "../../../config/external-images.js";
import type { ConfigurationPaths } from "../../../config/paths.js";
import { ExternalImageSourceError, isPublicImageAddress, type ExternalImagePolicyOptions, type ExternalImageTarget } from "./external-source.js";

export type ExternalImagePolicyLease = Omit<ExternalImagePolicyOptions, "beforeRequest" | "controlledNetworkBoundary"> & {
  readonly revision: string;
  readonly generation: string;
  readonly signal: AbortSignal;
  assertTarget(target: ExternalImageTarget): Promise<void>;
  release(): void;
};
const restricted = () => new ExternalImageSourceError("policy_restricted");
const reject = (): never => { throw restricted(); };
// Azure's host-node platform VIP is public numeric space, not an external origin.
const PLATFORM_NETWORKS = ["168.63.129.16/32"];
const withoutZone = (address: string): string => {
  const parts = address.split("%");
  if (parts.length === 1) return address;
  if (parts.length !== 2 || isIP(parts[0]!) !== 6 || !/^[A-Za-z0-9_.-]{1,128}$/.test(parts[1]!)) return reject();
  return parts[0]!;
};
function localNetworks(): { identity: string; networks: ImageNetworkCidr[] } {
  const interfaces = networkInterfaces();
  if (!interfaces || typeof interfaces !== "object" || Array.isArray(interfaces)) return reject();
  const networks: ImageNetworkCidr[] = [], identities: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!Array.isArray(entries)) return reject();
    for (const entry of entries) {
      if (!entry || !["IPv4", "IPv6"].includes(entry.family) || typeof entry.address !== "string" || typeof entry.netmask !== "string" || typeof entry.cidr !== "string" || typeof entry.internal !== "boolean") return reject();
      const family = entry.family === "IPv4" ? 4 : 6, address = withoutZone(entry.address), value = parseImageNetworkAddress(address), mask = parseImageNetworkAddress(entry.netmask);
      if (isIP(address) !== family || isIP(entry.netmask) !== family || !value || !mask || mask.family !== family || family === 6 && (typeof entry.scopeid !== "number" || !Number.isSafeInteger(entry.scopeid) || entry.scopeid < 0)) return reject();
      const width = family === 4 ? 32 : 128;
      let prefix = 0;
      while (prefix < width && ((mask.bits >> BigInt(width - prefix - 1)) & 1n) === 1n) prefix++;
      if (mask.bits !== ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix)) return reject();
      const parts = entry.cidr.split("/");
      if (parts.length !== 2 || parts[1] !== String(prefix)) return reject();
      const cidrAddress = parseImageNetworkAddress(withoutZone(parts[0]!));
      if (!cidrAddress || cidrAddress.family !== value.family || cidrAddress.bits !== value.bits) return reject();
      const network = parseImageNetworkCidr(`${address}/${prefix}`); if (!network) return reject();
      networks.push(network);
      identities.push(JSON.stringify([name, entry.family, entry.address, entry.netmask, entry.cidr, entry.internal, entry.scopeid ?? null]));
    }
  }
  if (!networks.length || networks.length > 4096) return reject();
  return { identity: identities.sort().join("\n"), networks };
}
type Generation = {
  id: string; configuration: ExternalImageConfigurationSnapshot; networkIdentity: string;
  networks: ImageNetworkCidr[]; abort: AbortController; users: number;
};

/** Local trusted config is the declaration owner, not a firewall verifier.
 * Checkpoints reject observed changes; polling also cancels sockets that are
 * waiting for DNS, connection, headers or body. It is not atomic OS notification. */
export function createExternalImagePolicyProducer(options: { paths: ConfigurationPaths }) {
  const paths = { ...options.paths };
  let closed = false, current: Generation | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const lifetime = new AbortController();
  let configurationRead: Promise<ExternalImageConfigurationSnapshot> | null = null;
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action); tail = result.catch(() => {}); return result;
  };
  const invalidate = (generation: Generation | null) => { generation?.abort.abort(restricted()); };
  const observe = async () => {
    if (closed) return reject();
    try {
      // Local regular files are the supported source. A stalled kernel read
      // cannot be forcibly joined by Node; do not accumulate more reads or
      // adopt its late result after the bounded admission has failed.
      if (configurationRead) return reject();
      const read = readExternalImageConfiguration(paths); configurationRead = read;
      void read.finally(() => { if (configurationRead === read) configurationRead = null; }).catch(() => {});
      let timeout: ReturnType<typeof setTimeout> | undefined, abort = () => {};
      const deadline = new Promise<never>((_resolve, refuse) => {
        timeout = setTimeout(() => refuse(restricted()), 1000);
        abort = () => refuse(restricted()); lifetime.signal.addEventListener("abort", abort, { once: true });
      });
      let configuration: ExternalImageConfigurationSnapshot;
      try { configuration = await Promise.race([read, deadline]); }
      finally { clearTimeout(timeout); lifetime.signal.removeEventListener("abort", abort); }
      const local = localNetworks();
      if (closed) return reject();
      return { configuration, local };
    } catch { invalidate(current); return reject(); }
  };
  const matches = (generation: Generation, observed: Awaited<ReturnType<typeof observe>>) => generation.configuration.identity === observed.configuration.identity && generation.configuration.revision === observed.configuration.revision && generation.networkIdentity === observed.local.identity;
  const verify = (generation: Generation) => serial(async () => {
    if (closed || generation.abort.signal.aborted) return reject();
    const observed = await observe();
    if (!matches(generation, observed)) { invalidate(generation); return reject(); }
  });
  const schedule = () => {
    if (closed || timer || !current?.users || current.abort.signal.aborted) return;
    timer = setTimeout(() => {
      timer = null; const generation = current;
      if (generation?.users) void verify(generation).catch(() => {}).finally(schedule);
    }, 250);
    timer.unref();
  };
  const acquire = (): Promise<ExternalImagePolicyLease> => serial(async () => {
    const observed = await observe();
    if (!current || current.abort.signal.aborted || !matches(current, observed)) {
      invalidate(current);
      const profile = observed.configuration.profile;
      current = { id: randomUUID(), configuration: observed.configuration, networkIdentity: observed.local.identity,
        networks: [...PLATFORM_NETWORKS.map(value => parseImageNetworkCidr(value)!), ...observed.local.networks, ...profile.protectedCidrs.map(value => parseImageNetworkCidr(value)!), ...(profile.egress.mode === "direct" ? profile.egress.nat64Prefixes.map(value => parseImageNetworkCidr(value)!) : [])], abort: new AbortController(), users: 0 };
    }
    const generation = current; generation.users++; schedule(); let released = false;
    const assertEgressPolicy = async () => { if (released) return reject(); await verify(generation); if (released) return reject(); };
    return {
      revision: generation.configuration.revision, generation: generation.id, signal: generation.abort.signal, assertEgressPolicy,
      async assertTarget({ hostname, address }) {
        await assertEgressPolicy();
        const host = hostname.toLowerCase().replace(/\.$/, "");
        if (generation.configuration.profile.protectedDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) throw new ExternalImageSourceError("source_forbidden");
        if (address !== undefined) {
          const value = parseImageNetworkAddress(address);
          if (!value || !isPublicImageAddress(address) || generation.networks.some(network => imageAddressInCidr(value, network))) throw new ExternalImageSourceError("source_forbidden");
        }
      },
      release() {
        if (released) return; released = true; generation.users--;
        if (current === generation && !generation.users && timer) { clearTimeout(timer); timer = null; }
      },
    };
  });
  return { acquire, async close() { closed = true; lifetime.abort(); if (timer) { clearTimeout(timer); timer = null; } invalidate(current); await tail; } };
}
