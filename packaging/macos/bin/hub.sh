#!/bin/sh
# What the LaunchAgent (ai.openbot.hub) runs: the hub, logging to <data>/logs/hub.log (one previous log is kept).
. "$(dirname "$0")/env.sh"
mkdir -p "$DATA/logs"
LOG="$DATA/logs/hub.log"
if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG")" -gt 5242880 ]; then mv -f "$LOG" "$LOG.1"; fi
exec "$NODE" "$APP/packaging/desktop/launch.mjs" run >>"$LOG" 2>&1
