import { validateCommandArguments, type CommandDefinition, type CommandOption } from "../../cli/schema.js";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const escapeSpecification = (value: string): string => value.replaceAll(/([\\\[\]:])/g, "\\$1");
const escapeDescription = (value: string): string => value.replaceAll(/([\\:])/g, "\\$1");

const optionSpecifications = (option: CommandOption): readonly string[] => {
  const exclusions = option.action === undefined ? option.names.map(escapeSpecification).join(" ") : "- *";
  const action = option.value?.choices === undefined ? "->text_value" : `(${option.value.choices.map(quote).join(" ")})`;
  const value = option.value === undefined
    ? ""
    : `:${escapeSpecification(option.value.name)}:${option.value.kind === "directory" ? "_files -/" : action}`;
  return option.names.map((name) => `${option.repeatable === true ? "*" : `(${exclusions})`}${escapeSpecification(name)}${option.value?.kind === "text" ? "=" : ""}[${escapeSpecification(option.description)}]${value}`);
};

const valueValidation = (option: CommandOption, variable: string, indentation: string): string => [
  option.value?.allowEmpty === true ? "" : `${indentation}[[ -n "$${variable}" ]] || return 1`,
  option.value?.choices === undefined ? "" : `${indentation}case "$${variable}" in\n${indentation}  ${option.value.choices.map(quote).join("|")}) ;;\n${indentation}  *) return 1 ;;\n${indentation}esac`,
].filter((line) => line !== "").join("\n");

// _arguments tolerates unknown options and excess positionals; completion must retain the CLI's grammar.
const renderPrefixValidation = (command: CommandDefinition): string => {
  validateCommandArguments(command);
  if (command.commands !== undefined) {
    const names = command.commands.flatMap((child) => [child.name, ...(child.aliases ?? [])]);
    return `  if (( CURRENT > 2 )); then
    case "\${(Q)words[2]}" in
      ${names.map(quote).join("|")}) ;;
      *) return 1 ;;
    esac
  fi
`;
  }

  const options = command.options?.filter((option) => option.action === undefined) ?? [];
  const arguments_ = command.arguments ?? [];
  const positionalValidation = arguments_.length === 0 ? "          return 1" : `          case "$positional_count" in
${arguments_.map((argument, index) => `            ${index})
${argument.allowEmpty === true ? "" : `              [[ -n "$word" ]] || return 1\n`}${argument.choices === undefined ? "" : `              case "$word" in
                ${argument.choices.map(quote).join("|")}) ;;
                *) return 1 ;;
              esac\n`}              ;;`).join("\n")}
            *) return 1 ;;
          esac
          (( positional_count++ ))`;
  return `  local word option_value
  local positional_count=0 expecting_value=0 options_terminated=0${options.map((_, index) => ` option_${index}=0`).join("")}
  if (( CURRENT > 2 )); then
    for word in "\${(@)words[2,CURRENT-1]}"; do
      word="\${(Q)word}"
      if (( expecting_value )); then
        [[ "$word" == -* ]] && return 1
        case "$expecting_value" in
${options.flatMap((option, index) => option.value === undefined ? [] : [`          ${index + 1})
${valueValidation(option, "word", "            ")}
            ;;`]).join("\n")}
        esac
        expecting_value=0
        continue
      fi
${command.allowOptionsTerminator === true ? `      if (( options_terminated )); then
${positionalValidation}
        continue
      fi
      if [[ "$word" == -- ]]; then
        options_terminated=1
        continue
      fi
` : ""}      case "$word" in
${options.map((option, index) => `        ${option.names.flatMap((name) => [quote(name), ...(option.value?.kind === "text" ? [`${quote(`${name}=`)}*`] : [])]).join("|")})
${option.repeatable === true ? "" : `          (( option_${index} )) && return 1\n`}          option_${index}=1${option.value === undefined ? "" : `
          if [[ "$word" == *=* ]]; then
            option_value="\${word#*=}"
${valueValidation(option, "option_value", "            ")}
          else expecting_value=${index + 1}; fi`}
          ;;`).join("\n")}
        -*) return 1 ;;
        *)
${positionalValidation}
          ;;
      esac
    done
  fi
`;
};

export const renderZshCompletion = (root: CommandDefinition): string => {
  const functions: string[] = [];
  let nextIdentifier = 0;

  const renderCommand = (command: CommandDefinition): string => {
    const functionName = `_daynight_command_${nextIdentifier++}`;
    const children = command.commands?.map((child) => ({ command: child, functionName: renderCommand(child) })) ?? [];
    const specifications = command.options?.filter((option) => option.action === undefined).flatMap(optionSpecifications) ?? [];
    const informationOptions = command.options?.filter((option) => option.action !== undefined).flatMap(optionSpecifications) ?? [];
    const states: string[] = [];
    const freeformSpecifications: string[] = [];
    if (command.options?.some((option) => option.value?.kind === "text") === true) {
      states.push(`    text_value)
      _message "$state_descr"
      return 0
      ;;`);
    }

    if (children.length !== 0) {
      specifications.push("1:command:->command", "*::arguments:->arguments");
      const descriptions = children.flatMap(({ command: child }) => [child.name, ...(child.aliases ?? [])]
        .map((name) => quote(`${escapeDescription(name)}:${escapeDescription(child.description)}`)));
      states.push(`    command)
      local -a commands=(
${descriptions.map((description) => `        ${description}`).join("\n")}
      )
      _describe 'command' commands && result=0
      ;;`, `    arguments)
      case "\${(Q)line[1]}" in
${children.map(({ command: child, functionName: childFunction }) => `        ${[child.name, ...(child.aliases ?? [])].map(quote).join("|")}) ${childFunction} && result=0 ;;`).join("\n")}
      esac
      ;;`);
    } else {
      for (const [index, argument] of (command.arguments ?? []).entries()) {
        const state = `argument_${index + 1}`;
        const specification = `${index + 1}${argument.optional === true ? "::" : ":"}${escapeSpecification(argument.description)}:->${state}`;
        if (argument.choices === undefined) {
          // zsh hides options beside a positional state unless the option prefix is present.
          // An unstarted free-form value has no candidates, so omit its state until needed.
          // https://zsh.sourceforge.io/Doc/Release/Completion-System.html (prefix-needed)
          freeformSpecifications.push(`  if (( positional_count > ${index} || expecting_value )) || [[ -n "\${(Q)words[CURRENT]}" ]]; then
    specifications+=( ${quote(specification)} )
  fi`);
        } else {
          specifications.push(specification);
          states.push(`    ${state})
      local -a choices=( ${argument.choices.map((choice) => quote(escapeDescription(choice))).join(" ")} )
      _describe ${quote(argument.name)} choices && result=0
      ;;`);
        }
      }
    }

    functions.push(`${functionName}() {
  local curcontext="$curcontext" state state_descr
  local -a line
  local -A opt_args
  local result=1
${renderPrefixValidation(command).trimEnd()}
  local -a specifications=(
${specifications.map((specification) => `    ${quote(specification)}`).join("\n")}
  )
${freeformSpecifications.length === 0 ? "" : `${freeformSpecifications.join("\n")}\n`}${informationOptions.length === 0 ? "" : `  if (( CURRENT == 2 )); then\n    specifications+=( ${informationOptions.map(quote).join(" ")} )\n  fi\n`}  (( $#specifications )) && _arguments -C${command.allowOptionsTerminator === true ? " -S" : ""} "\${specifications[@]}" && result=0
${states.length === 0 ? "" : `  case "$state" in\n${states.join("\n")}\n  esac\n`}  return result
}`);
    return functionName;
  };

  const rootFunction = renderCommand(root);
  return `# Native zsh completion generated by daynight.
if (( ! $+functions[compdef] )); then
  print -u2 -r -- ${quote(`${root.name}: initialize zsh completion with 'autoload -Uz compinit; compinit' before sourcing this script.`)}
  return 1
fi

${functions.join("\n\n")}

_daynight() {
  local -a completion_words=( "\${(@)words[1,CURRENT]}" )
  local -a words=( "\${completion_words[@]}" )
  ${rootFunction}
}

compdef _daynight ${[root.name, ...(root.aliases ?? [])].map(quote).join(" ")}
`;
};
