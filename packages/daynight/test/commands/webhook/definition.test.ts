import { describe, expect, it } from "vitest";
import { commandTree } from "../../../src/cli/commands.js";
import { parseCommand, renderCommandHelp } from "../../../src/cli/schema.js";
import { renderBashCompletion } from "../../../src/commands/completion/bash.js";
import { renderZshCompletion } from "../../../src/commands/completion/zsh.js";
import { webhookDefinition } from "../../../src/commands/webhook/definition.js";

const leaves = [
  "catalog", "list", "show", "create", "update", "enable", "disable", "delete",
  "subscription list", "subscription replace", "subscription reconfirm", "secret show", "secret rotate",
  "delivery list", "delivery show", "delivery payload", "delivery redeliver", "attempt list", "operation show",
];

describe("Webhook command definition", () => {
  it("registers the complete namespace and derives help for every leaf", () => {
    expect(commandTree.commands?.find(({ name }) => name === "webhook")).toEqual(webhookDefinition);
    const visit = (node: typeof webhookDefinition, prefix: string[] = []): string[] => node.commands === undefined
      ? [prefix.join(" ")]
      : node.commands.flatMap((child) => visit(child, [...prefix, child.name]));
    expect(visit(webhookDefinition)).toEqual(leaves);
    for (const leaf of leaves) {
      const parsed = parseCommand(commandTree, ["webhook", ...leaf.split(" "), "--help"]);
      expect(parsed.kind).toBe("help");
      const help = renderCommandHelp(parsed.command, parsed.path);
      expect(help).toContain(`Usage: daynight webhook ${leaf}`);
      expect(help).toContain("--json");
      expect(help.includes("--personal")).toBe(leaf !== "catalog");
      expect(help.includes("--team")).toBe(leaf !== "catalog");
    }
  });

  it("declares exact version and write options only where required", () => {
    const rotate = parseCommand(commandTree, ["webhook", "secret", "rotate", "--help"]);
    const help = renderCommandHelp(rotate.command, rotate.path);
    expect(help).toContain("--if-version <config-version>");
    expect(help).toContain("--mode <mode>");
    expect(help).toContain("--resume-operation");
    expect(() => parseCommand(commandTree, ["webhook", "secret", "rotate", "id", "--personal", "--mode", "overlap"])).toThrow("requires --if-version");
    const reconfirm = parseCommand(commandTree, ["webhook", "subscription", "reconfirm", "id", "--personal", "--if-version", "1", "--project", "one", "--project", "two"]);
    expect(reconfirm.kind === "run" && reconfirm.options.get("--project")).toEqual(["one", "two"]);
    expect(() => parseCommand(commandTree, ["webhook", "catalog", "--personal"])).toThrow();
  });

  it("exposes the same namespace and choices to both completion generators", () => {
    const bash = renderBashCompletion(commandTree);
    const zsh = renderZshCompletion(commandTree);
    for (const script of [bash, zsh]) {
      for (const token of ["webhook", "subscription", "reconfirm", "redeliver", "--resume-operation", "--if-generation", "overlap", "immediate"]) expect(script).toContain(token);
    }
  });
});
