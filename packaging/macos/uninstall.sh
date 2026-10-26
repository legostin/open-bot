#!/bin/sh
# Removes Owlbot without the Finder (a package install over SSH or MDM); run as root:
#   sudo /Applications/Owlbot.app/Contents/Resources/uninstall.sh <uid> <home> [--delete-data]
# Moving Owlbot.app to the Trash does the same for its user (its start-at-login agent then removes itself). The data
# (~/Library/Application Support/Owlbot) stays unless --delete-data is given.
set -u
USER_ID="$1"
USER_HOME="$2"
BUNDLE="$(cd "$(dirname "$0")/../.." && pwd)"
case "$BUNDLE" in
  *.app) [ -f "$BUNDLE/Contents/Resources/uninstall.sh" ] || exit 1 ;;
  *) echo "uninstall.sh runs from inside Owlbot.app, not from $BUNDLE" >&2; exit 1 ;;
esac
# The app stops its hub when it quits.
launchctl asuser "$USER_ID" sudo -u "#$USER_ID" "$BUNDLE/Contents/MacOS/Owlbot" --quit 2>/dev/null
i=0
while pgrep -f "$BUNDLE/Contents/MacOS/Owlbot" >/dev/null && [ "$i" -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
rm -f "$USER_HOME/Library/LaunchAgents/ai.owlbot.app.plist"
if [ "${3:-}" = --delete-data ]; then
  rm -rf "$USER_HOME/Library/Application Support/Owlbot" "$USER_HOME/Library/Application Support/ai.owlbot.app"
fi
rm -rf "$BUNDLE"
pkgutil --forget ai.owlbot.pkg >/dev/null 2>&1
exit 0
