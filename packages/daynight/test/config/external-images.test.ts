import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { readExternalImageConfiguration } from "../../src/config/external-images.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
const profile = { schemaVersion: 1, profileId: "host-1", protectedCidrs: ["8.8.8.0/24"], protectedDomains: ["private.example"], egress: { mode: "direct", nat64Prefixes: ["2003:abcd::/32"] } };
async function fixture(value: unknown = profile) {
  const base = path.resolve(import.meta.dirname, "../../../../.tmp/external-image-config-tests");
  await mkdir(base, { recursive: true }); const stateDirectory = await mkdtemp(path.join(base, "case-")); roots.push(stateDirectory);
  const configFile = path.join(stateDirectory, "config.yml");
  await writeFile(configFile, JSON.stringify({ server: { token: "secret" }, controller: { unrelated: true, externalImages: value }, unknown: true }));
  return { stateDirectory, configFile };
}

test("only the owned section is strict and its canonical content defines the revision", async () => {
  const paths = await fixture(), first = await readExternalImageConfiguration(paths);
  expect(first.profile).toEqual(profile);
  await writeFile(paths.configFile, JSON.stringify({ unknown: { new: "value" }, controller: { externalImages: { egress: profile.egress, protectedDomains: profile.protectedDomains, profileId: profile.profileId, schemaVersion: 1, protectedCidrs: profile.protectedCidrs } } }, null, 2));
  const second = await readExternalImageConfiguration(paths);
  expect(second.revision).toBe(first.revision);
  expect(second.identity).not.toBe(first.identity);
});

test("missing, partial, ambiguous and unknown deployment facts cannot enable external images", async () => {
  for (const invalid of [null, {}, { ...profile, schemaVersion: 2 }, { ...profile, profileId: "host\nsecret" }, { ...profile, enabled: true }, { ...profile, protectedCidrs: undefined }, { ...profile, protectedCidrs: ["8.8.8.1/24"] }, { ...profile, protectedCidrs: ["::ffff:8.8.8.0/80"] }, { ...profile, protectedDomains: ["*.example"] }, { ...profile, protectedDomains: ["PRIVATE.example"] }, { ...profile, egress: { mode: "direct" } }, { ...profile, egress: { mode: "direct", nat64Prefixes: ["2003:abcd::/80"] } }, { ...profile, egress: { mode: "enforced" } }, { ...profile, egress: { mode: "enforced", policyId: "policy-1", nat64Prefixes: [] } }]) {
    await expect(readExternalImageConfiguration(await fixture(invalid))).rejects.toThrow();
  }
  const enforced = { ...profile, egress: { mode: "enforced", policyId: "network-policy-1" } };
  expect((await readExternalImageConfiguration(await fixture(enforced))).profile).toEqual(enforced);
});

test("configuration reads reject missing, oversized, nonregular, symlink and malformed input", async () => {
  const paths = await fixture();
  await rm(paths.configFile); await expect(readExternalImageConfiguration(paths)).rejects.toThrow();
  await mkdir(paths.configFile); await expect(readExternalImageConfiguration(paths)).rejects.toThrow(); await rm(paths.configFile, { recursive: true });
  await writeFile(paths.configFile, "x".repeat(1_048_577)); await expect(readExternalImageConfiguration(paths)).rejects.toThrow();
  await writeFile(paths.configFile, "controller: { externalImages: { schemaVersion: 1, schemaVersion: 1 } }"); await expect(readExternalImageConfiguration(paths)).rejects.toThrow();
  await writeFile(paths.configFile, Buffer.from([255])); await expect(readExternalImageConfiguration(paths)).rejects.toThrow();
  await rm(paths.configFile); const target = path.join(paths.stateDirectory, "target.yml"); await writeFile(target, JSON.stringify({ controller: { externalImages: profile } }));
  await symlink(target, paths.configFile); await expect(readExternalImageConfiguration(paths)).rejects.toThrow();
});
