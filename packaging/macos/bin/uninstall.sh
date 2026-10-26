#!/bin/sh
# Removes Owlbot; run as root (Uninstall Owlbot.app asks for an administrator password).
#   uninstall.sh <uid> <home> [--delete-data]
# The user's data (~/Library/Application Support/Owlbot) stays unless --delete-data is given.
set -u
USER_ID="$1"
USER_HOME="$2"
launchctl bootout "gui/$USER_ID/ai.owlbot.hub" 2>/dev/null
rm -f "$USER_HOME/Library/LaunchAgents/ai.owlbot.hub.plist"
if [ "${3:-}" = --delete-data ]; then rm -rf "$USER_HOME/Library/Application Support/Owlbot"; fi
rm -rf "/Applications/Owlbot" "/Library/Application Support/Owlbot"
pkgutil --forget ai.owlbot.pkg >/dev/null 2>&1
exit 0
