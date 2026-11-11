import { expect, test } from "vitest";
import { loadWindowsControllerGuardianKernel } from "../../src/platform/windows-controller-guardian.js";

test.skipIf(process.platform !== "win32")("compares a duplicated original Job against a different real Job", async () => {
  const kernel = await loadWindowsControllerGuardianKernel();
  let original: unknown, duplicate: unknown, other: unknown, self: unknown;
  try {
    original = kernel.createAnonymousJob(); other = kernel.createAnonymousJob();
    self = kernel.openGuardian(process.pid);
    duplicate = kernel.duplicateJob(self, kernel.handleValue(original));
    expect(kernel.sameJob(original, duplicate)).toBe(true);
    expect(kernel.sameJob(original, other)).toBe(false);
  } finally {
    const errors: unknown[] = [];
    for (const handle of [duplicate, other, original]) if (handle !== undefined) try { kernel.close(handle); } catch (error) { errors.push(error); }
    if (self !== undefined) try { kernel.closeProcess(self); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Native test handles could not be released.");
  }
});
