#!/bin/sh
# What Owlbot.app runs each time it opens: sets up the hub's LaunchAgent for this copy of the app (or points it here
# after the app moved), waits for the hub and prints the address to open (with the setup code until the first run is
# done). Exits 3 when the hub did not come up, 4 when the app runs from its disk image (or translocated) instead of a
# copy in Applications.
. "$(dirname "$0")/env.sh"
# A disk image is mounted read-only, and so is the copy macOS runs a quarantined app from (App Translocation).
case "$BUNDLE" in */AppTranslocation/*) exit 4 ;; esac
mounted_on="$(df -P "$BUNDLE" | awk 'NR == 2 { for (i = 6; i <= NF; i++) printf "%s%s", (i > 6 ? " " : ""), $i }')"
if mount | grep -F " on $mounted_on (" | grep -q "read-only"; then exit 4; fi
mkdir -p "$DATA/logs"
/bin/sh "$BIN/agent.sh" ensure >>"$DATA/logs/launchd.log" 2>&1
exec "$NODE" "$APP/packaging/desktop/launch.mjs" url
