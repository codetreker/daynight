import { IMAGE_VALIDATION_BUILD_ID, ImageValidationError, parseImageValidationRequest, validateImageFile } from "./image-validation.js";

let bytes = 0, input = "";
try {
  for await (const chunk of process.stdin) {
    bytes += (chunk as Buffer).length;
    if (bytes > 16_384) throw new Error("Invalid image validation request.");
    input += (chunk as Buffer).toString("utf8");
  }
  const request = parseImageValidationRequest(JSON.parse(input));
  const result = await validateImageFile(request);
  process.stdout.write(JSON.stringify({ version: 1, buildId: IMAGE_VALIDATION_BUILD_ID, result, error: null }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ version: 1, buildId: IMAGE_VALIDATION_BUILD_ID, result: null, error: { code: error instanceof ImageValidationError ? error.code : "image_validation_unavailable", message: error instanceof ImageValidationError ? error.message : "Image validation could not complete.", retry: "never" } }) + "\n");
}
process.stderr.write(JSON.stringify({ peakRssBytes: String(process.resourceUsage().maxRSS * 1024) }) + "\n");
