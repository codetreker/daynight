import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { parseConfigurationDocument } from "./document.js";
import type { ConfigurationPaths } from "./paths.js";

export type ImageNetworkAddress = { family: 4 | 6; bits: bigint };
export type ImageNetworkCidr = ImageNetworkAddress & { prefix: number };
export function parseImageNetworkAddress(input: string): ImageNetworkAddress | null {
  if (input.includes("%")) return null;
  const family = isIP(input);
  if (family === 4) return { family, bits: input.split(".").reduce((n, octet) => (n << 8n) | BigInt(octet), 0n) };
  if (family !== 6) return null;
  let value = input.toLowerCase();
  if (value.includes(".")) {
    const pos = value.lastIndexOf(":"), v4 = parseImageNetworkAddress(value.slice(pos + 1));
    if (!v4) return null;
    value = value.slice(0, pos + 1) + (v4.bits >> 16n).toString(16) + ":" + (v4.bits & 65535n).toString(16);
  }
  const halves = value.split("::"), left = halves[0] ? halves[0].split(":") : [], right = halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  const bits = words.reduce((n, word) => (n << 16n) | BigInt("0x" + word), 0n);
  return (bits >> 32n) === 65535n ? { family: 4, bits: bits & 0xffffffffn } : { family, bits };
}
export function parseImageNetworkCidr(input: string): ImageNetworkCidr | null {
  const parts = input.split("/");
  if (parts.length !== 2 || !/^(?:0|[1-9][0-9]{0,2})$/.test(parts[1]!)) return null;
  const address = parseImageNetworkAddress(parts[0]!); if (!address) return null;
  let prefix = Number(parts[1]);
  if (isIP(parts[0]!) === 6 && address.family === 4) { if (prefix < 96) return null; prefix -= 96; }
  const width = address.family === 4 ? 32 : 128;
  if (prefix > width) return null;
  const shift = BigInt(width - prefix);
  return { family: address.family, bits: (address.bits >> shift) << shift, prefix };
}
export function imageAddressInCidr(address: ImageNetworkAddress, cidr: ImageNetworkCidr): boolean {
  if (address.family !== cidr.family) return false;
  const shift = BigInt((address.family === 4 ? 32 : 128) - cidr.prefix);
  return (address.bits >> shift) === (cidr.bits >> shift);
}

/** Trusted operator declarations cover both address families and HTTP(S).
 * Protected sets include deployment-only internal/public aliases. Direct egress
 * preserves that boundary after destination translation, with a complete list
 * of NAT64 prefixes; enforced egress applies it after translation. Neither mode
 * is an application observation of firewall, routing or remote service state. */
export type ExternalImageConfiguration = {
  schemaVersion: 1;
  profileId: string;
  protectedCidrs: string[];
  protectedDomains: string[];
  egress: { mode: "direct"; nat64Prefixes: string[] } | { mode: "enforced"; policyId: string };
};
const invalid = (): never => { throw new Error("External image deployment configuration is unavailable or invalid."); };
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: string[]) => { if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid(); };
const identifier = (value: unknown): string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : invalid();
const strings = (value: unknown, accept: (value: string) => boolean): string[] => {
  if (!Array.isArray(value) || value.length > 256 || !value.every(entry => typeof entry === "string" && entry.length <= 253 && accept(entry)) || new Set(value).size !== value.length) return invalid();
  return [...value].sort();
};
function parseProfile(value: unknown): ExternalImageConfiguration {
  const section = record(value); exact(section, ["schemaVersion", "profileId", "protectedCidrs", "protectedDomains", "egress"]);
  if (section.schemaVersion !== 1) return invalid();
  const network = (value: string) => { const cidr = parseImageNetworkCidr(value), address = parseImageNetworkAddress(value.split("/")[0]!); return !!cidr && !!address && cidr.bits === address.bits; };
  const protectedCidrs = strings(section.protectedCidrs, network);
  const protectedDomains = strings(section.protectedDomains, value => value === domainToASCII(value).toLowerCase() && !isIP(value) && value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)));
  const egress = record(section.egress);
  let result: ExternalImageConfiguration["egress"];
  if (egress.mode === "direct") {
    exact(egress, ["mode", "nat64Prefixes"]);
    const nat64Prefixes = strings(egress.nat64Prefixes, value => { const cidr = parseImageNetworkCidr(value); return network(value) && cidr?.family === 6 && [32, 40, 48, 56, 64, 96].includes(cidr.prefix); });
    result = { mode: "direct", nat64Prefixes };
  } else {
    if (egress.mode !== "enforced") return invalid();
    exact(egress, ["mode", "policyId"]); result = { mode: "enforced", policyId: identifier(egress.policyId) };
  }
  return { schemaVersion: 1, profileId: identifier(section.profileId), protectedCidrs, protectedDomains, egress: result };
}
const fileIdentity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
export type ExternalImageConfigurationSnapshot = { profile: ExternalImageConfiguration; revision: string; identity: string };

/** This reader never follows a final symlink or buffers more than one MiB + 1.
 * The fixed trusted configuration path is independent of every image locator. */
export async function readExternalImageConfiguration(paths: ConfigurationPaths): Promise<ExternalImageConfigurationSnapshot> {
  const limit = 1_048_576, before = await lstat(paths.configFile, { bigint: true });
  if (!before.isFile() || before.size > BigInt(limit)) return invalid();
  const handle = await open(paths.configFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || fileIdentity(initial) !== fileIdentity(before)) return invalid();
    const bytes = Buffer.alloc(Number(initial.size) + 1); let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break; length += read.bytesRead;
    }
    const final = await handle.stat({ bigint: true }), current = await lstat(paths.configFile, { bigint: true });
    if (length !== Number(initial.size) || !current.isFile() || fileIdentity(final) !== fileIdentity(initial) || fileIdentity(current) !== fileIdentity(initial)) return invalid();
    const mapping = parseConfigurationDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)), paths).mapping;
    const profile = parseProfile(record(mapping.controller).externalImages);
    return { profile, revision: createHash("sha256").update(JSON.stringify(profile)).digest("hex"), identity: fileIdentity(final) };
  } finally { await handle.close(); }
}
