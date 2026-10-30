import { describe, expect, it } from "vitest";
import { commandTree } from "../../src/cli/commands.js";
import { UsageError } from "../../src/cli/context.js";
import { parseCommand, renderCommandHelp } from "../../src/cli/schema.js";
import type { CommandDefinition } from "../../src/cli/schema.js";
import { taskDefinition } from "../../src/commands/task/definition.js";

describe("shared command syntax", () => {
  it.each([
    { args: [], name: "daynight" },
    { args: ["--help"], name: "daynight" },
    { args: ["review"], name: "review" },
    { args: ["review", "ls", "-h"], name: "list" },
    { args: ["update", "--help"], name: "update" },
    { args: ["completion", "--help"], name: "completion" },
    { args: ["completion"], name: "completion" },
    { args: ["completion", "setup", "--help"], name: "setup" },
    { args: ["completion", "bash", "--help"], name: "bash" },
  ])("resolves the declared help command for $args", ({ args, name }) => {
    const parsed = parseCommand(commandTree, args);
    expect(parsed.kind).toBe("help");
    expect(parsed.command.name).toBe(name);
  });

  it("resolves aliases to their canonical execution command", () => {
    const parsed = parseCommand(commandTree, ["review", "ls"]);
    expect(parsed.kind).toBe("run");
    expect(parsed.path).toEqual(["daynight", "review", "list"]);
    expect(parsed.command.name).toBe("list");
  });

  it.each([
    ["review", "add-repo", "git@github.com:o/r", "--path", "./new directory 用户"],
    ["review", "add-repo", "--path", "./new directory 用户", "git@github.com:o/r"],
  ])("consumes directory options on either side of required arguments: %j", (...args) => {
    const parsed = parseCommand(commandTree, args);
    expect(parsed.kind).toBe("run");
    if (parsed.kind !== "run") throw new Error("Expected executable command");
    expect(parsed.values).toEqual(["git@github.com:o/r"]);
    expect([...parsed.options]).toEqual([["--path", "./new directory 用户"]]);
  });

  it.each([" ", "\n", "./new\nline", "./a'\"$` directory"])("preserves a nonempty directory value verbatim: %j", (directory) => {
    const parsed = parseCommand(commandTree, ["review", "add-repo", "--path", directory, "remote"]);
    expect(parsed.kind === "run" && parsed.options.get("--path")).toBe(directory);
  });

  it.each([
    ["--help", "review"],
    ["review", "--version"],
    ["review", "run", "--help", "extra"],
    ["review", "ls", "-h", "extra"],
    ["review", "add-repo"],
    ["review", "add-repo", "remote", "extra"],
    ["review", "add-repo", "remote", "--path"],
    ["review", "add-repo", "remote", "--path", ""],
    ["review", "add-repo", "remote", "--path", "--help"],
    ["review", "add-repo", "remote", "--path", "one", "--path", "two"],
    ["review", "add-repo", "remote", "--path=directory"],
    ["review", "add-repo", "--", "remote"],
    ["review", "add-repo", "remote", "--help"],
    ["review", "add-repo", "-h", "remote"],
    ["completion", "fish"],
    ["completion", "bash", "zsh"],
  ])("rejects syntax outside the declared grammar: %j", (...args) => {
    expect(() => parseCommand(commandTree, args)).toThrow(UsageError);
  });

  it.each([" ", "\n", "\ufeff", "\u0085"])("leaves positional text semantics to its command owner: %j", (value) => {
    const parsed = parseCommand(commandTree, ["review", "add-repo", value]);
    expect(parsed.kind === "run" && parsed.values).toEqual([value]);
  });

  it.each([
    { args: ["project", "create", "Name 中文", "--repo", "remote"], name: "Name 中文" },
    { args: ["project", "create", "--repo", "remote", "Name 中文"], name: "Name 中文" },
    { args: ["project", "create", "--repo", "remote", "--", "-leading"], name: "-leading" },
    { args: ["project", "create", "--repo", "remote", "--", "--help"], name: "--help" },
  ])("parses positional project names with explicitly enabled option termination: $args", ({ args, name }) => {
    const parsed = parseCommand(commandTree, args);
    expect(parsed.kind === "run" && parsed.values).toEqual([name]);
    expect(parsed.kind === "run" && [...parsed.options]).toEqual([["--repo", "remote"]]);
  });

  it.each([
    ["project", "create", "--name", "Name", "--repo", "remote"],
    ["project", "create", "Name", "extra", "--repo", "remote"],
    ["project", "create", "--repo", "remote", "-leading"],
    ["project", "create", "--", "Name", "--repo", "remote"],
    ["project", "create", "--repo", "remote", "--"],
    ["project", "create", "--repo", "remote", "--", ""],
    ["task", "show", "--", "task-id"],
  ])("rejects removed project flags and undeclared termination: %j", (...args) => {
    expect(() => parseCommand(commandTree, args)).toThrow(UsageError);
  });

  it.each(["bash", "zsh"])("accepts the declared %s shell choice", (shell) => {
    const parsed = parseCommand(commandTree, ["completion", shell]);
    expect(parsed.kind === "run" && parsed.command.name).toBe(shell);
  });

  it("keeps version handling local to the root definition", () => {
    expect(parseCommand(commandTree, ["-v"]).kind).toBe("version");
    expect(() => parseCommand(commandTree, ["update", "-v"])).toThrow(UsageError);
  });

  it("uses the complete canonical command path on nested syntax errors", () => {
    const review = commandTree.commands!.find(({ name }) => name === "review")!;
    try {
      parseCommand(review, ["add-repo", "remote", "--path"], ["daynight", "review"], "daynight review --help");
      throw new Error("Expected a usage error");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toBe("--path requires a path value.");
      expect((error as UsageError).helpCommand).toBe("daynight review add-repo --help");
    }
  });

  it("parses three-level attachment commands and terminates options for dash-prefixed paths", () => {
    const parsed = parseCommand(commandTree, ["task", "attachment", "read", "task-id", "--", "-draft.md"]);
    expect(parsed.kind).toBe("run");
    expect(parsed.path).toEqual(["daynight", "task", "attachment", "read"]);
    expect(parsed.kind === "run" && parsed.values).toEqual(["task-id", "-draft.md"]);
    const help = parseCommand(commandTree, ["task", "attachment", "put", "--help"]);
    expect(renderCommandHelp(help.command, help.path)).toContain("Usage: daynight task attachment put <task-id> <file>");
    try {
      parseCommand(commandTree, ["task", "attachment", "list", "task-id", "--unknown"]);
      throw new Error("Expected a usage error");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toContain("daynight task attachment list");
      expect((error as UsageError).helpCommand).toBe("daynight task attachment list --help");
    }
  });

  it("takes syntax and help from the supplied definition", () => {
    const definition: CommandDefinition = {
      name: "example",
      description: "An example command",
      aliases: ["e"],
      arguments: [{ name: "mode", description: "Select a mode", choices: ["left", "right"] }],
      options: [{ names: ["--directory", "-d"], description: "Select a directory", value: { name: "destination", kind: "directory" } }],
      details: "A nonexistent destination remains a valid directory value.",
    };
    const parsed = parseCommand(definition, ["-d", "not-created", "left"]);
    expect(parsed.kind === "run" && [...parsed.options]).toEqual([["--directory", "not-created"]]);
    expect(() => parseCommand(definition, ["center"])).toThrow('Unknown mode "center". Expected left or right.');
    expect(() => parseCommand(definition, ["left", "-d", "one", "--directory", "two"])).toThrow("Specify --directory only once.");
    const help = renderCommandHelp(definition);
    expect(help).toContain("Usage: example <mode> [--directory <destination>]");
    expect(help).toContain("       e <mode>");
    expect(help).toContain("Select a mode");
    expect(help).toContain("Select a directory");
    expect(help).toContain(definition.details);
  });

  const textDefinition: CommandDefinition = {
    name: "create",
    description: "Create a resource",
    options: [
      { names: ["--name", "-n"], description: "Resource name", value: { name: "name", kind: "text" }, required: true },
      { names: ["--repo"], description: "Repository", value: { name: "repo", kind: "text" }, required: true },
      { names: ["--json"], description: "JSON" },
      { names: ["--help"], description: "Help", action: "help" },
    ],
  };

  it.each(["Name 中文", "\uFEFF", "\uFEFF\u0085", " name\n", "'\"$` value"])("preserves named text without trimming: %j", (name) => {
    const parsed = parseCommand(textDefinition, ["--repo", "git@host:Org/Repo.git", "-n", name]);
    expect(parsed.kind === "run" && [...parsed.options]).toEqual([["--repo", "git@host:Org/Repo.git"], ["--name", name]]);
  });

  it.each([
    [], ["--name", "name"], ["--repo", "repo"],
    ["--name"], ["--name", ""], ["--name", "--repo", "repo"],
    ["--name", "name", "--repo"], ["--name", "name", "--repo", ""],
    ["--name", "name", "--repo", "--json"],
    ["--name", "name", "--repo", "repo", "-n", "duplicate"],
  ])("rejects incomplete required named text before execution: %j", (...args) => {
    expect(() => parseCommand(textDefinition, args)).toThrow(UsageError);
  });

  it("renders required named values without brackets and permits help without values", () => {
    expect(renderCommandHelp(textDefinition)).toContain("Usage: create --name <name> --repo <repo> [--json]");
    expect(parseCommand(textDefinition, ["--help"]).kind).toBe("help");
  });

  it.each(["", "-leading", "=a=b", "\uFEFF"])("preserves inline descriptions split at only the first equals sign: %j", (description) => {
    const parsed = parseCommand(taskDefinition, ["create", "--title=Title", `--description=${description}`]);
    expect(parsed.kind === "run" && parsed.options.get("--description")).toBe(description);
  });

  it("keeps repeatable values as ordered arrays from their first occurrence", () => {
    const first = parseCommand(taskDefinition, ["create", "--title", "Title", "--depends-on", "a"]);
    expect(first.kind === "run" && first.options.get("--depends-on")).toEqual(["a"]);
    const repeated = parseCommand(taskDefinition, ["create", "--title", "Title", "--depends-on=a", "--depends-on", "b", "--depends-on=a"]);
    expect(repeated.kind === "run" && repeated.options.get("--depends-on")).toEqual(["a", "b", "a"]);
  });

  it("allows separate empty descriptions while keeping ordinary text scalar", () => {
    const parsed = parseCommand(taskDefinition, ["update", "task-id", "--description", "", "--title", "Title"]);
    expect(parsed.kind === "run" && [...parsed.options]).toEqual([["--description", ""], ["--title", "Title"]]);
  });

  it.each(["todo", "in_progress", "done"])("accepts exact status choices in separate and inline values: %s", (status) => {
    for (const args of [["list", "--status", status], ["list", `--status=${status}`]]) {
      const parsed = parseCommand(taskDefinition, args);
      expect(parsed.kind === "run" && parsed.options.get("--status")).toBe(status);
    }
  });

  it.each([false, true])("accepts optional valueless deletion consent %s", (removeDepends) => {
    const parsed = parseCommand(taskDefinition, ["delete", "task-id", ...(removeDepends ? ["--remove-depends"] : [])]);
    expect(parsed.kind === "run" && parsed.options.has("--remove-depends")).toBe(removeDepends);
    const definition = taskDefinition.commands!.find(({ name }) => name === "delete")!;
    expect(renderCommandHelp(definition, ["daynight", "task", "delete"])).toContain("[--remove-depends]");
  });

  it.each([
    ["create", "--title="], ["create", "--title", "-leading"],
    ["create", "--title", "Title", "--description"],
    ["create", "--title", "Title", "--description", "--status"],
    ["list", "--status=proposed"], ["set-status", "task-id", "proposed"], ["list", "--status=TODO"], ["list", "--status", "invalid"], ["list", "--status="],
    ["delete", "task-id", "--remove-depends=true"], ["delete", "task-id", "--remove-depends=false"],
    ["delete", "task-id", "--remove-depends", "true"], ["delete", "task-id", "--remove-depends", "--remove-depends"],
    ["list", "--ready=true"], ["list", "--help=true"],
    ["create", "--title=Title", "--depends-on="],
    ["update", "task-id", "--status=todo", "--status", "done"],
  ])("rejects invalid inline, empty, duplicate, and choice syntax: %j", (...args) => {
    expect(() => parseCommand(taskDefinition, args)).toThrow(UsageError);
  });

  it("renders repeatable dependencies and keeps help independent of task requirements", () => {
    const create = taskDefinition.commands!.find(({ name }) => name === "create")!;
    expect(renderCommandHelp(create, ["daynight", "task", "create"])).toContain("[--depends-on <task-id>...]");
    expect(parseCommand(taskDefinition, ["create", "--help"]).kind).toBe("help");
    expect(parseCommand(taskDefinition, []).kind).toBe("help");
  });

  it("supports trailing optional arguments and renders their optionality", () => {
    const definition: CommandDefinition = { name: "inspect", description: "Inspect", arguments: [{ name: "first", description: "Required" }, { name: "second", description: "Optional", optional: true }, { name: "third", description: "Optional", optional: true }] };
    for (const values of [["one"], ["one", "two"], ["one", "two", "three"]]) expect(parseCommand(definition, values)).toMatchObject({ kind: "run", values });
    expect(() => parseCommand(definition, [])).toThrow("requires a first value");
    expect(() => parseCommand(definition, ["one", "two", "three", "four"])).toThrow("Unexpected");
    expect(renderCommandHelp(definition)).toContain("Usage: inspect <first> [<second>] [<third>]");
  });

  it("rejects a required argument after an optional argument in the definition", () => {
    const definition: CommandDefinition = { name: "invalid", description: "", arguments: [{ name: "optional", description: "", optional: true }, { name: "required", description: "" }] };
    expect(() => parseCommand(definition, ["one", "two"])).toThrow("required argument after an optional argument");
    expect(() => renderCommandHelp(definition)).toThrow("required argument after an optional argument");
  });

  it("declares the two properties modes without making the task ID always required", () => {
    expect(parseCommand(taskDefinition, ["properties", "--schema"])).toMatchObject({ kind: "run", values: [] });
    expect(parseCommand(taskDefinition, ["properties", "task-id"])).toMatchObject({ kind: "run", values: ["task-id"] });
    const definition = taskDefinition.commands!.find(({ name }) => name === "properties")!;
    expect(renderCommandHelp(definition, ["daynight", "task", "properties"])).toContain("Usage: daynight task properties [<task-id>]");
  });

  it.each(["", "  ", "\n", '"hello"', '{"number":1e3}'])("preserves explicitly allowed empty or raw property text: %j", (value) => {
    expect(parseCommand(taskDefinition, ["set-property", "task-id", "future", value])).toMatchObject({ kind: "run", values: ["task-id", "future", value] });
  });

  it.each(["-123", "-text", "--help"])("passes terminated property values without interpreting them: %j", (value) => {
    expect(parseCommand(taskDefinition, ["set-property", "--if-version", "42", "task-id", "future", "--", value])).toMatchObject({ kind: "run", values: ["task-id", "future", value] });
  });

  it.each([
    ["set-property", "task-id", "future"], ["set-property", "task-id", "", "value"],
    ["remove-property", "task-id"], ["remove-property", "task-id", ""],
    ["create", "--title", "Title", "--pull-request-url", "url"],
    ["create", "--title", "Title", "--pull-request-title", "title"],
    ["update", "task-id", "--clear-pull-requests"],
  ])("rejects missing generic property arguments and removed PR flags: %j", (...args) => {
    expect(() => parseCommand(taskDefinition, args)).toThrow(UsageError);
  });

});
