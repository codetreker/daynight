#!/usr/bin/env python3
"""Collect bounded, read-only Ubuntu DNS and direct HTTPS observations."""

import argparse
import concurrent.futures
import datetime
import http.client
import inspect
import ipaddress
import json
import os
import pathlib
import pwd
import re
import selectors
import shlex
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
ETC = pathlib.Path('/etc')
HOSTS = ('azure.archive.ubuntu.com', 'archive.ubuntu.com',
         'security.ubuntu.com', 'packages.microsoft.com')
PROBE_SECONDS = 5.0
DNS_WORKER_SECONDS = 3.0
COLLECTION_SECONDS = 42.0
UBUNTU_CODENAMES = ('noble', 'resolute')
OUTPUT_LIMIT = 16384
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
            'SYSTEMD_COLORS': '0', 'SYSTEMD_PAGER': 'cat'}
RESOLVERS = {'cloudflare': ('1.1.1.1', 'https://cloudflare-dns.com/dns-query'),
             'google': ('8.8.8.8', 'https://dns.google/resolve')}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def require_host(host):
    if host not in HOSTS:
        raise ValueError('host_not_allowed')
    return host


def error_record(error):
    # Exception messages may contain URLs, credentials or private hostnames.
    result = {'type': type(error).__name__}
    if isinstance(getattr(error, 'errno', None), int):
        result['errno'] = error.errno
    return result


def stderr_record(value, truncated=False):
    text = value.decode(errors='replace').lower()
    recognized = [label for label, fragment in (
        ('permission_denied', 'permission denied'), ('password_required', 'a password is required'),
        ('dns_temporary_failure', 'temporary failure'), ('dns_not_found', 'name or service not known'),
        ('connection_refused', 'connection refused'), ('bus_unavailable', 'failed to connect to bus'),
        ('tool_not_found', 'not found')) if fragment in text]
    return {'capturedBytes': len(value), 'truncated': truncated, 'redacted': True,
            'recognizedErrors': recognized}


def run_process(argv, timeout, proxy_environment=False):
    """Bound the real process group, including inherited pipes after leader exit."""
    started = time.monotonic()
    result = {'observedAt': now(), 'status': 'unavailable', 'exitCode': None,
              'stdout': b'', 'stderr': b'', 'cleanup': 'not_started'}
    if timeout <= 0:
        return {**result, 'status': 'budget_exhausted', 'durationSeconds': 0.0}
    environment = dict(SAFE_ENV)
    if proxy_environment:
        for key in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'):
            for name in (key, key.upper()):
                if name in os.environ:
                    environment[name] = os.environ[name]
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True, env=environment)
    except OSError as error:
        return {**result, 'error': error_record(error), 'durationSeconds': time.monotonic() - started}
    streams = {'stdout': bytearray(), 'stderr': bytearray()}
    selector = selectors.DefaultSelector()
    for name in streams:
        stream = getattr(process, name)
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, name)
    deadline = started + timeout
    reason = None
    try:
        while selector.get_map() or process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                reason = 'timeout'
                break
            for key, _ in selector.select(min(remaining, 0.05)):
                block = os.read(key.fileobj.fileno(), 4096)
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                target = streams[key.data]
                available = OUTPUT_LIMIT - len(target)
                target.extend(block[:available])
                if len(block) > available:
                    reason = 'output_limit'
                    break
            if reason:
                break
    finally:
        if reason or process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
                result['cleanup'] = 'group_killed'
            except ProcessLookupError:
                result['cleanup'] = 'already_exited'
            except PermissionError:
                # Privileged DNS supervisors have their own shorter deadline.
                result['cleanup'] = 'signal_denied_inner_deadline_required'
        else:
            result['cleanup'] = 'exited'
        try:
            process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            result['cleanup'] = 'wait_deadline'
        selector.close()
        process.stdout.close()
        process.stderr.close()
    result.update({name: bytes(value) for name, value in streams.items()})
    result.update({'exitCode': process.returncode, 'status': reason or ('ok' if process.returncode == 0 else 'command_failed'),
                   'durationSeconds': time.monotonic() - started})
    return result


def public_process(result):
    return {**{key: value for key, value in result.items() if key not in ('stdout', 'stderr')},
            'stderr': stderr_record(result['stderr'], result['status'] == 'output_limit'),
            'stdoutCapturedBytes': len(result['stdout'])}


def dns_worker(host):
    require_host(host)
    try:
        answers = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
        addresses = sorted({str(ipaddress.ip_address(row[4][0])) for row in answers})
        return {'status': 'ok', 'uid': os.geteuid(), 'addresses': addresses}
    except socket.gaierror as error:
        return {'status': 'dns_error', 'uid': os.geteuid(), 'error': error_record(error)}
    except OSError as error:
        return {'status': 'network_error', 'uid': os.geteuid(), 'error': error_record(error)}


def https_worker(host):
    require_host(host)
    connection = http.client.HTTPSConnection(host, timeout=DNS_WORKER_SECONDS)
    path = '/' if host == 'packages.microsoft.com' else '/ubuntu/'
    try:
        connection.request('HEAD', path)
        response = connection.getresponse()
        result = {'status': 'ok' if response.status < 400 else 'http_error', 'httpStatus': response.status}
    except socket.gaierror as error:
        result = {'status': 'dns_error', 'error': error_record(error)}
    except (TimeoutError, socket.timeout) as error:
        result = {'status': 'network_timeout', 'error': error_record(error)}
    except ssl.SSLError as error:
        result = {'status': 'tls_error', 'error': error_record(error)}
    except http.client.HTTPException as error:
        result = {'status': 'http_protocol_error', 'error': error_record(error)}
    except OSError as error:
        result = {'status': 'network_error', 'error': error_record(error)}
    finally:
        connection.close()
    return {**result, 'method': 'HEAD', 'path': path, 'redirectFollowed': False, 'transport': 'direct'}


def decode_worker(result):
    public = public_process(result)
    if result['status'] != 'ok':
        return public
    try:
        observation = json.loads(result['stdout'])
        if not isinstance(observation, dict) or not isinstance(observation.get('status'), str):
            raise ValueError('invalid_observation')
        allowed = {'status', 'uid', 'addresses', 'error', 'httpStatus', 'redirectFollowed', 'transport',
                   'observedAt', 'exitCode', 'cleanup', 'durationSeconds', 'stderr', 'stdoutCapturedBytes',
                   'observation', 'downloadedBytes', 'phase', 'codename', 'boundary', 'proxyPresence',
                   'method', 'path'}
        if set(observation) - allowed:
            raise ValueError('unexpected_observation_fields')
        return {**public, 'status': observation['status'], 'observation': observation}
    except (ValueError, UnicodeError):
        return {**public, 'status': 'invalid_output'}


def dns_program(supervised):
    # Copy only fixed diagnostic functions into -c. The target UID must not need
    # directory traversal permission for the runner's checkout or home directory.
    functions = ['require_host', 'error_record']
    if supervised:
        functions += ['now', 'stderr_record', 'run_process', 'public_process', 'decode_worker', 'dns_supervisor']
    else:
        functions += ['dns_worker']
    constants = {'HOSTS': HOSTS, 'SAFE_ENV': SAFE_ENV, 'OUTPUT_LIMIT': OUTPUT_LIMIT,
                 'DNS_WORKER_SECONDS': DNS_WORKER_SECONDS}
    return ('import datetime,ipaddress,json,os,selectors,signal,socket,subprocess,sys,time\n'
            + ''.join(f'{key} = {value!r}\n' for key, value in constants.items())
            + '\n'.join(DNS_SOURCE[function] for function in functions)
            + '\nprint(json.dumps(' + ('dns_supervisor(sys.argv[1], sys.argv[2])' if supervised
                                        else 'dns_worker(sys.argv[1])') + '))\n')


def dns_supervisor(host, worker_code=None):
    require_host(host)
    # This layer runs under the target UID, so it can kill its own DNS worker
    # even when the unprivileged collector cannot signal a sudo descendant.
    return decode_worker(run_process([sys.executable, '-I', '-c', worker_code if worker_code is not None
                                      else dns_program(False), host], DNS_WORKER_SECONDS))


def dns_probe(identity, host, timeout):
    require_host(host)
    expected_uid = os.geteuid() if identity == 'current' else pwd.getpwnam(identity).pw_uid
    command = [sys.executable, '-I', '-c', dns_program(True), host, dns_program(False)]
    if expected_uid != os.geteuid():
        command = ['sudo', '-n', '-u', identity, '--', *command]
    result = decode_worker(run_process(command, timeout))
    nested = result.get('observation', {}).get('observation', {})
    if result['status'] == 'ok' and nested.get('uid') != expected_uid:
        result['status'] = 'identity_mismatch'
    return {**result, 'identity': identity, 'expectedUid': expected_uid}


DNS_SOURCE = {function.__name__: inspect.getsource(function) for function in (
    require_host, error_record, now, stderr_record, run_process, public_process,
    decode_worker, dns_supervisor, dns_worker)}


def ip_tokens(value):
    result = []
    for token in value.split():
        try:
            result.append(str(ipaddress.ip_address(token.split('%', 1)[0])))
        except ValueError:
            pass
    return result


def read_configuration():
    records = []
    for name in ('os-release', 'resolv.conf', 'nsswitch.conf'):
        record = {'path': f'/etc/{name}', 'observedAt': now(), 'lines': []}
        try:
            with (ETC / name).open('rb') as source:
                data = source.read(OUTPUT_LIMIT + 1)
            record['truncated'] = len(data) > OUTPUT_LIMIT
            text = data[:OUTPUT_LIMIT].decode(errors='replace')
            for line in text.splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith('#'):
                    continue
                if name == 'os-release':
                    key, separator, value = stripped.partition('=')
                    if separator and key in ('NAME', 'VERSION', 'VERSION_ID', 'ID', 'ID_LIKE', 'VERSION_CODENAME', 'PRETTY_NAME'):
                        record['lines'].append(f'{key}={value[:160]}')
                elif name == 'resolv.conf':
                    parts = stripped.split()
                    key = parts[0]
                    if key == 'nameserver':
                        record['lines'].append('nameserver ' + ' '.join(ip_tokens(' '.join(parts[1:]))))
                    elif key in ('search', 'domain'):
                        record['lines'].append(f'{key} <redacted:{len(parts) - 1}>')
                    elif key == 'options':
                        safe = [part for part in parts[1:] if re.fullmatch(r'(?:ndots|timeout|attempts):[0-9]+|rotate|single-request(?:-reopen)?|use-vc|trust-ad|edns0|no-aaaa|no-tld-query|debug', part)]
                        record['lines'].append('options ' + ' '.join(safe))
                elif stripped.startswith('hosts:'):
                    # Preserve the hosts resolution order without unrelated NSS configuration.
                    safe = [part for part in stripped.split()[1:] if re.fullmatch(r'files|dns|resolve|myhostname|mymachines|mdns(?:4|6)?(?:_minimal)?|nis|wins|\[!?(?:NOTFOUND|UNAVAIL|TRYAGAIN|SUCCESS)=(?:return|continue|merge)\]', part)]
                    record['lines'].append('hosts: ' + ' '.join(safe))
            record['status'] = 'output_limit' if record['truncated'] else 'ok'
        except OSError as error:
            record.update({'status': 'unavailable', 'error': error_record(error)})
        records.append(record)
    return records


def resolved_probe(host, timeout):
    if host is not None:
        require_host(host)
    args = ['resolvectl', '--no-pager', '--legend=no', 'query', host] if host else ['resolvectl', '--no-pager', 'status']
    result = run_process(args, timeout)
    public = public_process(result)
    if result['status'] == 'ok':
        text = result['stdout'].decode(errors='replace')
        if host:
            public['addresses'] = ip_tokens(text.replace('\n', ' '))
            if not public['addresses']:
                public['status'] = 'invalid_output'
        else:
            lines = []
            for line in text.splitlines():
                key, separator, value = line.strip().partition(':')
                if separator and key in ('Current DNS Server', 'DNS Servers', 'Fallback DNS Servers'):
                    lines.append({'field': key, 'addresses': ip_tokens(value)})
                elif separator and key == 'DNS Domain':
                    lines.append({'field': key, 'redactedDomainCount': len(value.split())})
                elif separator and key in ('Protocols', 'Current Scopes'):
                    lines.append({'field': key, 'values': re.findall(r'(?<!\S)[+-]?(?:DNS|LLMNR|mDNS|DefaultRoute|DNSOverTLS|DNSSEC)(?:=[a-z/-]+)?(?!\S)', value)})
            public['dnsState'] = lines
    return public


APT_INTEGER_KEYS = {'Retries': 'Acquire::Retries', 'HttpTimeout': 'Acquire::http::Timeout',
                    'HttpsTimeout': 'Acquire::https::Timeout'}
APT_PROXY_KEYS = {'HttpProxy': 'Acquire::http::Proxy', 'HttpsProxy': 'Acquire::https::Proxy',
                  'HttpProxyAutoDetect': 'Acquire::http::Proxy-Auto-Detect',
                  'HttpsProxyAutoDetect': 'Acquire::https::Proxy-Auto-Detect'}
for _scheme in ('http', 'https'):
    for _index, _host in enumerate(HOSTS):
        APT_PROXY_KEYS[f'{_scheme.title()}ProxyHost{_index}'] = f'Acquire::{_scheme}::Proxy::{_host}'
APT_KEYS = {'SrvRecords': 'Acquire::EnableSrvRecords', 'IPv4': 'Acquire::ForceIPv4',
            'IPv6': 'Acquire::ForceIPv6', **APT_INTEGER_KEYS, **APT_PROXY_KEYS}


def apt_probe(timeout):
    result = run_process(['apt-config', 'shell', *[part for pair in APT_KEYS.items() for part in pair]], timeout)
    public = public_process(result)
    if result['status'] != 'ok':
        return public
    values = {}
    try:
        for line in result['stdout'].decode().splitlines():
            tokens = shlex.split(line)
            if len(tokens) != 1:
                raise ValueError('invalid_assignment')
            key, separator, value = tokens[0].partition('=')
            if not separator or key not in APT_KEYS or key in values:
                raise ValueError('invalid_assignment')
            values[key] = value
    except (ValueError, UnicodeError):
        return {**public, 'status': 'invalid_output'}
    settings = {}
    for key in APT_KEYS:
        value = values.get(key)
        if value is None or value == '':
            settings[key] = 'unset'
        elif key in APT_PROXY_KEYS:
            settings[key] = 'direct' if value.upper() == 'DIRECT' else 'configured'
        elif key in APT_INTEGER_KEYS:
            settings[key] = int(value) if re.fullmatch(r'[0-9]{1,10}', value) and int(value) <= 2147483647 else 'invalid'
        elif value.lower() in ('true', 'yes', '1', 'on'):
            settings[key] = 'enabled'
        elif value.lower() in ('false', 'no', '0', 'off'):
            settings[key] = 'disabled'
        else:
            settings[key] = 'invalid'
    return {**public, 'status': 'invalid_output' if 'invalid' in settings.values() else public['status'],
            'settings': settings, 'settingKeys': APT_KEYS, 'scope': 'explicit_global_and_allowlisted_host_keys',
            'aptVersionCaptured': False, 'versionEvidence': 'Use the original APT job log; this probe does not query the APT version.'}


def ubuntu_codename(configurations):
    release = next((entry for entry in configurations if entry['path'] == '/etc/os-release'), None)
    if release is None or release['status'] != 'ok':
        return None
    values = {}
    for line in release['lines']:
        key, _, value = line.partition('=')
        values[key] = value.strip('"\'')
    if values.get('ID') != 'ubuntu' or values.get('VERSION_CODENAME') not in UBUNTU_CODENAMES:
        return None
    return values['VERSION_CODENAME']


def apt_transport_worker(codename):
    if codename not in UBUNTU_CODENAMES:
        raise ValueError('codename_not_allowed')
    # Validate the task-owned directory without accepting an arbitrary download path.
    directory = ROOT / '.tmp/ubuntu-network'
    descriptor = open_output(ROOT, f'.tmp/ubuntu-network/transport-{os.getpid()}.json')
    os.close(descriptor)
    marker = directory / f'transport-{os.getpid()}.json'
    try:
        with tempfile.TemporaryDirectory(prefix='apt-transport-', dir=directory) as temporary:
            destination = pathlib.Path(temporary) / 'InRelease'
            result = run_process(['/usr/lib/apt/apt-helper', '-o', 'Acquire::Retries=0',
                                  '-o', 'Acquire::http::Timeout=2', '-o', 'Acquire::https::Timeout=2',
                                  'download-file', f'https://archive.ubuntu.com/ubuntu/dists/{codename}/InRelease',
                                  str(destination)], DNS_WORKER_SECONDS, proxy_environment=True)
            downloaded = destination.stat().st_size if destination.is_file() else 0
            return {**public_process(result), 'downloadedBytes': downloaded, 'uid': os.geteuid(),
                    'phase': 'apt_transport', 'codename': codename, 'method': 'GET',
                    'path': f'/ubuntu/dists/{codename}/InRelease',
                    'proxyPresence': proxy_presence(),
                    'boundary': 'Temporary transport download only; no signature verification, package install, system lists update or configuration change. Temporary output permissions may differ from normal APT list directories.'}
    finally:
        marker.unlink(missing_ok=True)


def apt_transport_probe(identity, codename, timeout):
    if codename is None:
        return {'status': 'unavailable', 'error': {'type': 'UnsupportedUbuntuCodename'}, 'identity': identity}
    expected_uid = os.geteuid() if identity == 'current' else pwd.getpwnam(identity).pw_uid
    command = [sys.executable, '-I', str(pathlib.Path(__file__).resolve()), '--apt-transport', codename]
    if expected_uid != os.geteuid():
        command = ['sudo', '-n', '-u', identity, '--', *command]
    result = decode_worker(run_process(command, timeout, proxy_environment=True))
    if result['status'] == 'ok' and result.get('observation', {}).get('uid') != expected_uid:
        result['status'] = 'identity_mismatch'
    return {**result, 'identity': identity, 'expectedUid': expected_uid}


def proxy_presence():
    return {key: bool(os.environ.get(key.upper()) or os.environ.get(key.lower()))
            for key in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')}


def dns_name(value):
    label = r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
    if not isinstance(value, str) or not re.fullmatch(rf'(?=.{{1,253}}\.?$)(?:{label}\.)*{label}\.?', value):
        raise ValueError('invalid_dns_name')
    return value.rstrip('.').lower()


def validate_public_answer(host, response):
    require_host(host)
    if (host not in HOSTS[:3] or not isinstance(response, dict) or type(response.get('Status')) is not int
            or response['Status'] != 0 or response.get('TC', False) is not False):
        raise ValueError('dns_response_failed')
    questions, answers = response.get('Question'), response.get('Answer')
    if (not isinstance(questions, list) or len(questions) != 1 or not isinstance(questions[0], dict)
            or type(questions[0].get('type')) is not int or questions[0]['type'] != 1
            or dns_name(questions[0].get('name')) != host):
        raise ValueError('dns_question_mismatch')
    if not isinstance(answers, list) or not 1 <= len(answers) <= 64:
        raise ValueError('dns_answers_invalid')
    records = {}
    for answer in answers:
        if (not isinstance(answer, dict) or type(answer.get('type')) is not int or answer['type'] not in (1, 5)
                or type(answer.get('TTL')) is not int or not 0 < answer['TTL'] <= 2147483647):
            raise ValueError('dns_record_invalid')
        owner = dns_name(answer.get('name'))
        if answer['type'] == 5:
            value = dns_name(answer.get('data'))
        else:
            if not isinstance(answer.get('data'), str):
                raise ValueError('dns_address_invalid')
            value = ipaddress.IPv4Address(answer.get('data'))
            if not value.is_global or value.is_multicast:
                raise ValueError('dns_address_not_public_ipv4')
            value = str(value)
        records.setdefault(owner, []).append((answer['type'], value, answer['TTL']))
    name, seen, ttl = host, set(), 2147483647
    while name not in seen and len(seen) < 9:
        seen.add(name)
        rows = records.get(name, [])
        if not rows:
            break
        ttl = min(ttl, *(row[2] for row in rows))
        aliases = {row[1] for row in rows if row[0] == 5}
        addresses = sorted({row[1] for row in rows if row[0] == 1})
        if addresses and not aliases and seen == set(records):
            return {'addresses': addresses, 'canonicalName': name, 'ttlSeconds': ttl}
        if len(aliases) != 1 or addresses:
            break
        name = aliases.pop()
    raise ValueError('dns_chain_invalid')


def dig_response(output):
    text = output.decode('ascii')
    header = re.search(r'HEADER<<- opcode: QUERY, status: ([A-Z]+),', text)
    codes = {'NOERROR': 0, 'FORMERR': 1, 'SERVFAIL': 2, 'NXDOMAIN': 3, 'NOTIMP': 4, 'REFUSED': 5,
             'YXDOMAIN': 6, 'YXRRSET': 7, 'NXRRSET': 8, 'NOTAUTH': 9, 'NOTZONE': 10}
    if not header or header[1] not in codes:
        raise ValueError('dns_response_failed')
    questions = re.findall(r'^;([^;\s]+)\s+IN\s+A\s*$', text, re.MULTILINE)
    answers = []
    for line in text.splitlines():
        if not line or line.startswith(';'):
            continue
        fields = line.split()
        if len(fields) != 5 or fields[2] != 'IN' or fields[3] not in ('A', 'CNAME'):
            raise ValueError('dns_record_invalid')
        answers.append({'name': fields[0], 'TTL': int(fields[1]),
                        'type': 1 if fields[3] == 'A' else 5, 'data': fields[4]})
    return {'Status': codes[header[1]], 'TC': bool(re.search(r';; flags: [^;]*\btc\b', text)),
            'Question': [{'name': name, 'type': 1} for name in questions], 'Answer': answers}


def curl_command(timeout):
    return ['curl', '-q', '--silent', '--show-error', '--ipv4', '--noproxy', '*', '--proto', '=https',
            '--connect-timeout', str(min(2, timeout)), '--max-time', str(min(4, timeout))]


def public_dns_probe(provider, transport, host, timeout):
    if host not in HOSTS[:3] or provider not in RESOLVERS or transport not in ('udp', 'tcp', 'doh'):
        raise ValueError('public_dns_probe_not_allowed')
    started = time.monotonic()
    resolver, endpoint = RESOLVERS[provider]
    if transport == 'doh':
        argv = curl_command(timeout) + ['--header', 'Accept: application/dns-json', '--max-filesize', str(OUTPUT_LIMIT),
                                       '--write-out', '\n%{http_code} %{ssl_verify_result}',
                                       f'{endpoint}?name={host}.&type=A']
    else:
        argv = ['dig', '-r', f'@{resolver}', f'{host}.', 'A', '+time=2', '+tries=1', '+nosearch',
                '+noall', '+comments', '+question', '+answer', '+tcp' if transport == 'tcp' else '+notcp']
        if transport == 'udp':
            argv.append('+ignore')
    result = run_process(argv, min(4, timeout))
    public = {**public_process(result), 'provider': provider, 'transport': transport, 'host': host,
              'queryType': 'A', 'resolverAddress': resolver, 'authenticatedTransport': False,
              'bootstrap': 'system_hostname_resolution_and_https' if transport == 'doh' else 'literal_resolver_ipv4'}
    if result['status'] != 'ok':
        return public
    try:
        if transport == 'doh':
            body, metadata = result['stdout'].rsplit(b'\n', 1)
            code, verify = metadata.split()
            public.update({'httpStatus': int(code), 'tlsVerifyResult': int(verify)})
            if code != b'200' or verify != b'0':
                return {**public, 'status': 'http_or_tls_error'}
            response = json.loads(body)
        else:
            response = dig_response(result['stdout'])
        if isinstance(response, dict) and type(response.get('Status')) is int and 0 <= response['Status'] <= 65535:
            public['dnsResponseCode'] = response['Status']
        answer = validate_public_answer(host, response)
        # Retain only validated DNS fields, never arbitrary DoH response content.
        safe_response = {'Status': 0, 'TC': False, 'Question': [{'name': host, 'type': 1}],
                         'Answer': [{key: row[key] for key in ('name', 'type', 'TTL', 'data')} for row in response['Answer']]}
        return {**public, **answer, 'authenticatedTransport': transport == 'doh', 'dnsResponse': safe_response,
                'expiresMonotonic': started + answer['ttlSeconds'], 'ttlClock': 'this_collection_monotonic_only'}
    except (ValueError, TypeError, UnicodeError, KeyError):
        return {**public, 'status': 'invalid_dns_response'}


def inrelease_probe(host, codename, answer, timeout):
    if host not in HOSTS[:3]:
        raise ValueError('host_not_allowed')
    if codename not in UBUNTU_CODENAMES:
        return {'status': 'unavailable', 'error': {'type': 'UnsupportedUbuntuCodename'}}
    if (not answer or answer.get('status') != 'ok' or answer.get('provider') not in RESOLVERS
            or answer.get('transport') != 'doh' or answer.get('host') != host
            or answer.get('authenticatedTransport') is not True
            or answer.get('expiresMonotonic', 0) <= time.monotonic()):
        return {'status': 'unavailable', 'error': {'type': 'FreshAuthenticatedDnsAnswerRequired'}}
    try:
        address = validate_public_answer(host, answer['dnsResponse'])['addresses'][0]
    except (ValueError, TypeError, KeyError):
        return {'status': 'invalid_dns_response'}
    path = f'/ubuntu/dists/{codename}/InRelease'
    result = run_process(curl_command(timeout) + ['--resolve', f'{host}:443:{address}', '--output', '/dev/null',
                         '--max-filesize', '1048576', '--write-out', '%{http_code} %{ssl_verify_result} %{remote_ip} %{size_download}',
                         f'https://{host}{path}'], min(4, timeout))
    public = {**public_process(result), 'provider': answer['provider'], 'resolvedAddress': address,
              'method': 'GET', 'path': path, 'redirectFollowed': False, 'signatureVerified': False,
              'boundary': 'IPv4 transport only; process-local address override retains hostname TLS. No APT signature verification or configuration change.'}
    if result['status'] != 'ok':
        return public
    try:
        code, verify, remote, downloaded = result['stdout'].decode('ascii').split()
        public.update({'httpStatus': int(code), 'tlsVerifyResult': int(verify),
                       'remoteAddress': str(ipaddress.IPv4Address(remote)), 'downloadedBytes': int(downloaded)})
        if code != '200' or verify != '0' or remote != address or int(downloaded) <= 0:
            public['status'] = 'http_or_tls_error'
        return public
    except (ValueError, UnicodeError):
        return {**public, 'status': 'invalid_output'}


def collect():
    started = time.monotonic()
    deadline = started + COLLECTION_SECONDS
    configurations = read_configuration()
    codename = ubuntu_codename(configurations)
    jobs = [('resolver-status', None, lambda timeout: resolved_probe(None, timeout)),
            ('apt-settings', None, apt_probe)]
    for host in HOSTS:
        jobs.append(('resolver-query', host, lambda timeout, host=host: resolved_probe(host, timeout)))
        for identity in ('current', 'root', '_apt'):
            jobs.append((f'getaddrinfo-{identity}', host,
                         lambda timeout, identity=identity, host=host: dns_probe(identity, host, timeout)))
        jobs.append(('https-head', host, lambda timeout, host=host: decode_worker(run_process(
            [sys.executable, '-I', str(pathlib.Path(__file__).resolve()), '--worker', 'https', host], timeout))))
    for identity in ('current', 'root'):
        jobs.append((f'apt-transport-{identity}', 'archive.ubuntu.com',
                     lambda timeout, identity=identity: apt_transport_probe(identity, codename, timeout)))
    for host in HOSTS[:3]:
        for provider in RESOLVERS:
            for transport in ('udp', 'tcp', 'doh'):
                jobs.append((f'public-dns-{provider}-{transport}', host,
                             lambda timeout, host=host, provider=provider, transport=transport:
                             public_dns_probe(provider, transport, host, timeout)))

    def execute(entry):
        kind, host, operation = entry
        begun = time.monotonic()
        observed_at = now()
        remaining = min(PROBE_SECONDS, deadline - begun)
        if remaining <= 0:
            result = {'status': 'budget_exhausted'}
        else:
            try:
                result = operation(remaining)
            except KeyError:
                result = {'status': 'unavailable', 'error': {'type': 'AccountUnavailable'}}
            except OSError as error:
                result = {'status': 'unavailable', 'error': error_record(error)}
        return {'kind': kind, 'host': host, 'observedAt': observed_at,
                **result, 'durationSeconds': time.monotonic() - begun}

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        probes = list(pool.map(execute, jobs))
        answers = {(probe['host'], probe.get('provider')): probe for probe in probes if probe.get('transport') == 'doh'}
        tls_jobs = [(f'inrelease-via-{provider}', host,
                     lambda timeout, host=host, provider=provider:
                     inrelease_probe(host, codename, answers.get((host, provider)), timeout))
                    for host in HOSTS[:3] for provider in RESOLVERS]
        probes.extend(pool.map(execute, tls_jobs))
    failed = sum(probe['status'] != 'ok' for probe in probes)
    return {'schemaVersion': 1, 'collectionComplete': True, 'observedAt': now(),
            'durationSeconds': time.monotonic() - started, 'budgetSeconds': COLLECTION_SECONDS,
            'hosts': list(HOSTS), 'configuration': configurations, 'probes': probes,
            'probeCount': len(probes), 'failedProbeCount': failed,
            'allProbesSuccessful': failed == 0,
            'proxyPresence': proxy_presence(),
            'boundary': 'Collection completion is not a network-health verdict. Public resolver probes query A only, '
                        'use absolute names and do not assess AAAA/IPv6 or the system search path. '
                        'DoH hostname bootstrap uses the system resolver. Fresh authenticated public A answers '
                        'may be used for process-local InRelease GET with original hostname TLS, without redirects '
                        'or signature verification. Direct HEAD ignores proxy configuration; its path differs from '
                        'APT InRelease GET. DNS search domains and arbitrary stderr are redacted. APT proxy '
                        'classification does not reveal auto-detection results or credentials. No network configuration is changed.'}


def open_output(root, relative):
    parts = relative.split('/')
    if len(parts) < 2 or parts[0] != '.tmp' or not parts[-1].endswith('.json') or any(
            not re.fullmatch(r'[A-Za-z0-9_.-]+', part) or part in ('.', '..') for part in parts):
        raise ValueError('output_path_invalid')
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            try:
                os.mkdir(part, mode=0o755, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    finally:
        os.close(directory)


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == '--apt-transport':
        if len(arguments) != 2:
            raise ValueError('invalid_probe')
        print(json.dumps(apt_transport_worker(arguments[1]), sort_keys=True))
        return 0
    if arguments and arguments[0] in ('--worker', '--supervise'):
        if arguments[0] == '--supervise' and len(arguments) == 2:
            result = dns_supervisor(require_host(arguments[1]))
        elif len(arguments) == 3 and arguments[1] in ('dns', 'https'):
            host = require_host(arguments[2])
            result = dns_worker(host) if arguments[1] == 'dns' else https_worker(host)
        else:
            raise ValueError('invalid_probe')
        print(json.dumps(result, sort_keys=True))
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, help='New JSON file beneath this checkout\'s .tmp directory')
    options = parser.parse_args(arguments)
    with os.fdopen(open_output(ROOT, options.output), 'w') as destination:
        result = collect()
        json.dump(result, destination, indent=2, sort_keys=True)
        destination.write('\n')
        destination.flush()
        os.fsync(destination.fileno())
    print(json.dumps({'collectionComplete': result['collectionComplete'], 'output': options.output,
                      'probeCount': result['probeCount'], 'failedProbeCount': result['failedProbeCount'],
                      'durationSeconds': result['durationSeconds']}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError) as error:
        print(json.dumps({'collectionComplete': False, 'error': error_record(error)}), file=sys.stderr)
        sys.exit(2)
