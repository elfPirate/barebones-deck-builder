#!/bin/bash
# Double-click this file in Finder to launch the Barebones Deck Builder.
# It starts the local server (serve.py) and opens the app in your browser.
# The server stops automatically a few seconds after you close the tab.

cd "$(dirname "$0")" || exit 1

# Prefer python3; fall back to python if that's all that exists.
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "Python 3 is required but was not found."
  echo "Install it from https://www.python.org/downloads/ and try again."
  read -r -p "Press Enter to close..."
  exit 1
fi

echo "Starting Barebones Deck Builder..."
"$PY" serve.py
