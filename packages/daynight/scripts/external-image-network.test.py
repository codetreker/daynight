"""Offline safety checks; packet traversal is verified on the hosted Linux VM."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace


SCRIPT = Path(__file__).with_name("external-image-network.py")
SCRATCH = SCRIPT.parents[3] / ".tmp" / "external-image-network-tests"
spec = importlib.util.spec_from_file_location("image_network", SCRIPT)
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)


class AdmissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        SCRATCH.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        try:
            SCRATCH.rmdir()
        except OSError:
            pass  # Another concurrent invocation can own a temporary child.

    def test_setup_refuses_non_hosted_environment_before_creating_state(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            state = Path(directory) / "absent"
            environment = dict(os.environ, GITHUB_ACTIONS="false")
            result = subprocess.run(
                ["python3", str(SCRIPT), "setup", str(state), "8080",
                 "http://example.org/a.png", "https://example.org/a.png"],
                env=environment, capture_output=True, text=True, timeout=5,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("GitHub-hosted Linux", result.stderr)
            self.assertFalse(state.exists())

    def test_asset_inventory_preserves_dual_stack_routes_without_default_routes(self):
        addresses = [{"addr_info": [
            {"family": "inet", "local": "10.20.1.2", "prefixlen": 24},
            {"family": "inet6", "local": "fd12::2", "prefixlen": 64},
        ]}]
        routes = [{"dst": "default", "gateway": "10.20.1.1"},
                  {"dst": "172.19.0.0/16"}, {"dst": "2001:db8:1::/64"}]
        result = network.protected_cidrs(addresses, routes)
        self.assertIn("10.20.1.0/24", result)
        self.assertIn("172.19.0.0/16", result)
        self.assertIn("fd12::/64", result)
        self.assertIn("2001:db8:1::/64", result)
        self.assertNotIn("0.0.0.0/0", result)
        self.assertNotIn("::/0", result)

    def test_fixture_urls_refuse_credentials_and_non_http_sources(self):
        for values in (["file:///tmp/image.png", "https://example.org/a.png"],
                       ["http://user:secret@example.org/a.png", "https://example.org/a.png"],
                       ["http://example.org/a.png", "https://example.org/a.png#fragment"]):
            with self.subTest(values=values), self.assertRaises(ValueError):
                network.source_urls(values)

    def test_inventory_errors_identify_the_field_and_value(self):
        cases = [
            (lambda: network.protected_cidrs([], [{"gateway": "runner.example"}]),
             r"ip route\[0\]\.gateway: 'runner.example'"),
            (lambda: network.protected_cidrs([], [{"dst": "invalid"}]),
             r"ip route\[0\]\.dst: 'invalid'"),
            (lambda: network.protected_cidrs([{"addr_info": [{"family": "inet", "local": "bad", "prefixlen": 24}]}], []),
             r"ip address\[0\]\.addr_info\[0\] local/prefixlen: 'bad/24'"),
            (lambda: network.protected_hosts("runner.example alias\n", [], "runner"),
             r"/etc/hosts line 1 address: 'runner.example'"),
        ]
        for operation, diagnostic in cases:
            with self.subTest(diagnostic=diagnostic), self.assertRaisesRegex(ValueError, diagnostic):
                operation()

        with self.assertRaisesRegex(ValueError, "<redacted invalid value>") as failure:
            network.protected_hosts("https://user:secret@example.org alias\n", [], "runner")
        self.assertNotIn("secret", str(failure.exception))
        with self.assertRaisesRegex(ValueError, "host row fields: 0='runner.example', 1=<redacted invalid value>") as failure:
            network.protected_hosts("runner.example user:secret\n", [], "runner")
        self.assertNotIn("secret", str(failure.exception))

    def test_runner_hostname_row_resolves_all_addresses_and_preserves_aliases(self):
        fqdn = "ip-10-0-141-0.us-west-2.compute.internal"
        short = "ip-10-0-141-0"
        answers = {fqdn: ["10.0.141.0", "2001:db8::1"], short: ["10.0.141.1", "2001:db8::2"]}
        def resolve(host, *args, **kwargs):
            return [(network.socket.AF_INET6 if ":" in address else network.socket.AF_INET,
                     network.socket.SOCK_STREAM, 0, "", (address, 0)) for address in answers[host]]
        hosts = f"10.0.141.1 extra.internal\n{fqdn} {short}\n10.20.1.2 protected.internal\n203.0.113.1 external.internal\n"
        with patch.object(network.socket, "getaddrinfo", side_effect=resolve):
            domains, cidrs, observed = network.protected_hosts(hosts, ["10.20.1.0/24"], short)
        self.assertEqual(domains, ["extra.internal", short, fqdn, "protected.internal"])
        self.assertEqual(set(cidrs), {"10.0.141.0/32", "10.0.141.1/32", "2001:db8::1/128", "2001:db8::2/128"})
        self.assertEqual(observed[0], {"source": "/etc/hosts line 2 alias", "alias": fqdn, "addresses": ["10.0.141.0", "2001:db8::1"]})

    def test_unrecognized_hostname_rows_and_unresolved_aliases_fail(self):
        fqdn, short = "runner.example", "runner"
        for hosts, hostname in ((f"{fqdn} {short}\n", "other"), (f"{fqdn} wrong\n", short),
                                (f"{fqdn} {short} extra\n", short), ("999.999.999.999 999\n", "999")):
            with self.subTest(hosts=hosts), self.assertRaisesRegex(ValueError, "/etc/hosts line 1"):
                network.protected_hosts(hosts, [], hostname)
        def resolve(host, *args, **kwargs):
            if host == short:
                raise network.socket.gaierror("not found")
            return [(network.socket.AF_INET, network.socket.SOCK_STREAM, 0, "", ("10.0.0.1", 0))]
        with patch.object(network.socket, "getaddrinfo", side_effect=resolve):
            with self.assertRaisesRegex(ValueError, "/etc/hosts line 1 alias.*runner"):
                network.protected_hosts(f"{fqdn} {short}\n", [], short)
        invalid_answers = [[], [(network.socket.AF_INET6, network.socket.SOCK_STREAM, 0, "", ("fe80::1%eth0", 0))],
                           [(network.socket.AF_INET, network.socket.SOCK_STREAM, 0, "", ("not-an-address", 0))]]
        for answers in invalid_answers:
            with self.subTest(answers=answers), patch.object(network.socket, "getaddrinfo", return_value=answers):
                with self.assertRaisesRegex(ValueError, "/etc/hosts line 1 alias"):
                    network.protected_hosts(f"{fqdn} {short}\n", [], short)

    def test_invalid_host_inventory_aborts_before_network_mutation(self):
        for problem in ("route", "address", "unresolved"):
            calls = []
            def fake_command(*args, **kwargs):
                calls.append(args)
                if args[0] == "dig":
                    return SimpleNamespace(stdout="93.184.216.34\n", returncode=0)
                if args[:3] == ("ip", "-j", "address"):
                    return SimpleNamespace(stdout="[]", returncode=0)
                if args[:3] == ("ip", "-j", "route"):
                    return SimpleNamespace(stdout=json.dumps([{"gateway": "runner.example"}] if problem == "route" else []), returncode=0)
                if args[:4] == ("ip", "-6", "-j", "route"):
                    return SimpleNamespace(stdout="[]", returncode=0)
                self.fail(f"Unexpected command before inventory rejection: {args}")
            hosts = "runner.example runner\n" if problem == "unresolved" else "999.999.999.999 alias\n"
            with self.subTest(problem=problem), tempfile.TemporaryDirectory(dir=SCRATCH) as directory, \
                 patch.dict(network.os.environ, {"SUDO_UID": "1001", "SUDO_GID": "1001"}), \
                 patch.object(network.shutil, "which", return_value="/tool"), \
                 patch.object(network, "command", side_effect=fake_command), \
                 patch.object(network, "service_assets", return_value={"protectedCidrs": [], "protectedDomains": []}), \
                 patch.object(network.socket, "gethostname", return_value="runner"), \
                 patch.object(network.socket, "getaddrinfo", side_effect=network.socket.gaierror("not found")), \
                 patch.object(network.Path, "read_text", return_value=hosts):
                diagnostic = {"route": r"ip route\[0\]\.gateway", "address": "/etc/hosts line 1 address", "unresolved": "/etc/hosts line 1 alias.*runner.example"}[problem]
                with self.assertRaisesRegex(ValueError, diagnostic):
                    network.setup(Path(directory) / "run", "8080", ["http://example.org/a.png", "https://example.org/a.png"])
                self.assertFalse((Path(directory) / "run").exists())
                self.assertFalse(any(call[0] in ("nft", "iptables") or "netns" in call for call in calls))

    def test_cleanup_keeps_network_when_process_exit_is_unconfirmed(self):
        calls = []
        def fake_command(*args, **kwargs):
            calls.append(args)
            absent = args[:3] in (("ip", "link", "show"), ("nft", "list", "table")) or "-C" in args
            return SimpleNamespace(returncode=1 if absent else 0,
                                   stdout="0" if args[:2] == ("sysctl", "-n") else "", stderr="")
        state = {"namespace": "dni-unit", "sinkNamespace": "dnis-unit", "interface": "dnicunit",
                 "sinkInterface": "dnisunit", "table": "dni_unit", "blockTable": "dnib_unit",
                 "originalForward": "0", "uid": 1001, "gid": 1001}
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory, \
             patch.object(network, "command", side_effect=fake_command), \
             patch.object(network.os, "chown"), \
             patch.object(network, "stop_namespace_processes", create=True,
                          side_effect=RuntimeError("Owned process exit is unconfirmed")):
            with self.assertRaisesRegex(RuntimeError, "process exit is unconfirmed"):
                network.cleanup(Path(directory), state)
            self.assertFalse(any("delete" in call or "-D" in call for call in calls))

    def test_sigkill_does_not_count_as_observed_process_exit(self):
        # A non-readable descriptor models a live pidfd; the signal is an OS
        # outcome boundary, while the actual wait and failure receipt run here.
        read_fd, write_fd = os.pipe()
        ticks = iter(range(50))
        signals = []
        def fake_path(*args):
            path = Path(*args)
            if str(path).startswith("/var/run/netns/"):
                return SimpleNamespace(exists=lambda: True, stat=lambda: SimpleNamespace(st_ino=7))
            if str(path) == "/proc/43210/ns/net":
                return SimpleNamespace(stat=lambda: SimpleNamespace(st_ino=7))
            if str(path) == "/proc/43210/stat":
                return SimpleNamespace(read_text=lambda: "43210 (fixture) S " + "0 " * 18 + "123")
            return path
        def fake_command(*args, **kwargs):
            return SimpleNamespace(stdout="43210" if args[-1] == "dni-unit" else "", returncode=0)
        try:
            with tempfile.TemporaryDirectory(dir=SCRATCH) as directory, \
                 patch.object(network, "Path", side_effect=fake_path), \
                 patch.object(network, "command", side_effect=fake_command), \
                 patch.object(network.os, "pidfd_open", create=True, side_effect=lambda pid: os.dup(read_fd)), \
                 patch.object(network.signal, "pidfd_send_signal", create=True,
                              side_effect=lambda fd, action: signals.append(action)), \
                 patch.object(network.time, "monotonic", side_effect=lambda: next(ticks)):
                with self.assertRaisesRegex(RuntimeError, "process exit is unconfirmed"):
                    network.stop_namespace_processes(Path(directory), {"namespace": "dni-unit", "sinkNamespace": "dnis-unit"})
                receipt = json.loads((Path(directory) / "network-processes.json").read_text())
                self.assertFalse(receipt["exited"])
                self.assertEqual(receipt["remaining"][0]["pid"], 43210)
                self.assertIn(network.signal.SIGKILL, signals)
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_exited_parent_does_not_hide_a_new_namespace_child(self):
        parent_read, parent_write = os.pipe()
        child_read, child_write = os.pipe()
        os.write(parent_write, b"exited")
        ticks = iter(range(50))
        scans = []
        def fake_path(*args):
            path = Path(*args)
            if str(path).startswith("/var/run/netns/"):
                return SimpleNamespace(exists=lambda: True, stat=lambda: SimpleNamespace(st_ino=7))
            if str(path).startswith("/proc/"):
                if str(path).endswith("/ns/net"):
                    return SimpleNamespace(stat=lambda: SimpleNamespace(st_ino=7))
                return SimpleNamespace(read_text=lambda: "43210 (fixture) S " + "0 " * 18 + "123")
            return path
        def fake_command(*args, **kwargs):
            if args[-1] != "dni-unit":
                return SimpleNamespace(stdout="", returncode=0)
            scans.append(1)
            return SimpleNamespace(stdout="43210" if len(scans) == 1 else "43211", returncode=0)
        try:
            with tempfile.TemporaryDirectory(dir=SCRATCH) as directory, \
                 patch.object(network, "Path", side_effect=fake_path), \
                 patch.object(network, "command", side_effect=fake_command), \
                 patch.object(network.os, "pidfd_open", create=True,
                              side_effect=lambda pid: os.dup(parent_read if pid == 43210 else child_read)), \
                 patch.object(network.signal, "pidfd_send_signal", create=True), \
                 patch.object(network.time, "monotonic", side_effect=lambda: next(ticks)):
                with self.assertRaisesRegex(RuntimeError, "process exit is unconfirmed"):
                    network.stop_namespace_processes(Path(directory), {"namespace": "dni-unit", "sinkNamespace": "dnis-unit"})
                receipt = json.loads((Path(directory) / "network-processes.json").read_text())
                self.assertEqual(receipt["remaining"][0]["pid"], 43211)
                self.assertGreater(len(scans), 1)
        finally:
            for descriptor in (parent_read, parent_write, child_read, child_write):
                os.close(descriptor)


if __name__ == "__main__":
    unittest.main()
