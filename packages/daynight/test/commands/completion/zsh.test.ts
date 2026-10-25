import { describe, expect, it } from "vitest";
import { commandTree } from "../../../src/cli/commands.js";
import type { CommandDefinition } from "../../../src/cli/schema.js";
import { renderZshCompletion } from "../../../src/commands/completion/zsh.js";
import { taskDefinition } from "../../../src/commands/task/definition.js";

describe("native zsh completion", () => {
  it("offers explicit login and logout with a boolean browser option", () => {
    const script = renderZshCompletion(commandTree);
    expect(script).toContain("'login:Sign in through a browser using a device code'");
    expect(script).toContain("'logout:Revoke the current CLI credential and remove it locally'");
    expect(script).toContain("(--no-browser)--no-browser[Display the authorization link without opening a browser]");
  });

  it.each(["create", "update", "list", "ready"])("completes public platform values for %s", (name) => {
    const script = renderZshCompletion(taskDefinition.commands!.find((command) => command.name === name)!);
    expect(script).toContain(name === "create" || name === "update" ? "--required-platform=" : "--compatible-platform=");
    expect(script).toContain("('\\''windows'\\'' '\\''linux'\\'' '\\''macos'\\'')");
    expect(script.includes("--clear-required-platform[")).toBe(name === "update");
  });

  it.each(["update", "list", "ready"])("completes explicit automatic-execution booleans for %s", (name) => {
    const script = renderZshCompletion(taskDefinition.commands!.find((command) => command.name === name)!);
    expect(script).toContain("--allow-agents");
    expect(script).toContain("('\\''true'\\'' '\\''false'\\'')");
    const create = renderZshCompletion(taskDefinition.commands!.find((command) => command.name === "create")!);
    expect(create).not.toContain("--allow-agents");
  });

  it("offers the server token stdin option without a token value completion", () => {
    const script = renderZshCompletion(commandTree);
    expect(script).toContain("(--server-token-stdin)--server-token-stdin[Read one personal access token from piped stdin]");
    expect(script).not.toContain("--server-token-stdin=");
  });

  it("registers attachment operations below the task command", () => {
    const script = renderZshCompletion(commandTree);
    expect(script).toContain("'attachment:Manage files attached to a task'");
    expect(script).toContain("'put:Upload one local regular file, replacing the same attachment path'");
    expect(script).toContain("'read:Write the attachment'\\''s original bytes to stdout'");
    expect(script).toContain("(--tree)--tree[Display attachment paths as a directory tree]");
    expect(script).toContain("(--path)--path=[Attachment relative path (default\\: source basename)]:relative-path:->text_value");
  });

  it("offers unified status command and three-state filtering without metadata status updates", () => {
    const script = renderZshCompletion(commandTree);
    expect(script).toContain("compdef _daynight 'daynight' 'dn'\n");
    expect(script).toContain("(--status)--status=[Task status]:status:('\\''todo'\\'' '\\''in_progress'\\'' '\\''done'\\'')");
    expect(script).toContain("'set-status:Set a task to todo, in_progress, or done'");
    expect(script).toContain("'delete:Soft-delete a task while preserving its stored data and attachments'");
    const update = renderZshCompletion(taskDefinition.commands!.find(({ name }) => name === "update")!);
    expect(update).not.toContain("--status");
    expect(update).toContain("--if-version");
    expect(update).toContain("--depends-on");
    expect(update).toContain("*--external-depends-on=[External prerequisite UUID; repeat for the complete external set]:task-id:->text_value");
  });

  it("completes deletion with one task ID and exact-version/project text options", () => {
    const script = renderZshCompletion(taskDefinition.commands!.find(({ name }) => name === "delete")!);
    expect(script).toContain("(--if-version)--if-version=[Use this expected task version without reading a newer version]:version:->text_value");
    expect(script).toContain("(--project)--project=[Use this project UUID for this invocation]:project-id:->text_value");
    expect(script).toContain("specifications+=( '1:Task UUID:->argument_1' )");
    expect(script).not.toContain("2:Target task status");
    expect(script).not.toContain("--json");
    expect(script).not.toContain("_files");
  });

  it("completes set-status with a task ID, status choices, and version/project text options", () => {
    const script = renderZshCompletion(taskDefinition.commands!.find(({ name }) => name === "set-status")!);
    expect(script).toContain("(--if-version)--if-version=[Use this expected task version without reading a newer version]:version:->text_value");
    expect(script).toContain("(--project)--project=[Use this project UUID for this invocation]:project-id:->text_value");
    expect(script).toContain("(- *)--help[Show this help]");
    expect(script).toContain("specifications+=( '1:Task UUID:->argument_1' )");
    expect(script).toContain("2:Target task status:->argument_2");
    expect(script).toContain("'todo' 'in_progress' 'done'");
    expect(script).not.toContain("--status");
    expect(script).not.toContain("--json");
    expect(script).not.toContain("_files");
  });

  it("registers the actual command grammar and descriptions with native helpers", () => {
    const script = renderZshCompletion(commandTree);
    expect(script).toContain("compdef _daynight 'daynight' 'dn'\n");
    expect(script).toContain("_arguments -C");
    expect(script).toContain("_describe 'command' commands");
    expect(script).toContain("'review:Review GitHub pull requests and manage local review configuration'");
    expect(script).toContain("'ls:List tracked ongoing PRs and recorded review status'");
    expect(script).toContain("'list'|'ls')");
    expect(script).toContain("'setup:Install completion in shell startup files'");
    expect(script).toContain("(--shell)--shell=[Select the shell instead of detecting the calling shell]:shell:");
    expect(script).toContain("'bash'|'zsh')");
    expect(script).toContain("(--path)--path[Dedicated review clone path (relative to the current directory)]:path:_files -/");
    expect(script).not.toContain("bashcompinit");
    expect(script).not.toContain("eval ");
  });

  it("fails actionably before registering when compinit has not been initialized", () => {
    const script = renderZshCompletion(commandTree);
    const guard = script.indexOf("if (( ! $+functions[compdef] )); then");
    const failure = script.indexOf("return 1", guard);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(script.slice(guard, failure)).toContain("autoload -Uz compinit; compinit");
    expect(failure).toBeLessThan(script.indexOf("compdef _daynight"));
  });

  it("keeps free-form remote arguments separate from directory completion", () => {
    const script = renderZshCompletion({
      name: "daynight",
      description: "Test command",
      arguments: [{ name: "remote", description: "GitHub repository remote" }],
    });
    expect(script).toContain("specifications+=( '1:GitHub repository remote:->argument_1' )");
    expect(script).toContain('if (( positional_count > 0 || expecting_value )) || [[ -n "${(Q)words[CURRENT]}" ]]; then');
    expect(script).not.toContain("_files");
    expect(script).toContain('local -a completion_words=( "${(@)words[1,CURRENT]}" )');
  });

  it("quotes executable names and shell metacharacters while escaping helper specifications", () => {
    const definition: CommandDefinition = {
      name: "day'night\n$(touch forbidden)",
      aliases: ["d'n $HOME `uname` $(touch unsafe):中文"],
      description: "Root",
      commands: [{
        name: "a:b",
        aliases: ["a'b"],
        description: "Keep [brackets]: $HOME and `commands` literal",
        options: [{ names: ["--path"], description: "User's [directory]: $HOME", value: { name: "path", kind: "directory" } }],
      }],
    };
    const script = renderZshCompletion(definition);
    expect(script.startsWith("# Native zsh completion generated by daynight.\n")).toBe(true);
    expect(script).toContain("compdef _daynight 'day'\\''night\n$(touch forbidden)' 'd'\\''n $HOME `uname` $(touch unsafe):中文'\n");
    expect(script).toContain("'a\\:b:Keep [brackets]\\: $HOME and `commands` literal'");
    expect(script).toContain("'a'\\''b'");
    expect(script).toContain("User'\\''s \\[directory\\]\\: $HOME");
  });

  it("uses an explicit no-candidate state for named text values", () => {
    const script = renderZshCompletion({
      name: "tool",
      description: "",
      options: [{ names: ["--name"], description: "Name", value: { name: "name", kind: "text" }, required: true }],
    });
    expect(script).toContain("(--name)--name=[Name]:name:->text_value");
    expect(script).toContain('text_value)\n      _message "$state_descr"\n      return 0');
    expect(script).not.toContain("_files");
  });

  it("enables native option termination only for a declaring command", () => {
    const script = renderZshCompletion({ name: "tool", description: "", allowOptionsTerminator: true, arguments: [{ name: "name", description: "Name" }] });
    expect(script).toContain('_arguments -C -S "${specifications[@]}"');
    expect(script).toContain('if [[ "$word" == -- ]]; then');
    expect(script).toContain('if (( options_terminated )); then');
    expect(renderZshCompletion({ name: "tool", description: "" })).not.toContain("_arguments -C -S");
  });

  it("uses native inline choices and repeatable specifications without self-exclusion", () => {
    const script = renderZshCompletion({ name: "tool", description: "", options: [
      { names: ["--status"], description: "Status", value: { name: "status", kind: "text", choices: ["todo", "done"] } },
      { names: ["--depends-on"], description: "Dependency", value: { name: "task", kind: "text" }, repeatable: true },
      { names: ["--description"], description: "Description", value: { name: "description", kind: "text", allowEmpty: true } },
    ] });
    expect(script).toContain("(--status)--status=[Status]:status:('\\''todo'\\'' '\\''done'\\'')");
    expect(script).toContain("*--depends-on=[Dependency]:task:->text_value");
    expect(script).not.toContain("(--depends-on)");
    expect(script).toContain("option_value=\"${word#*=}\"");
    expect(script).toContain("'--status='*");
  });
});
