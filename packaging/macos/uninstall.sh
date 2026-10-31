#!/bin/sh
# Removes Piomio without the Finder (a package install over SSH or MDM); run as root:
#   sudo /Applications/Piomio.app/Contents/Resources/uninstall.sh <uid> <home> [--delete-data]
# Moving Piomio.app to the Trash does the same for its user (its start-at-login agent then removes itself). The data
# (~/Library/Application Support/Piomio) stays unless --delete-data is given.
set -u
USER_ID="$1"
USER_HOME="$2"
BUNDLE="$(cd "$(dirname "$0")/../.." && pwd)"
case "$BUNDLE" in
  *.app) [ -f "$BUNDLE/Contents/Resources/uninstall.sh" ] || exit 1 ;;
  *) echo "uninstall.sh runs from inside Piomio.app, not from $BUNDLE" >&2; exit 1 ;;
esac
# The app stops its hub when it quits.
launchctl asuser "$USER_ID" sudo -u "#$USER_ID" "$BUNDLE/Contents/MacOS/Piomio" --quit 2>/dev/null
i=0
while pgrep -f "$BUNDLE/Contents/MacOS/Piomio" >/dev/null && [ "$i" -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
rm -f "$USER_HOME/Library/LaunchAgents/ai.piomio.app.plist"
if [ "${3:-}" = --delete-data ]; then
  rm -rf "$USER_HOME/Library/Application Support/Piomio" "$USER_HOME/Library/Application Support/ai.piomio.app"
fi
rm -rf "$BUNDLE"
pkgutil --forget ai.piomio.pkg >/dev/null 2>&1
exit 0
