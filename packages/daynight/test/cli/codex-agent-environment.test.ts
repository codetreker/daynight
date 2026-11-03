import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { prepareAgentCliAliases } from "../../src/cli/agent-cli-aliases.js";
import { codexAgentCliOverrides } from "../../src/cli/codex-agent-environment.js";

const environment = { PATH: "/private/aliases:/worker/bin:/usr/bin", DN_CONFIG_DIR: "/private/dev" };

test.skipIf(process.platform === "win32").each(["/toolchain/bin:/usr/bin:/bin", "", ":/tools::/bin:"])("keeps the native PATH tail verbatim: %j", configured => {
  expect(codexAgentCliOverrides(environment, { config: { shell_environment_policy: { set: { PATH: configured, KEEP: "native" }, inherit: "none", include_only: ["PATH"] } } })).toEqual({
    "shell_environment_policy.set.PATH": `/private/aliases:${configured}`,
    "shell_environment_policy.set.DN_CONFIG_DIR": "/private/dev",
  });
});

test.skipIf(process.platform === "win32").each([{}, { shell_environment_policy: null }, { shell_environment_policy: { inherit: "core", exclude: ["SECRET*"], set: { KEEP: "native" } } }])("retains the launch PATH without a native PATH override: %j", config => {
  expect(codexAgentCliOverrides(environment, { config })["shell_environment_policy.set.PATH"]).toBe(environment.PATH);
});

test.skipIf(process.platform === "win32").each([undefined, {}, { config: [] }, { config: { shell_environment_policy: [] } }, { config: { shell_environment_policy: { set: [] } } }, { config: { shell_environment_policy: { set: { PATH: null } } } }])("rejects unavailable or invalid native config instead of replacing it: %j", response => {
  expect(() => codexAgentCliOverrides(environment, response)).toThrow();
});

test.skipIf(process.platform === "win32")("mapped CLI and native-only toolchain both execute with the resulting PATH", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../.tmp/codex-alias-tools"); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "test-"));
  try {
    const tools = path.join(directory, "toolchain"), development = path.join(directory, "development-cli");
    await mkdir(tools);
    await writeFile(path.join(tools, "native-compiler"), '#!/bin/sh\nprintf "%s\\n" native-toolchain\n', { mode: 0o700 });
    await writeFile(path.join(tools, "daynight"), '#!/bin/sh\nprintf "%s\\n" stable-cli\n', { mode: 0o700 });
    await writeFile(development, '#!/bin/sh\nprintf "%s\\n" development-cli\n', { mode: 0o700 });
    const aliases = await prepareAgentCliAliases({ aliases: { daynight: development }, environment: { PATH: "/usr/bin:/bin" }, stateDirectory: directory });
    const overrides = codexAgentCliOverrides({ PATH: aliases.environment.PATH!, DN_CONFIG_DIR: directory }, { config: { shell_environment_policy: { set: { PATH: `${tools}:/usr/bin:/bin` } } } });
    const result = await promisify(execFile)("/bin/sh", ["-c", "daynight; native-compiler"], { env: { PATH: overrides["shell_environment_policy.set.PATH"] }, timeout: 5000 });
    expect(result.stdout).toBe("development-cli\nnative-toolchain\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
