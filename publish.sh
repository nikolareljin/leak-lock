#!/bin/bash

set -euo pipefail

print_help() {
  cat <<'EOF'
Usage: ./publish.sh -t <type>

Options:
  -t <type>   Publish target: vscode or open-vsx
  -h          Show this help

Notes:
  - Reads credentials from .env in the repo root.
  - Expected variables: VSCE_PAT, OVSX_PAT, OVSX_NAMESPACE (optional).
EOF
}

TYPE=""

while getopts "t:h" opt; do
  case "$opt" in
    t) TYPE="$OPTARG" ;;
    h) print_help; exit 0 ;;
    *) print_help; exit 1 ;;
  esac
done

if [ -z "$TYPE" ]; then
  echo "Error: missing -t <type>."
  print_help
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "Error: .env not found in repo root."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

export NODE_OPTIONS="--max-old-space-size=4096"

package_vsix() {
  if ! command -v vsce >/dev/null 2>&1; then
    echo "vsce not found. Installing..."
    npm install -g @vscode/vsce
  fi

  if [ ! -d "node_modules" ]; then
    echo "Installing npm dependencies..."
    npm install
  fi

  echo "Packaging extension..."
  vsce package
  VSIX_FILE=$(ls *.vsix | head -1)
  if [ -z "$VSIX_FILE" ] || [ ! -f "$VSIX_FILE" ]; then
    echo "Error: .vsix package not found."
    exit 1
  fi
}

cleanup_vsix() {
  rm -f ./*.vsix
}

case "$TYPE" in
  vscode)
    if [ -z "${VSCE_PAT:-}" ]; then
      echo "Error: VSCE_PAT is not set in .env."
      exit 1
    fi
    package_vsix
    echo "Publishing to VS Code Marketplace..."
    vsce publish --pat "$VSCE_PAT"
    cleanup_vsix
    ;;
  open-vsx|openvsx|open)
    if ! command -v ovsx >/dev/null 2>&1; then
      echo "ovsx not found. Installing..."
      npm install -g ovsx
    fi
    # No --namespace support in ovsx CLI; publisher is set in package.json
    if [ -z "${OVSX_PAT:-}" ]; then
      echo "Error: OVSX_PAT is not set in .env."
      exit 1
    fi
    # OVSX_NAMESPACE is not required for ovsx CLI; publisher is set in package.json
    package_vsix
    echo "Publishing to Open VSX..."
    ovsx publish "$VSIX_FILE" -p "$OVSX_PAT"
    cleanup_vsix
    ;;
  *)
    echo "Error: unknown type '$TYPE'. Use 'vscode' or 'open-vsx'."
    print_help
    exit 1
    ;;
esac
