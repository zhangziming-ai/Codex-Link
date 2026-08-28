"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { validateMacosReleaseEvidence } = require("../lib/macos-release-evidence");
const CURRENT_VERSION = require("../package.json").version;

function fixture(overrides = {}) {
  const value = {
    status: "passed",
    host: { os: "macOS", version: "15.6", arch: "arm64" },
    product: { version: CURRENT_VERSION, bundleId: "com.codexlink.desktop", minimumSystemVersion: "12.0" },
    releaseMode: false,
    artifacts: {
      dmg: { path: `dist/Codex-Link-${CURRENT_VERSION}-mac-arm64.dmg`, bytes: 10, sha256: "a".repeat(64) },
      zip: { path: `dist/Codex-Link-${CURRENT_VERSION}-mac-arm64.zip`, bytes: 10, sha256: "b".repeat(64) }
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
      signatureVerified: false,
      hardenedRuntimeVerified: false,
      notarizationTicketVerified: false
    }
  };
  return Object.assign(value, overrides);
}

function verify(value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-mac-evidence-"));
  const file = path.join(root, "report.json");
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  try {
    return validateMacosReleaseEvidence(file, CURRENT_VERSION);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("unsigned Apple Silicon internal report proves functional Mac completion", () => {
  const result = verify(fixture());
  assert.equal(result.pass, true);
  assert.match(result.evidence, /内部测试模式/);
});

test("non-arm64 host or short launch cannot prove Mac completion", () => {
  const value = fixture();
  value.host.arch = "x64";
  value.validation.extractedZipLaunchSeconds = 1;
  const result = verify(value);
  assert.equal(result.pass, false);
  assert.match(result.evidence, /macOS arm64/);
  assert.match(result.evidence, /8 秒/);
});

test("release mode additionally requires signature, hardened runtime and notarization", () => {
  const value = fixture({ releaseMode: true });
  const result = verify(value);
  assert.equal(result.pass, false);
  assert.match(result.evidence, /发布签名/);
  assert.match(result.evidence, /hardened runtime/);
  assert.match(result.evidence, /公证票据/);
});
