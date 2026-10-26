#!/bin/sh
# The hub's LaunchAgent for the user running this (starts at login, restarted after a crash), for this copy of
# open-bot.app.
#   agent.sh install   write ~/Library/LaunchAgents/ai.openbot.hub.plist and (re)start the hub
#   agent.sh ensure    the same when the agent is not loaded or was written for another copy of the app
#   agent.sh remove    stop the hub and delete the plist
. "$(dirname "$0")/env.sh"
DOMAIN="gui/$(id -u)"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# What the agent runs, with the bundle, the plist and the label as $1-$3: the app's hub.sh, waiting up to a minute for
# a copy being replaced (an upgrade). When the app is gone for good (moved to the Trash), the agent removes itself.
GUARD='h="$1/Contents/Resources/bin/hub.sh"
i=0
while [ ! -f "$h" ] && [ "$i" -lt 30 ]; do sleep 2; i=$((i + 1)); done
if [ -f "$h" ]; then exec /bin/sh "$h"; fi
echo "$(date): $1 is gone, removing the agent" >&2
rm -f "$2"
launchctl bootout "gui/$(id -u)/$3"'

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$DATA/logs"
  # launchd's PATH is bare; brain CLIs installed by the user live in these.
  cat >"$PLIST.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string><string>$(xml "$GUARD")</string><string>open-bot</string>
    <string>$(xml "$BUNDLE")</string><string>$(xml "$PLIST")</string><string>$LABEL</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENBOT_DATA_DIR</key><string>$(xml "$DATA")</string>
    <key>PATH</key><string>$(xml "$HOME/.local/bin"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>$(xml "$DATA/logs/launchd.log")</string>
</dict>
</plist>
EOF
}

running() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
stop() {
  if running; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; fi
  # bootout may return while the hub is still stopping, and bootstrap fails (5: I/O error) until it is gone.
  i=0
  while running && [ "$i" -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
  return 0
}
start() { stop; mv -f "$PLIST.tmp" "$PLIST"; launchctl bootstrap "$DOMAIN" "$PLIST"; }

case "${1:-ensure}" in
  install) write_plist; start ;;
  ensure)
    write_plist
    if running && cmp -s "$PLIST.tmp" "$PLIST"; then rm -f "$PLIST.tmp"; else start; fi
    ;;
  remove) stop; rm -f "$PLIST" ;;
  *) echo "usage: agent.sh install|ensure|remove" >&2; exit 1 ;;
esac
