#!/usr/bin/env bash
# Pack a plugin into a tarball that can be installed on its own.
#
#   scripts/package-plugin.sh <plugin-name> [output-dir]
#
# The archive contains exactly the payload the installer copies, so somebody
# can unpack it into ~/.minimax/plugins/<name>/ and have a working plugin
# without cloning the repository. The file list lives in
# scripts/plugin-payload.txt, shared with the installer.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <plugin-name> [output-dir]" >&2
  exit 2
fi

PLUGIN_NAME="$1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$REPO_ROOT/$PLUGIN_NAME"
OUTPUT_DIR="${2:-$REPO_ROOT/dist}"

if ! printf '%s' "$PLUGIN_NAME" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
  echo "invalid plugin name: '$PLUGIN_NAME'" >&2
  exit 2
fi

if [ ! -d "$SOURCE_DIR" ]; then
  echo "no such plugin directory: $SOURCE_DIR" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
ARCHIVE="$OUTPUT_DIR/$PLUGIN_NAME.tar.gz"
rm -f "$ARCHIVE"

# Build the file list from the shared payload definition, skipping anything
# this plugin does not have.
FILES=()
while IFS= read -r item; do
  if [ -z "$item" ]; then continue; fi
  if [ -e "$SOURCE_DIR/$item" ]; then
    FILES+=("$item")
  fi
done < "$REPO_ROOT/scripts/plugin-payload.txt"

if [ ${#FILES[@]} -eq 0 ]; then
  echo "nothing to pack for $PLUGIN_NAME" >&2
  exit 1
fi

tar -czf "$ARCHIVE" -C "$SOURCE_DIR" "${FILES[@]}"
echo "packed $PLUGIN_NAME -> $ARCHIVE"
tar -tzf "$ARCHIVE" | sed 's/^/  /'
