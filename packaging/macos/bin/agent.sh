#!/bin/sh
# The hub's LaunchAgent for the user running this (starts at login, restarted after a crash).
#   agent.sh install   write ~/Library/LaunchAgents/ai.owlbot.hub.plist and (re)start the hub
#   agent.sh ensure    the same unless it is already running
#   agent.sh remove    stop the hub and delete the plist
. "$(dirname "$0")/env.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

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
  <array><string>/bin/sh</string><string>$(xml "$BIN/hub.sh")</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OWLBOT_DATA_DIR</key><string>$(xml "$DATA")</string>
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
  mv -f "$PLIST.tmp" "$PLIST"
}

running() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
stop() { if running; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; fi; return 0; }

case "${1:-ensure}" in
  install) stop; write_plist; launchctl bootstrap "$DOMAIN" "$PLIST" ;;
  ensure) running || { write_plist; launchctl bootstrap "$DOMAIN" "$PLIST"; } ;;
  remove) stop; rm -f "$PLIST" ;;
  *) echo "usage: agent.sh install|ensure|remove" >&2; exit 1 ;;
esac
