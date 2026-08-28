#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This packaging gate must run on an Apple Silicon Mac (Darwin arm64)." >&2
  exit 1
fi

if [[ "${CODEX_LINK_MAC_RELEASE:-0}" == "1" ]]; then
  : "${CSC_LINK:?Set CSC_LINK to a Developer ID Application certificate (.p12 path, URL, or base64).}"
  : "${CSC_KEY_PASSWORD:?Set CSC_KEY_PASSWORD for the signing certificate.}"
  if [[ -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_ISSUER:-}" ]]; then
    : "${APPLE_ID:?Set APPLE_ID, or provide all three App Store Connect API key variables.}"
    : "${APPLE_APP_SPECIFIC_PASSWORD:?Set APPLE_APP_SPECIFIC_PASSWORD.}"
    : "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID.}"
  fi
  build_script="build:mac:release"
else
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  build_script="build:mac:arm64"
fi

npm ci
npm run check
npm test
npm run verify:mac
npm run "$build_script"
chmod +x scripts/verify-macos-release.sh
scripts/verify-macos-release.sh
