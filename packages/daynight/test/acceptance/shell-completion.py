#!/usr/bin/env python3
"""Exercise generated completion through real Readline and ZLE Tab handling."""

import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time


PACKAGE = Path(__file__).resolve().parents[2]
ROOT = PACKAGE.parents[1]
MARKER = "__DAYNIGHT_CAPTURE__"
READY = "__DAYNIGHT_READY__"
PROMPT = "__DAYNIGHT_PROMPT_GENERATION__"
EDITOR_KEY = "\x1b!"
RESET_KEY = "\x1b?"
ARGUMENT = "__DAYNIGHT_ARGUMENT__"
FINISHED = "__DAYNIGHT_FINISHED__"


class Terminal:
    def __init__(self, binary, kind, cwd, environment, setup, startup=None):
        gate_reader, self.gate_writer = os.pipe()
        capture_reader, self.capture_gate_writer = os.pipe()
        os.set_inheritable(gate_reader, True)
        os.set_inheritable(capture_reader, True)
        environment = dict(environment, DAYNIGHT_EDITOR_GATE_FD=str(gate_reader), DAYNIGHT_CAPTURE_GATE_FD=str(capture_reader))
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.close(self.gate_writer)
                os.close(self.capture_gate_writer)
                os.chdir(cwd)
                arguments = [binary, *startup] if startup is not None else [binary, "--noprofile", "--norc", "-i"] if kind == "bash" else [binary, "-d", "-i"]
                os.execve(binary, arguments, environment)
            except BaseException:
                os._exit(127)
        os.close(gate_reader)
        os.close(capture_reader)
        self.transcript = bytearray()
        self.pending = bytearray()
        self.generation = 0
        self.editor_ready = False
        self.readiness_proof = False
        self.capture_reset_proof = False
        self.calls = cwd / "daynight-invocations.log"
        self.forbidden = cwd / "forbidden-executions.log"
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 240, 0, 0))
            self.send(setup + "\n")
            self.await_editor(prove_transition=True)
            self.prove_capture_reset()
        except BaseException:
            self.close()
            raise

    def send(self, text):
        os.write(self.fd, text.encode())

    def read(self, timeout):
        if not select.select([self.fd], [], [], timeout)[0]:
            return b""
        try:
            data = os.read(self.fd, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                raise AssertionError(f"The interactive shell exited unexpectedly: {self.pending.decode(errors='replace')!r}") from error
            raise
        if not data:
            raise AssertionError("The interactive shell closed its terminal")
        self.transcript.extend(data)
        self.pending.extend(data)
        return data

    def until(self, marker, timeout=8):
        expected = marker.encode()
        deadline = time.monotonic() + timeout
        while expected not in self.pending:
            if time.monotonic() >= deadline:
                raise AssertionError(f"Timed out waiting for {marker!r}: {self.pending.decode(errors='replace')!r}")
            self.read(min(0.2, deadline - time.monotonic()))
        end = self.pending.index(expected) + len(expected)
        result = bytes(self.pending[:end]).decode(errors="replace")
        del self.pending[:end]
        return result

    def acknowledge_editor(self, probe_sent=False):
        if not probe_sent:
            self.send(EDITOR_KEY)
        output = self.until(READY + "END\r\n")
        match = re.search(READY + r"GEN(\d+)" + READY + r"BUFFER(.*?)" + READY + r"CURSOR(\d+)" + READY + "END", output, re.S)
        if match is None or int(match.group(1)) != self.generation or match.group(2) != "" or int(match.group(3)) != 0:
            raise AssertionError(f"The active editor is not empty and ready for generation {self.generation}: {output!r}")
        self.editor_ready = True

    def await_editor(self, prove_transition=False):
        output = self.until(PROMPT + "END\r\n")
        match = re.search(PROMPT + r"(\d+)" + PROMPT + "END", output)
        if match is None or int(match.group(1)) != self.generation + 1:
            raise AssertionError(f"Expected the next primary prompt after generation {self.generation}: {output!r}")
        self.generation = int(match.group(1))
        self.editor_ready = False
        self.send(EDITOR_KEY)
        if prove_transition:
            # The prompt hook is blocked before editor entry. Quiet output cannot establish readiness.
            self.assert_no_editor_ack()
            os.write(self.gate_writer, b"release\n")
            os.close(self.gate_writer)
            self.gate_writer = None
            self.readiness_proof = True
        self.acknowledge_editor(probe_sent=True)

    def assert_no_editor_ack(self):
        proof_deadline = time.monotonic() + 8
        while self.read(0.03):
            if time.monotonic() >= proof_deadline:
                raise AssertionError("The blocked editor transition did not become quiet")
        if (READY + "END").encode() in self.pending:
            raise AssertionError("The editor acknowledged input before its transition gate was released")

    def prove_capture_reset(self):
        proof_line = "editor reset proof"
        generation = self.generation
        line, cursor, output = self.complete(proof_line)
        if line != proof_line or cursor != len(proof_line):
            raise AssertionError(f"The capture-reset proof did not preserve its input: {output!r}")
        self.send(RESET_KEY)
        # The capture marker is already visible while its widget still holds the editor.
        self.assert_no_editor_ack()
        os.write(self.capture_gate_writer, b"release\n")
        os.close(self.capture_gate_writer)
        self.capture_gate_writer = None
        self.acknowledge_editor(probe_sent=True)
        if self.generation != generation:
            raise AssertionError("Resetting an editor must not start a new prompt generation")
        self.capture_reset_proof = True

    def complete(self, keys):
        if not self.editor_ready:
            raise AssertionError("A completion scenario requires a fresh empty editor")
        self.acknowledge_editor()
        self.editor_ready = False
        calls_before = self.calls.read_bytes() if self.calls.exists() else b""
        self.send(keys + "\x18\x12")
        output = self.until(MARKER + "END\r\n")
        capture = re.search(MARKER + r"BEGIN(.*?)" + MARKER + r"CURSOR(\d+)" + MARKER + "END", output, re.S)
        if capture is None:
            raise AssertionError(f"Missing captured input: {output!r}")
        calls_after = self.calls.read_bytes() if self.calls.exists() else b""
        if ARGUMENT in output or "__DAYNIGHT_FORBIDDEN_NODE__" in output or calls_after != calls_before or self.forbidden.exists():
            raise AssertionError(f"Completion executed a CLI process: {output!r}")
        return capture.group(1), int(capture.group(2)), output

    def execute(self):
        self.send("\x05\n")
        output = self.until(FINISHED + "\r\n")
        arguments = re.findall(ARGUMENT + r"(.*?)" + ARGUMENT + "END", output)
        self.await_editor()
        return arguments

    def clear(self):
        self.send(RESET_KEY)
        self.acknowledge_editor(probe_sent=True)

    def close(self):
        for name in ["gate_writer", "capture_gate_writer"]:
            descriptor = getattr(self, name)
            if descriptor is not None:
                os.close(descriptor)
                setattr(self, name, None)
        try:
            os.killpg(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            child, _ = os.waitpid(self.pid, os.WNOHANG)
            if child:
                break
            time.sleep(0.02)
        else:
            os.killpg(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        os.close(self.fd)


def shell_setup(kind, script):
    common = "PS1='__DAYNIGHT_PROMPT__ '; PS2='__DAYNIGHT_CONTINUE__ '; _daynight_generation=0; _daynight_capture_gate_pending=1; "
    common += "_daynight_prompt() { ((_daynight_generation+=1)); printf '\\n" + PROMPT + "%s" + PROMPT + "END\\n' \"$_daynight_generation\"; if (( _daynight_generation == 1 )); then read -r -u \"$DAYNIGHT_EDITOR_GATE_FD\" _daynight_release; fi; }; "
    common += "_daynight_hold_capture() { if (( _daynight_capture_gate_pending )); then _daynight_capture_gate_pending=0; read -r -u \"$DAYNIGHT_CAPTURE_GATE_FD\" _daynight_release; fi; }; "
    if kind == "bash":
        setup = common + "set +o history; bind 'set bell-style none'; bind 'set show-all-if-ambiguous on'; bind 'set completion-query-items 0'; "
        setup += "_daynight_capture() { printf '\\n" + MARKER + "BEGIN%s" + MARKER + "CURSOR%s" + MARKER + "END\\n' \"$READLINE_LINE\" \"$READLINE_POINT\"; _daynight_hold_capture; }; "
        setup += "bind -x '\"\\C-x\\C-r\":_daynight_capture'; "
        setup += "_daynight_editor_ready() { printf '\\n" + READY + "GEN%s" + READY + "BUFFER%s" + READY + "CURSOR%s" + READY + "END\\n' \"$_daynight_generation\" \"$READLINE_LINE\" \"$READLINE_POINT\"; }; bind -x '\"\\e!\":_daynight_editor_ready'; "
        setup += "_daynight_editor_reset() { READLINE_LINE=''; READLINE_POINT=0; _daynight_editor_ready; }; bind -x '\"\\e?\":_daynight_editor_reset'; "
    else:
        setup = common + "unsetopt BEEP AUTO_MENU MENU_COMPLETE; "
        if script is not None:
            setup += "autoload -Uz compaudit; compaudit || exit 91; autoload -Uz compinit; compinit -D; "
        setup += "bindkey -e; "
        setup += "_daynight_capture() { printf '\\n" + MARKER + "BEGIN%s" + MARKER + "CURSOR%s" + MARKER + "END\\n' \"$BUFFER\" \"$CURSOR\"; _daynight_hold_capture; zle redisplay; }; zle -N _daynight_capture; bindkey '^X^R' _daynight_capture; "
        setup += "_daynight_editor_ready() { printf '\\n" + READY + "GEN%s" + READY + "BUFFER%s" + READY + "CURSOR%s" + READY + "END\\n' \"$_daynight_generation\" \"$BUFFER\" \"$CURSOR\"; zle redisplay; }; zle -N _daynight_editor_ready; bindkey '^[!' _daynight_editor_ready; "
        setup += "_daynight_editor_reset() { BUFFER=''; CURSOR=0; _daynight_editor_ready; }; zle -N _daynight_editor_reset; bindkey '^[?' _daynight_editor_reset; "
    if script is not None:
        setup += "source " + shlex.quote(str(script)) + " || exit 90; "
    # Completion must not invoke these functions. Enter invokes only this harmless argv recorder.
    setup += "daynight() { printf x >>daynight-invocations.log; printf '\\n'; for _dn_arg in \"$@\"; do printf '" + ARGUMENT + "%s" + ARGUMENT + "END\\n' \"$_dn_arg\"; done; printf '" + FINISHED + "\\n'; }; "
    setup += "dn() { daynight \"$@\"; }; "
    setup += "node() { printf x >>forbidden-executions.log; printf '__DAYNIGHT_FORBIDDEN_NODE__\\n'; return 99; }; "
    setup += "PROMPT_COMMAND=_daynight_prompt" if kind == "bash" else "precmd_functions+=(_daynight_prompt)"
    return setup


def zsh_environment(directory, root, disable_rcs=True):
    environment = dict(os.environ)
    environment.update({"HOME": str(directory / "home"), "ZDOTDIR": str(directory / "home")})
    environment.pop("FPATH", None)
    startup = "unsetopt GLOBAL_RCS\n"
    if root:
        root = Path(root).resolve()
        modules = sorted(path for path in root.glob("usr/lib/*/zsh/*") if path.is_dir())
        functions = root / "usr/share/zsh/functions"
        paths = sorted(path for pattern in ["*", "Completion/*"] for path in functions.glob(pattern) if path.is_dir())
        if not modules or not paths:
            raise AssertionError(f"Extracted zsh toolchain is incomplete: {root}")
        startup += "module_path=(" + " ".join(shlex.quote(str(path)) for path in modules) + ")\n"
        startup += "fpath=(" + " ".join(shlex.quote(str(path)) for path in paths) + ")\n"
    # MODULE_PATH from the environment is ignored; .zshenv precedes the first ZLE initialization.
    # https://zsh.sourceforge.io/Doc/Release/Parameters.html#index-module_005fpath
    # https://zsh.sourceforge.io/Doc/Release/Files.html#Startup_002fShutdown-Files
    if disable_rcs:
        startup += "unsetopt RCS\n"
    startup_path = directory / "home/.zshenv"
    startup_path.write_text(startup)
    startup_path.chmod(0o600)
    return environment


def executable(variable, default):
    value = os.environ.get(variable, default)
    binary = shutil.which(value)
    if binary is None:
        raise AssertionError(f"Required shell not found: {variable}={value!r}; run packages/daynight/scripts/prepare-completion-shells.sh")
    return str(Path(binary).resolve())


def version(binary):
    return subprocess.run([binary, "--version"], check=True, capture_output=True, text=True, timeout=10).stdout.splitlines()[0]


def open_quote(line):
    quote = ""
    escaped = False
    for character in line:
        if escaped:
            escaped = False
        elif character == "\\" and quote != "'":
            escaped = True
        elif character == quote:
            quote = ""
        elif character in "\"'" and not quote:
            quote = character
    return quote


def scenarios():
    cases = [
        ("root command and local directory collision", "daynight rev\t", ["review"]),
        ("short root command and local directory collision", "dn rev\t", ["review"]),
        ("short command nested operation", "dn task attachment rea\t", ["task", "attachment", "read"]),
        ("short command inline choice", "dn task list --status=do\t", ["task", "list", "--status=done"]),
        ("short command directory", "dn review add-repo --path nor\t", ["review", "add-repo", "--path", "normal-directory/"]),
        ("root login", "daynight logi\t", ["login"]),
        ("root logout", "daynight logo\t", ["logout"]),
        ("login no browser option", "daynight login --no-b\t", ["login", "--no-browser"]),
        ("root update", "daynight upd\t", ["update"]),
        ("root completion", "daynight comp\t", ["completion"]),
        ("root setup and local directory collision", "daynight set\t", ["setup"]),
        ("setup server URL option", "daynight setup --server-u\t", ["setup", "--server-url"]),
        ("setup server options common prefix", "daynight setup --ser\t", ["setup", "--server-"]),
        ("setup token stdin option", "daynight setup --server-t\t", ["setup", "--server-token-stdin"]),
        ("setup server URL after token stdin flag", "daynight setup --server-token-stdin --server-u\t", ["setup", "--server-token-stdin", "--server-url"]),
        ("setup review repository option", "daynight setup --review-r\t", ["setup", "--review-repo"]),
        ("setup review path option", "daynight setup --review-p\t", ["setup", "--review-path"]),
        ("setup review directory", "daynight setup --review-path nor\t", ["setup", "--review-path", "normal-directory/"]),
        ("setup review after server URL", "daynight setup --server-url https://service.example --review-r\t", ["setup", "--server-url", "https://service.example", "--review-repo"]),
        ("root project and local directory collision", "daynight pro\t", ["project"]),
        ("project create", "daynight project cre\t", ["project", "create"]),
        ("project list", "daynight project li\t", ["project", "list"]),
        ("project show", "daynight project sh\t", ["project", "show"]),
        ("project help", "daynight project --he\t", ["project", "--help"]),
        ("project repo option", "daynight project create --re\t", ["project", "create", "--repo"]),
        ("project repo after text name", 'daynight project create "Day Night" --re\t', ["project", "create", "Day Night", "--repo"]),
        ("project list JSON", "daynight project list --js\t", ["project", "list", "--json"]),
        ("project show JSON", "daynight project show project-id --js\t", ["project", "show", "project-id", "--json"]),
        ("root task and local directory collision", "daynight ta\t", ["task"]),
        ("task create", "daynight task cre\t", ["task", "create"]),
        ("task delete", "daynight task del\t", ["task", "delete"]),
        ("task delete dependency removal switch", "daynight task delete task-id --remove-dep\t", ["task", "delete", "task-id", "--remove-depends"]),
        ("task delete project after dependency removal", "daynight task delete task-id --remove-depends --pro\t", ["task", "delete", "task-id", "--remove-depends", "--project"]),
        ("task delete exact version", "daynight task delete task-id --if-ver\t", ["task", "delete", "task-id", "--if-version"]),
        ("task delete explicit project after int64", "daynight task delete task-id --if-version=9007199254740993 --pro\t", ["task", "delete", "task-id", "--if-version=9007199254740993", "--project"]),
        ("task set-status", "daynight task set-s\t", ["task", "set-status"]),
        ("task set-status positional todo", "daynight task set-status task-id to\t", ["task", "set-status", "task-id", "todo"]),
        ("task set-status positional in-progress", "daynight task set-status task-id in\t", ["task", "set-status", "task-id", "in_progress"]),
        ("task set-status positional done", "daynight task set-status task-id do\t", ["task", "set-status", "task-id", "done"]),
        ("task list", "daynight task li\t", ["task", "list"]),
        ("task ready", "daynight task rea\t", ["task", "ready"]),
        ("task show", "daynight task sh\t", ["task", "show"]),
        ("task update", "daynight task upd\t", ["task", "update"]),
        ("task graph", "daynight task gr\t", ["task", "graph"]),
        ("task attachment group", "daynight task att\t", ["task", "attachment"]),
        ("task attachment put", "daynight task attachment pu\t", ["task", "attachment", "put"]),
        ("task attachment list", "daynight task attachment li\t", ["task", "attachment", "list"]),
        ("task attachment read", "daynight task attachment rea\t", ["task", "attachment", "read"]),
        ("task attachment remove", "daynight task attachment rem\t", ["task", "attachment", "remove"]),
        ("task attachment target path", "daynight task attachment put task-id source --pa\t", ["task", "attachment", "put", "task-id", "source", "--path"]),
        ("task attachment explicit project", "daynight task attachment read task-id docs/a.md --pro\t", ["task", "attachment", "read", "task-id", "docs/a.md", "--project"]),
        ("task attachment tree", "daynight task attachment list task-id --tr\t", ["task", "attachment", "list", "task-id", "--tree"]),
        ("task attachment JSON", "daynight task attachment list task-id --js\t", ["task", "attachment", "list", "task-id", "--json"]),
        ("task attachment inline path followed by project", "daynight task attachment put task-id source --path=-draft.md --pro\t", ["task", "attachment", "put", "task-id", "source", "--path=-draft.md", "--project"]),
        ("task title option", "daynight task create --ti\t", ["task", "create", "--title"]),
        ("task list ready", "daynight task list --rea\t", ["task", "list", "--ready"]),
        ("task list all", "daynight task list --al\t", ["task", "list", "--all"]),
        ("task ready limit", "daynight task ready --li\t", ["task", "ready", "--limit"]),
        ("task ready limit followed by JSON", "daynight task ready --limit=2 --js\t", ["task", "ready", "--limit=2", "--json"]),
        ("task create platform option", "daynight task create --required-plat\t", ["task", "create", "--required-platform"]),
        ("task create platform separate Windows", "daynight task create --required-platform win\t", ["task", "create", "--required-platform", "windows"]),
        ("task update platform inline Linux", "daynight task update task-id --required-platform=lin\t", ["task", "update", "task-id", "--required-platform=linux"]),
        ("task update clear platform", "daynight task update task-id --clear-required-plat\t", ["task", "update", "task-id", "--clear-required-platform"]),
        ("task list compatible platform macOS", "daynight task list --compatible-platform mac\t", ["task", "list", "--compatible-platform", "macos"]),
        ("task ready compatible platform inline Linux", "daynight task ready --compatible-platform=lin\t", ["task", "ready", "--compatible-platform=linux"]),
        ("task update permission option", "daynight task update task-id --allow-ag\t", ["task", "update", "task-id", "--allow-agents"]),
        ("task update permission separate true", "daynight task update task-id --allow-agents tr\t", ["task", "update", "task-id", "--allow-agents", "true"]),
        ("task list permission inline false", "daynight task list --allow-agents=fa\t", ["task", "list", "--allow-agents=false"]),
        ("task ready permission separate true", "daynight task ready --allow-agents tr\t", ["task", "ready", "--allow-agents", "true"]),
        ("task list separate status", "daynight task list --status in\t", ["task", "list", "--status", "in_progress"]),
        ("task list inline status", "daynight task list --status=do\t", ["task", "list", "--status=done"]),
        ("task inline status before further options", "daynight task list --status=done --rea\t", ["task", "list", "--status=done", "--ready"]),
        ("task empty separate description", 'daynight task create --title Title --description "" --pro\t', ["task", "create", "--title", "Title", "--description", "", "--project"]),
        ("task empty inline description", "daynight task create --title Title --description='' --pro\t", ["task", "create", "--title", "Title", "--description=", "--project"]),
        ("task dash inline description", "daynight task create --title Title --description=-leading --pro\t", ["task", "create", "--title", "Title", "--description=-leading", "--project"]),
        ("task equals inline description", "daynight task create --title Title --description==a=b --pro\t", ["task", "create", "--title", "Title", "--description==a=b", "--project"]),
        ("task repeatable dependency remains available", "daynight task create --title Title --depends-on a --dep\t", ["task", "create", "--title", "Title", "--depends-on", "a", "--depends-on"]),
        ("task external dependency option", "daynight task create --external-dep\t", ["task", "create", "--external-depends-on"]),
        ("task external-only option followed by ordinary option", "daynight task update task-id --external-depends-on=a --dep\t", ["task", "update", "task-id", "--external-depends-on=a", "--depends-on"]),
        ("task repeatable external dependency remains available", "daynight task update task-id --external-depends-on a --external-dep\t", ["task", "update", "task-id", "--external-depends-on", "a", "--external-depends-on"]),
        ("task inline dependency followed by option", "daynight task create --title Title --depends-on=a --pro\t", ["task", "create", "--title", "Title", "--depends-on=a", "--project"]),
        ("task repeated inline and separate dependencies", "daynight task create --title Title --depends-on=a --depends-on a --dep\t", ["task", "create", "--title", "Title", "--depends-on=a", "--depends-on", "a", "--depends-on"]),
        ("task clear dependency flag", "daynight task update task-id --clear-dep\t", ["task", "update", "task-id", "--clear-dependencies"]),
        ("task PR URL option", "daynight task create --pull-request-u\t", ["task", "create", "--pull-request-url"]),
        ("task PR title option", "daynight task update task-id --pull-request-t\t", ["task", "update", "task-id", "--pull-request-title"]),
        ("task repeated PR URL remains available", "daynight task create --pull-request-url= --pull-request-u\t", ["task", "create", "--pull-request-url=", "--pull-request-url"]),
        ("task repeated PR title remains available", 'daynight task update task-id --pull-request-title "" --pull-request-t\t', ["task", "update", "task-id", "--pull-request-title", "", "--pull-request-title"]),
        ("task raw inline PR text followed by option", "daynight task create --pull-request-url=-a=b --pro\t", ["task", "create", "--pull-request-url=-a=b", "--project"]),
        ("task clear PR flag", "daynight task update task-id --clear-pull\t", ["task", "update", "task-id", "--clear-pull-requests"]),
        ("task version option", "daynight task update task-id --if-ver\t", ["task", "update", "task-id", "--if-version"]),
        ("task graph JSON", "daynight task graph --js\t", ["task", "graph", "--json"]),
        ("task inline project followed by JSON", "daynight task show task-id --project=project-id --js\t", ["task", "show", "task-id", "--project=project-id", "--json"]),
        ("review run", "daynight review ru\t", ["review", "run"]),
        ("review list", "daynight review li\t", ["review", "list"]),
        ("quoted command name", "daynight 'review' li\t", ["review", "list"]),
        ("quoted nested command name", "daynight review 'add-repo' --pa\t", ["review", "add-repo", "--path"]),
        ("review alias", "daynight review ls\t", ["review", "ls"]),
        ("nested command", "daynight review ad\t", ["review", "add-repo"]),
        ("root help", "daynight --he\t", ["--help"]),
        ("root version", "daynight --ver\t", ["--version"]),
        ("nested help", "daynight review --he\t", ["review", "--help"]),
        ("leaf help", "daynight review run --he\t", ["review", "run", "--help"]),
        ("bash shell choice", "daynight completion ba\t", ["completion", "bash"]),
        ("zsh shell choice", "daynight completion zs\t", ["completion", "zsh"]),
        ("completion setup command", "daynight completion set\t", ["completion", "setup"]),
        ("completion setup shell option", "daynight completion setup --sh\t", ["completion", "setup", "--shell"]),
        ("completion setup separate shell choice", "daynight completion setup --shell ba\t", ["completion", "setup", "--shell", "bash"]),
        ("completion setup inline shell choice", "daynight completion setup --shell=zs\t", ["completion", "setup", "--shell=zsh"]),
        ("completion setup rc option", "daynight completion setup --rc\t", ["completion", "setup", "--rc-file"]),
        ("path before remote", "daynight review add-repo --pa\t", ["review", "add-repo", "--path"]),
        ("path after HTTPS remote", "daynight review add-repo https://github.com/acme/repo.git --pa\t", ["review", "add-repo", "https://github.com/acme/repo.git", "--path"]),
        ("path after SSH remote", "daynight review add-repo git@github.com:acme/repo.git --pa\t", ["review", "add-repo", "git@github.com:acme/repo.git", "--path"]),
        ("directory before remote", "daynight review add-repo --path nor\t", ["review", "add-repo", "--path", "normal-directory/"]),
        ("directory after remote", "daynight review add-repo acme/repo --path nor\t", ["review", "add-repo", "acme/repo", "--path", "normal-directory/"]),
        ("directory followed by remote", "daynight review add-repo --path nor\t acme/repo", ["review", "add-repo", "--path", "normal-directory/", "acme/repo"]),
        ("escaped space directory", "daynight review add-repo --path sp\t", ["review", "add-repo", "--path", "space directory/"]),
        ("single quoted directory", "daynight review add-repo --path 'sp\t", ["review", "add-repo", "--path", "space directory/"]),
        ("double quoted directory", 'daynight review add-repo --path "sp\t', ["review", "add-repo", "--path", "space directory/"]),
        ("Unicode directory", "daynight review add-repo --path 中\t", ["review", "add-repo", "--path", "中文目录/"]),
        ("apostrophe directory", "daynight review add-repo --path apo\t", ["review", "add-repo", "--path", "apostrophe'directory/"]),
        ("double quote directory", "daynight review add-repo --path dou\t", ["review", "add-repo", "--path", 'double"directory/']),
        ("dollar directory", 'daynight review add-repo --path "dol\t', ["review", "add-repo", "--path", "dollar$directory/"]),
        ("backtick directory", 'daynight review add-repo --path "bac\t', ["review", "add-repo", "--path", "backtick`directory/"]),
        ("colon directory", "daynight review add-repo --path col\t", ["review", "add-repo", "--path", "colon:directory/"]),
        ("colon directory after word break", "daynight review add-repo --path colon:di\t", ["review", "add-repo", "--path", "colon:directory/"]),
        ("literal quoted tilde", "daynight review add-repo --path '~lit\t", ["review", "add-repo", "--path", "~literal/"]),
        ("literal escaped tilde", "daynight review add-repo --path \\~lit\t", ["review", "add-repo", "--path", "~literal/"]),
        ("cursor before following arguments", "daynight review ad --path normal-directory/\x01" + "\x06" * len("daynight review ad") + "\t", ["review", "add-repo", "--path", "normal-directory/"]),
        ("Unicode cursor before following option", "daynight review add-repo --path 中 --bad\x01" + "\x06" * len("daynight review add-repo --path 中") + "\t", ["review", "add-repo", "--path", "中文目录/", "--bad"]),
    ]
    unchanged = [
        ("short command text has no file fallback", "dn task create --title nor"),
        ("short command invalid status stops completion", "dn task list --status=invalid --rea"),
        ("setup server URL has no file fallback", "daynight setup --server-url nor"),
        ("setup review repository has no file fallback", "daynight setup --review-repo nor"),
        ("used setup server URL is hidden", "daynight setup --server-url https://service.example --server-u"),
        ("used setup token stdin flag is hidden", "daynight setup --server-token-stdin --server-t"),
        ("setup token stdin flag has no secret value completion", "daynight setup --server-token-stdin nor"),
        ("remote has no file fallback", "daynight review add-repo nor"),
        ("project name has no file fallback", "daynight project create nor"),
        ("project repo has no file fallback", "daynight project create --repo nor"),
        ("removed project name flag has no candidate", "daynight project create --na"),
        ("project repo has no option fallback", "daynight project create --repo --na"),
        ("quoted project text has no file fallback", 'daynight project create "nor'),
        ("project ID has no file fallback", "daynight project show nor"),
        ("removed project name flag stops completion", 'daynight project create --name "Day Night" --re'),
        ("project name after repo has no file fallback", "daynight project create --repo remote nor"),
        ("terminated project name has no file fallback", "daynight project create --repo remote -- nor"),
        ("terminated dash name has no candidate", "daynight project create --repo remote -- -leading"),
        ("terminated name cannot complete options", "daynight project create --repo remote -- --re"),
        ("terminator stops options after name", "daynight project create --repo remote -- -leading --re"),
        ("review terminator remains unsupported", "daynight review add-repo -- --pa"),
        ("used project repo is hidden", "daynight project create --repo git@github.com:acme/repo.git --re"),
        ("used project JSON is hidden", "daynight project list --json --js"),
        ("task title has no file fallback", "daynight task create --title nor"),
        ("task attachment ID has no file fallback", "daynight task attachment list nor"),
        ("task attachment target has no file fallback", "daynight task attachment put task-id source --path nor"),
        ("task attachment path has no file fallback", "daynight task attachment read task-id nor"),
        ("task attachment terminated path has no candidate", "daynight task attachment read task-id -- -draft.md"),
        ("task attachment terminator stops options", "daynight task attachment read task-id -- --pro"),
        ("task description has no file fallback", "daynight task create --description nor"),
        ("task inline title has no file fallback", "daynight task create --title=nor"),
        ("task inline description has no option fallback", "daynight task create --description=--pro"),
        ("task empty inline description has no file fallback", "daynight task create --description="),
        ("task PR URL has no file fallback", "daynight task create --pull-request-url nor"),
        ("task PR title has no file fallback", "daynight task update task-id --pull-request-title nor"),
        ("task empty inline PR text has no file fallback", "daynight task create --pull-request-url="),
        ("task dependency has no file fallback", "daynight task create --depends-on nor"),
        ("task external dependency has no file fallback", "daynight task create --external-depends-on nor"),
        ("task project has no file fallback", "daynight task list --project nor"),
        ("task ID has no file fallback", "daynight task show nor"),
        ("task delete consumed dependency removal is hidden", "daynight task delete task-id --remove-depends --remove-dep"),
        ("task delete dependency removal rejects inline value", "daynight task delete task-id --remove-depends=true --pro"),
        ("task version has no file fallback", "daynight task update task-id --if-version nor"),
        ("task create cannot set automatic permission", "daynight task create --title Test --allow-ag"),
        ("invalid platform stops completion", "daynight task list --compatible-platform=darwin --rea"),
        ("task create cannot clear platform", "daynight task create --clear-required-plat"),
        ("invalid permission stops completion", "daynight task list --allow-agents=invalid --rea"),
        ("removed task update status has no candidate", "daynight task update task-id --sta"),
        ("removed inline task update status has no candidate", "daynight task update task-id --status=in"),
        ("removed task update status stops completion", "daynight task update task-id --status todo --pro"),
        ("removed inline task update status stops completion", "daynight task update task-id --status=todo --pro"),
        ("task ready limit has no file fallback", "daynight task ready --limit nor"),
        ("used task inline scalar status is hidden", "daynight task list --status=done --sta"),
        ("invalid inline task status stops completion", "daynight task list --status=invalid --rea"),
        ("removed task status stops completion", "daynight task list --status proposed --rea"),
        ("removed setter status stops completion", "daynight task set-status task-id proposed --pro"),
        ("removed approve command", "daynight task approve task-id --pro"),
        ("removed unapprove command", "daynight task unapprove task-id --pro"),
        ("removed complete command", "daynight task complete task-id --pro"),
        ("removed claim command", "daynight task claim task-id --pro"),
        ("invalid separate task status stops completion", "daynight task list --status invalid --rea"),
        ("empty dependency stops completion", "daynight task create --depends-on= --dep"),
        ("inline switch has no candidate fallback", "daynight task list --ready=true --sta"),
        ("inline directory remains unsupported", "daynight review add-repo acme/repo --path=nor"),
        ("used path is hidden", "daynight review add-repo acme/repo --path normal-directory/ --pa"),
        ("consumed shell choice is hidden", "daynight completion bash zs"),
        ("nonexistent directory leaf", "daynight review add-repo --path missing-leaf"),
        ("unknown option stops completion", "daynight review add-repo --bad --pa"),
        ("terminal help stops completion", "daynight review --help ru"),
        ("version does not inherit", "daynight review --ver"),
    ]
    for action, version in [("set-status", "9007199254740991"), ("set-status", "9007199254740993"), ("set-status", "9223372036854775807")]:
        cases.extend([
            (f"task {action} version option", f"daynight task {action} task-id done --if-ver\t", ["task", action, "task-id", "done", "--if-version"]),
            (f"task {action} explicit project", f"daynight task {action} task-id done --pro\t", ["task", action, "task-id", "done", "--project"]),
            (f"task {action} help", f"daynight task {action} --he\t", ["task", action, "--help"]),
            (f"task {action} separate int64 version", f"daynight task {action} task-id done --if-version {version} --pro\t", ["task", action, "task-id", "done", "--if-version", version, "--project"]),
            (f"task {action} inline int64 version", f"daynight task {action} task-id done --if-version={version} --pro\t", ["task", action, "task-id", "done", f"--if-version={version}", "--project"]),
            (f"task {action} int64 version before ID", f"daynight task {action} --if-version={version} task-id done --pro\t", ["task", action, f"--if-version={version}", "task-id", "done", "--project"]),
        ])
        unchanged.extend([
            (f"task {action} ID has no file fallback", f"daynight task {action} nor"),
            (f"task {action} version has no file fallback", f"daynight task {action} task-id done --if-version nor"),
            (f"task {action} inline version has no file fallback", f"daynight task {action} task-id done --if-version=nor"),
            (f"task {action} project has no file fallback", f"daynight task {action} task-id done --project nor"),
            (f"task {action} used int64 version is hidden", f"daynight task {action} task-id done --if-version={version} --if-ver"),
            (f"task {action} status has no candidate", f"daynight task {action} task-id done --sta"),
            (f"task {action} terminal help stops completion", f"daynight task {action} --help --pro"),
        ])
    lifecycle_commands = ("task set-status",)
    lifecycle_choices = set()
    lifecycle_rejections = {
        "removed task update status has no candidate",
        "removed inline task update status has no candidate",
        "removed task update status stops completion",
        "removed inline task update status stops completion",
    }
    cases.extend([
        ("short command " + name, "dn " + keys.removeprefix("daynight "), expected)
        for name, keys, expected in cases
        if name.startswith(lifecycle_commands) or name in lifecycle_choices
    ])
    unchanged.extend([
        ("short command " + name, "dn " + line.removeprefix("daynight "))
        for name, line in unchanged
        if name.startswith(lifecycle_commands) or name in lifecycle_rejections
    ])
    return cases, unchanged


def run_shell(label, binary, kind, script, directory, evidence, zsh_root):
    environment = zsh_environment(directory, zsh_root) if kind == "zsh" else dict(os.environ)
    environment.pop("FPATH", None)
    environment.update({"HOME": str(directory / "home"), "ZDOTDIR": str(directory / "home"), "INPUTRC": "/dev/null", "TERM": "xterm", "LC_ALL": "C.UTF-8", "HISTFILE": "/dev/null", "PATH": str(directory / "bin") + os.pathsep + os.environ["PATH"]})
    shell = Terminal(binary, kind, directory, environment, shell_setup(kind, script))
    receipt = {"shell": label, "binary": binary, "version": version(binary), "editor_readiness_proof": shell.readiness_proof, "capture_reset_proof": shell.capture_reset_proof, "scenarios": []}
    evidence.append(receipt)
    try:
        cases, unchanged = scenarios()
        cases.append(("home directory", "daynight review add-repo --path ~/hom\t", ["review", "add-repo", "--path", str(directory / "home" / "home-directory") + "/"]))
        for name, keys, expected in cases:
            line, cursor, output = shell.complete(keys)
            if open_quote(line):
                shell.send(open_quote(line))
            actual = shell.execute()
            native_expected = list(expected)
            # ZLE removes an automatically added directory slash when accepting the line.
            directory_option = next((option for option in ["--path", "--review-path"] if option in expected), None)
            if kind == "zsh" and directory_option is not None:
                path_index = expected.index(directory_option) + 1
                if path_index < len(expected) and path_index < len(actual) and expected[path_index].endswith("/") and actual[path_index] == expected[path_index][:-1]:
                    native_expected[path_index] = expected[path_index][:-1]
            result = {"name": name, "line": line, "cursor": cursor, "argv": actual, "passed": actual == native_expected}
            receipt["scenarios"].append(result)
            if actual != native_expected:
                raise AssertionError(f"{label}: {name}: expected {native_expected!r}, received {actual!r}, line={line!r}, terminal={output!r}")
            if name in ["root command and local directory collision", "short root command and local directory collision"] and line != keys.split()[0] + " review ":
                raise AssertionError(f"{label}: command completion must append a space despite the local review directory: {line!r}")
            print(f"PASS {label}: {name}", flush=True)
        for name, line in unchanged:
            actual, cursor, output = shell.complete(line + "\t")
            result = {"name": name, "line": actual, "cursor": cursor, "passed": actual == line}
            receipt["scenarios"].append(result)
            shell.clear()
            if actual != line:
                raise AssertionError(f"{label}: {name}: expected unchanged {line!r}, received {actual!r}, terminal={output!r}")
            print(f"PASS {label}: {name}", flush=True)
        for name, line, candidates in [
            ("empty root prefix", "daynight ", ["login", "logout", "review", "update", "completion", "project", "task", "setup"]),
            ("empty short root prefix", "dn ", ["login", "logout", "review", "update", "completion", "project", "task", "setup"]),
            ("empty setup prefix", "daynight setup ", ["--server-url", "--server-token-stdin", "--review-repo", "--review-path"]),
            ("empty review prefix", "daynight review ", ["run", "list", "ls", "add-repo"]),
            ("empty project prefix", "daynight project ", ["create", "list", "show"]),
            ("empty project create prefix", "daynight project create ", ["--repo"]),
            ("empty task prefix", "daynight task ", ["create", "list", "ready", "show", "update", "set-status", "delete", "graph", "attachment"]),
            ("empty task attachment prefix", "daynight task attachment ", ["put", "list", "read", "remove"]),
            ("empty separate task status", "daynight task list --status ", ["todo", "in_progress", "done"]),
            ("empty inline task status", "daynight task list --status=", ["todo", "in_progress", "done"]),
            ("short command empty task prefix", "dn task ", ["create", "list", "ready", "show", "update", "set-status", "delete", "graph", "attachment"]),
            ("short command empty separate task status", "dn task list --status ", ["todo", "in_progress", "done"]),
            ("short command empty inline task status", "dn task list --status=", ["todo", "in_progress", "done"]),
            ("empty positional status", "daynight task set-status task-id ", ["todo", "in_progress", "done"]),
            ("short command empty positional status", "dn task set-status task-id ", ["todo", "in_progress", "done"]),
            ("empty shell prefix", "daynight completion ", ["bash", "zsh", "setup"]),
            ("empty setup shell choice", "daynight completion setup --shell ", ["bash", "zsh"]),
        ]:
            actual, cursor, output = shell.complete(line + "\t\t")
            missing = [candidate for candidate in candidates if candidate not in output]
            receipt["scenarios"].append({"name": name, "line": actual, "cursor": cursor, "passed": not missing})
            shell.clear()
            if missing:
                raise AssertionError(f"{label}: {name}: missing candidates {missing!r}: {output!r}")
            print(f"PASS {label}: {name}", flush=True)
    finally:
        receipt["transcript"] = bytes(shell.transcript).decode(errors="replace")
        shell.close()


def setup_fixture(directory, kind, zsh_root):
    (directory / "home").mkdir(parents=True)
    (directory / "bin").mkdir()
    environment = zsh_environment(directory, zsh_root, disable_rcs=False) if kind == "zsh" else dict(os.environ)
    environment.update({"HOME": str(directory / "home"), "INPUTRC": "/dev/null", "TERM": "xterm", "LC_ALL": "C.UTF-8", "HISTFILE": "/dev/null", "PATH": str(directory / "bin") + os.pathsep + os.environ["PATH"]})
    for name in ["BASH_ENV", "ENV"]:
        environment.pop(name, None)
    environment["SHELL"] = "/bin/zsh" if kind == "bash" else "/bin/bash"
    if kind == "bash":
        environment.pop("ZDOTDIR", None)
    log = directory / "generation.log"
    shim = directory / "bin/daynight"
    shim.write_text("#!/bin/sh\nif [ \"$1\" = completion ] && { [ \"$2\" = bash ] || [ \"$2\" = zsh ]; }; then printf '%s\\n' \"$2\" >>" + shlex.quote(str(log)) + "; fi\nexec " + shlex.quote(executable("DAYNIGHT_TEST_NODE", "node")) + " " + shlex.quote(str(PACKAGE / "dist/main.js")) + ' "$@"\n')
    shim.chmod(0o755)
    return environment


def invoke_setup(binary, kind, directory, environment, options=(), implicit=False, success=True):
    command = [str(directory / "bin/daynight"), "completion", "setup", *options]
    if implicit:
        arguments = [binary, "--noprofile", "--norc", "-c"] if kind == "bash" else [binary, "-d", "-c"]
        command = [*arguments, shlex.join(command) + "; _daynight_status=$?; exit $_daynight_status"]
    result = subprocess.run(command, cwd=directory, env=environment, capture_output=True, text=True, timeout=15)
    if (result.returncode == 0) != success:
        raise AssertionError(f"Unexpected setup result ({'success' if success else 'failure'} required): {result!r}")
    return {"exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


def generation_count(directory):
    log = directory / "generation.log"
    return len(log.read_text().splitlines()) if log.exists() else 0


def startup_probe(label, binary, kind, directory, environment, profile, login=False, repeat=True, explicit_source=False):
    # Neither registration nor compinit is installed by the editor harness: startup owns both.
    registered = "complete -p daynight >/dev/null 2>&1 && complete -p dn >/dev/null 2>&1" if kind == "bash" else '(( $+functions[compdef] )) && [[ -n ${_comps[daynight]-} && ${_comps[dn]-} == ${_comps[daynight]} ]]'
    guard = "source " + shlex.quote(str(profile)) + " || exit 93; " if explicit_source else ""
    guard += registered + " || exit 92; "
    if repeat:
        guard += "source " + shlex.quote(str(profile)) + " || exit 93; "
    startup = ["--noprofile", "--norc", "-i"] if explicit_source and kind == "bash" else ["-l", "-i"] if login else ["-i"] if kind == "bash" else ["-d", "-i"]
    shell = Terminal(binary, kind, directory, environment, guard + shell_setup(kind, None), startup=startup)
    try:
        loads = generation_count(directory)
        if loads != 1:
            raise AssertionError(f"{label}: startup and repeated sourcing must load exactly once, received {loads}")
        completions = []
        for command in ["daynight", "dn"]:
            line, cursor, output = shell.complete(command + " comp\t")
            actual = shell.execute()
            if actual != ["completion"]:
                raise AssertionError(f"{label}: installed startup completion failed for {command}: {actual!r}, {output!r}")
            completions.append({"command": command, "line": line, "cursor": cursor, "argv": actual})
        if generation_count(directory) != loads:
            raise AssertionError(f"{label}: Tab completion started the CLI")
        return {"login": login, "completions": completions, "generationCalls": loads, "editor_readiness_proof": shell.readiness_proof, "capture_reset_proof": shell.capture_reset_proof, "transcript": bytes(shell.transcript).decode(errors="replace"), "passed": True}
    finally:
        shell.close()


def run_setup_acceptance(selected, directory, evidence, zsh_root):
    for label, binary, kind in selected:
        receipt = {"shell": label, "version": version(binary), "scenarios": []}
        evidence.append(receipt)

        def fixture(name):
            target = directory / (label.replace(" ", "-") + "-" + name)
            target.mkdir()
            return target, setup_fixture(target, kind, zsh_root)

        def passed(name, **details):
            receipt["scenarios"].append({"name": name, **details, "passed": True})
            print(f"PASS {label} setup: {name}", flush=True)

        fresh, environment = fixture("fresh")
        first = invoke_setup(binary, kind, fresh, environment, implicit=True)
        home = fresh / "home"
        profile = home / (".bashrc" if kind == "bash" else ".zshrc")
        expected = [profile, home / ".bash_profile"] if kind == "bash" else [profile]
        if not all(path.is_file() for path in expected):
            raise AssertionError(f"{label}: setup did not create expected startup files: {expected!r}")
        original = {path: path.read_bytes() for path in expected}
        second = invoke_setup(binary, kind, fresh, environment, implicit=True)
        if any(path.read_bytes() != contents for path, contents in original.items()):
            raise AssertionError(f"{label}: repeating setup changed installed startup files")
        passed("caller detection, fresh install and byte-identical repeat", first=first, repeated=second)
        probe = startup_probe(label, binary, kind, fresh, environment, profile)
        passed("fresh interactive startup and repeated source load once with real Tab", probe=probe)
        if kind == "bash":
            (fresh / "generation.log").unlink()
            probe = startup_probe(label, binary, kind, fresh, environment, home / ".bash_profile", login=True)
            passed("fresh login startup and repeated source load once with real Tab", probe=probe)

        manual, environment = fixture("manual")
        rc = manual / "manual.rc"
        original = ("# A manually installed completion loader.\nsource <(daynight completion " + kind + ")\n").encode()
        rc.write_bytes(original)
        invoke_setup(binary, kind, manual, environment, ["--shell", kind, "--rc-file", str(rc)])
        if rc.read_bytes() != original:
            raise AssertionError(f"{label}: setup duplicated the documented manual loader")
        passed("documented manual loader is preserved byte for byte")

        custom, environment = fixture("custom")
        rc = custom / "custom.rc"
        prefix = b"# Existing CRLF configuration\r\nexport DAYNIGHT_CUSTOM_PRESENT=preserved"
        rc.write_bytes(prefix)
        rc.chmod(0o640)
        link = custom / "linked.rc"
        link.symlink_to(rc.name)
        invoke_setup(binary, kind, custom, environment, ["--shell", kind, "--rc-file", str(link)])
        first = rc.read_bytes()
        if not link.is_symlink() or rc.stat().st_mode & 0o777 != 0o640 or not first.startswith(prefix):
            raise AssertionError(f"{label}: setup replaced a symlink, permissions or existing contents")
        invoke_setup(binary, kind, custom, environment, ["--shell", kind, "--rc-file", str(link)])
        if rc.read_bytes() != first or any((custom / "home" / name).exists() for name in [".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc"]):
            raise AssertionError(f"{label}: explicit --rc-file was not isolated and idempotent")
        probe = startup_probe(label, binary, kind, custom, environment, link, explicit_source=True)
        passed("custom symlink with CRLF and no final newline preserves contents and mode and works with Tab", probe=probe)
        readonly = custom / "readonly.rc"
        readonly.write_text("# A fresh file requiring an install.\n")
        readonly.chmod(0o400)
        try:
            failure = invoke_setup(binary, kind, custom, environment, ["--shell", kind, "--rc-file", str(readonly)], success=False)
        finally:
            readonly.chmod(0o640)
        passed("write failure is reported", result=failure)

        rejected, environment = fixture("directory")
        failure = invoke_setup(binary, kind, rejected, environment, ["--shell", kind, "--rc-file", str(rejected / "home")], success=False)
        passed("non-file rc target fails", result=failure)
        malformed = rejected / "malformed.rc"
        malformed.write_text("# >>> daynight completion >>>\n")
        before = malformed.read_bytes()
        failure = invoke_setup(binary, kind, rejected, environment, ["--shell", kind, "--rc-file", str(malformed)], success=False)
        if malformed.read_bytes() != before:
            raise AssertionError(f"{label}: setup modified a damaged managed block")
        passed("damaged managed block fails without modifying it", result=failure)

        generation, environment = fixture("generation-failure")
        rc = generation / "generated.rc"
        invoke_setup(binary, kind, generation, environment, ["--shell", kind, "--rc-file", str(rc)])
        if kind == "zsh":
            zsh_environment(generation, zsh_root)
        for name, body, expected_status in [
            ("generator failure", "printf 'injected generation failure\\n' >&2\nexit 73\n", 73),
            ("generated script failure", "printf 'return 74\\n'\n", 74),
        ]:
            (generation / "bin/daynight").write_text("#!/bin/sh\n" + body)
            registered = "complete -p daynight >/dev/null 2>&1" if kind == "bash" else '[[ -n ${_comps[daynight]-} ]]'
            source = "source " + shlex.quote(str(rc)) + "; _daynight_status=$?; if " + registered + "; then exit 99; fi; exit $_daynight_status"
            arguments = [binary, "--noprofile", "--norc", "-i", "-c", source] if kind == "bash" else [binary, "-d", "-i", "-c", source]
            result = subprocess.run(arguments, cwd=generation, env=environment, input="", capture_output=True, text=True, timeout=15)
            if result.returncode != expected_status:
                raise AssertionError(f"{label}: {name} must preserve failure status {expected_status}: {result!r}")
            passed(name + " remains nonzero and unregistered", exitCode=result.returncode, stderr=result.stderr)

        if kind == "bash":
            for login_name in [".bash_login", ".profile"]:
                target, environment = fixture(login_name[1:])
                login = target / "home" / login_name
                prefix = "export DAYNIGHT_EXISTING_PROFILE=preserved\n"
                login.write_text(prefix)
                invoke_setup(binary, kind, target, environment, ["--shell", kind])
                if (target / "home/.bash_profile").exists() or not login.read_text().startswith(prefix):
                    raise AssertionError(f"{label}: setup masked or replaced existing {login_name}")
                probe = startup_probe(label, binary, kind, target, environment, login, login=True)
                if login_name == ".profile":
                    result = subprocess.run(["/bin/sh", "-c", '. "$HOME/.profile"; printf "%s" "$DAYNIGHT_EXISTING_PROFILE"'], cwd=target, env=environment, capture_output=True, text=True, timeout=10)
                    if result.returncode != 0 or result.stdout != "preserved":
                        raise AssertionError(f"Bash setup made .profile unsafe for a POSIX shell: {result!r}")
                passed("existing " + login_name + " remains effective and works with Tab", probe=probe)
        else:
            reused, environment = fixture("compinit-reuse")
            rc = reused / "home/.zshrc"
            initialization_log = reused / "unexpected-compinit.log"
            rc.write_text("autoload -Uz compinit; compinit -D\ncompinit() { print -r -- called >>" + shlex.quote(str(initialization_log)) + "; return 82; }\n")
            invoke_setup(binary, kind, reused, environment, ["--shell", kind])
            probe = startup_probe(label, binary, kind, reused, environment, rc, repeat=False)
            if initialization_log.exists():
                raise AssertionError("zsh setup reran compinit despite an initialized completion system")
            passed("existing compinit is reused", probe=probe)

            failed, environment = fixture("compinit-failure")
            invoke_setup(binary, kind, failed, environment, ["--shell", kind])
            zsh_environment(failed, zsh_root)
            rc = failed / "home/.zshrc"
            source = "fpath=(); source " + shlex.quote(str(rc)) + "; _daynight_status=$?; [[ -z ${_comps[daynight]-} ]] || exit 99; exit $_daynight_status"
            result = subprocess.run([binary, "-d", "-i", "-c", source], cwd=failed, env=environment, input="", capture_output=True, text=True, timeout=15)
            if result.returncode == 0 or result.returncode == 99 or generation_count(failed) != 0 or "compinit" not in result.stderr:
                raise AssertionError(f"zsh initialization failure must remain visible and leave completion unregistered: {result!r}")
            passed("compinit failure remains nonzero and unregistered", exitCode=result.returncode, stderr=result.stderr)
            insecure = failed / "insecure-functions"
            insecure.mkdir(mode=0o777)
            insecure.chmod(0o777)
            (insecure / "_insecure").write_text("#compdef insecure\n")
            source = "fpath=(" + shlex.quote(str(insecure)) + " $fpath); source " + shlex.quote(str(rc)) + "; _daynight_status=$?; [[ -z ${_comps[daynight]-} ]] || exit 99; exit $_daynight_status"
            result = subprocess.run([binary, "-d", "-i", "-c", source], cwd=failed, env=environment, input="n\n", capture_output=True, text=True, timeout=15)
            if result.returncode == 0 or result.returncode == 99 or generation_count(failed) != 0 or "compinit" not in result.stderr:
                raise AssertionError(f"zsh setup bypassed the completion security audit: {result!r}")
            passed("compinit security audit rejects insecure function directories", exitCode=result.returncode, stderr=result.stderr)

            for zdotdir in [None, "absolute", "relative"]:
                target, environment = fixture("zdotdir-" + ("unset" if zdotdir is None else zdotdir))
                if zdotdir is None:
                    environment.pop("ZDOTDIR", None)
                    startup_directory = target / "home"
                else:
                    startup_directory = target / "custom-dotdir"
                    startup_directory.mkdir(exist_ok=True)
                    (startup_directory / ".zshenv").write_bytes((target / "home/.zshenv").read_bytes())
                    environment["ZDOTDIR"] = startup_directory.name if zdotdir == "relative" else str(startup_directory)
                invoke_setup(binary, kind, target, environment, ["--shell", kind])
                rc = startup_directory / ".zshrc"
                if not rc.is_file():
                    raise AssertionError(f"zsh setup ignored ZDOTDIR={zdotdir!r}")
                probe = startup_probe(label, binary, kind, target, environment, rc)
                passed("ZDOTDIR " + repr(zdotdir) + " is honored with real startup Tab", probe=probe)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shell", choices=["all", "bash42", "bash", "zsh"], default="all")
    arguments = parser.parse_args()
    temporary = ROOT / ".tmp"
    temporary.mkdir(exist_ok=True)
    receipt_path = Path(os.environ.get("DAYNIGHT_COMPLETION_EVIDENCE", str(temporary / "completion-evidence.json"))).resolve()
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    evidence = {"shells": [], "setup": [], "passed": False}
    try:
        with tempfile.TemporaryDirectory(prefix="completion-acceptance-", dir=temporary) as path:
            directory = Path(path)
            (directory / "bin").mkdir()
            for command in ["node", "daynight"]:
                sentinel = directory / "bin" / command
                sentinel.write_text("#!/bin/sh\nprintf x >>" + shlex.quote(str(directory / "forbidden-executions.log")) + "\nprintf '__DAYNIGHT_FORBIDDEN_NODE__\\n'\nexit 99\n")
                sentinel.chmod(0o755)
            for name in ["review", "project", "task", "setup", "normal-directory", "space directory", "中文目录", "apostrophe'directory", 'double"directory', "dollar$directory", "backtick`directory", "colon:directory", "~literal", "home/home-directory"]:
                (directory / name).mkdir(parents=True)
            scripts = {}
            for kind in ["bash", "zsh"]:
                result = subprocess.run([executable("DAYNIGHT_TEST_NODE", "node"), str(PACKAGE / "dist/main.js"), "completion", kind], check=True, capture_output=True, text=True, timeout=15, cwd=PACKAGE)
                scripts[kind] = directory / ("completion." + kind)
                scripts[kind].write_text(result.stdout)
            selected = []
            if arguments.shell in ["all", "bash42"]:
                binary = executable("DAYNIGHT_TEST_BASH42", "bash4.2")
                if not re.search(r"version 4\.2(?:\.|\()", version(binary)):
                    raise AssertionError("DAYNIGHT_TEST_BASH42 must identify a real Bash 4.2 binary")
                selected.append(("Bash 4.2", binary, "bash"))
            if arguments.shell in ["all", "bash"]:
                binary = executable("DAYNIGHT_TEST_BASH", "bash")
                if not re.search(r"version [5-9]\.", version(binary)):
                    raise AssertionError("DAYNIGHT_TEST_BASH must identify a modern Bash >=5")
                selected.append(("modern Bash", binary, "bash"))
            if arguments.shell in ["all", "zsh"]:
                selected.append(("zsh", executable("DAYNIGHT_TEST_ZSH", "zsh"), "zsh"))
            for label, binary, kind in selected:
                subprocess.run([binary, "-n", str(scripts[kind])], check=True, timeout=10)
                run_shell(label, binary, kind, scripts[kind], directory, evidence["shells"], os.environ.get("DAYNIGHT_TEST_ZSH_ROOT"))
            run_setup_acceptance(selected, directory, evidence["setup"], os.environ.get("DAYNIGHT_TEST_ZSH_ROOT"))
            if arguments.shell in ["all", "zsh"]:
                binary = executable("DAYNIGHT_TEST_ZSH", "zsh")
                source = "typeset -A _comps; source " + shlex.quote(str(scripts["zsh"])) + "; _dn_status=$?; print -r -- __REGISTERED__${_comps[daynight]-}; exit $_dn_status"
                environment = zsh_environment(directory, os.environ.get("DAYNIGHT_TEST_ZSH_ROOT"))
                result = subprocess.run([binary, "-d", "-c", source], env=environment, capture_output=True, text=True, timeout=10)
                if result.returncode == 0 or "compinit" not in result.stderr or result.stdout.strip() != "__REGISTERED__":
                    raise AssertionError(f"zsh without compinit must fail with a clear diagnostic: {result!r}")
                evidence["zsh_without_compinit"] = {"exitCode": result.returncode, "stderr": result.stderr, "passed": True}
                print("PASS zsh: loading without compinit fails clearly", flush=True)
            evidence["passed"] = True
    finally:
        receipt_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
        print(f"Completion evidence: {receipt_path.relative_to(ROOT) if receipt_path.is_relative_to(ROOT) else receipt_path}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
