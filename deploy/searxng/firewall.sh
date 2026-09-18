#!/usr/bin/env bash
set -euo pipefail

if [ -r /etc/default/searxng-docker-firewall ]; then
  # shellcheck disable=SC1091
  . /etc/default/searxng-docker-firewall
fi

PORT="${SEARXNG_PORT:-8888}"
LAN_CIDR="${SEARXNG_LAN_CIDR:-192.168.0.0/16}"
RULE=(-p tcp --dport "${PORT}" ! -s "${LAN_CIDR}" -j DROP)

if ! iptables -C DOCKER-USER "${RULE[@]}" 2>/dev/null; then
  iptables -I DOCKER-USER 1 "${RULE[@]}"
fi

if ! iptables -C DOCKER-USER -j RETURN 2>/dev/null; then
  iptables -A DOCKER-USER -j RETURN
fi
