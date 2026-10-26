# Sourced by the other scripts here: where the app, the data and the Node build for this Mac's CPU are.
BIN="$(cd "$(dirname "$0")" && pwd)"
APP="$(dirname "$BIN")/app"
DATA="${OPENBOT_DATA_DIR:-$HOME/Library/Application Support/open-bot}"
LABEL=ai.openbot.hub
# Both Node builds ship; a translated (Rosetta) shell still reports arm64 hardware here.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  NODE="$APP/runtime/arm64/bin/node"
else
  NODE="$APP/runtime/x64/bin/node"
fi
export OPENBOT_DATA_DIR="$DATA"
