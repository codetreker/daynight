import { expect, test } from "vitest";
import { networkInterfaces } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createExternalImagePolicyProducer } from "../../../../src/commands/controller/markdown/external-policy.js";

test("native host interface observations exclude every assigned address without network requests", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../../.tmp/external-host-policy-tests"); await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, "case-")), configFile = path.join(stateDirectory, "config.yml");
  // This synthetic declaration permits examining the real OS address parser;
  // it is not evidence that the host's actual egress enforces this policy.
  await writeFile(configFile, JSON.stringify({ controller: { externalImages: { schemaVersion: 1, profileId: "host-parser-fixture", protectedCidrs: [], protectedDomains: [], egress: { mode: "enforced", policyId: "synthetic-test-declaration" } } } }));
  const producer = createExternalImagePolicyProducer({ paths: { stateDirectory, configFile } });
  try {
    const lease = await producer.acquire();
    try {
      const addresses = Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? []); expect(addresses.length).toBeGreaterThan(0);
      for (const address of addresses) await expect(lease.assertTarget({ hostname: "host.example", address })).rejects.toMatchObject({ code: "source_forbidden" });
    } finally { lease.release(); }
  } finally { await producer.close(); await rm(stateDirectory, { recursive: true, force: true }); }
});
