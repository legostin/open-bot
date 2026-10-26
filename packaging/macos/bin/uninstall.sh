#!/bin/sh
# Removes open-bot; run as root (Uninstall open-bot.app asks for an administrator password).
#   uninstall.sh <uid> <home> [--delete-data]
# The user's data (~/Library/Application Support/open-bot) stays unless --delete-data is given.
set -u
USER_ID="$1"
USER_HOME="$2"
launchctl bootout "gui/$USER_ID/ai.openbot.hub" 2>/dev/null
rm -f "$USER_HOME/Library/LaunchAgents/ai.openbot.hub.plist"
if [ "${3:-}" = --delete-data ]; then rm -rf "$USER_HOME/Library/Application Support/open-bot"; fi
rm -rf "/Applications/open-bot" "/Library/Application Support/open-bot"
pkgutil --forget ai.openbot.pkg >/dev/null 2>&1
exit 0
