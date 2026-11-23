import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createImageDecoder, type ImageDecoderConfiguration } from "../../../src/commands/controller/media/image-decoder.js";
import { IMAGE_VALIDATION_BUILD_ID, ImageValidationError } from "../../../src/commands/controller/media/image-validation.js";
import { sourceImageDecoder } from "../../fixtures/image-decoder.js";
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
  try {
    for (let n = 0; n < 100; n++) {
      try {
        const observed = Number(await readFile(path.join(f.root, "pid"), "utf8"));
        // Opening the file precedes writing its PID, so an empty read is not readiness.
        if (Number.isSafeInteger(observed) && observed > 0) { pid = observed; break; }
      } catch { /* The helper has not published its PID yet. */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(pid).toBeGreaterThan(0);
  } finally {
    controller.abort(new Error("cancelled")); await assertion;
  }
  expect(() => process.kill(pid!, 0)).toThrow();
});
test("a helper deadline and output overflow terminate and join the process", async () => {
  const idle = await fixture("setInterval(()=>{},1000);");
  await expect(createImageDecoder({ ...idle.configuration, timeoutMilliseconds: 30 })(idle.request)).rejects.toThrow("deadline");
  const loud = await fixture("process.stdout.write('x'.repeat(16385));setInterval(()=>{},1000);");
  await expect(createImageDecoder(loud.configuration)(loud.request)).rejects.toThrow("bound");
});

test.each([
  { name: "corrupt PNG", bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), code: "image_decode_failed" },
  { name: "unsupported format", bytes: Buffer.from("<svg/>"), code: "image_format_unsupported" },
])("the real helper preserves the confirmed $name failure across process exit", async ({ bytes, code }) => {
  const f = await fixture("");
  const decoder = await sourceImageDecoder(path.join(f.root, "decoder"));
  await writeFile(f.request.inputPath, bytes);
  await expect(decoder({ ...f.request, expectedByteLength: String(bytes.length), expectedSha256: createHash("sha256").update(bytes).digest("hex") })).rejects.toMatchObject({ code });
});

test("the real helper does not classify an unavailable input file as invalid image bytes", async () => {
  const f = await fixture("");
  const decoder = await sourceImageDecoder(path.join(f.root, "decoder"));
  await expect(decoder(f.request)).rejects.toMatchObject({ code: "image_validation_unavailable" });
});

test.each([
  { code: "image_decode_failed", message: "Invalid pixels.", retry: "always" },
  { code: "unknown_failure", message: "Invalid pixels.", retry: "never" },
  { code: "image_decode_failed", message: "Invalid pixels.", retry: "never", extra: true },
  { code: "image_decode_failed", message: null, retry: "never" },
])("malformed helper failures never establish a confirmed image rejection: %j", async error => {
  const body = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify(${JSON.stringify({ version: 1, buildId: IMAGE_VALIDATION_BUILD_ID, result: null, error })}));process.stderr.write(JSON.stringify({peakRssBytes:'123456'}));});`;
  const f = await fixture(body);
  const failure = await createImageDecoder(f.configuration)(f.request).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(ImageValidationError);
});

test("an abnormal helper exit does not establish a confirmed image rejection", async () => {
  const f = await fixture("process.stdin.resume();process.stdin.on('end',()=>process.exit(19));");
  const failure = await createImageDecoder(f.configuration)(f.request).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(ImageValidationError);
});
