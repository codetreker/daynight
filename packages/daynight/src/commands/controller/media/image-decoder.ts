import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseValidatedImage, type ValidatedImage } from "../../../session/image-values.js";
import { IMAGE_VALIDATION_BUILD_ID, IMAGE_VALIDATION_ERROR_CODES, ImageValidationError, type ImageValidationRequest } from "./image-validation.js";

export type ImageDecoder = (request: ImageValidationRequest, signal?: AbortSignal) => Promise<ValidatedImage>;
export type ImageDecoderConfiguration = { runtimePath: string; helperPath: string; enginePath: string; helperSha256: string; engineSha256: string; buildId: string; timeoutMilliseconds?: number; rssLimitBytes?: number; onPeakRss?(bytes: number): void };

/** A decoder owns one child and does not resolve cancellation before process close. */
export const createImageDecoder = (configuration: ImageDecoderConfiguration): ImageDecoder => async (request, signal) => {
  if (signal?.aborted) throw signal.reason;
  const c = configuration;
  if (!path.isAbsolute(c.runtimePath) || !path.isAbsolute(c.helperPath) || !path.isAbsolute(c.enginePath) || c.buildId !== IMAGE_VALIDATION_BUILD_ID || !/^[a-f0-9]{64}$/.test(c.helperSha256) || !/^[a-f0-9]{64}$/.test(c.engineSha256)) throw new Error("Image decoder component_unsupported.");
  for (const [filename, hash] of [[c.helperPath, c.helperSha256], [c.enginePath, c.engineSha256]] as const) {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576 || await realpath(filename) !== filename || createHash("sha256").update(await readFile(filename)).digest("hex") !== hash) throw new Error("Image decoder component_unsupported: artifact integrity failed.");
  }
  const child = spawn(c.runtimePath, ["--max-old-space-size=256", c.helperPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, VIPS_CONCURRENCY: "1", UV_THREADPOOL_SIZE: "1" } });
  return new Promise<ValidatedImage>((resolve, reject) => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), failure: unknown;
    const stop = (error: unknown) => { if (failure === undefined) failure = error; child.kill("SIGKILL"); };
    const aborted = () => stop(signal?.reason ?? new Error("Image decoding was cancelled."));
    const timer = setTimeout(() => stop(new Error("Image decoding exceeded its 15 second deadline.")), Math.min(15_000, c.timeoutMilliseconds ?? 15_000));
    signal?.addEventListener("abort", aborted, { once: true });
    child.stdout.on("data", (value: Buffer) => { if (stdout.length + value.length > 16_384) stop(new Error("Image decoder output exceeded its bound.")); else stdout = Buffer.concat([stdout, value]); });
    child.stderr.on("data", (value: Buffer) => { if (stderr.length + value.length > 16_384) stop(new Error("Image decoder diagnostics exceeded its bound.")); else stderr = Buffer.concat([stderr, value]); });
    child.once("error", error => { failure ??= error; });
    child.stdin.on("error", error => { failure ??= error; });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", aborted);
      if (failure !== undefined) { reject(failure); return; }
      try {
        if (code !== 0 || !stdout.toString("utf8").isWellFormed()) throw new Error("Image decoder did not complete.");
        const metrics: unknown = JSON.parse(stderr.toString("utf8"));
        if (!metrics || typeof metrics !== "object" || Object.keys(metrics).join() !== "peakRssBytes" || !("peakRssBytes" in metrics) || typeof metrics.peakRssBytes !== "string" || !/^[1-9][0-9]{0,15}$/.test(metrics.peakRssBytes)) throw new Error("Image decoder RSS observation is unavailable.");
        const rss = Number(metrics.peakRssBytes); c.onPeakRss?.(rss);
        if (rss > (c.rssLimitBytes ?? 536_870_912)) throw new Error("Image decoder exceeded its monitored RSS target.");
        const reply: unknown = JSON.parse(stdout.toString("utf8"));
        if (!reply || typeof reply !== "object" || Object.keys(reply).sort().join() !== "buildId,error,result,version") throw new Error("Invalid image decoder response.");
        const r = reply as Record<string, unknown>;
        if (r.version !== 1 || r.buildId !== c.buildId || (r.result === null) === (r.error === null)) throw new Error("Invalid image decoder response.");
        if (r.error !== null) {
          if (typeof r.error !== "object" || Array.isArray(r.error) || Object.keys(r.error).sort().join() !== "code,message,retry") throw new Error("Invalid image decoder failure.");
          const error = r.error as Record<string, unknown>;
          if (typeof error.message !== "string" || !error.message || !error.message.isWellFormed() || error.message.length > 1024 || error.retry !== "never") throw new Error("Invalid image decoder failure.");
          if (error.code === "image_validation_unavailable") throw Object.assign(new Error(error.message), { code: error.code });
          if (!IMAGE_VALIDATION_ERROR_CODES.some(code => code === error.code)) throw new Error("Invalid image decoder failure.");
          throw new ImageValidationError(error.code as ImageValidationError["code"], error.message);
        }
        const result = parseValidatedImage(r.result);
        if (result.sha256 !== request.expectedSha256 || result.byteLength !== request.expectedByteLength) throw new Error("Image decoder returned conflicting original integrity.");
        resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
    if (signal?.aborted) aborted();
  });
};

export const bundledImageDecoder = (): ImageDecoder => async (request, signal) => {
  const helperPath = fileURLToPath(new URL("./image-validation-helper.js", import.meta.url));
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(new URL("./image-validation-manifest.json", import.meta.url), "utf8")); }
  catch { throw new Error("Image decoder component_unsupported: packaged validation artifacts are unavailable."); }
  if (!manifest || typeof manifest !== "object") throw new Error("Image decoder component_unsupported.");
  const m = manifest as Record<string, unknown>;
  if (m.version !== 1 || typeof m.buildId !== "string" || typeof m.helperSha256 !== "string" || typeof m.engineSha256 !== "string") throw new Error("Image decoder component_unsupported.");
  return createImageDecoder({ runtimePath: process.execPath, helperPath, enginePath: fileURLToPath(new URL("./image-validation.js", import.meta.url)), buildId: m.buildId, helperSha256: m.helperSha256, engineSha256: m.engineSha256 })(request, signal);
};
