#!/bin/sh
# What the LaunchAgent runs (through the guard in agent.sh): the hub, logging to <data>/logs/hub.log (one previous log
# is kept). When this copy of Owlbot.app goes away (moved to the Trash, or replaced by an upgrade: another folder at
# the same path) it stops the hub and exits 75, so launchd runs the guard again: it starts the new copy or removes the
# agent.
. "$(dirname "$0")/env.sh"
mkdir -p "$DATA/logs"
LOG="$DATA/logs/hub.log"
if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG")" -gt 5242880 ]; then mv -f "$LOG" "$LOG.1"; fi
COPY="$(stat -f %i "$BUNDLE")"
"$NODE" "$APP/packaging/desktop/launch.mjs" run >>"$LOG" 2>&1 &
HUB=$!
trap 'kill -TERM "$HUB" 2>/dev/null' TERM INT HUP
while kill -0 "$HUB" 2>/dev/null; do
  if [ "$(stat -f %i "$BUNDLE" 2>/dev/null)" != "$COPY" ]; then
    echo "$(date): $BUNDLE was moved or replaced, stopping the hub" >&2
    kill -TERM "$HUB" 2>/dev/null
    wait "$HUB"
    exit 75
  fi
  sleep 2
done
wait "$HUB"
