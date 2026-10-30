import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { parseAgentCliAliases, readAgentCliAliases } from "../../src/config/agent-cli-aliases.js";

const paths = { stateDirectory: "/state", configFile: "/state/config.yml" };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("agent CLI alias configuration", () => {
  it("disables aliases by default and for an empty mapping", () => {
    expect(parseAgentCliAliases("worker: {}", paths)).toEqual({});
    expect(parseAgentCliAliases("agentCliAliases: {}", paths)).toEqual({});
  });

  it("maps only explicit source names to command names or absolute executable paths", () => {
    const aliases = { daynight: "daynight-dev", dn: "/builds/local dev/daynight-dev" };
    expect(parseAgentCliAliases(stringify({ agentCliAliases: aliases }), paths)).toEqual(aliases);
    expect(parseAgentCliAliases("agentCliAliases: {daynight: dn}", paths)).toEqual({ daynight: "dn" });
  });

  it.each([null, [], "daynight-dev", { git: "git-dev" }, { DAYNIGHT: "daynight-dev" }, { daynight: 1 }, { daynight: "" }, { daynight: "daynight-dev --flag" }, { daynight: "./daynight-dev" }, { daynight: "~/bin/daynight-dev" }, { daynight: "has\nnewline" }, { daynight: "$(whoami)" }])("rejects malformed or out-of-scope aliases %j", value => {
    expect(() => parseAgentCliAliases(stringify({ agentCliAliases: value }), paths)).toThrow("agentCliAliases");
  });

  it("does not reflect rejected values into diagnostics", () => {
    const secret = "SYNTHETIC_SECRET_MUST_NOT_LEAK";
    expect(() => parseAgentCliAliases(stringify({ agentCliAliases: { [secret]: secret } }), paths)).toThrow(/^agentCliAliases supports only daynight and dn command names\.$/);
  });

  it("reads the selected root without creating missing configuration", async () => {
    const base = path.resolve(import.meta.dirname, "../../../../.tmp/alias-config-tests");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(path.join(base, "config-")); directories.push(root);
    const configured = { stateDirectory: root, configFile: path.join(root, "config.yml") };
    expect(await readAgentCliAliases(configured)).toEqual({});
    await writeFile(configured.configFile, "agentCliAliases: {daynight: daynight-dev}");
    expect(await readAgentCliAliases(configured)).toEqual({ daynight: "daynight-dev" });
    await writeFile(configured.configFile, "agentCliAliases: []");
    await expect(readAgentCliAliases(configured)).rejects.toThrow("agentCliAliases");
  });
});
