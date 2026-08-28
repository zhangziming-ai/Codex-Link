# Codex Link Mac M Series Build Guide

This document describes how to build the Apple Silicon macOS package for Codex Link from the handoff source package.

## What is in the handoff package

The source package contains the files needed to build and verify the Mac M series product:

- `package.json` and `package-lock.json`
- Electron desktop entry files in `desktop/`
- Server and restore logic in `server.js` and `lib/`
- Web UI files in `public/`
- Build assets in `build/`, including `icon.icns` and macOS entitlements
- Build and verification scripts in `scripts/`
- Regression and macOS compatibility tests in `test/`
- QA/self-check definitions in `qa/`
- Project documentation, including this guide and `README.md`

The package intentionally does not include `node_modules/`, `dist/`, or generated UI screenshot folders. Those files are either platform-specific, generated output, or large verification artifacts. On Apple Silicon, dependencies must be installed natively with `npm ci` before packaging.

## macOS-only application packaging

Codex Link v1.0 does not create macOS application archives on Windows. The previous cross-platform ZIP path could encode framework symlink targets with Windows separators and is intentionally disabled.

Run `npm run package:mac:arm64` or `npm run package:mac:arm64:unsigned` on an Apple Silicon Mac. Both commands use the native macOS builder and the POSIX symlink verification gate. For local internal testing, `npm run sign:mac:test` applies and verifies an ad-hoc signature; it is not a release signature.

## Required build machine

Use an Apple Silicon Mac:

- macOS 12.0 or newer
- CPU architecture: `arm64` (`uname -m` should print `arm64`)
- Node.js and npm installed
- Xcode Command Line Tools installed

Install Xcode Command Line Tools if needed:

```bash
xcode-select --install
```

## Build unsigned internal test packages

From the unpacked project directory on the Apple Silicon Mac, run:

```bash
npm run package:mac:arm64
```

The script performs the full local gate:

```bash
npm ci
npm run check
npm test
npm run verify:mac
npm run build:mac:arm64
```

It also verifies the generated app and packages:

- Confirms the app executable is `arm64`
- Checks `Info.plist` metadata
- Verifies the `.dmg`
- Tests the `.zip`
- Mounts the DMG and checks the app plus Applications symlink
- Extracts the ZIP and checks the app architecture
- Smoke-launches the app extracted from the final ZIP with isolated test config paths and confirms it remains alive for at least 8 seconds
- Writes machine-readable and human-readable evidence to `qa/reports/macos-arm64-release-latest.json` and `.md`

Expected unsigned test outputs:

```text
dist/Codex-Link-1.0.0-mac-arm64.dmg
dist/Codex-Link-1.0.0-mac-arm64.zip
dist/mac-arm64/Codex Link.app
qa/reports/macos-arm64-release-latest.json
qa/reports/macos-arm64-release-latest.md
```

Unsigned packages are suitable for internal validation only. macOS Gatekeeper may warn users when opening them.

## Build on the Apple Silicon GitHub runner

The repository includes `.github/workflows/build-macos-arm64.yml`. In GitHub, open **Actions → Build macOS Apple Silicon → Run workflow**.

- Keep `release` off to create unsigned internal-test DMG and ZIP files.
- Turn `release` on only after the signing and notarization secrets listed below are configured.
- The workflow runs on GitHub's `macos-14` arm64 runner, executes the same local gate, writes SHA-256 checksums, and uploads the DMG, ZIP and both verification reports as a workflow artifact.
- The workflow fails immediately if the runner is not `Darwin arm64`.

## Build signed and notarized release packages

For public distribution, provide an Apple Developer ID Application certificate and notarization credentials.

Required signing variables:

```bash
export CODEX_LINK_MAC_RELEASE=1
export CSC_LINK="/path/to/developer-id-application.p12"
export CSC_KEY_PASSWORD="certificate-password"
```

Preferred App Store Connect API notarization variables:

```bash
export APPLE_API_KEY="/path/to/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Alternative Apple ID notarization variables:

```bash
export APPLE_ID="developer@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID1234"
```

Then run:

```bash
npm run package:mac:arm64
```

Release mode additionally runs:

```bash
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Codex Link.app"
spctl --assess --type execute --verbose=4 "dist/mac-arm64/Codex Link.app"
xcrun stapler validate "dist/mac-arm64/Codex Link.app"
```

The final verifier repeats `codesign` against the app extracted from the ZIP, checks the hardened-runtime flag and required Electron entitlements, and validates stapled notarization tickets on both the extracted app and DMG.

Do not treat a package as signed or notarized unless those checks pass.

## Useful direct commands

Run syntax checks only:

```bash
npm run check
```

Run all Node tests:

```bash
npm test
```

Run macOS/platform compatibility tests only:

```bash
npm run verify:mac
```

Verify already-built arm64 DMG and ZIP outputs and regenerate release evidence:

```bash
npm run verify:mac:release
```

Build macOS arm64 DMG and ZIP without the extra script gate:

```bash
npm run build:mac:arm64
```

Build the existing Windows NSIS installer on Windows:

```powershell
npm run build:win
```

## Current Windows limitation

Windows can build and verify the Windows NSIS package, but macOS application packaging is deliberately blocked. DMG/ZIP creation, POSIX symlink validation, launch testing, Developer ID signing and notarization remain on Apple Silicon macOS through `npm run package:mac:arm64` or `.github/workflows/build-macos-arm64.yml`.

References:

- Electron Packager supported hosts and `darwin-arm64` targets: <https://electron.github.io/packager/main/>
- GitHub-hosted runner specifications: <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
