#!/usr/bin/env bash
# Install mcode-chrome as a local MiniMax Code plugin.
#
#   bash mcode-chrome/scripts/install.sh
#
# The plugin lives in a checkout of this repository, so the real installer is
# the repository's own — one implementation, one payload list, one set of
# safety checks. This script is a convenience wrapper for the plugin's
# directory.
set -euo pipefail

PLUGIN_NAME="mcode-chrome"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SOURCE_DIR/.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/install-plugin.sh"

if [ ! -f "$INSTALLER" ]; then
  echo "cannot find $INSTALLER" >&2
  echo "this plugin has to be installed from a checkout of the repository:" >&2
  echo "  git clone https://github.com/DraconDev/mcode-plugins.git" >&2
  exit 1
fi

exec bash "$INSTALLER" "$PLUGIN_NAME"
