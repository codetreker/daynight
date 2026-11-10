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
        if (config.services.server.environment.DAYNIGHT_METRICS_LISTEN_ADDR !== "127.0.0.1:8788") process.exit(1);
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
