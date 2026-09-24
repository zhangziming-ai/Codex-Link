"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const installer = path.resolve("dist/Codex-Link-Setup-2.1.0-x64.exe");
const archive = path.resolve("dist/win-unpacked/resources/app.asar");
const evidencePath = path.resolve("ui-verification/ui01-2.1/installer-smoke.json");
const installerEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8").replace(/^\uFEFF/, ""));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const installerSha256 = sha(fs.readFileSync(installer));
assert.equal(installerSha256, installerEvidence.installerSha256.toLowerCase());
const packagedVersion = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8")).version;
assert.equal(packagedVersion, "2.1.0");

const files = [
  "public/index.html", "public/app.js", "public/ui01.css",
  "public/ui01.js", "public/assets/ui01-refraction.png",
  "public/assets/brand-glass-motion.gif", "server.js", "desktop/main.js"
];
const checks = files.map((file) => {
  const sourceHash = sha(fs.readFileSync(path.resolve(file)));
  const packageHash = sha(asar.extractFile(archive, path.normalize(file)));
  return { file, match: sourceHash === packageHash };
});
assert.ok(checks.every((item) => item.match), `Installer source differs: ${checks.filter((item) => !item.match).map((item) => item.file).join(", ")}`);

const result = {
  passed: true, version: packagedVersion, installerSha256,
  bytes: fs.statSync(installer).size, checks, date: new Date().toISOString()
};
const output = path.resolve("ui-verification/ui01-2.1/package-source-match.json");
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
