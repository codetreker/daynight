import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createImageDecoder, type ImageDecoderConfiguration } from "../../../src/commands/controller/media/image-decoder.js";
import { IMAGE_VALIDATION_BUILD_ID } from "../../../src/commands/controller/media/image-validation.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async (body: string) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/image-decoder-tests"); await mkdir(base, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(base, "d-"))); roots.push(root);
  const helperPath = path.join(root, "helper.mjs"), enginePath = path.join(root, "image-validation.js"), engine = "pinned";
  await writeFile(helperPath, body); await writeFile(enginePath, engine);
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const configuration: ImageDecoderConfiguration = { runtimePath: await realpath(process.execPath), helperPath, enginePath, helperSha256: sha(body), engineSha256: sha(engine), buildId: IMAGE_VALIDATION_BUILD_ID };
  const request = { version: 1 as const, policy: "image-validation-v1" as const, inputPath: path.join(root, "original"), expectedByteLength: "3", expectedSha256: sha("png") };
  return { root, configuration, request };
};
const success = `let input='';for await(const chunk of process.stdin)input+=chunk;const r=JSON.parse(input);process.stdout.write(JSON.stringify({version:1,buildId:'${IMAGE_VALIDATION_BUILD_ID}',result:{mediaType:'image/png',byteLength:r.expectedByteLength,sha256:r.expectedSha256,width:1,height:1,frameCount:1},error:null}));process.stderr.write(JSON.stringify({peakRssBytes:'123456'}));`;
test("decoder validates bounded process metadata and pinned artifacts before returning", async () => {
  const f = await fixture(success); const peaks: number[] = [];
  await expect(createImageDecoder({ ...f.configuration, onPeakRss: n => peaks.push(n) })(f.request)).resolves.toMatchObject({ sha256: f.request.expectedSha256, width: 1 });
  expect(peaks).toEqual([123456]);
  await expect(createImageDecoder({ ...f.configuration, rssLimitBytes: 123455 })(f.request)).rejects.toThrow("RSS");
  await writeFile(f.configuration.enginePath, "tampered");
  await expect(createImageDecoder(f.configuration)(f.request)).rejects.toThrow("integrity");
});
test("cancellation waits for the actual helper process to exit", async () => {
  const f = await fixture(`import{writeFileSync}from'node:fs';writeFileSync(new URL('./pid',import.meta.url),String(process.pid));setInterval(()=>{},1000);`);
  const controller = new AbortController(); const pending = createImageDecoder(f.configuration)(f.request, controller.signal); const assertion = expect(pending).rejects.toThrow("cancelled");
  let pid: number | undefined;
  for (let n = 0; n < 100; n++) { try { pid = Number(await readFile(path.join(f.root, "pid"), "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  expect(pid).toBeGreaterThan(0); controller.abort(new Error("cancelled")); await assertion;
  expect(() => process.kill(pid!, 0)).toThrow();
});
test("a helper deadline and output overflow terminate and join the process", async () => {
  const idle = await fixture("setInterval(()=>{},1000);");
  await expect(createImageDecoder({ ...idle.configuration, timeoutMilliseconds: 30 })(idle.request)).rejects.toThrow("deadline");
  const loud = await fixture("process.stdout.write('x'.repeat(16385));setInterval(()=>{},1000);");
  await expect(createImageDecoder(loud.configuration)(loud.request)).rejects.toThrow("bound");
});
