import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAgentCliAliases } from "../../src/cli/agent-cli-aliases.js";

const execute = promisify(execFile);
const directories: string[] = [];
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../.tmp/alias-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "alias 用户 ' ")); directories.push(root);
  const bin = path.join(root, "bin"); await mkdir(bin);
  const stateDirectory = path.join(root, "state");
  const executable = async (name: string, marker: string) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${marker}' "$@"\n`, { mode: 0o700 });
    return file;
  };
  return { root, bin, stateDirectory, executable };
};
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("Agent-scoped CLI aliases", () => {
  it("does nothing, including preserving the same environment object, when disabled", async () => {
    const { stateDirectory } = await fixture(); const environment = { PATH: "/unchanged", HOME: "/real-home" };
    const prepared = await prepareAgentCliAliases({ aliases: {}, environment, stateDirectory });
    expect(prepared).toEqual({ environment, bindings: [], directory: null });
    expect(prepared.environment).toBe(environment);
    await expect(stat(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("pins the target before PATH injection and preserves arguments and real home", async () => {
    const { root, bin, stateDirectory, executable } = await fixture();
    const target = await executable("snapshot-v1", "version-one");
    const second = await executable("snapshot-v2", "version-two");
    await executable("daynight", "stable"); await executable("dn", "stable-dn");
    const entry = path.join(bin, "daynight-dev"); await symlink(target, entry);
    const environment = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: root, DN_CONFIG_DIR: stateDirectory };
    const prepared = await prepareAgentCliAliases({ aliases: { daynight: "daynight-dev" }, environment, stateDirectory });
    expect(prepared.bindings).toEqual([{ name: "daynight", target: "daynight-dev", executable: await realpath(target) }]);
    expect(prepared.environment.HOME).toBe(root); expect(prepared.environment.DN_CONFIG_DIR).toBe(stateDirectory);
    expect(prepared.environment).not.toBe(environment);
    await unlink(entry); await symlink(second, entry);
    const args = ["spaces in input", "'double\"quotes", "$(touch should-not-exist)", "", "line\nbreak"];
    const result = await execute("/bin/sh", ["-c", 'exec daynight "$@"', "sh", ...args], { env: prepared.environment });
    expect(result.stdout).toBe(["version-one", ...args, ""].join("\n"));
    expect((await execute("/bin/sh", ["-c", "daynight"], { env: environment })).stdout).toBe("stable\n");
    expect((await execute("/bin/sh", ["-c", "dn"], { env: prepared.environment })).stdout).toBe("stable-dn\n");
    expect((await stat(prepared.directory!)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(prepared.directory!, "daynight"))).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("resolves all configured targets against the original PATH", async () => {
    const { bin, stateDirectory, executable } = await fixture();
    await executable("daynight", "original-daynight"); await executable("dn", "original-dn");
    const prepared = await prepareAgentCliAliases({ aliases: { daynight: "dn", dn: "daynight" }, environment: { PATH: bin }, stateDirectory });
    expect((await execute("/bin/sh", ["-c", "daynight; dn"], { env: prepared.environment })).stdout).toBe("original-dn\noriginal-daynight\n");
  });

  it.skipIf(process.platform === "win32")("fails before creating shims when any target is missing or not executable", async () => {
    const { bin, stateDirectory, executable } = await fixture();
    const target = await executable("not-executable", "ignored"); await chmod(target, 0o600);
    for (const aliases of [{ daynight: "missing-command" }, { daynight: target }]) {
      await expect(prepareAgentCliAliases({ aliases, environment: { PATH: bin }, stateDirectory })).rejects.toThrow(/agentCliAliases.daynight/);
      await expect(stat(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a PATH delimiter in an enabled alias state root before writing shims", async () => {
    const { bin, stateDirectory, executable } = await fixture();
    await executable("daynight-dev", "development"); await executable("daynight", "stable");
    const environment = { PATH: bin };
    const ambiguousRoot = `${stateDirectory}:development`;
    await expect(prepareAgentCliAliases({ aliases: { daynight: "daynight-dev" }, environment, stateDirectory: ambiguousRoot }))
      .rejects.toThrow("agentCliAliases requires DN_CONFIG_DIR without the PATH delimiter");
    await expect(stat(ambiguousRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const disabled = await prepareAgentCliAliases({ aliases: {}, environment, stateDirectory: ambiguousRoot });
    expect(disabled.environment).toBe(environment);
    expect((await execute("/bin/sh", ["-c", "daynight"], { env: disabled.environment })).stdout).toBe("stable\n");
  });

  it.skipIf(process.platform === "win32")("keeps independent preparation directories for active executions", async () => {
    const { bin, stateDirectory, executable } = await fixture(); await executable("daynight-dev", "dev");
    const input = { aliases: { daynight: "daynight-dev" }, environment: { PATH: bin }, stateDirectory };
    const first = await prepareAgentCliAliases(input); const second = await prepareAgentCliAliases(input);
    expect(first.directory).not.toBe(second.directory);
    expect(first.environment.DN_CONFIG_DIR).toBe(stateDirectory);
    expect(await readdir(path.dirname(first.directory!))).toHaveLength(2);
  });
});
