import path from "node:path";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";

/** Creating a symbolic link on Windows needs SeCreateSymbolicLinkPrivilege,
 * which an ordinary account only holds under Developer Mode or elevation.
 * Without it every `symlink` call fails with EPERM while the fixture is being
 * built, so a test that merely needs a link to exist fails for a reason that
 * has nothing to do with the behavior it covers. Probing once tells those
 * fixtures apart from the behavior, and only on an unprivileged developer
 * machine: CI keeps running them so a real regression still fails there.
 */
const probe = (): boolean => {
  if (process.platform !== "win32") return true;
  let directory: string | undefined;
  try {
    directory = mkdtempSync(path.join(tmpdir(), "daynight-symlink-probe-"));
    symlinkSync(path.join(directory, "target"), path.join(directory, "link"));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) return false;
    throw error;
  } finally {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
};

export const symbolicLinksAvailable = probe();

/** True when a test that builds a symbolic-link fixture cannot run here. CI is
 * excluded deliberately: a runner that loses the privilege must fail loudly
 * rather than report a silently reduced suite.
 */
export const skipWithoutSymbolicLinks = !symbolicLinksAvailable && process.env.CI === undefined;
