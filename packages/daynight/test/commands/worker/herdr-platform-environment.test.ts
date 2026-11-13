import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { platformSystemEnvironment, runHerdrToolPlatform } from "./herdr-tool-platform.fixtures.js";

it.each(["upper", "lower", "mixed"] as const)("canonicalizes %s Windows system keys without inheriting user configuration", casing => {
  const expected = { SystemRoot: "C:\\Windows", SystemDrive: "C:", ComSpec: "C:\\Windows\\system32\\cmd.exe", WINDIR: "C:\\Windows", OS: "Windows_NT" };
  const source = Object.fromEntries(Object.entries(expected).map(([key, value]) => [casing === "upper" ? key.toUpperCase() : casing === "lower" ? key.toLowerCase() : key, value]));
  Object.assign(source, { PATH: "user-path", HOME: "user-home", OPENAI_API_KEY: "user-key" });
  expect(platformSystemEnvironment(source)).toEqual(expected);
});

it("records a real Git initialization failure before creating any Herdr resources", async () => {
  vi.stubEnv("DAYNIGHT_TEST_CODEX", process.execPath);
  vi.stubEnv("DAYNIGHT_TEST_HERDR", process.execPath);
  vi.stubEnv("DAYNIGHT_TEST_GIT", path.resolve(`missing-platform-git-${randomUUID()}`));
  let evidence: Awaited<ReturnType<typeof runHerdrToolPlatform>> | undefined;
  try {
    evidence = await runHerdrToolPlatform("codex");
    expect(evidence).toMatchObject({ resourceStage: "initialization", initialInputAttempts: 0, requests: [], errorDetails: { code: "ENOENT", killed: null, signal: null, timeoutMs: 5000 }, cleanup: { mockClosed: true, runtimeDirectoryRemoved: true, windowsQueries: [] } });
    expect(evidence.errorDetails.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(evidence.ready).toBeUndefined();
    expect(evidence.receipt).toBeUndefined();
    expect(evidence.cleanup.instance).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
    if (evidence) {
      await rm(evidence.evidenceFile);
      await rm(path.join(path.dirname(evidence.evidenceFile), `acceptance-codex-${evidence.nonce}.json`));
    }
  }
});
