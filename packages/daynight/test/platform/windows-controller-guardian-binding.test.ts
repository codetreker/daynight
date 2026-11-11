import { expect, test, vi } from "vitest";

const binding = vi.hoisted(() => ({ load: vi.fn(), compare: vi.fn(), declarations: [] as { library: string; declaration: string }[] }));
vi.mock("../../src/platform/windows-job.js", async original => ({ ...await original<typeof import("../../src/platform/windows-job.js")>(), loadWindowsJobKernel: vi.fn(async () => ({})) }));
vi.mock("koffi", async original => ({ ...await original<typeof import("koffi")>(), load: binding.load }));
import { loadWindowsControllerGuardianKernel } from "../../src/platform/windows-controller-guardian.js";

test("binds original-handle comparison from Kernelbase and compares both handles", async () => {
  binding.declarations.length = 0;
  binding.load.mockImplementation((library: string) => ({ func: (declaration: string) => {
    binding.declarations.push({ library, declaration });
    if (declaration.includes("CompareObjectHandles")) {
      if (library !== "kernelbase.dll") throw new Error("CompareObjectHandles is unavailable in this DLL.");
      return binding.compare;
    }
    if (library !== "kernel32.dll") throw new Error("Unexpected guardian API library.");
    return vi.fn();
  } }));
  const kernel = await loadWindowsControllerGuardianKernel(), original = {}, duplicate = {}, other = {};
  binding.compare.mockReturnValueOnce(1).mockReturnValueOnce(0);
  expect(kernel.sameJob(original, duplicate)).toBe(true);
  expect(kernel.sameJob(original, other)).toBe(false);
  expect(binding.compare.mock.calls).toEqual([[original, duplicate], [original, other]]);
  expect(binding.declarations.filter(entry => entry.declaration.includes("CompareObjectHandles"))).toEqual([{ library: "kernelbase.dll", declaration: "int __stdcall CompareObjectHandles(void *left, void *right)" }]);
});
