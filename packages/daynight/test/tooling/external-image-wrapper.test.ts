import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")("passes runtime arguments and decoder settings through the external-image server wrapper", () => {
  const base = path.resolve(import.meta.dirname, "../../../../.tmp/external-image-wrapper-tests");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, "wrapper-"));
  try {
    const source = readFileSync(new URL("../../scripts/external-image-harness/server-wrapper.sh", import.meta.url), "utf8");
    const command = "exec /opt/e2e/daynight-server.bin";
    expect(source).toContain(command);
    const wrapper = path.join(directory, "wrapper.sh"), target = path.join(directory, "fake server.sh");
    writeFileSync(wrapper, source.replace(command, 'exec "$FAKE_DAYNIGHT_SERVER"'));
    writeFileSync(target, '#!/bin/sh\nprintf "%s\\n" "$$" "$@" "$DAYNIGHT_IMAGE_NODE_PATH" "$DAYNIGHT_IMAGE_HELPER_PATH" "$DAYNIGHT_IMAGE_MANIFEST_PATH" "$DAYNIGHT_IMAGE_TEMP_DIRECTORY"\n', { mode: 0o700 });
    const result = spawnSync("/bin/sh", [wrapper, "--root", "/run/private/daynight root"], { env: { ...process.env, FAKE_DAYNIGHT_SERVER: target }, encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      String(result.pid), "--root", "/run/private/daynight root", "/usr/local/bin/node",
      "/opt/e2e/image-validator/image-validation-helper.js", "/opt/e2e/image-validator/image-validation-manifest.json", "/run/private/image-validation",
    ]);
    writeFileSync(target, "#!/bin/sh\nexit 37\n", { mode: 0o700 });
    const failed = spawnSync("/bin/sh", [wrapper, "--root", "/run/private/daynight root"], { env: { ...process.env, FAKE_DAYNIGHT_SERVER: target }, encoding: "utf8", timeout: 5000 });
    expect(failed.error).toBeUndefined();
    expect(failed.status).toBe(37);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
