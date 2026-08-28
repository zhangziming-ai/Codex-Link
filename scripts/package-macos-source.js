"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const releaseRoot = path.join(root, "release");
const name = `Codex-Link-${packageJson.version}-mac-arm64-source`;
const target = path.join(releaseRoot, name);
const archive = `${target}.zip`;
const checksumFile = `${archive}.sha256.txt`;
const entries = [
  ".github",
  "build",
  "desktop",
  "docs",
  "lib",
  "public",
  "qa",
  "scripts",
  "test",
  "README.md",
  "package.json",
  "package-lock.json",
  "server.js"
];

function copyEntry(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const child of fs.readdirSync(source)) {
      copyEntry(path.join(source, child), path.join(destination, child));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

for (const output of [target, archive, checksumFile]) {
  if (fs.existsSync(output)) {
    throw new Error(`Refusing to overwrite existing release output: ${output}`);
  }
}

fs.mkdirSync(target, { recursive: true });
for (const entry of entries) {
  const source = path.join(root, entry);
  if (!fs.existsSync(source)) continue;
  copyEntry(source, path.join(target, entry));
}

let result;
if (process.platform === "win32") {
  result = spawnSync("tar", ["-a", "-c", "-f", archive, name], { cwd: releaseRoot, stdio: "inherit" });
} else if (process.platform === "darwin") {
  result = spawnSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", target, archive], { stdio: "inherit" });
} else {
  result = spawnSync("zip", ["-qr", archive, name], { cwd: releaseRoot, stdio: "inherit" });
}

if (result.status !== 0 || !fs.existsSync(archive)) {
  throw new Error(`Could not create Mac source archive (exit ${result.status ?? "unknown"}).`);
}

const checksum = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(checksumFile, `${checksum}  ${path.basename(archive)}\n`, "utf8");
console.log(JSON.stringify({ target, archive, checksumFile, checksum }, null, 2));
