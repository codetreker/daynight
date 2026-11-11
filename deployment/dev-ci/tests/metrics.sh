#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_dir="$(cd -- "$script_dir/../../.." && pwd)"

if [[ ${1:-} != --inside ]]; then
  # Evaluate the real localhost Compose configuration without using private .env.
  DAYNIGHT_PORT=8787 DAYNIGHT_METRICS_PORT=8788 \
    DAYNIGHT_UNIAUTH_APP_ID=test DAYNIGHT_UNIAUTH_APP_SECRET=test \
    docker compose --env-file "$repository_dir/deployment/localhost/.env.example" \
    --file "$repository_dir/deployment/localhost/compose.yaml" config --format json |
    node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const config = JSON.parse(input);
        const ports = config.services.gateway.ports;
        for (const [target, published] of [[80, "8787"], [81, "8788"]]) {
          if (!ports.some(p => Number(p.target) === target && String(p.published) === published && p.host_ip === "127.0.0.1" && p.protocol === "tcp")) process.exit(1);
        }
        const server = config.services.server;
        if (server.environment.DAYNIGHT_METRICS_LISTEN_ADDR !== undefined) process.exit(1);
        if (JSON.stringify(server.command) !== JSON.stringify(["--root", "/var/lib/daynight"])) process.exit(1);
        const mount = server.volumes.find(v => v.target === "/var/lib/daynight/config");
        if (!mount || mount.type !== "bind" || !mount.read_only || !mount.source.endsWith("/deployment/localhost/config")) process.exit(1);
        const yaml = require("node:fs").readFileSync(`${mount.source}/config.yml`, "utf8");
        if (!/^  metrics_listen_address: "127\.0\.0\.1:8788"$/m.test(yaml)) process.exit(1);
      });'
  exec bash "$repository_dir/deployment/dev-ci/run.sh" bash "$script_dir/metrics.sh" --inside
fi

compose=(docker compose --env-file "$DAYNIGHT_DEV_CI_AUTH_ENV_FILE" \
  --project-directory "$repository_dir/deployment/dev-ci" \
  --file "$repository_dir/deployment/dev-ci/compose.yaml" \
  --project-name "daynight-dev-ci-$DAYNIGHT_DEV_CI_RUN_ID")
endpoint="$("${compose[@]}" port gateway 81)"
[[ $endpoint =~ ^127\.0\.0\.1:[0-9]+$ ]]
gateway_id="$("${compose[@]}" ps --quiet gateway)"
[[ $gateway_id =~ ^[a-f0-9]{12,64}$ ]]
server_id="$("${compose[@]}" ps --quiet server)"
[[ $server_id =~ ^[a-f0-9]{12,64}$ ]]
[[ $(docker exec "$server_id" id -u) == 10001 ]]
[[ $(docker exec "$server_id" stat -c '%a' /var/lib/daynight/config) == 755 ]]
[[ $(docker exec "$server_id" stat -c '%a' /var/lib/daynight/config/config.yml) == 644 ]]
docker inspect "$server_id" | node -e '
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const container = JSON.parse(input)[0];
    const mount = container.Mounts.find(m => m.Destination === "/var/lib/daynight/config");
    if (!mount || mount.Type !== "bind" || mount.RW || !mount.Source.endsWith(`/.tmp/dev-ci-config/${process.env.DAYNIGHT_DEV_CI_RUN_ID}`)) process.exit(1);
    if (container.Mounts.some(m => m.Source.includes("/.tmp/dev-ci-private/"))) process.exit(1);
    if (JSON.stringify(container.Config.Cmd) !== JSON.stringify(["--root", "/var/lib/daynight"])) process.exit(1);
    for (const name of ["DAYNIGHT_DATABASE_URL", "DAYNIGHT_LISTEN_ADDR", "DAYNIGHT_METRICS_LISTEN_ADDR", "DAYNIGHT_STORAGE_ROOT"]) {
      if (container.Config.Env.some(e => e.startsWith(`${name}=`))) process.exit(1);
    }
  });'
docker exec "$server_id" cat /var/lib/daynight/config/config.yml | cmp - "$repository_dir/deployment/dev-ci/config/config.yml"
if docker exec "$server_id" touch /var/lib/daynight/config/.write-test 2>/dev/null; then
  docker exec "$server_id" rm -f /var/lib/daynight/config/.write-test
  printf '%s\n' 'Config mount unexpectedly writable' >&2
  exit 1
fi
docker inspect --format '{{json .NetworkSettings.Ports}}' "$gateway_id" | node -e '
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const ports = JSON.parse(input);
    for (const port of ["80/tcp", "81/tcp"]) {
      if (!Array.isArray(ports[port]) || ports[port].length !== 1 || ports[port][0].HostIp !== "127.0.0.1" || !Number(ports[port][0].HostPort)) process.exit(1);
    }
    if (ports["80/tcp"][0].HostPort === ports["81/tcp"][0].HostPort) process.exit(1);
  });'

mkdir -p "$repository_dir/.tmp"
body="$(mktemp "$repository_dir/.tmp/dev-ci-metrics.XXXXXX")"
trap 'rm -f -- "$body"' EXIT
status="$(curl --silent --show-error --max-time 10 --output "$body" --write-out '%{http_code}' "http://$endpoint/metrics")"
[[ $status == 200 ]]
for metric in go_goroutines process_cpu_seconds_total process_resident_memory_bytes process_start_time_seconds process_open_fds; do
  grep -Eq "^${metric}([ {]|$)" "$body"
done
status="$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "$DAYNIGHT_BASE_URL/metrics")"
[[ $status == 404 ]]
status="$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "http://$endpoint/readyz")"
[[ $status == 404 ]]
printf 'Metrics deployment check passed: business=%s metrics=http://%s\n' "$DAYNIGHT_BASE_URL" "$endpoint"
