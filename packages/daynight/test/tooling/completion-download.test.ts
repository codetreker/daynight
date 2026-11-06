import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const script = path.resolve(import.meta.dirname, "../../scripts/download-completion-archive.sh");
const payload = "verified fixture archive\n";
const checksum = createHash("sha256").update(payload).digest("hex");

const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../.tmp/completion-download-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); roots.push(root);
  const bin = path.join(root, "bin"); await mkdir(bin);
  const archive = path.join(root, "archive.tar.gz"), events = path.join(root, "events"), source = path.join(root, "payload");
  await writeFile(source, payload);
  const curl = path.join(bin, "curl");
  await writeFile(curl, `#!/usr/bin/env bash
set -eu
output=""; url=""
while (( $# )); do
  if [[ "$1" == --output ]]; then shift; output="$1"; fi
  if [[ "$1" == https://* ]]; then url="$1"; fi
  shift
done
printf '%s\\n' "$url" >> "$DNT_TEST_DOWNLOAD_EVENTS"
case "$url" in
  */failed) printf partial > "$output"; exit 28 ;;
  */corrupt) printf corrupt > "$output" ;;
  */good) cp "$DNT_TEST_DOWNLOAD_SOURCE" "$output" ;;
  *) exit 2 ;;
esac
`);
  await chmod(curl, 0o755);
  const run = (...urls: string[]) => spawnSync("bash", [script, archive, checksum, ...urls], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, DNT_TEST_DOWNLOAD_EVENTS: events, DNT_TEST_DOWNLOAD_SOURCE: source },
  });
  return { archive, events, root, run };
};

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== "linux")("completion toolchain downloads", () => {
  it.each(["failed", "corrupt"])("replaces a %s response with the next verified source", async failure => {
    const f = await fixture();
    const result = f.run(`https://first.example/${failure}`, "https://second.example/good");
    expect(result.status).toBe(0);
    expect(await readFile(f.archive, "utf8")).toBe(payload);
    expect(await readFile(f.events, "utf8")).toBe(`https://first.example/${failure}\nhttps://second.example/good\n`);
    expect((await readdir(f.root)).filter(name => name.includes(".part."))).toEqual([]);
  });

  it("keeps a failed partial download out of the cache and retries an invalid cache", async () => {
    const f = await fixture();
    expect(f.run("https://first.example/failed").status).toBe(1);
    await expect(readFile(f.archive)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(f.archive, "invalid cached bytes");
    expect(f.run("https://first.example/failed", "https://second.example/corrupt").status).toBe(1);
    expect(await readFile(f.archive, "utf8")).toBe("invalid cached bytes");
    expect((await readdir(f.root)).filter(name => name.includes(".part."))).toEqual([]);
    expect(f.run("https://second.example/good").status).toBe(0);
    expect(await readFile(f.archive, "utf8")).toBe(payload);
  });

  it("reuses a verified cached archive without downloading", async () => {
    const f = await fixture(); await writeFile(f.archive, payload);
    expect(f.run("https://first.example/failed").status).toBe(0);
    await expect(readFile(f.events)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
