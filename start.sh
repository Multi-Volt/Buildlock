#!/usr/bin/env sh
# Mac / Linux launcher. Double-click (Mac: right-click > Open the first time) or run ./start.sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."
  echo "Meanwhile you can open public/index.html directly in a browser (uses the saved Tracklock snapshot)."
  read -r _; exit 1
fi
( sleep 1.5; (command -v open >/dev/null && open http://localhost:8787) || (command -v xdg-open >/dev/null && xdg-open http://localhost:8787) ) >/dev/null 2>&1 &
node server.js --warm
