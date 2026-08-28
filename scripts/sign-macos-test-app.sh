#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Local macOS test signing requires an Apple Silicon Mac." >&2
  exit 1
fi

app="dist/mac-arm64/Codex Link.app"
test -d "$app"

# Ad-hoc signing is intended only for local testing. It is not a release signature.
codesign --force --deep --sign - --entitlements build/entitlements.mac.plist "$app"
codesign --verify --deep --strict --verbose=2 "$app"
echo "Ad-hoc test signature verified: $app"
