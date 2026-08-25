#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This bootstrap is for macOS. Run the equivalent pinned tools manually on this platform." >&2
  exit 2
fi

command -v brew >/dev/null 2>&1 || {
  echo "Homebrew is required: https://brew.sh" >&2
  exit 2
}

brew install volta uv docker docker-compose colima
volta install node@22.23.2 yarn@1.22.22
uv python install 3.12.14

if ! colima status >/dev/null 2>&1; then
  colima start --cpu 4 --memory 8 --disk 60
fi

exec "$HOME/.volta/bin/yarn" setup
