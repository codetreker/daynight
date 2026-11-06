import assert from "node:assert/strict";
import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
import { createWorkerReadOnlyChannel } from "../../dist/commands/worker/read-only/channel.js";
import { browseWorkerDirectory as browseLocalDirectory } from "../../dist/commands/worker/read-only/directory.js";

// Only the Go harness supplies credentials, over stdin. The fixture never reads
// user directories or file contents; all tested entries are created under its
// private temporary root before the Worker starts serving read-only requests.
const lines = createInterface({ input: process.stdin });
const configuration = await new Promise((resolve, reject) => {
  lines.once("line", line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
  lines.once("close", () => reject(new Error("Encoding fixture configuration was not supplied.")));
});
lines.close();
const root = await realpath(configuration.defaultCwd);
const owned = [];
let server, channel;
const originalFetch = globalThis.fetch;
const measurements = [];
try {
  const cases = [
    { id: "a", characters: "&".repeat(240) },
    ...(process.platform === "win32" ? [] : [{ id: "b", characters: "<>".repeat(120) }]),
    { id: "c", characters: "\u2028\u2029".repeat(40) },
  ];
  for (const item of cases) {
    item.directory = path.join(root, item.id);
    await mkdir(item.directory); owned.push(item.directory);
    item.names = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}${item.characters}`);
    for (const name of item.names) await mkdir(path.join(item.directory, name));
  }
  let nativeResult;
  channel = createWorkerReadOnlyChannel({
    ...configuration,
    configurationSignature: () => "native-encoding-acceptance",
    execute: async (_operation, input, signal) => {
      const result = await browseLocalDirectory(input, { defaultCwd: root, signal });
      nativeResult = JSON.stringify(result);
      return result;
    },
    onError: message => process.stderr.write(`${message}\n`),
  });
  const deadline = Date.now() + 10_000;
  while (!channel.connected()) {
    if (Date.now() >= deadline) throw new Error("Encoding fixture Worker did not connect before its deadline.");
    await delay(20);
  }
  server = await createServer({
    root: path.resolve(import.meta.dirname, "../../../daynight-web"),
    configFile: false, appType: "custom", logLevel: "error",
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  const web = await server.ssrLoadModule("/src/api/worker-readonly.ts");
  // Node has no browser origin or cookie jar. Supply the fixture's origin and
  // PAT while retaining the real HTTP response and untouched streaming body.
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${configuration.serverToken}`);
    const response = await originalFetch(new URL(String(input), configuration.serverOrigin), { ...init, headers });
    const bytes = Buffer.from(await response.clone().arrayBuffer());
    const raw = bytes.toString("utf8");
    assert.equal(response.status, 200, "The production route must return a successful directory response.");
    assert.ok(nativeResult !== undefined, "The target Worker must produce the response.");
    const logicalResultPreserved = JSON.stringify(JSON.parse(raw).result) === nativeResult;
    const nativeBytes = Buffer.byteLength(nativeResult);
    const legacyEscapedBytes = Buffer.byteLength(raw.replace(/[&<>\u2028\u2029]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));
    assert.ok(nativeBytes <= 65_536, "The Worker page must stay within its 64 KiB result budget.");
    measurements.push({ nativeBytes, wireBytes: bytes.byteLength, legacyEscapedBytes, logicalResultPreserved });
    return response;
  };
  let pages = 0;
  for (const item of cases) {
    const names = [];
    let cursor;
    do {
      const response = await web.browseWorkerDirectory(configuration.workerId,
        { path: item.directory, limit: 100, ...(cursor === undefined ? {} : { cursor }) },
        AbortSignal.timeout(12_000), { userId: configuration.ownerUserId, onPrincipalMismatch: () => assert.fail("The response principal changed.") });
      assert.equal(response.result.path, item.directory);
      names.push(...response.result.entries.map(entry => entry.name));
      cursor = response.result.nextCursor ?? undefined;
      assert.ok(++pages <= 12, "The bounded directory pages must terminate.");
    } while (cursor !== undefined);
    assert.deepEqual(names, item.names, "The production Web typed client must retain every exact directory name across pages.");
  }
  assert.ok(measurements.every(item => item.logicalResultPreserved), "The HTTP response must preserve the Worker's logical result, including line separators.");
  assert.ok(measurements.every(item => item.wireBytes <= 256 * 1024), "The actual response stream must stay within the production Web client budget.");
  assert.ok(measurements.some(item => item.nativeBytes >= 60 * 1024 && item.legacyEscapedBytes > 256 * 1024),
    "The real fixture must exercise a valid near-limit Worker page that legacy HTML escaping would exceed the Web budget.");
  process.stdout.write(`${JSON.stringify({ kind: "worker-readonly-encoding", platform: process.platform,
    cases: cases.length, entries: cases.length * 100, pages,
    maxNativeBytes: Math.max(...measurements.map(item => item.nativeBytes)),
    maxWireBytes: Math.max(...measurements.map(item => item.wireBytes)),
    maxLegacyEscapedBytes: Math.max(...measurements.map(item => item.legacyEscapedBytes)),
    productionWebClient: true, logicalResultPreserved: true })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ kind: "worker-readonly-encoding-failure", measurements })}\n`);
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  channel?.close();
  await server?.close();
  for (const directory of owned) await rm(directory, { recursive: true, force: true });
}
