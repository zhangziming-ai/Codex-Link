"use strict";

const { spawnSync } = require("child_process");
const { _electron } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    ...options
  });
}

function hasExistingInstall() {
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
  ];
  return roots.some((root) => {
    const result = run("reg.exe", ["query", root, "/s", "/f", "Codex Link", "/d"]);
    return /DisplayName\s+REG_SZ\s+Codex Link(?:\s+\d+(?:\.\d+)*)?\s*$/im.test(result.stdout || "");
  });
}

async function waitUntil(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

(async () => {
  if (process.platform !== "win32") {
    throw new Error("Windows installer smoke test can only run on Windows.");
  }
  if (hasExistingInstall()) {
    throw new Error("An existing Codex Link installation was detected; refusing to replace it during smoke testing.");
  }

  const version = require("../package.json").version;
  const installer = path.join(process.cwd(), "dist", `Codex-Link-Setup-${version}-x64.exe`);
  if (!fs.existsSync(installer)) throw new Error(`Installer not found: ${installer}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-installer-e2e-"));
  const installDir = path.join(root, "installed-app");
  const backupDir = path.join(root, "user-backups");
  const codexHome = path.join(root, "fixture", ".codex");
  const userData = path.join(root, "user-data");
  const backupSentinel = path.join(backupDir, "restore-point.keep");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(backupSentinel, "backup data must survive uninstall\n", "utf8");
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "installer-smoke"\n', "utf8");

  let app;
  let uninstallCompleted = false;
  let installedBackupManifest = "";
  try {
    const installResult = run(installer, ["/S", `/D=${installDir}`]);
    if (installResult.status !== 0) {
      throw new Error(`Silent install failed (${installResult.status}): ${installResult.stderr || installResult.stdout}`);
    }

    const executable = path.join(installDir, "Codex Link.exe");
    if (!fs.existsSync(executable)) throw new Error("Installed executable is missing.");
    const uninstaller = fs.readdirSync(installDir)
      .find((name) => /^Uninstall.*\.exe$/i.test(name));
    if (!uninstaller) throw new Error("Installed uninstaller is missing.");

    const launchedAt = Date.now();
    app = await _electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${userData}`],
      env: { ...process.env, CODEX_HOME: codexHome }
    });
    const page = await app.firstWindow();
    await page.waitForSelector(".app-shell", { timeout: 15000 });
    await page.waitForFunction(
      () => document.querySelector("#sidebarRunState")?.textContent?.includes("扫描完成"),
      null,
      { timeout: 15000 }
    );
    const identity = await page.evaluate(() => ({
      title: document.title,
      heading: document.querySelector(".brand-name")?.textContent?.trim(),
      desktop: window.codexLinkDesktop?.isDesktop === true
    }));
    if (identity.title !== "Codex Link v1.2" || identity.heading !== "Codex Link" || !identity.desktop) {
      throw new Error(`Installed app identity check failed: ${JSON.stringify(identity)}`);
    }
    await page.click('[data-view="backup"]');
    await page.fill("#backupDirInput", backupDir);
    await page.click("#createBackupButton");
    await page.waitForFunction(
      () => document.querySelector("#backupResultVisualTitle")?.textContent?.includes("备份已创建"),
      null,
      { timeout: 30000 }
    );
    const restorePoints = path.join(backupDir, "Codex Link", "restore-points");
    const snapshot = fs.readdirSync(restorePoints, { withFileTypes: true })
      .find((entry) => entry.isDirectory());
    if (!snapshot) throw new Error("Installed app did not create a restore point.");
    installedBackupManifest = path.join(restorePoints, snapshot.name, "manifest.json");
    if (!fs.existsSync(installedBackupManifest)) throw new Error("Installed app backup manifest is missing.");
    const remainingLaunchTime = Math.max(0, 6000 - (Date.now() - launchedAt));
    if (remainingLaunchTime) await new Promise((resolve) => setTimeout(resolve, remainingLaunchTime));
    await app.close();
    app = null;

    const uninstallResult = run(path.join(installDir, uninstaller), ["/S"]);
    if (uninstallResult.status !== 0) {
      throw new Error(`Silent uninstall failed (${uninstallResult.status}): ${uninstallResult.stderr || uninstallResult.stdout}`);
    }
    const removed = await waitUntil(() => !fs.existsSync(executable));
    if (!removed) throw new Error("Installed executable remained after silent uninstall.");
    uninstallCompleted = true;
    if (!fs.existsSync(backupSentinel)) throw new Error("User backup data was removed by uninstall.");
    if (!fs.existsSync(installedBackupManifest)) throw new Error("Installed app restore point was removed by uninstall.");

    console.log(JSON.stringify({
      status: "passed",
      installer: path.basename(installer),
      customInstallDirectory: true,
      installedExecutableLaunchedForAtLeast6Seconds: true,
      installedBackupCreated: true,
      silentUninstall: true,
      backupDataPreserved: true
    }, null, 2));
  } finally {
    if (app) await app.close().catch(() => {});
    if (!uninstallCompleted && fs.existsSync(installDir)) {
      const fallbackUninstaller = fs.readdirSync(installDir)
        .find((name) => /^Uninstall.*\.exe$/i.test(name));
      if (fallbackUninstaller) {
        run(path.join(installDir, fallbackUninstaller), ["/S"]);
        await waitUntil(() => !fs.existsSync(path.join(installDir, "Codex Link.exe")), 15000);
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
