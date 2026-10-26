#!/bin/sh
# Removes Owlbot without the Finder (an install from the package, over SSH or MDM); run as root:
#   sudo /Applications/Owlbot.app/Contents/Resources/bin/uninstall.sh <uid> <home> [--delete-data]
# Moving Owlbot.app to the Trash does the same for its user: the agent then removes itself. The user's data
# (~/Library/Application Support/Owlbot) stays unless --delete-data is given.
set -u
USER_ID="$1"
USER_HOME="$2"
. "$(dirname "$0")/env.sh"
case "$BUNDLE" in
  *.app) [ -f "$BUNDLE/Contents/Resources/bin/uninstall.sh" ] || exit 1 ;;
  *) echo "uninstall.sh runs from inside Owlbot.app, not from $BUNDLE" >&2; exit 1 ;;
esac
launchctl bootout "gui/$USER_ID/$LABEL" 2>/dev/null
rm -f "$USER_HOME/Library/LaunchAgents/$LABEL.plist"
if [ "${3:-}" = --delete-data ]; then rm -rf "$USER_HOME/Library/Application Support/Owlbot"; fi
rm -rf "$BUNDLE"
pkgutil --forget ai.owlbot.pkg >/dev/null 2>&1
exit 0
