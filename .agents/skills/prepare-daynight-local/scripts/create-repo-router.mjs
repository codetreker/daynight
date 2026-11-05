import { constants } from "node:fs";
import { access, link, lstat, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const usage = "Usage: node create-repo-router.mjs --repo-root <directory> [--repo-root <directory> ...] --dev-root <directory> --dev-cli <executable> --output <new-directory> [--include-dn]";
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const absolute = (value, name) => {
  if (typeof value !== "string" || !path.isAbsolute(value) || /\p{Cc}/u.test(value)) throw new Error(`${name} must be an absolute path without control characters.`);
  return value;
};
const directory = async (value, name) => {
  const resolved = await realpath(absolute(value, name));
  if (!(await stat(resolved)).isDirectory()) throw new Error(`${name} must identify an existing directory.`);
  return resolved;
};
const contains = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const overlaps = (first, second) => contains(first, second) || contains(second, first);
const ancestry = async (directory) => {
  const identities = new Set();
  let identity;
  for (let current = directory; ; current = path.dirname(current)) {
    const entry = await stat(current, { bigint: true });
    const key = `${entry.dev}:${entry.ino}`;
    identity ??= key;
    identities.add(key);
    if (current === path.dirname(current)) break;
  }
  return { identity, identities };
};

// Keep the entry count separate: no entries must not become an empty entry (cwd).
const filterPath = `
_dn_router_rest=\${PATH-}
_dn_router_filtered=
_dn_router_have=0
_dn_router_removed=0
if [ "\${PATH+x}" = x ]; then
  while :; do
    case "$_dn_router_rest" in
      *:*) _dn_router_entry=\${_dn_router_rest%%:*}; _dn_router_rest=\${_dn_router_rest#*:}; _dn_router_more=1 ;;
      *) _dn_router_entry=$_dn_router_rest; _dn_router_more=0 ;;
    esac
    _dn_router_directory=\${_dn_router_entry:-.}
    if [ "$_dn_router_directory" -ef "$_dn_router_bin" ] || [ "$_dn_router_directory/$_dn_router_command" -ef "$_dn_router_self" ]; then
      _dn_router_removed=1
    elif [ "$_dn_router_have" = 0 ]; then
      _dn_router_filtered=$_dn_router_entry
      _dn_router_have=1
    else
      _dn_router_filtered=$_dn_router_filtered:$_dn_router_entry
    fi
    [ "$_dn_router_more" = 1 ] || break
  done
fi
`;

const wrapper = ({ repoRoots, devRoot, devCli, output, commands }) => `#!/bin/sh
# Route only the configured physical repositories; do not change the parent shell.
_dn_router_bin=${quote(output)}
_dn_router_self=${quote(path.join(output, "daynight"))}
case "\${0##*/}" in
  ${commands.map(quote).join("|")}) _dn_router_command=\${0##*/} ;;
  *) printf '%s\\n' 'Invoke this router as daynight or its configured dn alias.' >&2; exit 126 ;;
esac
_dn_router_cwd=$(pwd -P) || exit 126
case "$_dn_router_cwd" in
  ${repoRoots.flatMap((root) => [quote(root), `${quote(root)}/*`]).join("|")})
    if [ ! -f ${quote(devCli)} ] || [ ! -x ${quote(devCli)} ] || [ ${quote(devCli)} -ef "$_dn_router_self" ]; then
      printf '%s\\n' 'Development executable is unavailable; no stable fallback was attempted.' >&2
      exit 126
    fi
    DN_CONFIG_DIR=${quote(devRoot)}
    export DN_CONFIG_DIR
    exec ${quote(devCli)} "$@"
    ;;
esac
${filterPath}
if [ "$_dn_router_have" = 0 ]; then
  printf 'No original %s executable: PATH contains only this router.\\n' "$_dn_router_command" >&2
  exit 127
fi
PATH=$_dn_router_filtered
export PATH
_dn_router_original=$(command -v "$_dn_router_command" 2>/dev/null) || _dn_router_original=
if [ ! -f "$_dn_router_original" ] || [ ! -x "$_dn_router_original" ] || [ "$_dn_router_original" -ef "$_dn_router_self" ]; then
  printf 'No original %s executable is available outside the configured repositories.\\n' "$_dn_router_command" >&2
  exit 127
fi
exec "$_dn_router_original" "$@"
`;

const activation = (output) => `# Source this file in sh or zsh. It does not select a Daynight configuration root.
_dn_router_activate() {
  _dn_router_current=$(command -v daynight 2>/dev/null) || _dn_router_current=
  case "$_dn_router_current" in
    */agent-cli-aliases/*/daynight)
      if [ -f "$_dn_router_current" ] && [ -x "$_dn_router_current" ]; then
        return 0
      fi
      ;;
  esac
  _dn_router_bin=${quote(output)}
  _dn_router_self=${quote(path.join(output, "daynight"))}
  _dn_router_command=daynight
${filterPath}
  if [ "$_dn_router_have" = 1 ]; then
    PATH=$_dn_router_bin:$_dn_router_filtered
  else
    PATH=$_dn_router_bin
  fi
  export PATH
  hash -r 2>/dev/null || :
}
_dn_router_activate
unset -f _dn_router_activate
unset _dn_router_current _dn_router_bin _dn_router_self _dn_router_command
unset _dn_router_rest _dn_router_filtered _dn_router_have _dn_router_entry
unset _dn_router_more _dn_router_directory _dn_router_removed
`;

const deactivation = (output) => `# Source before activating a replacement router. Existing router files are retained.
_dn_router_deactivate() {
  _dn_router_bin=${quote(output)}
  _dn_router_self=${quote(path.join(output, "daynight"))}
  _dn_router_command=daynight
${filterPath}
  if [ "$_dn_router_removed" = 0 ]; then
    return 0
  fi
  if [ "$_dn_router_have" = 0 ]; then
    printf '%s\\n' 'Router deactivation left no PATH entries. Restore a non-router PATH entry and retry; PATH was not changed.' >&2
    return 1
  fi
  PATH=$_dn_router_filtered
  export PATH
  hash -r 2>/dev/null || :
}
if _dn_router_deactivate; then _dn_router_result=0; else _dn_router_result=1; fi
unset -f _dn_router_deactivate
unset _dn_router_bin _dn_router_self _dn_router_command _dn_router_rest
unset _dn_router_filtered _dn_router_have _dn_router_entry _dn_router_more
unset _dn_router_directory _dn_router_removed
if [ "$_dn_router_result" = 0 ]; then
  unset _dn_router_result
else
  unset _dn_router_result
  false
fi
`;

/** Create only a new private output directory; configuration and repositories are read-only inputs. */
export async function createRepoRouter(options) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Repository command routing requires macOS or Linux.");
  if (!Array.isArray(options.repoRoots) || options.repoRoots.length === 0) throw new Error("At least one --repo-root is required.");
  const repoRoots = [...new Set(await Promise.all(options.repoRoots.map((root) => directory(root, "--repo-root"))))];
  const devRoot = await directory(options.devRoot, "--dev-root");
  if (devRoot.includes(":")) throw new Error("--dev-root must not contain the PATH delimiter (:).");
  const repoAncestors = await Promise.all(repoRoots.map(ancestry));
  const stateAncestors = await ancestry(devRoot);
  if (repoRoots.some((root) => overlaps(root, devRoot)) || repoAncestors.some((repository) => repository.identities.has(stateAncestors.identity) || stateAncestors.identities.has(repository.identity))) {
    throw new Error("The development state directory and repository roots must not overlap, including through symbolic links.");
  }

  const requestedEntry = absolute(options.devCli, "--dev-cli");
  // Resolve parent links but retain the final entry link so a later dev install can update it.
  const devCli = path.join(await directory(path.dirname(requestedEntry), "--dev-cli parent"), path.basename(requestedEntry));
  const validatedDevTarget = await realpath(devCli);
  if (!(await stat(validatedDevTarget)).isFile()) throw new Error("--dev-cli must identify a regular executable file.");
  try { await access(devCli, constants.X_OK); }
  catch (cause) { throw new Error("--dev-cli is not executable.", { cause }); }

  const requestedOutput = absolute(options.output, "--output");
  const output = path.join(await directory(path.dirname(requestedOutput), "--output parent"), path.basename(requestedOutput));
  if (output.includes(":")) throw new Error("--output must not contain the PATH delimiter (:).");
  const outputAncestors = await ancestry(path.dirname(output));
  if (repoRoots.some((root) => overlaps(root, output)) || repoAncestors.some((repository) => outputAncestors.identities.has(repository.identity))) throw new Error("The output directory must be outside every repository root.");
  try {
    await lstat(output);
    throw new Error(`Output already exists: ${output}. Reuse it after inspection or choose a new output directory.`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }

  const commands = options.includeDn ? ["daynight", "dn"] : ["daynight"];
  const metadata = { format: "daynight-repository-router-v1", repoRoots, devRoot, devCli, validatedDevTarget, commands, output };
  try { await mkdir(output, { mode: 0o700 }); }
  catch (cause) { throw new Error(cause.code === "EEXIST" ? `Output already exists: ${output}.` : `Cannot create output directory: ${output}.`, { cause }); }
  try {
    await writeFile(path.join(output, "daynight"), wrapper(metadata), { flag: "wx", mode: 0o700 });
    // One inode also lets fallback identify either spelling through hard links or symlinks.
    if (options.includeDn) await link(path.join(output, "daynight"), path.join(output, "dn"));
    await writeFile(path.join(output, "activate.sh"), activation(output), { flag: "wx", mode: 0o600 });
    await writeFile(path.join(output, "deactivate.sh"), deactivation(output), { flag: "wx", mode: 0o600 });
    await writeFile(path.join(output, "router.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw cause;
  }
  return metadata;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      "repo-root": { type: "string", multiple: true }, "dev-root": { type: "string" },
      "dev-cli": { type: "string" }, output: { type: "string" }, "include-dn": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    } });
    if (values.help) console.log(`${usage}\n\nAll inputs must exist; output must be new and its parent must exist. This command never edits shell startup files or files under the supplied repository roots.`);
    else {
      const metadata = await createRepoRouter({ repoRoots: values["repo-root"], devRoot: values["dev-root"], devCli: values["dev-cli"], output: values.output, includeDn: values["include-dn"] });
      console.log(`Created ${metadata.output}\nActivate in the intended shell: . ${quote(path.join(metadata.output, "activate.sh"))}\nRepository roots: ${metadata.repoRoots.join(", ")}\nDevelopment state: ${metadata.devRoot}\nExisting shell functions or aliases can still shadow executable routing.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
