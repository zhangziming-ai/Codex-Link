#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This verification gate must run on an Apple Silicon Mac (Darwin arm64)." >&2
  exit 1
fi

version="$(node -p "require('./package.json').version")"
app="dist/mac-arm64/Codex Link.app"
executable="$app/Contents/MacOS/Codex Link"
info_plist="$app/Contents/Info.plist"
dmg="dist/Codex-Link-${version}-mac-arm64.dmg"
zip="dist/Codex-Link-${version}-mac-arm64.zip"
report_json="qa/reports/macos-arm64-release-latest.json"

assert_posix_symlinks() {
  local candidate_app="$1"
  local label="$2"
  local broken
  broken="$(find -L "$candidate_app" -type l -print -quit)"
  if [[ -n "$broken" ]]; then
    echo "$label contains a broken symbolic link: $broken" >&2
    return 1
  fi
  while IFS= read -r link_path; do
    local link_target
    link_target="$(readlink "$link_path")"
    if [[ "$link_target" == *\\* ]]; then
      echo "$label contains a Windows-style symbolic-link target: $link_path -> $link_target" >&2
      return 1
    fi
  done < <(find "$candidate_app" -type l -print)
}
report_md="qa/reports/macos-arm64-release-latest.md"
release_mode="${CODEX_LINK_MAC_RELEASE:-0}"

test -d "$app"
test -f "$dmg"
test -f "$zip"
test -x "$executable"
test "$(lipo -archs "$executable")" = "arm64"
test "$(plutil -extract CFBundleIdentifier raw "$info_plist")" = "com.codexlink.desktop"
test "$(plutil -extract CFBundleDisplayName raw "$info_plist")" = "Codex Link"
test "$(plutil -extract LSMinimumSystemVersion raw "$info_plist")" = "12.0"
test -f "$app/Contents/Resources/icon.icns"
assert_posix_symlinks "$app" "Built app"
hdiutil verify "$dmg"
unzip -t "$zip" >/dev/null

mount_dir="$(mktemp -d)"
zip_dir="$(mktemp -d)"
smoke_root="$(mktemp -d)"
mounted=0
app_pid=""
cleanup() {
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then
    kill "$app_pid" || true
    wait "$app_pid" || true
  fi
  if [[ "$mounted" == "1" ]]; then
    hdiutil detach "$mount_dir" -quiet || true
  fi
  rm -rf "$mount_dir" "$zip_dir" "$smoke_root"
}
trap cleanup EXIT

hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$mount_dir" -quiet
mounted=1
test -d "$mount_dir/Codex Link.app"
test -L "$mount_dir/Applications"
test "$(lipo -archs "$mount_dir/Codex Link.app/Contents/MacOS/Codex Link")" = "arm64"
assert_posix_symlinks "$mount_dir/Codex Link.app" "DMG app"
hdiutil detach "$mount_dir" -quiet
mounted=0

ditto -x -k "$zip" "$zip_dir"
zip_app="$zip_dir/Codex Link.app"
zip_executable="$zip_app/Contents/MacOS/Codex Link"
test -x "$zip_executable"
test "$(lipo -archs "$zip_executable")" = "arm64"

mkdir -p "$smoke_root/home" "$smoke_root/user-data"
printf 'model = "macos-arm64-release-smoke"\n' > "$smoke_root/home/config.toml"
env CODEX_HOME="$smoke_root/home" CODEX_LINK_CONFIG_FILE="$smoke_root/config.json" \
  "$zip_executable" --user-data-dir="$smoke_root/user-data" >"$smoke_root/app.log" 2>&1 &
assert_posix_symlinks "$zip_app" "ZIP app"
app_pid=$!
sleep 8
kill -0 "$app_pid"
kill "$app_pid"
wait "$app_pid" || true
app_pid=""

signature_verified=false
notarization_verified=false
hardened_runtime_verified=false
if [[ "$release_mode" == "1" ]]; then
  codesign --verify --deep --strict --verbose=2 "$app"
  codesign --verify --deep --strict --verbose=2 "$zip_app"
  codesign -dvv "$zip_app" 2>"$smoke_root/codesign.txt"
  grep -Eq 'flags=.*runtime' "$smoke_root/codesign.txt"
  codesign -d --entitlements :- "$zip_app" >"$smoke_root/entitlements.plist" 2>/dev/null
  test "$(plutil -extract com.apple.security.cs.allow-jit raw "$smoke_root/entitlements.plist")" = "true"
  test "$(plutil -extract com.apple.security.cs.allow-unsigned-executable-memory raw "$smoke_root/entitlements.plist")" = "true"
  spctl --assess --type execute --verbose=4 "$zip_app"
  xcrun stapler validate "$zip_app"
  xcrun stapler validate "$dmg"
  signature_verified=true
  notarization_verified=true
  hardened_runtime_verified=true
fi

mkdir -p "$(dirname "$report_json")"
dmg_sha="$(shasum -a 256 "$dmg" | awk '{print $1}')"
zip_sha="$(shasum -a 256 "$zip" | awk '{print $1}')"
os_version="$(sw_vers -productVersion)"

REPORT_JSON="$report_json" REPORT_MD="$report_md" VERSION="$version" OS_VERSION="$os_version" \
DMG_PATH="$dmg" ZIP_PATH="$zip" DMG_SHA="$dmg_sha" ZIP_SHA="$zip_sha" \
DMG_BYTES="$(stat -f %z "$dmg")" ZIP_BYTES="$(stat -f %z "$zip")" \
RELEASE_MODE="$release_mode" SIGNATURE_VERIFIED="$signature_verified" \
NOTARIZATION_VERIFIED="$notarization_verified" HARDENED_RUNTIME_VERIFIED="$hardened_runtime_verified" \
node <<'NODE'
const fs = require("fs");
const path = require("path");
const yes = (name) => process.env[name] === "true";
const report = {
  schemaVersion: 1,
  status: "passed",
  generatedAt: new Date().toISOString(),
  host: { os: "macOS", version: process.env.OS_VERSION, arch: "arm64" },
  product: { name: "Codex Link", version: process.env.VERSION, bundleId: "com.codexlink.desktop", minimumSystemVersion: "12.0" },
  releaseMode: process.env.RELEASE_MODE === "1",
  artifacts: {
    dmg: { path: process.env.DMG_PATH, bytes: Number(process.env.DMG_BYTES), sha256: process.env.DMG_SHA },
    zip: { path: process.env.ZIP_PATH, bytes: Number(process.env.ZIP_BYTES), sha256: process.env.ZIP_SHA }
  },
  validation: {
    mainMachO: "arm64",
    dmgVerifiedAndMounted: true,
    applicationsSymlink: true,
    zipIntegrity: true,
    extractedZipMachO: "arm64",
    extractedZipLaunchSeconds: 8,
    extractedZipStayedAlive: true,
    customIcon: true,
    signatureVerified: yes("SIGNATURE_VERIFIED"),
    hardenedRuntimeVerified: yes("HARDENED_RUNTIME_VERIFIED"),
    notarizationTicketVerified: yes("NOTARIZATION_VERIFIED")
  }
};
fs.writeFileSync(process.env.REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const md = [
  "# Codex Link macOS arm64 发布验证",
  "",
  `- 状态：**${report.status.toUpperCase()}**`,
  `- 执行时间：${report.generatedAt}`,
  `- 主机：macOS ${report.host.version} · ${report.host.arch}`,
  `- 版本：${report.product.version}`,
  `- 发布签名模式：${report.releaseMode ? "是" : "否（内部测试包）"}`,
  "",
  "## 验证结果",
  "",
  `- DMG 校验、挂载、Applications 链接：通过`,
  `- ZIP 完整性、解压与 arm64：通过`,
  `- ZIP 解压应用持续启动 8 秒：通过`,
  `- 签名/强化运行时/公证票据：${report.releaseMode ? "通过" : "未执行"}`,
  "",
  "## SHA-256",
  "",
  `- DMG：\`${report.artifacts.dmg.sha256}\``,
  `- ZIP：\`${report.artifacts.zip.sha256}\``,
  ""
].join("\n");
fs.writeFileSync(process.env.REPORT_MD, md, "utf8");
NODE

echo "macOS arm64 release verification passed:"
printf '  %s\n' "$dmg" "$zip" "$report_json" "$report_md"
