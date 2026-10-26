#!/bin/sh
# Prepares /data and the sandbox, then runs the hub as the unprivileged "owlbot" user.
set -eu

DATA="${OWLBOT_DATA_DIR:-/data}"

mkdir -p "$DATA" "$DATA/home/agent" "$DATA/home/plugin" "$DATA/plugins-data" "$DATA/workspaces" \
  "$DATA/plugins" "$DATA/skills" "$DATA/commands" "$DATA/agents"

# Hub-owned state. Only top-level dirs are fixed on every start (cheap); a fresh volume gets everything.
chown owlbot:owlbot "$DATA" "$DATA/home" "$DATA/plugins" "$DATA/skills" "$DATA/commands" "$DATA/agents"
chmod 0755 "$DATA/home"
# Each plugin gets its own dir inside, created as that plugin's user (sticky, like /tmp).
chown root:root "$DATA/plugins-data"
chmod 1777 "$DATA/plugins-data"
# Brain CLIs keep their logins (claude, codex) in the agent home.
chown agent:agent "$DATA/home/agent"
chmod 0700 "$DATA/home/agent"
chown plugin:plugin "$DATA/home/plugin"
chmod 0700 "$DATA/home/plugin"
# Workspaces: created by the hub, written by agent CLIs through the shared owlbot group.
chown owlbot:owlbot "$DATA/workspaces"
chmod 2775 "$DATA/workspaces"
# Agent and plugin users must reach their dirs through /data.
chmod 0751 "$DATA"

# Virtual display for a headful browser (anti-bot friendlier, screenshots look real).
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
if [ -n "${DISPLAY:-}" ] && command -v Xvfb >/dev/null 2>&1; then
  n="${DISPLAY#:}"
  rm -f "/tmp/.X${n}-lock" "/tmp/.X11-unix/X${n}"
  setpriv --reuid=owlbot --regid=owlbot --init-groups Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp -ac >/dev/null 2>&1 &
fi

# Optional hard egress enforcement (needs --cap-add NET_ADMIN): agent and plugin users can only
# reach the hub's egress proxy on loopback; the proxy applies per-plugin allowlists.
if [ "${OWLBOT_EGRESS_ENFORCED:-proxy}" = "iptables" ]; then
  if iptables -w -N OWLBOT_EGRESS 2>/dev/null || iptables -w -F OWLBOT_EGRESS; then
    iptables -w -A OWLBOT_EGRESS -o lo -j ACCEPT
    iptables -w -A OWLBOT_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # DNS stays open: plugins resolve names to refuse private addresses before asking the proxy.
    iptables -w -A OWLBOT_EGRESS -p udp --dport 53 -j ACCEPT
    iptables -w -A OWLBOT_EGRESS -p tcp --dport 53 -j ACCEPT
    iptables -w -A OWLBOT_EGRESS -m owner --uid-owner agent -j REJECT
    iptables -w -A OWLBOT_EGRESS -m owner --uid-owner plugin -j REJECT
    iptables -w -C OUTPUT -j OWLBOT_EGRESS 2>/dev/null || iptables -w -A OUTPUT -j OWLBOT_EGRESS
    echo "[entrypoint] egress enforced with iptables"
  else
    echo "[entrypoint] WARNING: iptables unavailable (add --cap-add NET_ADMIN); falling back to proxy-only egress" >&2
    export OWLBOT_EGRESS_ENFORCED=proxy
  fi
fi

cd /app
case "${1:-start}" in
  start | reset-password | pairing-code | backup | audit-verify)
    exec setpriv --reuid=owlbot --regid=owlbot --init-groups env HOME=/home/owlbot \
      node --disable-warning=ExperimentalWarning packages/core/src/cli.ts "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
