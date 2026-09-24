"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const version = require("../package.json").version;
const base = `Codex-Link-${version}-mac-arm64-source`;
const archive = path.resolve("release", `${base}.zip`);
const checksumFile = `${archive}.sha256.txt`;
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const checksum = sha(fs.readFileSync(archive));
assert.ok(fs.readFileSync(checksumFile, "utf8").startsWith(checksum));

const listing = spawnSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
assert.equal(listing.status, 0, listing.stderr || "Cannot read ZIP listing");
const entries = listing.stdout.trim().split(/\r?\n/);
assert.ok(entries.length > 50);
assert.ok(entries.every((entry) => entry.startsWith(`${base}/`) &&
  !entry.split("/").includes("..") && !entry.includes("\\")));
assert.ok(entries.every((entry) => !/\/(?:node_modules|dist|release|\.env)(?:\/|$)/i.test(entry)));

const files = [
  "package.json", "package-lock.json", "public/index.html", "public/app.js",
  "public/ui01.css", "public/ui01.js", "public/assets/ui01-refraction.png",
  "public/assets/brand-glass-motion.gif", "desktop/main.js", "server.js",
  "scripts/build-macos-arm64.sh", "scripts/verify-macos-release.sh",
  ".github/workflows/build-macos-arm64.yml"
];
const checks = files.map((file) => {
  const result = spawnSync("tar", ["-xOf", archive, `${base}/${file}`], { maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, `Missing ${file}: ${result.stderr?.toString("utf8")}`);
  return { file, match: sha(result.stdout) === sha(fs.readFileSync(path.resolve(file))) };
});
assert.ok(checks.every((item) => item.match), `Source mismatch: ${checks.filter((item) => !item.match).map((item) => item.file).join(", ")}`);
const report = { passed: true, version, artifact: archive, sha256: checksum,
  bytes: fs.statSync(archive).size, entryCount: entries.length, checks, nativeMacBuild: false,
  date: new Date().toISOString() };
fs.writeFileSync(path.resolve("release", `${base}.validation.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
