import type { CommandDefinition } from "../../cli/schema.js";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const shellArray = (values: readonly string[]): string => `(${values.map(shellQuote).join(" ")})`;

const commandCases = (root: CommandDefinition): string => {
  const nodes: CommandDefinition[] = [root];
  const cases: string[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    const childNames: string[] = [];
    const childNodes: string[] = [];
    for (const child of node.commands ?? []) {
      const childIndex = nodes.length;
      nodes.push(child);
      for (const name of [child.name, ...(child.aliases ?? [])]) {
        childNames.push(name);
        childNodes.push(String(childIndex));
      }
    }
    const optionNames: string[] = [];
    const optionIds: string[] = [];
    const optionValues: string[] = [];
    const optionActions: string[] = [];
    const optionEmpty: string[] = [];
    const optionRepeats: string[] = [];
    for (const [optionIndex, option] of (node.options ?? []).entries()) {
      for (const name of option.names) {
        optionNames.push(name);
        optionIds.push(String(optionIndex));
        optionValues.push(option.value?.kind ?? "");
        optionActions.push(option.action ?? "");
        optionEmpty.push(option.value?.allowEmpty === true ? "1" : "0");
        optionRepeats.push(option.repeatable === true ? "1" : "0");
      }
    }
    const choices = (node.arguments ?? []).map((argument, argumentIndex) =>
      `        ${argumentIndex}) dn_choices=${shellArray(argument.choices ?? [])}; dn_argument_empty=${argument.allowEmpty === true ? 1 : 0} ;;`,
    );
    const valueChoices = (node.options ?? []).flatMap((option, optionIndex) => option.value?.choices === undefined ? [] :
      [`        ${optionIndex}) dn_value_choices=${shellArray(option.value.choices)} ;;`]);
    cases.push(`    ${index})
      dn_children=${shellArray(childNames)}
      dn_child_nodes=${shellArray(childNodes)}
      dn_options=${shellArray(optionNames)}
      dn_option_ids=${shellArray(optionIds)}
      dn_option_values=${shellArray(optionValues)}
      dn_option_actions=${shellArray(optionActions)}
      dn_option_empty=${shellArray(optionEmpty)}
      dn_option_repeats=${shellArray(optionRepeats)}
      dn_argument_count=${node.arguments?.length ?? 0}
      dn_allow_terminator=${node.allowOptionsTerminator === true ? 1 : 0}
      case "$dn_position" in
${choices.join("\n")}
      esac
      case "$dn_value_option" in
${valueChoices.join("\n")}
      esac
      ;;`);
  }
  return cases.join("\n");
};

// COMP_POINT counts bytes. The local C locale keeps substring offsets aligned
// while the arrays retain the original bytes of quoted and Unicode arguments.
const runtime = String.raw`
@PREFIX@_words() {
  local dn_index dn_char dn_token='' dn_quote='' dn_escape=''
  local dn_started=0
  dn_words=()
  dn_tilde=0
  for ((dn_index=0; dn_index<COMP_POINT; dn_index++)); do
    dn_char="@{COMP_LINE:dn_index:1}"
    if [[ -n "$dn_escape" ]]; then
      if [[ "$dn_escape" == double && "$dn_char" != '$' && "$dn_char" != '\' && "$dn_char" != '"' && "$dn_char" != $'\x60' && "$dn_char" != $'\n' ]]; then
        dn_token+='\'
      fi
      [[ "$dn_char" == $'\n' ]] || dn_token+="$dn_char"
      dn_escape=''
      continue
    fi
    if [[ "$dn_quote" == single ]]; then
      if [[ "$dn_char" == "'" ]]; then dn_quote=''; else dn_token+="$dn_char"; fi
      continue
    fi
    if [[ "$dn_quote" == double ]]; then
      case "$dn_char" in
        '"') dn_quote='' ;;
        '\') dn_escape=double ;;
        *) dn_token+="$dn_char" ;;
      esac
      continue
    fi
    case "$dn_char" in
      "'") dn_quote=single; dn_started=1 ;;
      '"') dn_quote=double; dn_started=1 ;;
      '\') dn_escape=plain; dn_started=1 ;;
      ' '|$'\t'|$'\n')
        if ((dn_started)); then dn_words+=("$dn_token"); fi
        dn_token=''; dn_started=0; dn_tilde=0
        ;;
      ';'|'|'|'&'|'('|')')
        dn_words=(); dn_token=''; dn_started=0; dn_tilde=0
        ;;
      '<'|'>') return 1 ;;
      *)
        if ((!dn_started)) && [[ "$dn_char" == '~' ]]; then dn_tilde=1; fi
        dn_token+="$dn_char"; dn_started=1
        ;;
    esac
  done
  [[ -z "$dn_escape" ]] || return 1
  dn_words+=("$dn_token")
}

@PREFIX@_schema() {
  dn_children=(); dn_child_nodes=(); dn_options=(); dn_option_ids=()
  dn_option_values=(); dn_option_actions=(); dn_choices=()
  dn_option_empty=(); dn_option_repeats=(); dn_value_choices=()
  dn_argument_empty=0
  case "$dn_node" in
@CASES@
  esac
}

@PREFIX@_valid_value() {
  [[ -n "$dn_value" || "@{dn_option_empty[dn_value_match]}" == 1 ]] || return 1
  if ((@{#dn_value_choices[@]} > 0)); then
    for dn_choice in "@{dn_value_choices[@]}"; do
      [[ "$dn_value" != "$dn_choice" ]] || return 0
    done
    return 1
  fi
  return 0
}

@PREFIX@() {
  local LC_ALL=C
  local -a dn_words dn_children dn_child_nodes dn_options dn_option_ids
  local -a dn_option_values dn_option_actions dn_choices
  local -a dn_option_empty dn_option_repeats dn_value_choices
  local dn_node=0 dn_position=0 dn_argument_count=0 dn_argument_empty=0 dn_count=0 dn_pending=''
  local dn_value_option=-1 dn_value_match=-1 dn_inline=0 dn_options_terminated=0 dn_allow_terminator=0
  local dn_used='|' dn_tilde dn_current dn_word dn_index dn_match dn_option
  local dn_candidate dn_prefix dn_fragment dn_trim dn_choice
  local dn_name dn_value dn_inline_prefix
  COMPREPLY=()
  compopt +o filenames +o nospace 2>/dev/null || :
  @PREFIX@_words || return 0
  ((@{#dn_words[@]} >= 2)) || return 0
  dn_current="@{dn_words[@{#dn_words[@]}-1]}"
  @PREFIX@_schema
  for ((dn_index=1; dn_index<@{#dn_words[@]}-1; dn_index++)); do
    dn_word="@{dn_words[dn_index]}"
    if [[ -n "$dn_pending" ]]; then
      [[ "$dn_word" != -* ]] || return 0
      dn_value="$dn_word"
      @PREFIX@_valid_value || return 0
      dn_pending=''
      dn_value_option=-1; dn_value_match=-1
      @PREFIX@_schema
      continue
    fi
    if ((!dn_options_terminated && dn_allow_terminator)) && [[ "$dn_word" == -- ]]; then
      dn_options_terminated=1
      ((dn_count+=1))
      continue
    fi
    dn_name="$dn_word"; dn_inline=0
    if [[ "$dn_word" == -*=* ]]; then dn_name="@{dn_word%%=*}"; dn_inline=1; fi
    dn_match=-1
    for ((dn_option=0; dn_option<@{#dn_options[@]}; dn_option++)); do
      if ((!dn_options_terminated)) && [[ "$dn_name" == "@{dn_options[dn_option]}" ]]; then dn_match=$dn_option; break; fi
    done
    if ((dn_match >= 0)); then
      [[ "@{dn_option_repeats[dn_match]}" == 1 || "$dn_used" != *"|@{dn_option_ids[dn_match]}|"* ]] || return 0
      [[ -z "@{dn_option_actions[dn_match]}" ]] || return 0
      dn_used+="@{dn_option_ids[dn_match]}|"
      dn_value_match=$dn_match; dn_value_option="@{dn_option_ids[dn_match]}"
      @PREFIX@_schema
      if ((dn_inline)); then
        [[ "@{dn_option_values[dn_match]}" == text ]] || return 0
        dn_value="@{dn_word#*=}"
        @PREFIX@_valid_value || return 0
        dn_value_option=-1; dn_value_match=-1
        @PREFIX@_schema
      else dn_pending="@{dn_option_values[dn_match]}"; fi
      ((dn_count+=1))
      continue
    fi
    ((dn_options_terminated)) || [[ "$dn_word" != -* ]] || return 0
    if ((@{#dn_children[@]} > 0)); then
      dn_match=-1
      for ((dn_option=0; dn_option<@{#dn_children[@]}; dn_option++)); do
        if [[ "$dn_word" == "@{dn_children[dn_option]}" ]]; then dn_match=$dn_option; break; fi
      done
      ((dn_match >= 0)) || return 0
      dn_node="@{dn_child_nodes[dn_match]}"
      dn_position=0; dn_count=0; dn_used='|'
      @PREFIX@_schema
      continue
    fi
    ((dn_position < dn_argument_count)) || return 0
    [[ -n "$dn_word" || "$dn_argument_empty" == 1 ]] || return 0
    if ((@{#dn_choices[@]} > 0)); then
      dn_match=0
      for dn_choice in "@{dn_choices[@]}"; do
        if [[ "$dn_word" == "$dn_choice" ]]; then dn_match=1; break; fi
      done
      ((dn_match)) || return 0
    fi
    ((dn_position+=1)); ((dn_count+=1))
    @PREFIX@_schema
  done
  if [[ "$dn_pending" == text ]]; then
    for dn_candidate in "@{dn_value_choices[@]}"; do
      [[ "$dn_candidate" == "$dn_current"* ]] && COMPREPLY+=("$dn_candidate")
    done
    return 0
  fi
  if [[ "$dn_pending" == directory ]]; then
    [[ "$dn_current" != -* ]] || return 0
    dn_prefix="$dn_current"
    if ((!dn_tilde)) && [[ "$dn_prefix" == '~'* ]]; then dn_prefix="./$dn_prefix"; fi
    dn_fragment="@{COMP_WORDS[COMP_CWORD]}"
    dn_trim=''
    if [[ -n "$dn_fragment" && "$dn_current" == *"$dn_fragment" ]]; then
      dn_trim="@{dn_current%"$dn_fragment"}"
    fi
    while IFS= read -r dn_candidate; do
      if ((!dn_tilde)) && [[ "$dn_current" == '~'* ]]; then dn_candidate="@{dn_candidate#./}"; fi
      if [[ -n "$dn_trim" ]]; then
        # Readline cannot stat the suffix after a word break as the full path.
        [[ "$dn_candidate" == */ ]] || dn_candidate+='/'
        dn_candidate="@{dn_candidate#"$dn_trim"}"
      fi
      COMPREPLY+=("$dn_candidate")
    done < <(compgen -d -- "$dn_prefix")
    compopt -o filenames -o nospace 2>/dev/null || :
    return 0
  fi
  if ((!dn_options_terminated)) && [[ "$dn_current" == -*=* ]]; then
    dn_name="@{dn_current%%=*}"
    for ((dn_option=0; dn_option<@{#dn_options[@]}; dn_option++)); do
      [[ "$dn_name" == "@{dn_options[dn_option]}" ]] || continue
      [[ "@{dn_option_values[dn_option]}" == text ]] || return 0
      [[ "@{dn_option_repeats[dn_option]}" == 1 || "$dn_used" != *"|@{dn_option_ids[dn_option]}|"* ]] || return 0
      dn_value_option="@{dn_option_ids[dn_option]}"
      @PREFIX@_schema
      dn_inline_prefix="@{dn_name}="
      dn_current="@{dn_current#*=}"
      dn_fragment="@{COMP_WORDS[COMP_CWORD]}"
      for dn_candidate in "@{dn_value_choices[@]}"; do
        [[ "$dn_candidate" == "$dn_current"* ]] || continue
        if [[ "$dn_fragment" == "$dn_inline_prefix"* ]]; then dn_candidate="$dn_inline_prefix$dn_candidate"; fi
        COMPREPLY+=("$dn_candidate")
      done
      return 0
    done
    return 0
  fi
  for dn_candidate in "@{dn_children[@]}" "@{dn_choices[@]}"; do
    [[ "$dn_candidate" == "$dn_current"* ]] && COMPREPLY+=("$dn_candidate")
  done
  ((dn_options_terminated)) && return 0
  for ((dn_option=0; dn_option<@{#dn_options[@]}; dn_option++)); do
    [[ "@{dn_option_repeats[dn_option]}" == 1 || "$dn_used" != *"|@{dn_option_ids[dn_option]}|"* ]] || continue
    [[ -z "@{dn_option_actions[dn_option]}" || "$dn_count" == 0 ]] || continue
    dn_candidate="@{dn_options[dn_option]}"
    [[ "$dn_candidate" == "$dn_current"* ]] && COMPREPLY+=("$dn_candidate")
  done
  return 0
}

complete -F @PREFIX@ @COMMAND@
`;

export const renderBashCompletion = (root: CommandDefinition): string => {
  const prefix = `_${root.name.replaceAll(/[^a-zA-Z0-9_]/g, "_")}_completion`;
  return `# Bash >=4.2 completion for ${root.name.replaceAll(/[\r\n]/g, " ")}
if [[ -z "\${BASH_VERSION-}" ]] || (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 2) )); then
  printf '%s\\n' 'daynight completion requires Bash >=4.2.' >&2
  return 1 2>/dev/null || exit 1
fi
${runtime.replaceAll("@{", "${").replaceAll("@PREFIX@", prefix).replace("@COMMAND@", () => [root.name, ...(root.aliases ?? [])].map(shellQuote).join(" ")).replace("@CASES@", () => commandCases(root))}`;
};
