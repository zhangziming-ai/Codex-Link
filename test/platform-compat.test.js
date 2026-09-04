"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const packageJson = require("../package.json");
const {
  cloudCandidates,
  createSelectionSnapshot,
  createSnapshot,
  loadConfig,
  normalizeConfig,
  restorePlan,
  saveConfig
} = require("../server");
const {
  executeRestoreTransaction,
  finalizeSnapshotManifest,
  portablePath,
  resolveInside,
  validateRelativePath
} = require("../lib/restore-engine");

function tempFixture(prefix = "codex-link-platform-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

test("macOS arm64 builder metadata coexists with the unchanged Windows NSIS target", () => {
  assert.equal(packageJson.version, "1.2.0");
  const desktopMain = fs.readFileSync(path.join(__dirname, "..", "desktop", "main.js"), "utf8");
  const publicHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const publicApp = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(desktopMain, /title:\s*["']Codex Link v1\.2["']/);
  assert.match(publicHtml, /<title>Codex Link v1\.2<\/title>/);
  assert.match(publicHtml, /id="viewRollbackPointsButton"/);
  assert.match(publicApp, /data-restore-project-expand-row/);
  assert.match(publicApp, /toggleRestoreProjectDetails/);
  assert.match(publicApp, /data-restore-group-toggle/);
  assert.match(publicApp, /data-restore-overview-toggle/);
  assert.doesNotMatch(publicApp, /<details class="restore-selection-group/);
  assert.doesNotMatch(publicApp, /<details class="restore-overview-group/);
  const macTargets = new Map(packageJson.build.mac.target.map((entry) => [entry.target, entry.arch]));
  assert.deepEqual(macTargets.get("dmg"), ["arm64"]);
  assert.deepEqual(macTargets.get("zip"), ["arm64"]);
  assert.equal(packageJson.build.mac.icon, "build/icon.icns");
  assert.equal(packageJson.build.mac.category, "public.app-category.utilities");
  assert.equal(packageJson.build.mac.minimumSystemVersion, "12.0");
  assert.match(packageJson.build.mac.artifactName, /mac-\$\{arch\}/);

  assert.deepEqual(packageJson.build.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.equal(packageJson.build.win.icon, "build/icon.png");
  assert.equal(packageJson.build.nsis.oneClick, false);
  assert.equal(packageJson.build.nsis.allowToChangeInstallationDirectory, true);

  const icon = fs.readFileSync(path.join(__dirname, "..", "build", "icon.icns"));
  assert.equal(icon.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icon.readUInt32BE(4), icon.length);

  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "build-macos-arm64.yml"), "utf8");
  assert.match(workflow, /runs-on:\s*macos-14/);
  assert.match(workflow, /test "\$\(uname -m\)" = "arm64"/);
  assert.match(workflow, /npm run package:mac:arm64/);
  assert.match(workflow, /macos-arm64-release-latest\.json/);
  assert.match(workflow, /actions\/upload-artifact@v4/);

  const gate = fs.readFileSync(path.join(__dirname, "..", "scripts", "build-macos-arm64.sh"), "utf8");
  assert.match(gate, /scripts\/verify-macos-release\.sh/);
  const releaseVerification = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-macos-release.sh"), "utf8");
  assert.match(releaseVerification, /lipo -archs/);
  assert.match(releaseVerification, /hdiutil verify/);
  assert.match(releaseVerification, /ditto -x -k/);
  assert.match(releaseVerification, /sleep 8/);
  assert.match(releaseVerification, /codesign --verify --deep --strict/);
  assert.match(releaseVerification, /xcrun stapler validate "\$dmg"/);
  assert.match(releaseVerification, /macos-arm64-release-latest\.json/);
});

test("darwin backup candidates never contain Windows drive paths", () => {
  const candidates = cloudCandidates({
    platform: "darwin",
    homeDir: "/Users/tester",
    env: {},
    exists: () => false
  });

  assert.ok(candidates.some((item) => item.path.includes("/Library/Mobile Documents/com~apple~CloudDocs/")));
  assert.ok(candidates.some((item) => item.path.includes("/Library/CloudStorage/OneDrive-Personal/")));
  assert.equal(candidates.some((item) => /^[A-Za-z]:[\\/]/.test(item.path)), false);
  assert.equal(candidates.some((item) => item.path.includes("\\")), false);
});

test("foreign absolute settings fall back locally and tilde paths expand on macOS", () => {
  const options = {
    platform: "darwin",
    homeDir: "/Users/tester",
    env: {},
    exists: () => false
  };
  const migrated = normalizeConfig({
    codexHome: "C:\\Users\\old\\.codex",
    cloudDir: "D:\\Backups"
  }, options);

  assert.equal(migrated.codexHome, "/Users/tester/.codex");
  assert.equal(migrated.cloudDir, "/Users/tester/Documents/Codex Link Backups");
  assert.equal(normalizeConfig({ cloudDir: "~/Portable Backups" }, options).cloudDir, "/Users/tester/Portable Backups");
});

test("settings writes keep a durable last-known-good backup", (t) => {
  const root = tempFixture();
  const configFile = path.join(root, "Application Support", "Codex Link", "codex-link.config.local.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = saveConfig({ cloudDir: path.join(root, "first") }, configFile);
  const second = saveConfig({ cloudDir: path.join(root, "second") }, configFile);
  assert.equal(loadConfig(configFile).cloudDir, second.cloudDir);
  assert.equal(fs.existsSync(`${configFile}.bak`), true);

  fs.writeFileSync(configFile, "{truncated", "utf8");
  assert.equal(loadConfig(configFile).cloudDir, first.cloudDir);
});

test("portable restore paths accept legacy backslashes but reject absolute or escaping values", (t) => {
  const root = tempFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = write(root, path.join("payload", "selected", "conversation.jsonl"), "{}\n");

  assert.equal(portablePath("payload\\selected\\conversation.jsonl"), "payload/selected/conversation.jsonl");
  assert.equal(validateRelativePath("payload\\selected\\conversation.jsonl"), "payload/selected/conversation.jsonl");
  assert.equal(resolveInside(root, "payload\\selected\\conversation.jsonl"), expected);
  assert.throws(() => validateRelativePath("C:\\Users\\name\\file"), /Unsafe relative path/);
  assert.throws(() => validateRelativePath("../outside"), /Unsafe relative path/);
});

test("selection manifests always serialize portable paths", (t) => {
  const root = tempFixture();
  const codexHome = path.join(root, ".codex");
  const conversation = write(codexHome, path.join("sessions", "sample.jsonl"), "{}\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const snapshot = createSelectionSnapshot({
    codexHome,
    cloudDir: path.join(root, "backups"),
    selected: {
      conversations: [{ path: conversation, title: "sample" }],
      capabilities: []
    },
    dryRun: true
  });

  assert.equal(snapshot.manifest.sourceArch, process.arch);
  assert.match(snapshot.manifest.copied[0].target, /^payload\/selected\/conversations\//);
  assert.equal(snapshot.manifest.copied[0].target.includes("\\"), false);
});

test("cross-system config restore imports for manual merge without overwriting the target", (t) => {
  const root = tempFixture();
  const source = path.join(root, "source", ".codex");
  const target = path.join(root, "target", ".codex");
  const cloud = path.join(root, "backups");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(source, "config.toml", "model = \"source-model\"\n");
  write(target, "config.toml", "model = \"target-model\"\n");

  const snapshot = createSnapshot({
    codexHome: source,
    cloudDir: cloud,
    include: { config: true },
    dryRun: false
  });
  snapshot.manifest.sourceOS = process.platform === "win32" ? "darwin" : "win32";
  finalizeSnapshotManifest(snapshot.snapshotDir, snapshot.manifest);

  const plan = restorePlan({
    snapshotDir: snapshot.snapshotDir,
    targetCodexHome: target,
    targetOS: process.platform
  });
  const configMapping = plan.mappings.find((item) => item.label === "基础配置");
  assert.equal(configMapping.action, "import_for_manual_merge");
  assert.ok(configMapping.target.includes("_codex-link-import"));

  executeRestoreTransaction({ plan, cloudDir: cloud, confirmHighRisk: true });
  assert.equal(fs.readFileSync(path.join(target, "config.toml"), "utf8"), "model = \"target-model\"\n");
  assert.equal(fs.readFileSync(configMapping.target, "utf8"), "model = \"source-model\"\n");
});
