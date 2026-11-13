"""Owned Linux network for real external-image acceptance, never a product policy."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import select
import signal
import shutil
import subprocess
import sys
import time
from urllib.parse import urlsplit


GATEWAY = "198.18.0.1"
CONTROLLER = "198.18.0.2"
SINK_GATEWAY = "198.18.0.5"
SINK = "198.18.0.6"
INPUT_PROBE = "198.51.100.10"
FORWARD_PROBE = "198.51.100.11"
# Public DNS is explicit; the namespace must not use the host's loopback stub.
DNS = ["1.1.1.1", "8.8.8.8"]
PLATFORM = ["168.63.129.16/32"]


def command(*args, check=True, input_text=None, timeout=15):
    result = subprocess.run(args, input=input_text, text=True, capture_output=True,
                            check=False, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {result.stderr[-3000:]}")
    return result


def document(filename, value, private=False):
    path = Path(filename)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(0o600 if private else 0o644)
    temporary.replace(path)


def environment_directory(value):
    if (sys.platform != "linux" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"):
        raise RuntimeError("Network mutation requires a GitHub-hosted Linux VM.")
    if os.geteuid() != 0:
        raise RuntimeError("Network orchestration requires sudo on the owned VM.")
    root = Path(os.environ.get("GITHUB_WORKSPACE", "")).resolve()
    target = Path(value)
    scratch = root / ".tmp"
    if (not root.is_dir() or not target.is_absolute() or target != target.resolve()
            or scratch != scratch.resolve() or not target.is_relative_to(scratch)
            or target == scratch):
        raise RuntimeError("Network state must be a physical directory under GITHUB_WORKSPACE/.tmp.")
    if not re.fullmatch(r"[0-9]+", os.environ.get("GITHUB_RUN_ID", "")):
        raise RuntimeError("A GitHub run identity is required.")
    return target


def names(directory):
    identity = f"{os.environ['GITHUB_RUN_ID']}:{os.environ.get('GITHUB_RUN_ATTEMPT', '1')}:{directory}"
    suffix = hashlib.sha256(identity.encode()).hexdigest()[:9]
    return {"namespace": "dni-" + suffix, "sinkNamespace": "dnis-" + suffix,
            "interface": "dnic" + suffix, "sinkInterface": "dnis" + suffix,
            "table": "dni_" + suffix, "blockTable": "dnib_" + suffix}


def source_urls(values):
    if len(values) != 2 or [urlsplit(v).scheme for v in values] != ["http", "https"]:
        raise ValueError("Exactly one HTTP image URL and one HTTPS image URL are required.")
    for value in values:
        parsed = urlsplit(value)
        if (len(value) > 8192 or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.fragment or parsed.port not in (None, 80, 443)
                or any(ord(c) < 33 for c in value)):
            raise ValueError("Image URLs must be ordinary credential-free HTTP/HTTPS URLs.")
    return values


def protected_cidrs(addresses, routes):
    result = {ipaddress.ip_network(v) for v in PLATFORM + ["198.18.0.0/29"] + [ip + "/32" for ip in DNS]}
    # Interface networks include the host, Docker bridges and every owned service.
    for interface in addresses:
        for address in interface.get("addr_info", []):
            if address.get("family") in ("inet", "inet6"):
                result.add(ipaddress.ip_network(f"{address['local']}/{address['prefixlen']}", strict=False))
    for route in routes:
        destination = route.get("dst", "default")
        if destination != "default":
            network = ipaddress.ip_network(destination, strict=False)
            if network.prefixlen:
                result.add(network)
        if route.get("gateway"):
            try:
                gateway = ipaddress.ip_address(route["gateway"])
            except ValueError as error:
                raise ValueError(f"Invalid host route gateway: {route['gateway']!r}") from error
            result.add(ipaddress.ip_network(str(gateway) + ("/32" if gateway.version == 4 else "/128")))
    return [str(v) for family in (4, 6) for v in
            ipaddress.collapse_addresses(n for n in result if n.version == family)]


def protected_domains(hosts, cidrs):
    networks = [ipaddress.ip_network(cidr) for cidr in cidrs]
    domains = set()
    for line in hosts.splitlines():
        fields = line.split("#", 1)[0].split()
        if len(fields) < 2:
            continue
        try:
            address = ipaddress.ip_address(fields[0])
        except ValueError:
            # A hosts record without an IP address is not a name mapping.
            continue
        if not any(address in network for network in networks):
            continue
        for value in fields[1:]:
            domain = value.lower().rstrip(".")
            if not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in domain.split(".")):
                raise RuntimeError("A protected host alias cannot be represented by the production profile.")
            domains.add(domain)
    if len(domains) > 256:
        raise RuntimeError("Protected host aliases exceed the production profile capacity.")
    return sorted(domains)


def service_assets(directory):
    filename = directory / "service-assets.json"
    info = filename.lstat()
    if filename.is_symlink() or info.st_size > 65536:
        raise RuntimeError("The regression requires a bounded regular service asset declaration.")
    declaration = json.loads(filename.read_text())
    if set(declaration) != {"containerNames", "networkNames", "aliases"}:
        raise RuntimeError("The service asset declaration has unexpected fields.")
    for key in declaration:
        values = declaration[key]
        if (not isinstance(values, list) or not values or len(values) > 16 or len(set(values)) != len(values)
                or any(not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}", value) for value in values)):
            raise RuntimeError("The regression service asset names are invalid.")
    if len(declaration["containerNames"]) != 2 or len(declaration["networkNames"]) != 2:
        raise RuntimeError("The regression requires its two owned containers and networks.")
    domains, networks, observed, labels = set(declaration["aliases"]), [], [], set()
    for name in declaration["containerNames"]:
        template = '{{json .Name}}\n{{json .Config.Hostname}}\n{{json (index .Config.Labels "daynight.e2e.run")}}\n{{json .NetworkSettings.Networks}}'
        values = [json.loads(line) for line in command("docker", "inspect", "--type", "container", "--format", template, name).stdout.splitlines()]
        actual, hostname, label, attached = values
        if actual != "/" + name or not attached or set(attached) - set(declaration["networkNames"]):
            raise RuntimeError("A declared service container differs from its owned networks.")
        labels.add(label)
        domains.update([name, hostname])
        public = {"name": name, "hostname": hostname, "runId": label, "networks": {}}
        for network_name, details in attached.items():
            aliases = details.get("Aliases") or []
            dns_names = details.get("DNSNames") or []
            domains.update(aliases + dns_names)
            addresses = [details[key] for key in ("IPAddress", "GlobalIPv6Address") if details.get(key)]
            networks.extend(str(ipaddress.ip_network(address + ("/128" if ":" in address else "/32"))) for address in addresses)
            public["networks"][network_name] = {"aliases": aliases, "dnsNames": dns_names, "addresses": addresses}
        observed.append(public)
    for name in declaration["networkNames"]:
        template = '{{json .Name}}\n{{json (index .Labels "daynight.e2e.run")}}\n{{json .IPAM.Config}}'
        actual, label, ipam = [json.loads(line) for line in command("docker", "network", "inspect", "--format", template, name).stdout.splitlines()]
        if actual != name:
            raise RuntimeError("A declared service network identity changed.")
        labels.add(label)
        subnets = [str(ipaddress.ip_network(item["Subnet"], strict=False)) for item in ipam if item.get("Subnet")]
        networks.extend(subnets)
        observed.append({"network": name, "runId": label, "subnets": subnets})
    if len(labels) != 1 or not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", next(iter(labels)) or ""):
        raise RuntimeError("The service assets do not share one owned E2E run label.")
    prefix = "daynight-e2e-" + next(iter(labels))
    if (set(declaration["containerNames"]) != {prefix + "-application", prefix + "-postgres"}
            or set(declaration["networkNames"]) != {prefix + "-network", prefix + "-ingress"}):
        raise RuntimeError("The declared assets differ from their exact E2E run identity.")
    normalized = sorted({value.lower().rstrip(".") for value in domains})
    if any(not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in value.split(".")) for value in normalized):
        raise RuntimeError("An observed service alias cannot be represented in the production profile.")
    return {"protectedDomains": normalized, "protectedCidrs": sorted(set(networks)), "observed": observed}


def rules(state):
    interface, sink_interface, table = state["interface"], state["sinkInterface"], state["table"]
    port = state["servicePort"]
    protected = ", ".join(cidr for cidr in state["protectedCidrs"] if ipaddress.ip_network(cidr).version == 4)
    sources = ", ".join(state["sourceIPv4"])
    dns_rules = "\n".join(
        f' iifname "{interface}" ct original ip daddr {ip} ip daddr {ip} '
        f'{protocol} dport 53 ct original proto-dst 53 counter accept'
        for ip in DNS for protocol in ("udp", "tcp"))
    return f"""table inet {table} {{
 set protected4 {{ type ipv4_addr; flags interval; elements = {{ {protected} }} }}
 set sources4 {{ type ipv4_addr; elements = {{ {sources} }} }}
 counter input_protected {{ }}
 counter forward_protected {{ }}
 chain input {{
  type filter hook input priority -10; policy accept;
  iifname \"{interface}\" meta nfproto ipv6 counter drop
  iifname \"{interface}\" ct original ip daddr {GATEWAY} ip daddr {GATEWAY} tcp dport {port} ct original proto-dst {port} counter accept
  iifname \"{interface}\" ip daddr @protected4 counter name input_protected drop
  iifname \"{interface}\" counter drop
 }}
 chain forward {{
  type filter hook forward priority -10; policy accept;
  iifname \"{interface}\" meta nfproto ipv6 counter drop
{dns_rules}
  iifname \"{interface}\" ip daddr @protected4 counter name forward_protected drop
  iifname \"{interface}\" ct original ip daddr @sources4 ip daddr @sources4 tcp dport {{ 80, 443 }} ct original proto-dst {{ 80, 443 }} counter accept
  iifname \"{interface}\" counter drop
  iifname \"{sink_interface}\" counter drop
 }}
 chain prerouting {{
  type nat hook prerouting priority dstnat; policy accept;
  iifname \"{interface}\" ip daddr {INPUT_PROBE} tcp dport {port} dnat ip to {GATEWAY}:{port}
  iifname \"{interface}\" ip daddr {FORWARD_PROBE} tcp dport {port} dnat ip to {SINK}:{port}
 }}
 chain postrouting {{
  type nat hook postrouting priority srcnat; policy accept;
  ip saddr {CONTROLLER}/32 oifname != \"{interface}\" masquerade
 }}
}}
"""


def read_state(directory):
    filename = directory / "ownership.json"
    info = filename.lstat()
    if filename.is_symlink() or info.st_uid != 0 or info.st_mode & 0o077:
        raise RuntimeError("Network ownership must be a private root-owned regular file.")
    state = json.loads(filename.read_text())
    if (state["runId"] != os.environ["GITHUB_RUN_ID"]
            or any(state.get(k) != v for k, v in names(directory).items())
            or state["originalForward"] not in ("0", "1")):
        raise RuntimeError("Network ownership does not match the current run.")
    return state


def evidence(directory, state, phase):
    snapshot = {"phase": phase, "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "kernel": command("uname", "-srmo").stdout.strip(),
                "nftables": command("nft", "--version").stdout.strip(),
                "hostAddresses": json.loads(command("ip", "-j", "address").stdout),
                "hostRoutes": json.loads(command("ip", "-j", "route", "show", "table", "all").stdout),
                "hostIPv6Routes": json.loads(command("ip", "-6", "-j", "route", "show", "table", "all").stdout)}
    for key in ("namespace", "sinkNamespace"):
        name = state[key]
        snapshot[key] = {
            "addresses": json.loads(command("ip", "-n", name, "-j", "address").stdout),
            "routes": json.loads(command("ip", "-n", name, "-j", "route", "show", "table", "all").stdout),
            "ipv6Routes": json.loads(command("ip", "-n", name, "-6", "-j", "route", "show", "table", "all").stdout),
            "ipv6Disabled": command("ip", "netns", "exec", name, "sysctl", "-n", "net.ipv6.conf.all.disable_ipv6").stdout.strip(),
        }
        if snapshot[key]["ipv6Disabled"] != "1" or snapshot[key]["ipv6Routes"]:
            raise RuntimeError("IPv6 must be disabled and have no namespace routes.")
    snapshot["rules"] = json.loads(command("nft", "-j", "list", "table", "inet", state["table"]).stdout)
    blocked = command("nft", "-j", "list", "table", "inet", state["blockTable"], check=False)
    snapshot["sourceDenyCounters"] = None
    if blocked.returncode == 0:
        snapshot["sourceDenyRules"] = json.loads(blocked.stdout)
        snapshot["sourceDenyCounters"] = {
            "httpPackets": count(state, "source_http", state["blockTable"]),
            "httpsPackets": count(state, "source_https", state["blockTable"]),
        }
    document(directory / f"network-{phase}.json", snapshot)
    return snapshot


def connection(state, address):
    script = "import socket,sys; s=socket.create_connection((sys.argv[1],int(sys.argv[2])),1); s.close()"
    return command("ip", "netns", "exec", state["namespace"], "python3", "-c", script,
                   address, str(state["servicePort"]), check=False, timeout=4).returncode == 0


def count(state, name, table=None):
    data = json.loads(command("nft", "-j", "list", "counter", "inet", table or state["table"], name).stdout)
    return sum(entry.get("counter", {}).get("packets", 0) for entry in data["nftables"])


def verify_translation(directory, state):
    if not connection(state, GATEWAY):
        raise RuntimeError("The exact original control endpoint must be reachable before capture.")
    # This receiver is a temporary probe in the owned sink namespace. A drop
    # counter and a zero-connection receiver distinguish filtering from refusal.
    receiver = ("import socket,sys; s=socket.socket(); s.bind((sys.argv[1],int(sys.argv[2]))); "
                "s.listen(); print('ready',flush=True)\n"
                "while True:\n c,_=s.accept(); print('accepted',flush=True); c.close()\n")
    process = subprocess.Popen(["ip", "netns", "exec", state["sinkNamespace"], "python3", "-u", "-c",
                                receiver, SINK, str(state["servicePort"])], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True)
    outcomes = []
    try:
        readable, _, _ = select.select([process.stdout], [], [], 5)
        if not readable or process.stdout.readline().strip() != "ready":
            raise RuntimeError("The owned DNAT receiver did not become ready.")
        for target, counter in ((INPUT_PROBE, "input_protected"), (FORWARD_PROBE, "forward_protected")):
            before = count(state, counter)
            connected = connection(state, target)
            after = count(state, counter)
            outcomes.append({"originalDestination": target, "finalDestination": GATEWAY if target == INPUT_PROBE else SINK,
                             "counter": counter, "before": before, "after": after, "connected": connected})
            if connected or after <= before:
                raise RuntimeError(f"Post-DNAT rejection was not observed on {counter}.")
    finally:
        process.terminate()
        try:
            stdout, stderr = process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=3)
    if stdout.strip() or stderr.strip():
        raise RuntimeError("The protected receiver observed a connection or failed: " + stdout + stderr)
    document(directory / "translation-verification.json", {"controlConnected": True, "probes": outcomes,
             "forwardReceiverConnections": 0, "inputReceiverOwner": "The harness verifies exactly one direct-control connection."})


def setup(directory, port_value, urls):
    port = int(port_value)
    if not 1024 <= port <= 65535:
        raise ValueError("The owned service port must be between 1024 and 65535.")
    urls = source_urls(urls)
    if (directory / "ownership.json").exists():
        raise RuntimeError("Network setup already has an outcome; inspect or clean up that run.")
    for executable in ("ip", "nft", "iptables", "sysctl", "setpriv", "dig", "docker"):
        if not shutil.which(executable):
            raise RuntimeError(f"Required network tool is missing: {executable}")
    uid, gid = int(os.environ.get("SUDO_UID", "0")), int(os.environ.get("SUDO_GID", "0"))
    if uid == 0 or gid == 0:
        raise RuntimeError("A non-root runner identity is required for Controller execution.")
    source_addresses = set()
    for hostname in sorted({urlsplit(url).hostname for url in urls}):
        answers = command("dig", "@" + DNS[0], "+time=3", "+tries=1", "+short", "A", hostname, timeout=5).stdout
        for candidate in answers.splitlines():
            try:
                address = ipaddress.ip_address(candidate)
            except ValueError:
                continue  # CNAMEs are revalidated by the production resolver.
            if address.version == 4:
                source_addresses.add(str(address))
    source_addresses = sorted(source_addresses)
    if not source_addresses or any(not ipaddress.ip_address(a).is_global for a in source_addresses):
        raise RuntimeError("Every selected source IPv4 address must be ordinary public unicast.")
    host_addresses = json.loads(command("ip", "-j", "address").stdout)
    host_routes = json.loads(command("ip", "-j", "route", "show", "table", "all").stdout)
    host_routes += json.loads(command("ip", "-6", "-j", "route", "show", "table", "all").stdout)
    services = service_assets(directory)
    protected = sorted(set(protected_cidrs(host_addresses, host_routes) + services["protectedCidrs"]))
    # Collapse each family separately so nftables interval elements never overlap.
    protected = [str(network) for family in (4, 6) for network in ipaddress.collapse_addresses(
        ipaddress.ip_network(cidr) for cidr in protected if ipaddress.ip_network(cidr).version == family)]
    domains = sorted(set(protected_domains(Path("/etc/hosts").read_text(), protected) + services["protectedDomains"]))
    if len(domains) > 256 or len(protected) > 256:
        raise RuntimeError("The deployment asset inventory exceeds the production profile capacity.")
    if any(ipaddress.ip_address(a) in ipaddress.ip_network(cidr) for a in source_addresses for cidr in protected):
        raise RuntimeError("A public fixture address belongs to the protected deployment.")
    state = {"schemaVersion": 1, **names(directory), "runId": os.environ["GITHUB_RUN_ID"],
             "uid": uid, "gid": gid, "servicePort": port, "sourceURLs": urls,
             "sourceIPv4": source_addresses, "protectedCidrs": protected, "protectedDomains": domains,
             "createdResolverRoot": not Path("/etc/netns").exists(),
             "originalForward": command("sysctl", "-n", "net.ipv4.ip_forward").stdout.strip()}
    existing_names = command("ip", "netns", "list").stdout
    if any(state[key] in existing_names for key in ("namespace", "sinkNamespace")):
        raise RuntimeError("A proposed namespace already exists; ownership is unknown.")
    if any(command("ip", "link", "show", state[key], check=False).returncode == 0
           for key in ("interface", "sinkInterface")):
        raise RuntimeError("A proposed interface already exists; ownership is unknown.")
    if any(command("nft", "list", "table", "inet", state[key], check=False).returncode == 0
           for key in ("table", "blockTable")):
        raise RuntimeError("A proposed rules table already exists; ownership is unknown.")
    if any(ipaddress.ip_network(route["dst"], strict=False).overlaps(ipaddress.ip_network("198.18.0.0/29"))
           for route in host_routes if route.get("dst", "default") != "default"
           and ipaddress.ip_network(route["dst"], strict=False).version == 4
           and ipaddress.ip_network(route["dst"], strict=False).prefixlen > 0):
        raise RuntimeError("The owned probe network overlaps an existing host route.")
    directory.mkdir(parents=True, mode=0o755, exist_ok=True)
    document(directory / "ownership.json", state, private=True)
    document(directory / "deployment-assets.json", {"hostAddresses": host_addresses, "hostRoutes": host_routes,
             "extraNetworks": ["198.18.0.0/29"], "platformTargets": PLATFORM, "dns": DNS,
             "protectedCidrs": protected, "protectedDomains": domains,
             "services": services["observed"],
             "sourceResolution": {"urls": urls, "ipv4": source_addresses},
             "boundary": "This fresh hosted VM and its owned namespaces and Docker service networks; no private cloud network is attached."})
    try:
        for key, interface, host_ip, child_ip in (("namespace", state["interface"], GATEWAY, CONTROLLER),
                                                  ("sinkNamespace", state["sinkInterface"], SINK_GATEWAY, SINK)):
            namespace = state[key]
            command("ip", "netns", "add", namespace)
            state.setdefault("namespaceInodes", {})[namespace] = Path("/var/run/netns", namespace).stat().st_ino
            document(directory / "ownership.json", state, private=True)
            command("ip", "netns", "exec", namespace, "sysctl", "-q", "-w", "net.ipv6.conf.all.disable_ipv6=1", "net.ipv6.conf.default.disable_ipv6=1")
            command("ip", "link", "add", interface, "type", "veth", "peer", "name", "peer0", "netns", namespace)
            command("ip", "address", "add", host_ip + "/30", "dev", interface)
            command("ip", "link", "set", interface, "up")
            command("ip", "-n", namespace, "address", "add", child_ip + "/30", "dev", "peer0")
            command("ip", "-n", namespace, "link", "set", "peer0", "up")
            command("ip", "-n", namespace, "link", "set", "lo", "up")
            command("ip", "-n", namespace, "route", "add", "default", "via", host_ip)
        resolver = Path("/etc/netns") / state["namespace"]
        resolver.mkdir(parents=True, mode=0o755)
        (resolver / "resolv.conf").write_text("".join(f"nameserver {ip}\n" for ip in DNS))
        text = rules(state)
        (directory / "policy.nft").write_text(text)
        command("nft", "--check", "-f", str(directory / "policy.nft"))
        command("nft", "-f", str(directory / "policy.nft"))
        # Docker can install a FORWARD default drop. These owned accepts cannot
        # bypass the earlier nftables destination guard.
        command("iptables", "-w", "-I", "FORWARD", "1", "-i", state["interface"], "-j", "ACCEPT")
        command("iptables", "-w", "-I", "FORWARD", "1", "-o", state["interface"], "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")
        command("sysctl", "-q", "-w", "net.ipv4.ip_forward=1")
        verify_translation(directory, state)
        evidence(directory, state, "ready")
        # Stateless rules retain an immutable digest; packet counters are runtime evidence.
        installed = command("nft", "--stateless", "list", "table", "inet", state["table"]).stdout
        (directory / "policy-installed.nft").write_text(installed)
        digest = hashlib.sha256(installed.encode()).hexdigest()
        profile = {"schemaVersion": 1, "profileId": state["table"], "protectedCidrs": protected,
                   "protectedDomains": sorted(set(domains + ["postgres", "localhost"])),
                   "egress": {"mode": "enforced", "policyId": state["table"] + "_sha256_" + digest}}
        document(directory / "network.json", {"schemaVersion": 1, "namespace": state["namespace"],
                 "gatewayIPv4": GATEWAY, "controllerIPv4": CONTROLLER, "serviceOrigin": f"http://{GATEWAY}:{port}",
                 "sourceURLs": urls, "externalImages": profile,
                 "policyEvidence": {"rulesSha256": digest, "rulesPath": str(directory / "policy-installed.nft"),
                                    "assetsPath": str(directory / "deployment-assets.json"),
                                    "translationPath": str(directory / "translation-verification.json")}})
    except BaseException as original:
        try:
            cleanup(directory, state)
        except Exception as cleanup_error:
            raise RuntimeError(f"Network setup failed: {original}; cleanup also failed: {cleanup_error}") from original
        raise


def block_sources(directory, state):
    # The original enforced policy remains unchanged. This additional earlier
    # deny closes existing source connections as well as future attempts.
    table, interface = state["blockTable"], state["interface"]
    text = f"""table inet {table} {{
 counter source_http {{ }}
 counter source_https {{ }}
 chain input {{ type filter hook input priority -20; policy accept;
  iifname \"{interface}\" ct original ip daddr {{ {', '.join(state['sourceIPv4'])} }} meta l4proto tcp ct original proto-dst 80 counter name source_http drop
  iifname \"{interface}\" ct original ip daddr {{ {', '.join(state['sourceIPv4'])} }} meta l4proto tcp ct original proto-dst 443 counter name source_https drop
 }}
 chain forward {{ type filter hook forward priority -20; policy accept;
  iifname \"{interface}\" ct original ip daddr {{ {', '.join(state['sourceIPv4'])} }} meta l4proto tcp ct original proto-dst 80 counter name source_http drop
  iifname \"{interface}\" ct original ip daddr {{ {', '.join(state['sourceIPv4'])} }} meta l4proto tcp ct original proto-dst 443 counter name source_https drop
 }}
}}
"""
    command("nft", "-f", "-", input_text=text)
    document(directory / "sources-blocked.json", json.loads(command("nft", "-j", "list", "table", "inet", table).stdout))
    evidence(directory, state, "sources-blocked")


def assert_policy(directory, state):
    profile = json.loads((directory / "network.json").read_text())
    installed = command("nft", "--stateless", "list", "table", "inet", state["table"]).stdout
    if hashlib.sha256(installed.encode()).hexdigest() != profile["policyEvidence"]["rulesSha256"]:
        raise RuntimeError("The enforced policy changed after its configuration was declared.")


def stop_namespace_processes(directory, state):
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("Confirmed process cleanup requires Linux pidfds.")
    held = {}
    observations = []
    namespaces = (state["namespace"], state["sinkNamespace"])

    def discover():
        observed_pids = []
        for namespace in namespaces:
            mount = Path("/var/run/netns", namespace)
            if not mount.exists():
                continue
            inode = mount.stat().st_ino
            if inode != state.get("namespaceInodes", {}).get(namespace, inode):
                raise RuntimeError("Owned namespace identity changed before cleanup.")
            for value in command("ip", "netns", "pids", namespace).stdout.split():
                pid = int(value)
                observed_pids.append({"namespace": namespace, "pid": pid})
                previous = held.get(pid)
                if previous is not None:
                    if not select.select([previous["fd"]], [], [], 0)[0]:
                        continue
                    os.close(previous["fd"])
                    del held[pid]
                descriptor = None
                try:
                    descriptor = os.pidfd_open(pid)
                    if Path(f"/proc/{pid}/ns/net").stat().st_ino != inode:
                        raise RuntimeError("A discovered process left the owned namespace before cleanup.")
                    start = Path(f"/proc/{pid}/stat").read_text().rpartition(")")[2].split()[19]
                    entry = {"pid": pid, "startTime": start, "namespace": namespace, "namespaceInode": inode}
                    observations.append(entry)
                    held[pid] = {"fd": descriptor, "identity": entry, "signals": set()}
                    descriptor = None
                except (FileNotFoundError, ProcessLookupError):
                    pass
                finally:
                    if descriptor is not None:
                        os.close(descriptor)
        return observed_pids

    try:
        for action in (signal.SIGTERM, signal.SIGKILL):
            deadline = time.monotonic() + 3
            while True:
                observed_pids = discover()
                live = [entry for entry in held.values() if not select.select([entry["fd"]], [], [], 0)[0]]
                if not live and not observed_pids:
                    document(directory / "network-processes.json", {"exited": True, "observed": observations})
                    return
                for entry in live:
                    if action not in entry["signals"]:
                        try:
                            signal.pidfd_send_signal(entry["fd"], action)
                        except ProcessLookupError:
                            pass
                        entry["signals"].add(action)
                if time.monotonic() >= deadline:
                    break
                # A parent can fork and exit after the PID enumeration. Even
                # readable pidfds require a subsequent empty namespace scan.
                select.select([entry["fd"] for entry in live], [], [], 0.05)
        live = [entry["identity"] for entry in held.values() if not select.select([entry["fd"]], [], [], 0)[0]]
        document(directory / "network-processes.json", {"exited": False, "observed": observations,
                 "remaining": live, "lastNamespacePids": observed_pids})
        raise RuntimeError("Owned process exit is unconfirmed; namespace names and guards are retained.")
    finally:
        for entry in held.values():
            os.close(entry["fd"])


def cleanup(directory, state):
    failures = []
    # Keep names and guards until pidfds confirm every observed process exited.
    # Unlinking a namespace name alone would hide live namespace references.
    try:
        state["closing"] = True
        document(directory / "ownership.json", state, private=True)
        stop_namespace_processes(directory, state)
    except Exception as error:
        document(directory / "network-cleanup.json", {"verified": False, "failures": [str(error)]})
        raise
    for namespace in (state["namespace"], state["sinkNamespace"]):
        command("ip", "netns", "delete", namespace, check=False)
    for interface in (state["interface"], state["sinkInterface"]):
        command("ip", "link", "delete", interface, check=False)
    for table in (state["blockTable"], state["table"]):
        command("nft", "delete", "table", "inet", table, check=False)
    for args in (("-i", state["interface"], "-j", "ACCEPT"),
                 ("-o", state["interface"], "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")):
        command("iptables", "-w", "-D", "FORWARD", *args, check=False)
        if command("iptables", "-w", "-C", "FORWARD", *args, check=False).returncode == 0:
            failures.append("Owned FORWARD rule remains")
    command("sysctl", "-q", "-w", "net.ipv4.ip_forward=" + state["originalForward"])
    resolver = Path("/etc/netns") / state["namespace"]
    if resolver.exists():
        (resolver / "resolv.conf").unlink(missing_ok=True)
        resolver.rmdir()
    if state.get("createdResolverRoot") and resolver.parent.exists() and not any(resolver.parent.iterdir()):
        resolver.parent.rmdir()
    live_names = command("ip", "netns", "list").stdout
    for namespace in (state["namespace"], state["sinkNamespace"]):
        if namespace in live_names:
            failures.append("Owned namespace remains: " + namespace)
    for interface in (state["interface"], state["sinkInterface"]):
        if command("ip", "link", "show", interface, check=False).returncode == 0:
            failures.append("Owned interface remains: " + interface)
    for table in (state["blockTable"], state["table"]):
        if command("nft", "list", "table", "inet", table, check=False).returncode == 0:
            failures.append("Owned nftables table remains: " + table)
    observed = command("sysctl", "-n", "net.ipv4.ip_forward").stdout.strip()
    if observed != state["originalForward"]:
        failures.append("Host forwarding was not restored")
    document(directory / "network-cleanup.json", {"verified": not failures, "failures": failures, "forwarding": observed})
    if failures:
        raise RuntimeError("Network cleanup did not verify: " + "; ".join(failures))
    # The private root-owned ownership receipt remains readable by a repeated
    # sudo cleanup. Owning the directory lets the runner remove it after proof.
    os.chown(directory, state["uid"], state["gid"])


def main(argv):
    if len(argv) < 2:
        raise ValueError("Expected setup|exec|block-sources|inspect|cleanup and a state directory.")
    operation, value, *args = argv
    directory = environment_directory(value)
    if operation == "setup":
        if len(args) != 3:
            raise ValueError("setup requires servicePort httpImageURL httpsImageURL.")
        setup(directory, args[0], args[1:])
        return
    if operation == "cleanup" and not (directory / "ownership.json").exists():
        return
    state = read_state(directory)
    if operation != "cleanup":
        if state.get("closing"):
            raise RuntimeError("The owned network is closing; no new execution is admitted.")
        assert_policy(directory, state)
    if operation == "exec":
        if not args or args.pop(0) != "--" or not args or not Path(args[0]).is_absolute():
            raise ValueError("exec requires -- followed by an absolute executable and arguments.")
        os.execvp("ip", ["ip", "netns", "exec", state["namespace"], "setpriv", "--reuid", str(state["uid"]),
                         "--regid", str(state["gid"]), "--init-groups", "--bounding-set=-all",
                         "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--", *args])
    if args:
        raise ValueError("Unexpected operation arguments.")
    if operation == "block-sources":
        block_sources(directory, state)
    elif operation == "inspect":
        evidence(directory, state, "observed")
    elif operation == "cleanup":
        cleanup(directory, state)
    else:
        raise ValueError("Unknown network operation.")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as error:
        print(f"External-image network failed: {error}", file=sys.stderr)
        sys.exit(1)
