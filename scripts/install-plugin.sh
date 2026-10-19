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

# The name goes straight into a path that is then deleted recursively, so it
# has to be a plain name. Without this, an empty argument resolves to the
# plugins directory itself — which would uninstall every plugin — and a name
# like "../../.." resolves outside it entirely.
if ! printf '%s' "$PLUGIN_NAME" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
  echo "invalid plugin name: '$PLUGIN_NAME'" >&2
  echo "expected a plain name such as mcode-agnes (letters, digits, dot, dash, underscore)" >&2
  exit 2
fi

if [ ! -d "$SOURCE_DIR" ]; then
  echo "no such plugin directory: $SOURCE_DIR" >&2
  exit 1
fi

# Belt and braces: the delete target must stay inside the plugins directory.
case "$TARGET_DIR" in
  "$DATA_DIR/plugins/"*) ;;
  *)
    echo "refusing to install outside $DATA_DIR/plugins: $TARGET_DIR" >&2
    exit 1
    ;;
esac

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
# The list lives in one file so the installer and the packager ship the same set.
while IFS= read -r item; do
  if [ -z "$item" ]; then continue; fi
  if [ -e "$SOURCE_DIR/$item" ]; then
    cp -R "$SOURCE_DIR/$item" "$TARGET_DIR/"
  fi
done < "$REPO_ROOT/scripts/plugin-payload.txt"

# Shared modules live once in the repository and are copied into each plugin
# that has an MCP server, so the installed plugin is self-contained and there
# is still one source. A plugin with no server directory gets none.
if [ -d "$SOURCE_DIR/server" ] && [ -d "$REPO_ROOT/shared" ]; then
  mkdir -p "$TARGET_DIR/server"
  cp "$REPO_ROOT"/shared/*.mjs "$TARGET_DIR/server/" 2>/dev/null || true
fi

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
