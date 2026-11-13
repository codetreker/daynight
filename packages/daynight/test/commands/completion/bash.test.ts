import { describe, expect, it } from "vitest";
import { renderBashCompletion } from "../../../src/commands/completion/bash.js";
import { commandTree } from "../../../src/cli/commands.js";
import type { CommandDefinition } from "../../../src/cli/schema.js";
import { taskDefinition } from "../../../src/commands/task/definition.js";

describe("Bash completion rendering", () => {
  it("offers the standalone root skill flag without a value state", () => {
    const script = renderBashCompletion(commandTree);
    expect(script).toContain("dn_options=('--skill' '-h' '--help' '-v' '--version')");
    expect(script).toContain("dn_option_values=('' '' '' '' '')");
    expect(script).toContain("dn_option_actions=('skill' 'help' 'help' 'version' 'version')");
  });

  it("offers explicit login and logout with a boolean browser option", () => {
    const script = renderBashCompletion(commandTree);
    expect(script).toContain("'login' 'logout'");
    expect(script).toContain("dn_options=('--no-browser' '-h' '--help')");
  });

  it.each(["create", "update", "list", "ready"])("completes public platform values for %s", (name) => {
    const script = renderBashCompletion(taskDefinition.commands!.find((command) => command.name === name)!);
    expect(script).toContain(name === "create" || name === "update" ? "'--required-platform'" : "'--compatible-platform'");
    expect(script).toContain("dn_value_choices=('windows' 'linux' 'macos')");
    expect(script.includes("'--clear-required-platform'")).toBe(name === "update");
  });

  it.each(["update", "list", "ready"])("completes explicit automatic-execution booleans for %s", (name) => {
    const script = renderBashCompletion(taskDefinition.commands!.find((command) => command.name === name)!);
    expect(script).toContain("'--allow-agents'");
    expect(script).toContain("dn_value_choices=('true' 'false')");
    const create = renderBashCompletion(taskDefinition.commands!.find((command) => command.name === "create")!);
    expect(create).not.toContain("'--allow-agents'");
  });

  it("registers both installed command names with the same completion function", () => {
    expect(renderBashCompletion(commandTree)).toContain("complete -F _daynight_completion 'daynight' 'dn'\n");
  });

  it("omits the removed top-level setup command and its options", () => {
    expect(commandTree.commands!.some(({ name }) => name === "setup")).toBe(false);
    const script = renderBashCompletion(commandTree);
    expect(script).not.toContain("'--server-url'");
    expect(script).not.toContain("'--server-token-stdin'");
    expect(script).not.toContain("'--review-repo'");
    expect(script).not.toContain("'--review-path'");
    expect(script).toContain("dn_children=('bash' 'zsh' 'setup')");
  });

  it("registers all three attachment command levels and operation options", () => {
    const script = renderBashCompletion(commandTree);
    expect(script).toContain("'attachment'");
    expect(script).toContain("dn_children=('put' 'list' 'read' 'remove')");
    expect(script).toContain("dn_options=('--path' '--project' '-h' '--help')");
    expect(script).toContain("dn_options=('--tree' '--project' '--json' '-h' '--help')");
  });

  it("offers unified status command and Task status filtering without metadata status updates", () => {
    const script = renderBashCompletion(commandTree);
    expect(script).toContain("complete -F _daynight_completion 'daynight' 'dn'\n");
    expect(script).toContain("dn_children=('session' 'create' 'list' 'search' 'ready' 'show' 'properties' 'set-property' 'remove-property' 'update' 'tag' 'set-status' 'delete' 'graph' 'step' 'thread' 'attachment')");
    expect(script).toContain("dn_value_choices=('proposed' 'todo' 'in_progress' 'done' 'cancelled')");
    const update = renderBashCompletion(taskDefinition.commands!.find(({ name }) => name === "update")!);
    expect(update).not.toContain("'--status'");
    expect(update).toContain("'--if-version'");
    expect(update).toContain("'--depends-on'");
    expect(update).toContain("'--external-depends-on'");
  });

  it("discovers delivered Step commands with separate operation options", () => {
    const step = taskDefinition.commands!.find(({ name }) => name === "step")!;
    const script = renderBashCompletion(step);
    expect(script).toContain("dn_children=('list' 'show' 'add' 'update' 'set-status' 'move' 'delete')");
    const list = renderBashCompletion(step.commands!.find(({ name }) => name === "list")!);
    expect(list).toContain("dn_options=('--project' '--json' '-h' '--help')");
    expect(list).not.toContain("'--if-version'");
    const add = renderBashCompletion(step.commands!.find(({ name }) => name === "add")!);
    expect(add).toContain("'--id' '--before' '--after' '--if-version'");
    expect(add).toContain("dn_value_choices=('todo' 'in_progress' 'done' 'skipped')");
    const status = renderBashCompletion(step.commands!.find(({ name }) => name === "set-status")!);
    expect(status).toContain("dn_choices=('todo' 'in_progress' 'done' 'skipped')");
    const update = renderBashCompletion(step.commands!.find(({ name }) => name === "update")!);
    expect(update).toContain("'--title' '--description' '--if-version'");
    expect(update).not.toContain("'--status'");
    const move = renderBashCompletion(step.commands!.find(({ name }) => name === "move")!);
    expect(move).toContain("'--before' '--after' '--first' '--last' '--if-version'");
    const remove = renderBashCompletion(step.commands!.find(({ name }) => name === "delete")!);
    expect(remove).toContain("'--if-version'");
    expect(remove).toContain("'--project'");
    expect(remove).toContain("'--json'");
    expect(remove).not.toContain("'--title'");
  });

  it("discovers Thread read/post options through the registered command tree", () => {
    const thread = taskDefinition.commands!.find(({ name }) => name === "thread")!;
    const script = renderBashCompletion(thread);
    expect(script).toContain("dn_children=('read' 'post')");
    expect(script).toContain("dn_options=('--before-id' '--after-id' '--count' '--details' '--project' '-h' '--help')");
    expect(script).toContain("dn_options=('--body' '--reply-to' '--claim-id' '--project' '-h' '--help')");
    expect(script).not.toContain("'--json'");
  });

  it("completes deletion with a task ID and exact-version/project text options", () => {
    const script = renderBashCompletion(taskDefinition.commands!.find(({ name }) => name === "delete")!);
    expect(script).toContain("dn_options=('--remove-depends' '--force' '--if-version' '--project' '-h' '--help')");
    expect(script).toContain("dn_option_values=('' '' 'text' 'text' '' '')");
    expect(script).toContain("dn_argument_count=1");
    expect(script).not.toContain("'--status'");
    expect(script).not.toContain("'--json'");
  });

  it("completes set-status with task/status arguments and claim/version/project text options", () => {
    const script = renderBashCompletion(taskDefinition.commands!.find(({ name }) => name === "set-status")!);
    expect(script).toContain("dn_options=('--claim-id' '--force' '--if-version' '--project' '-h' '--help')");
    expect(script).toContain("dn_option_values=('text' '' 'text' 'text' '' '')");
    expect(script).toContain("dn_option_actions=('' '' '' '' 'help' 'help')");
    expect(script).toContain("dn_option_repeats=('0' '0' '0' '0' '0' '0')");
    expect(script).toContain("dn_argument_count=2");
    expect(script).toContain("dn_choices=('proposed' 'todo' 'in_progress' 'done' 'cancelled')");
    expect(script).not.toContain("'--status'");
    expect(script).not.toContain("'--json'");
  });

  it("renders the supplied command tree, aliases, option identity, and argument choices", () => {
    const definition: CommandDefinition = {
      name: "tool",
      aliases: ["t"],
      description: "Example command",
      commands: [{
        name: "inspect",
        aliases: ["show"],
        description: "Inspect a resource",
        options: [
          { names: ["-d", "--directory"], description: "Directory", value: { name: "path", kind: "directory" } },
          { names: ["--help"], description: "Help", action: "help" },
        ],
        arguments: [{ name: "format", description: "Output format", choices: ["json", "text"] }],
      }],
    };

    const script = renderBashCompletion(definition);
    expect(script).toContain("complete -F _tool_completion 'tool' 't'\n");
    expect(script).toContain("dn_children=('inspect' 'show')");
    expect(script).toContain("dn_child_nodes=('1' '1')");
    expect(script).toContain("dn_options=('-d' '--directory' '--help')");
    expect(script).toContain("dn_option_ids=('0' '0' '1')");
    expect(script).toContain("dn_option_values=('directory' 'directory' '')");
    expect(script).toContain("dn_option_actions=('' '' 'help')");
    expect(script).toContain("dn_choices=('json' 'text')");
    expect(script).not.toContain("review");
  });

  it("quotes every command, alias, option, and fixed candidate as shell data", () => {
    const value = "a'b $HOME `uname` $(touch unsafe):中文";
    const quoted = "'a'\\''b $HOME `uname` $(touch unsafe):中文'";
    const script = renderBashCompletion({
      name: "tool",
      aliases: [value],
      description: "",
      commands: [{
        name: value,
        aliases: ["another'alias"],
        description: "A description need not become executable shell code",
        options: [{ names: [value], description: "" }],
        arguments: [{ name: "choice", description: "", choices: [value] }],
      }],
    });

    expect(script).toContain(`dn_children=(${quoted} 'another'\\''alias')`);
    expect(script).toContain(`dn_options=(${quoted})`);
    expect(script).toContain(`dn_choices=(${quoted})`);
    expect(script).toContain(`complete -F _tool_completion 'tool' ${quoted}\n`);
    expect(script).not.toContain("A description need not become executable shell code");
  });

  it("guards the Bash baseline before defining or registering completion", () => {
    const script = renderBashCompletion({ name: "tool", description: "" });
    const guard = script.indexOf("BASH_VERSINFO[1] < 2");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(script.indexOf("_tool_completion_words()"));
    expect(script).toContain("return 1 2>/dev/null || exit 1");
    expect(script).not.toContain("COMP_WORDBREAKS=");
    expect(script).not.toMatch(/\beval\b/);
  });

  it("preserves replacement metacharacters and generator markers in metadata", () => {
    const script = renderBashCompletion({
      name: "tool",
      description: "",
      arguments: [{ name: "choice", description: "", choices: ["$&", "$'", "@COMMAND@", "@PREFIX@", "@{"] }],
    });
    expect(script).toContain("dn_choices=('$&' '$'\\''' '@COMMAND@' '@PREFIX@' '@{')");
    expect(script).toContain("complete -F _tool_completion 'tool'");
  });

  it("consumes text values without file or option candidates", () => {
    const script = renderBashCompletion({
      name: "tool",
      description: "",
      options: [{ names: ["--name"], description: "Name", value: { name: "name", kind: "text" }, required: true }],
    });
    expect(script).toContain("dn_option_values=('text')");
    const noTextCandidates = script.indexOf('if [[ "$dn_pending" == text ]]; then');
    expect(noTextCandidates).toBeGreaterThan(0);
    expect(noTextCandidates).toBeLessThan(script.indexOf('if [[ "$dn_pending" == directory ]]'));
  });

  it("derives option termination from the command definition", () => {
    const script = renderBashCompletion({ name: "tool", description: "", allowOptionsTerminator: true, arguments: [{ name: "name", description: "Name" }] });
    expect(script).toContain("dn_allow_terminator=1");
    expect(script).toContain('if ((!dn_options_terminated && dn_allow_terminator)) && [[ "$dn_word" == -- ]]');
    expect(script).toContain("((dn_options_terminated)) && return 0");
    expect(renderBashCompletion({ name: "tool", description: "" })).toContain("dn_allow_terminator=0");
  });

  it("retains repeat and empty metadata and separates named static choices", () => {
    const script = renderBashCompletion({ name: "tool", description: "", options: [
      { names: ["--status"], description: "", value: { name: "status", kind: "text", choices: ["todo", "done"] } },
      { names: ["--depends-on"], description: "", value: { name: "task", kind: "text" }, repeatable: true },
      { names: ["--description"], description: "", value: { name: "description", kind: "text", allowEmpty: true } },
    ] });
    expect(script).toContain("dn_option_repeats=('0' '1' '0')");
    expect(script).toContain("dn_option_empty=('0' '0' '1')");
    expect(script).toContain("0) dn_value_choices=('todo' 'done')");
    expect(script).toContain('dn_current="${dn_current#*=}"');
    expect(script).toContain('dn_fragment="${COMP_WORDS[COMP_CWORD]}"');
    expect(script).not.toContain("COMP_WORDBREAKS=");
  });

  it("carries generic property syntax and allowed empty positional values", () => {
    const script = renderBashCompletion(commandTree);
    expect(script).toContain("'properties' 'set-property' 'remove-property'");
    expect(script).toContain("dn_options=('--schema' '--project' '--json' '-h' '--help')");
    const set = renderBashCompletion(taskDefinition.commands!.find(({ name }) => name === "set-property")!);
    expect(set).toContain("dn_argument_count=3");
    expect(set).toContain("dn_argument_empty=('0' '0' '1')");
    expect(set).toContain('"${dn_argument_empty[dn_position]}" == 1');
    expect(set).toContain("dn_allow_terminator=1");
    expect(set).toContain("dn_choices=()");
    expect(script).not.toContain("--pull-request-url");
    expect(script).not.toContain("--pull-request-title");
    expect(script).not.toContain("--clear-pull-requests");
  });

  it("rejects ambiguous optional argument definitions", () => {
    expect(() => renderBashCompletion({ name: "invalid", description: "", arguments: [{ name: "a", description: "", optional: true }, { name: "b", description: "" }] })).toThrow("required argument after an optional argument");
  });

});
