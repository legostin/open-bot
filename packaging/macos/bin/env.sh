# Sourced by the other scripts here (Owlbot.app/Contents/Resources/bin): where this copy of the app, the hub, the
# data, the LaunchAgent and the Node build for this Mac's CPU are.
BIN="$(cd "$(dirname "$0")" && pwd)"
APP="$(dirname "$BIN")/app"
BUNDLE="$(cd "$BIN/../../.." && pwd)"
DATA="${OWLBOT_DATA_DIR:-$HOME/Library/Application Support/Owlbot}"
LABEL=ai.owlbot.hub
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# Both Node builds ship; a translated (Rosetta) shell still reports arm64 hardware here.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  NODE="$APP/runtime/arm64/bin/node"
else
  NODE="$APP/runtime/x64/bin/node"
fi
export OWLBOT_DATA_DIR="$DATA"
