#!/usr/bin/env bash
# Install one plugin from this repo as a local MiniMax Code plugin.
#
#   scripts/install-plugin.sh <plugin-name>
#
# Local plugins live as a direct child of the runtime data dir's plugins folder
# (~/.minimax/plugins/<name>) and are enabled by presence there.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <plugin-name>" >&2
  exit 2
fi

PLUGIN_NAME="$1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$REPO_ROOT/$PLUGIN_NAME"
DATA_DIR="${MINIMAX_DATA_DIR:-$HOME/.minimax}"
TARGET_DIR="$DATA_DIR/plugins/$PLUGIN_NAME"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "no such plugin directory: $SOURCE_DIR" >&2
  exit 1
fi

echo "source:  $SOURCE_DIR"
echo "target:  $TARGET_DIR"

mkdir -p "$DATA_DIR/plugins"

if [ -e "$TARGET_DIR" ]; then
  echo "replacing existing $TARGET_DIR"
  # Use node rather than `rm`: the agent PATH has a recoverable-delete shim
  # ahead of /bin/rm, and its shebang may not resolve on this system.
  node -e 'require("node:fs").rmSync(process.argv[1], {recursive:true, force:true})' "$TARGET_DIR"
fi

mkdir -p "$TARGET_DIR"
# Copy the plugin payload, excluding developer-only scripts and local state.
for item in .minimax-plugin mcp server skills hooks agents bindings icon.webp package.json README.md; do
  [ -e "$SOURCE_DIR/$item" ] && cp -R "$SOURCE_DIR/$item" "$TARGET_DIR/"
done

echo "installed to $TARGET_DIR"

if command -v mcode >/dev/null 2>&1; then
  LISTED="$(mcode plugin list 2>/dev/null || true)"
  if printf '%s' "$LISTED" | grep -q "${PLUGIN_NAME}@local"; then
    if printf '%s' "$LISTED" | grep -q "^\[\*\] ${PLUGIN_NAME}@local"; then
      echo "already installed and enabled: ${PLUGIN_NAME}@local"
    else
      echo "already installed but not enabled — enabling"
      mcode plugin enable -m local "$PLUGIN_NAME" || true
    fi
  else
    mcode plugin add -m local "$PLUGIN_NAME" || {
      echo "note: 'mcode plugin add' reported an error; the files are in place, so you can also" >&2
      echo "      register it from the MiniMax Code UI or with:" >&2
      echo "        mcode plugin add -m local $PLUGIN_NAME" >&2
      exit 1
    }
  fi
  echo "list it with: mcode plugin list"
else
  echo "note: 'mcode' is not on PATH; register the plugin later with:" >&2
  echo "      mcode plugin add -m local $PLUGIN_NAME" >&2
fi
