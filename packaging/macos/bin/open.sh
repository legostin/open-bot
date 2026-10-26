#!/bin/sh
# What open-bot.app runs: starts the hub's LaunchAgent if it is not running, waits for the hub and prints the address
# to open (with the setup code until the first run is done). Exits non-zero when the hub did not come up.
. "$(dirname "$0")/env.sh"
mkdir -p "$DATA/logs"
/bin/sh "$BIN/agent.sh" ensure >>"$DATA/logs/launchd.log" 2>&1
exec "$NODE" "$APP/packaging/desktop/launch.mjs" url
