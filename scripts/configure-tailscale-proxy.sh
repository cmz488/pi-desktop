#!/usr/bin/env bash
set -euo pipefail

# Configure tailscaled for direct networking, preserving its identity and Serve rules.
# Run as your regular user; sudo asks for credentials in your own terminal.
mode="${1:-}"
if [[ "$mode" != '' && "$mode" != '--check' ]]; then
  echo 'Usage: bash scripts/configure-tailscale-proxy.sh [--check]' >&2
  exit 2
fi

curl_direct() {
  local attempt
  for attempt in 1 2 3; do
    if curl "$@"; then return 0; fi
    (( attempt == 3 )) || sleep 1
  done
  return 1
}

# Verify direct routes without trusting or disabling TLS certificate checks.
curl_direct --fail --silent --show-error --noproxy '*' --ipv6 \
  --connect-timeout 3 --max-time 8 --output /dev/null \
  https://controlplane.tailscale.com/
echo 'Verified direct HTTPS: controlplane.tailscale.com (IPv6)'

derp_map="$(curl_direct --fail --silent --show-error --noproxy '*' --ipv6 \
  --connect-timeout 3 --max-time 8 https://controlplane.tailscale.com/derpmap/default)"
netcheck="$(LC_ALL=C timeout 15 env \
  -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy \
  tailscale netcheck)"
nearest="$(sed -n 's/.*Nearest DERP: //p' <<<"$netcheck" | head -n 1)"
[[ -n "$nearest" && "$nearest" != '(none)' ]] || {
  echo 'Unable to identify the nearest Tailscale DERP region' >&2
  exit 1
}
nearest_hosts="$(printf '%s' "$derp_map" | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
  try {
    const map = JSON.parse(input);
    const region = Object.values(map.Regions ?? {}).find((row) => row.RegionName === process.argv[1]);
    const hosts = (region?.Nodes ?? []).map((node) => node.HostName).filter((host) => typeof host === "string" && /^derp[a-z0-9-]*\.tailscale\.com$/i.test(host));
    if (!hosts.length) throw new Error("nearest region has no DERP nodes");
    console.log(hosts.join(" "));
  } catch (error) {
    console.error("Unable to identify nearest DERP hosts:", error.message);
    process.exitCode = 1;
  }
});
' "$nearest")"
verified_derp=0
for host in $nearest_hosts; do
  if curl_direct --fail --silent --show-error --noproxy '*' --ipv4 \
    --connect-timeout 3 --max-time 8 --output /dev/null "https://$host/"; then
    echo "Verified direct HTTPS DERP: $host"
    verified_derp=$((verified_derp + 1))
  else
    echo "Direct HTTPS unavailable for $host; checking the next relay" >&2
  fi
done
(( verified_derp > 0 )) || {
  echo 'No direct HTTPS DERP relay is reachable in the nearest region' >&2
  exit 1
}
echo "Verified direct IPv4 HTTPS for $verified_derp relay(s) in the nearest DERP region"
[[ "$mode" == '--check' ]] && exit 0

file=/etc/systemd/system/tailscaled.service.d/50-pi-desktop-proxy.conf
content=$(mktemp)
trap 'rm -f "$content"' EXIT
cat > "$content" <<EOF
# Managed by Pi Desktop configure-tailscale-proxy.sh
[Service]
UnsetEnvironment=HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
EOF
echo 'This restarts tailscaled briefly. Node identity and Serve/Funnel rules are preserved.'
sudo -v
if sudo test -f "$file"; then
  if ! sudo head -n 1 "$file" | rg -q '^# Managed by Pi Desktop configure-tailscale-proxy.sh$'; then
    echo "Refusing to replace an unmanaged file: $file" >&2
    exit 1
  fi
  sudo cp -p "$file" "$file.backup.$(date +%Y%m%d%H%M%S)"
fi
sudo install -d -m 755 /etc/systemd/system/tailscaled.service.d
sudo install -m 644 "$content" "$file"
sudo systemctl daemon-reload
sudo systemctl restart tailscaled
echo 'Direct networking configured for tailscaled. Refresh Remote Connection in Pi Desktop.'
echo "To undo, remove only $file and restart tailscaled."
