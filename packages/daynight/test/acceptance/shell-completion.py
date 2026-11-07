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
            with tempfile.NamedTemporaryFile(mode="w", prefix="shell-setup-", dir=cwd, delete=False) as setup_file:
                setup_file.write(setup + "\n")
                setup_path = Path(setup_file.name)
            try:
                self.send("source " + shlex.quote(str(setup_path)) + "\n")
                self.await_editor(prove_transition=True)
            finally:
                setup_path.unlink()
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
        os.close(self.fd)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            child, _ = os.waitpid(self.pid, os.WNOHANG)
            if child:
                break
            time.sleep(0.02)
        else:
            os.killpg(self.pid, signal.SIGKILL)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                child, _ = os.waitpid(self.pid, os.WNOHANG)
                if child:
                    break
                time.sleep(0.02)
            else:
                raise AssertionError("The shell did not exit after SIGKILL")


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


def run_shell(label, binary, kind, script, directory, evidence, zsh_root):
    environment = zsh_environment(directory, zsh_root) if kind == "zsh" else dict(os.environ)
    environment.pop("FPATH", None)
    environment.update({"HOME": str(directory / "home"), "ZDOTDIR": str(directory / "home"), "INPUTRC": "/dev/null", "TERM": "xterm", "LC_ALL": "C.UTF-8", "HISTFILE": "/dev/null", "PATH": str(directory / "bin") + os.pathsep + os.environ["PATH"]})
    shell = Terminal(binary, kind, directory, environment, shell_setup(kind, script))
    receipt = {"shell": label, "binary": binary, "version": version(binary), "editor_readiness_proof": shell.readiness_proof, "capture_reset_proof": shell.capture_reset_proof, "scenarios": []}
    evidence.append(receipt)
    try:
        for command in ["daynight", "dn"]:
            scenarios = [
                ("root", command + " comp\t", ["completion"]),
                ("webhook", command + " webh\t sec\t rot\t endpoint --mode o\t", ["webhook", "secret", "rotate", "endpoint", "--mode", "overlap"]),
            ]
            for name, keys, expected in scenarios:
                line, cursor, output = shell.complete(keys)
                actual = shell.execute()
                passed = actual == expected
                receipt["scenarios"].append({"name": f"{command} {name}", "line": line, "cursor": cursor, "argv": actual, "passed": passed})
                if not passed:
                    raise AssertionError(f"{label}: completion failed for {command} {name}: {actual!r}, terminal={output!r}")
                print(f"PASS {label}: {command} {name}", flush=True)
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


def invoke_setup(binary, kind, directory, environment):
    command = [str(directory / "bin/daynight"), "completion", "setup"]
    arguments = [binary, "--noprofile", "--norc", "-c"] if kind == "bash" else [binary, "-d", "-c"]
    command = [*arguments, shlex.join(command) + "; _daynight_status=$?; exit $_daynight_status"]
    result = subprocess.run(command, cwd=directory, env=environment, capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        raise AssertionError(f"Completion setup failed: {result!r}")
    return {"exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


def generation_count(directory):
    log = directory / "generation.log"
    return len(log.read_text().splitlines()) if log.exists() else 0


def startup_probe(label, binary, kind, directory, environment, login=False):
    # Neither registration nor compinit is installed by the editor harness: startup owns both.
    registered = "declare -F _daynight_completion >/dev/null && [ \"$(complete -p daynight 2>/dev/null)\" = 'complete -F _daynight_completion daynight' ] && [ \"$(complete -p dn 2>/dev/null)\" = 'complete -F _daynight_completion dn' ]" if kind == "bash" else '(( $+functions[compdef] && $+functions[_daynight] )) && [[ ${_comps[daynight]-} == _daynight && ${_comps[dn]-} == _daynight ]]'
    guard = registered + " || exit 92; "
    startup = ["-l", "-i"] if login else ["-i"] if kind == "bash" else ["-d", "-i"]
    shell = Terminal(binary, kind, directory, environment, guard + shell_setup(kind, None), startup=startup)
    try:
        loads = generation_count(directory)
        if loads != 1:
            raise AssertionError(f"{label}: startup must load completion once, received {loads}")
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
        first = invoke_setup(binary, kind, fresh, environment)
        home = fresh / "home"
        profile = home / (".bashrc" if kind == "bash" else ".zshrc")
        expected = [profile, home / ".bash_profile"] if kind == "bash" else [profile]
        if not all(path.is_file() for path in expected):
            raise AssertionError(f"{label}: setup did not create expected startup files: {expected!r}")
        passed("fresh install", result=first)
        probe = startup_probe(label, binary, kind, fresh, environment)
        passed("interactive startup with real Tab", probe=probe)
        if kind == "bash":
            (fresh / "generation.log").unlink()
            probe = startup_probe(label, binary, kind, fresh, environment, login=True)
            passed("login startup with real Tab", probe=probe)


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
            (directory / "home").mkdir()
            for command in ["node", "daynight"]:
                sentinel = directory / "bin" / command
                sentinel.write_text("#!/bin/sh\nprintf x >>" + shlex.quote(str(directory / "forbidden-executions.log")) + "\nprintf '__DAYNIGHT_FORBIDDEN_NODE__\\n'\nexit 99\n")
                sentinel.chmod(0o755)
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
