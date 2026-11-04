import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { expect, inject, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";

it("shares one real installation while retaining private mutable package bytes, native launchers and runtime cleanup", async () => {
  const canonical = inject("installedCli");
  const owned: Awaited<ReturnType<typeof createAcceptanceCli>>[] = [];
  let failure: unknown;
  try {
    const readonly = await createAcceptanceCli(); owned.push(readonly);
    const first = await createAcceptanceCli({ writablePackage: true }); owned.push(first);
    const second = await createAcceptanceCli({ writablePackage: true }); owned.push(second);
    expect(new Set(owned.map(({ receipt }) => receipt.root)).size).toBe(3);
    expect(readonly.receipt.entryPath).toBe(canonical.entryPath);
    expect(first.receipt.source).toEqual(canonical.source);
    expect(first.receipt.tarballSha256).toBe(canonical.tarballSha256);
    expect(await realpath(first.receipt.entryPath)).not.toBe(await realpath(canonical.entryPath));
    const manual = (entry: string): string => path.join(path.dirname(entry), "commands/skill/usage.md");
    const contents = await readFile(manual(canonical.entryPath));
    await writeFile(manual(first.receipt.entryPath), "private package contents\n");
    expect(await readFile(manual(second.receipt.entryPath))).toEqual(contents);
    expect(await readFile(manual(canonical.entryPath))).toEqual(contents);
    for (const fixture of owned) {
      for (const name of ["daynight", "dn"]) {
        const launcher = path.join(path.dirname(fixture.receipt.launcherPath), process.platform === "win32" ? `${name}.cmd` : name);
        const result = crossSpawn.sync(launcher, ["--version"], { cwd: fixture.receipt.root, env: { ...process.env, HOME: fixture.receipt.root, USERPROFILE: fixture.receipt.root }, encoding: "utf8", timeout: 10_000, windowsHide: true });
        if (result.error) throw result.error;
        expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
        expect(result.stdout.trim()).toBe(canonical.packageVersion);
      }
    }
    await rm(manual(first.receipt.entryPath));
    expect(await readFile(manual(second.receipt.entryPath))).toEqual(contents);
    expect(await readFile(manual(canonical.entryPath))).toEqual(contents);
  } catch (cause) { failure = cause; }
  const cleanup = (await Promise.allSettled(owned.map((fixture) => fixture.cleanup())))
    .flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  for (const fixture of owned) {
    try { await lstat(fixture.receipt.root); cleanup.push(new Error("Acceptance runtime directory was retained after cleanup.")); }
    catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) cleanup.push(cause); }
  }
  try { await lstat(canonical.entryPath); } catch (cause) { cleanup.push(cause); }
  if (cleanup.length !== 0) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Installed acceptance view or cleanup failed.");
  if (failure !== undefined) throw failure;
});
