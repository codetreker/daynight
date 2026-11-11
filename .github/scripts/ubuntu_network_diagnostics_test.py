"""Tooling contracts for the read-only Ubuntu network collector."""

import contextlib
import errno
import importlib.util
import io
import json
import os
import pathlib
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SCRIPT = pathlib.Path(__file__).with_name('ubuntu-network-diagnostics.py').resolve()
SPEC = importlib.util.spec_from_file_location('ubuntu_network_diagnostics', SCRIPT)
DIAGNOSTICS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIAGNOSTICS)
ROOT = SCRIPT.parents[2]
SECRET = 'never-publish-this-credential'


class CollectorTests(unittest.TestCase):
    def setUp(self):
        (ROOT / '.tmp').mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='ubuntu-network-test-', dir=ROOT / '.tmp')
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)

    def assert_stopped(self, pid):
        result = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True,
                                text=True, timeout=2)
        self.assertTrue(result.returncode == 1 or result.stdout.strip().startswith('Z'),
                        f'Process remains active: {pid} ({result.stdout.strip()})')

    def test_deadline_kills_a_started_process_and_its_descendant(self):
        code = ('import json,os,subprocess,sys,time; '
                'child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(20)"]); '
                'print(json.dumps([os.getpid(),child.pid]),flush=True); time.sleep(20)')
        result = DIAGNOSTICS.run_process([sys.executable, '-u', '-c', code], 0.6)
        self.assertEqual(result['status'], 'timeout')
        self.assertEqual(result['cleanup'], 'group_killed')
        self.assertEqual(result['exitCode'], -signal.SIGKILL)
        self.assertLess(result['durationSeconds'], 2)
        pids = json.loads(result['stdout'])
        for pid in pids:
            self.assert_stopped(pid)

    def test_deadline_includes_pipes_inherited_after_parent_exits(self):
        code = ('import subprocess,sys; '
                'child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(20)"]); '
                'print(child.pid,flush=True)')
        result = DIAGNOSTICS.run_process([sys.executable, '-u', '-c', code], 0.5)
        self.assertEqual(result['status'], 'timeout')
        self.assertEqual(result['exitCode'], 0)
        self.assertEqual(result['cleanup'], 'group_killed')
        self.assert_stopped(int(result['stdout']))

    def test_exit_failure_and_safe_stderr_classification_are_retained(self):
        code = f'import sys; print("temporary failure user:{SECRET}@proxy.invalid",file=sys.stderr); sys.exit(27)'
        raw = DIAGNOSTICS.run_process([sys.executable, '-c', code], 2)
        public = DIAGNOSTICS.public_process(raw)
        self.assertEqual(public['status'], 'command_failed')
        self.assertEqual(public['exitCode'], 27)
        self.assertIn('dns_temporary_failure', public['stderr']['recognizedErrors'])
        self.assertGreater(public['stderr']['capturedBytes'], 0)
        self.assertNotIn(SECRET, json.dumps(public))
        self.assertNotIn('proxy.invalid', json.dumps(public))

    def test_missing_tool_and_output_overflow_remain_distinct(self):
        absent = DIAGNOSTICS.run_process([str(self.directory / 'missing')], 1)
        self.assertEqual(absent['status'], 'unavailable')
        self.assertEqual(absent['error']['errno'], errno.ENOENT)
        loud = DIAGNOSTICS.run_process([sys.executable, '-c', 'print("x" * 100000)'], 2)
        self.assertEqual(loud['status'], 'output_limit')
        self.assertLessEqual(len(loud['stdout']), DIAGNOSTICS.OUTPUT_LIMIT)
        self.assertTrue(DIAGNOSTICS.public_process(loud)['stderr']['truncated'])

    def test_expired_collection_budget_does_not_spawn(self):
        marker = self.directory / 'must-not-exist'
        result = DIAGNOSTICS.run_process([sys.executable, '-c', f'open({str(marker)!r}, "w").close()'], 0)
        self.assertEqual(result['status'], 'budget_exhausted')
        self.assertFalse(marker.exists())

    def test_dns_preserves_the_actual_literal_host_and_errno(self):
        answer = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('192.0.2.10', 443))]
        with mock.patch.object(socket, 'getaddrinfo', return_value=answer) as resolver:
            result = DIAGNOSTICS.dns_worker('archive.ubuntu.com')
        self.assertEqual(result['addresses'], ['192.0.2.10'])
        self.assertEqual(resolver.call_args.args, ('archive.ubuntu.com', 443))
        with mock.patch.object(socket, 'getaddrinfo', side_effect=socket.gaierror(socket.EAI_AGAIN, SECRET)):
            result = DIAGNOSTICS.dns_worker('archive.ubuntu.com')
        self.assertEqual(result['status'], 'dns_error')
        self.assertEqual(result['error']['errno'], socket.EAI_AGAIN)
        self.assertNotIn(SECRET, json.dumps(result))

    def test_host_allowlist_rejects_urls_subdomains_and_redirect_targets_before_io(self):
        with mock.patch.object(socket, 'getaddrinfo') as resolver, mock.patch.object(DIAGNOSTICS.http.client, 'HTTPSConnection') as connection:
            for host in ('localhost', 'archive.ubuntu.com.evil.example', 'https://archive.ubuntu.com',
                         'archive.ubuntu.com:443', '127.0.0.1', f'user:{SECRET}@archive.ubuntu.com'):
                with self.subTest(host=host), self.assertRaisesRegex(ValueError, 'host_not_allowed'):
                    DIAGNOSTICS.dns_worker(host)
                with self.assertRaisesRegex(ValueError, 'host_not_allowed'):
                    DIAGNOSTICS.https_worker(host)
            resolver.assert_not_called()
            connection.assert_not_called()
        child = subprocess.run([sys.executable, '-I', str(SCRIPT), '--worker', 'dns', SECRET],
                               capture_output=True, timeout=3)
        self.assertEqual(child.returncode, 2)
        self.assertNotIn(SECRET, (child.stdout + child.stderr).decode())

    def test_https_is_head_only_without_redirect_or_proxy_configuration(self):
        connection = mock.Mock()
        connection.getresponse.return_value.status = 302
        connection.getresponse.return_value.getheaders.side_effect = AssertionError('headers must not be read')
        with mock.patch.dict(os.environ, {'HTTPS_PROXY': f'https://user:{SECRET}@proxy.invalid/path'}), \
                mock.patch.object(DIAGNOSTICS.http.client, 'HTTPSConnection', return_value=connection) as constructor:
            result = DIAGNOSTICS.https_worker('security.ubuntu.com')
        constructor.assert_called_once_with('security.ubuntu.com', timeout=DIAGNOSTICS.DNS_WORKER_SECONDS)
        connection.request.assert_called_once_with('HEAD', '/ubuntu/')
        connection.close.assert_called_once()
        self.assertEqual(result['httpStatus'], 302)
        self.assertFalse(result['redirectFollowed'])
        self.assertEqual(result['transport'], 'direct')
        self.assertNotIn(SECRET, json.dumps(result))

    def test_https_distinguishes_dns_tls_deadline_http_and_connection_failures(self):
        errors = [(socket.gaierror(socket.EAI_NONAME, SECRET), 'dns_error'),
                  (ssl.SSLError(1, SECRET), 'tls_error'), (TimeoutError(SECRET), 'network_timeout'),
                  (ConnectionRefusedError(errno.ECONNREFUSED, SECRET), 'network_error')]
        for error, expected in errors:
            connection = mock.Mock()
            connection.request.side_effect = error
            with self.subTest(expected=expected), mock.patch.object(DIAGNOSTICS.http.client, 'HTTPSConnection', return_value=connection):
                result = DIAGNOSTICS.https_worker('packages.microsoft.com')
            self.assertEqual(result['status'], expected)
            self.assertNotIn(SECRET, json.dumps(result))
            connection.close.assert_called_once()
        connection = mock.Mock()
        connection.getresponse.return_value.status = 503
        with mock.patch.object(DIAGNOSTICS.http.client, 'HTTPSConnection', return_value=connection):
            result = DIAGNOSTICS.https_worker('packages.microsoft.com')
        self.assertEqual(result, {'status': 'http_error', 'httpStatus': 503, 'redirectFollowed': False,
                                  'transport': 'direct', 'method': 'HEAD', 'path': '/'})

    def test_target_identity_refusal_is_not_reported_as_resolution_success(self):
        refusal = {'observedAt': 'test', 'status': 'command_failed', 'exitCode': 1,
                   'stdout': b'', 'stderr': b'sudo: a password is required', 'cleanup': 'exited'}
        with mock.patch.object(DIAGNOSTICS, 'run_process', return_value=refusal):
            result = DIAGNOSTICS.dns_probe('root', 'archive.ubuntu.com', 1)
        self.assertEqual(result['status'], 'command_failed')
        self.assertIn('password_required', result['stderr']['recognizedErrors'])

    def test_configuration_reads_only_os_and_dns_fields(self):
        (self.directory / 'os-release').write_text(f'ID=ubuntu\nVERSION_ID="24.04"\nPRIVATE_TOKEN={SECRET}\n')
        (self.directory / 'resolv.conf').write_text(f'nameserver 127.0.0.53\nsearch {SECRET}.private\noptions edns0 trust-ad timeout:2\n')
        (self.directory / 'nsswitch.conf').write_text(f'passwd: {SECRET}\nhosts: files resolve [!UNAVAIL=return] dns\n')
        with mock.patch.object(DIAGNOSTICS, 'ETC', self.directory):
            result = DIAGNOSTICS.read_configuration()
        self.assertEqual(result[0]['lines'], ['ID=ubuntu', 'VERSION_ID="24.04"'])
        self.assertEqual(result[1]['lines'], ['nameserver 127.0.0.53', 'search <redacted:1>', 'options edns0 trust-ad timeout:2'])
        self.assertEqual(result[2]['lines'], ['hosts: files resolve [!UNAVAIL=return] dns'])
        self.assertNotIn(SECRET, json.dumps(result))

    def test_apt_proxy_values_are_classified_without_disclosing_credentials(self):
        value = (f"SrvRecords='true'\nIPv4='false'\nHttpProxy='http://user:{SECRET}@private/'\nHttpsProxy='DIRECT'\n"
                 f"HttpProxyHost0='http://{SECRET}@private/'\nHttpsProxyAutoDetect='/private/{SECRET}'\n"
                 "Retries='0'\nHttpTimeout='12'\nHttpsTimeout='3'\n").encode()
        process = {'status': 'ok', 'exitCode': 0, 'stdout': value, 'stderr': b'', 'cleanup': 'exited'}
        with mock.patch.object(DIAGNOSTICS, 'run_process', return_value=process) as run:
            result = DIAGNOSTICS.apt_probe(1)
        self.assertEqual(run.call_args.args[0][:2], ['apt-config', 'shell'])
        self.assertEqual({key: result['settings'][key] for key in ('SrvRecords', 'IPv4', 'IPv6', 'HttpProxy', 'HttpsProxy')},
                         {'SrvRecords': 'enabled', 'IPv4': 'disabled', 'IPv6': 'unset', 'HttpProxy': 'configured', 'HttpsProxy': 'direct'})
        self.assertEqual(result['settings']['HttpProxyHost0'], 'configured')
        self.assertEqual(result['settings']['HttpsProxyAutoDetect'], 'configured')
        self.assertEqual([result['settings'][key] for key in ('Retries', 'HttpTimeout', 'HttpsTimeout')], [0, 12, 3])
        self.assertEqual(result['settingKeys']['HttpProxyHost0'], 'Acquire::http::Proxy::azure.archive.ubuntu.com')
        self.assertFalse(result['aptVersionCaptured'])
        self.assertNotIn(SECRET, json.dumps(result))
        for bad in (b"HttpProxy='unterminated", b"Unknown='private'", b"IPv4='true'\nIPv4='false'"):
            with mock.patch.object(DIAGNOSTICS, 'run_process', return_value={**process, 'stdout': bad}):
                result = DIAGNOSTICS.apt_probe(1)
            self.assertEqual(result['status'], 'invalid_output')
        for bad in (b"Retries='-1'", b"HttpTimeout='1e9'", b"HttpsTimeout='99999999999'"):
            with mock.patch.object(DIAGNOSTICS, 'run_process', return_value={**process, 'stdout': bad}):
                result = DIAGNOSTICS.apt_probe(1)
            self.assertEqual(result['status'], 'invalid_output')

    def test_output_is_new_json_under_tmp_and_never_follows_symlinks(self):
        workspace = self.directory / 'workspace'
        workspace.mkdir()
        for path in ('/tmp/a.json', '../escape.json', '.tmp/../escape.json', '.tmp/a.txt', '.tmp//a.json'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                DIAGNOSTICS.open_output(workspace, path)
        descriptor = DIAGNOSTICS.open_output(workspace, '.tmp/diagnostics/before.json')
        os.write(descriptor, b'{"collectionComplete": true}')
        os.close(descriptor)
        with self.assertRaises(FileExistsError):
            DIAGNOSTICS.open_output(workspace, '.tmp/diagnostics/before.json')
        (workspace / '.tmp/link').symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(OSError):
            DIAGNOSTICS.open_output(workspace, '.tmp/link/escape.json')
        (workspace / '.tmp/leaf.json').symlink_to(self.directory / 'outside.json')
        with self.assertRaises(OSError):
            DIAGNOSTICS.open_output(workspace, '.tmp/leaf.json')
        self.assertFalse((self.directory / 'outside.json').exists())
        self.assertFalse((self.directory / 'escape.json').exists())

    def test_complete_failed_observations_are_written_without_claiming_network_health(self):
        relative = str((self.directory / 'before.json').relative_to(ROOT))
        observation = {'collectionComplete': True, 'probeCount': 1, 'failedProbeCount': 1,
                       'durationSeconds': 0.1, 'allProbesSuccessful': False,
                       'probes': [{'status': 'timeout', 'kind': 'https-head', 'host': 'archive.ubuntu.com'}]}
        with mock.patch.object(DIAGNOSTICS, 'collect', return_value=observation), contextlib.redirect_stdout(io.StringIO()) as output:
            code = DIAGNOSTICS.main(['--output', relative])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads((ROOT / relative).read_bytes()), observation)
        self.assertEqual(json.loads(output.getvalue())['failedProbeCount'], 1)

    def test_collection_keeps_all_host_identity_results_and_only_proxy_presence(self):
        denied = {'status': 'command_failed', 'exitCode': 77, 'stdout': b'',
                  'stderr': f'permission denied {SECRET}'.encode(), 'cleanup': 'exited'}
        with mock.patch.object(DIAGNOSTICS, 'read_configuration', return_value=[]), \
                mock.patch.object(DIAGNOSTICS, 'run_process', return_value=denied), \
                mock.patch.object(DIAGNOSTICS.pwd, 'getpwnam', return_value=mock.Mock(pw_uid=42)), \
                mock.patch.dict(os.environ, {'HTTPS_PROXY': f'https://{SECRET}@proxy.invalid'}):
            result = DIAGNOSTICS.collect()
        self.assertTrue(result['collectionComplete'])
        self.assertFalse(result['allProbesSuccessful'])
        self.assertEqual(result['probeCount'], 24)
        self.assertEqual(result['failedProbeCount'], 24)
        self.assertTrue(result['proxyPresence']['https_proxy'])
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual({probe['host'] for probe in result['probes'] if probe['host']}, set(DIAGNOSTICS.HOSTS))
        self.assertEqual(sum(probe['kind'].startswith('getaddrinfo-') for probe in result['probes']), 12)

    def test_apt_transport_is_bounded_and_removes_its_only_download(self):
        workspace = self.directory / 'apt-workspace'
        workspace.mkdir()
        seen = []

        def transport(argv, timeout, proxy_environment=False):
            seen.append(argv)
            self.assertEqual(timeout, DIAGNOSTICS.DNS_WORKER_SECONDS)
            self.assertTrue(proxy_environment)
            self.assertEqual(argv[-2], 'https://archive.ubuntu.com/ubuntu/dists/noble/InRelease')
            pathlib.Path(argv[-1]).write_bytes(b'controlled-inrelease')
            return {'status': 'command_failed', 'exitCode': 100, 'stdout': f'proxy:{SECRET}'.encode(),
                    'stderr': f'permission denied {SECRET}'.encode(), 'cleanup': 'exited'}

        with mock.patch.object(DIAGNOSTICS, 'ROOT', workspace), mock.patch.object(DIAGNOSTICS, 'run_process', side_effect=transport):
            result = DIAGNOSTICS.apt_transport_worker('noble')
            with self.assertRaisesRegex(ValueError, 'codename_not_allowed'):
                DIAGNOSTICS.apt_transport_worker('../secret')
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][:7], ['/usr/lib/apt/apt-helper', '-o', 'Acquire::Retries=0',
                                     '-o', 'Acquire::http::Timeout=2', '-o', 'Acquire::https::Timeout=2'])
        self.assertEqual(result['status'], 'command_failed')
        self.assertEqual(result['exitCode'], 100)
        self.assertEqual(result['downloadedBytes'], 20)
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(list((workspace / '.tmp/ubuntu-network').iterdir()), [])

    def test_apt_transport_rejects_unknown_release_before_executing(self):
        configs = [{'path': '/etc/os-release', 'status': 'ok',
                    'lines': ['ID=ubuntu', 'VERSION_CODENAME="resolute"']}]
        self.assertEqual(DIAGNOSTICS.ubuntu_codename(configs), 'resolute')
        configs[0]['lines'][1] = 'VERSION_CODENAME="../private"'
        self.assertIsNone(DIAGNOSTICS.ubuntu_codename(configs))
        with mock.patch.object(DIAGNOSTICS, 'run_process') as process:
            result = DIAGNOSTICS.apt_transport_probe('current', None, 1)
        self.assertEqual(result['status'], 'unavailable')
        process.assert_not_called()

    def test_collection_deadline_bounds_real_controlled_children(self):
        execute = DIAGNOSTICS.run_process

        def controlled(_argv, timeout, **_kwargs):
            return execute([sys.executable, '-u', '-c', 'import time; print("started",flush=True); time.sleep(20)'], timeout)

        started = time.monotonic()
        with mock.patch.object(DIAGNOSTICS, 'read_configuration', return_value=[]), \
                mock.patch.object(DIAGNOSTICS, 'COLLECTION_SECONDS', 0.35), \
                mock.patch.object(DIAGNOSTICS, 'PROBE_SECONDS', 0.25), \
                mock.patch.object(DIAGNOSTICS, 'run_process', side_effect=controlled), \
                mock.patch.object(DIAGNOSTICS.pwd, 'getpwnam', return_value=mock.Mock(pw_uid=42)):
            result = DIAGNOSTICS.collect()
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(result['probeCount'], 24)
        self.assertTrue(any(probe['status'] == 'timeout' for probe in result['probes']))
        self.assertTrue(any(probe['status'] == 'budget_exhausted' for probe in result['probes']))
        self.assertFalse(result['allProbesSuccessful'])

    def test_only_apt_transport_inherits_proxy_values_without_public_disclosure(self):
        code = 'import os; print(os.environ.get("https_proxy","absent"),flush=True)'
        with mock.patch.dict(os.environ, {'https_proxy': f'http://user:{SECRET}@proxy.invalid'}):
            direct = DIAGNOSTICS.run_process([sys.executable, '-c', code], 2)
            apt = DIAGNOSTICS.run_process([sys.executable, '-c', code], 2, proxy_environment=True)
        self.assertEqual(direct['stdout'].strip(), b'absent')
        self.assertIn(SECRET, apt['stdout'].decode())
        self.assertNotIn(SECRET, json.dumps(DIAGNOSTICS.public_process(apt)))

    def test_malformed_worker_output_is_retained_as_protocol_failure(self):
        for data in (b'not-json', json.dumps({'status': 'ok', 'private': SECRET}).encode()):
            result = DIAGNOSTICS.decode_worker({'status': 'ok', 'stdout': data, 'stderr': b'', 'exitCode': 0})
            self.assertEqual(result['status'], 'invalid_output')
            self.assertNotIn(SECRET, json.dumps(result))


if __name__ == '__main__':
    unittest.main()
