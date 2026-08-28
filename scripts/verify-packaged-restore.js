const { _electron } = require("playwright");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function verifyManifest(snapshotDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8"));
  if (manifest.integrity?.algorithm !== "sha256") throw new Error("Snapshot is missing SHA-256 integrity metadata.");
  for (const entry of manifest.integrity.files || []) {
    if (entry.type !== "file") continue;
    const filePath = path.join(snapshotDir, "payload", ...entry.path.split("/"));
    if (!fs.existsSync(filePath)) throw new Error(`Snapshot file is missing: ${entry.path}`);
    if (sha256File(filePath) !== entry.sha256) throw new Error(`Snapshot hash mismatch: ${entry.path}`);
  }
  return manifest;
}

function firstDirectory(parent) {
  return fs.readdirSync(parent, { withFileTypes: true }).find((entry) => entry.isDirectory())?.name;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-packaged-e2e-"));
  const source = path.join(root, "source", ".codex");
  const target = path.join(root, "target", ".codex");
  const cloud = path.join(root, "backups");
  const userData = path.join(root, "user-data");
  const executablePath = path.join(process.cwd(), "dist", "win-unpacked", "Codex Link.exe");
  const sourceContents = 'model = "restored-from-snapshot"\n';
  const originalTargetContents = 'model = "original-target"\n';
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(source, "config.toml"), sourceContents);
  fs.writeFileSync(path.join(target, "config.toml"), originalTargetContents);

  let app;
  try {
    console.log("packaged-e2e: launching app");
    app = await _electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      env: {
        ...process.env,
        CODEX_HOME: source,
        CODEX_LINK_ALLOW_TEST_INSTANCE: "1",
        CODEX_LINK_CONFIG_FILE: path.join(root, "codex-link.config.local.json")
      },
    });
    console.log("packaged-e2e: app launched");
    const page = await app.firstWindow();
    console.log("packaged-e2e: first window ready");
    const identity = {
      version: await app.evaluate(({ app: electronApp }) => electronApp.getVersion()),
      documentTitle: await page.title(),
      nativeTitle: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())
    };
    if (identity.version !== "1.0.0" || identity.documentTitle !== "Codex Link v1.0" || identity.nativeTitle !== "Codex Link v1.0") {
      throw new Error("Packaged identity mismatch: " + JSON.stringify(identity));
    }
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text().slice(0, 300));
    });
    page.on("pageerror", (error) => errors.push(error.message.slice(0, 300)));
    page.on("dialog", (dialog) => dialog.accept());

    await page.waitForSelector(".app-shell");
    try {
      await page.waitForFunction(() => document.querySelector("#sidebarRunState")?.textContent?.includes("扫描完成"), null, { timeout: 15000 });
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        status: document.querySelector("#sidebarRunState")?.textContent,
        backupResult: document.querySelector("#backupResult")?.textContent,
        restoreResult: document.querySelector("#restoreResult")?.textContent,
        body: document.body?.innerText?.slice(0, 1200)
      }));
      throw new Error("Initial packaged scan did not complete: " + JSON.stringify({ diagnostics, errors, cause: error.message }));
    }
    console.log("packaged-e2e: scan complete");
    await page.click('[data-view="backup"]');
    await page.fill("#backupDirInput", cloud);
    await page.click("#createBackupButton");
    await page.waitForFunction(() => document.querySelector("#backupResultVisualTitle")?.textContent?.includes("备份已创建"), null, { timeout: 30000 });
    console.log("packaged-e2e: backup complete");

    const restorePointsDir = path.join(cloud, "Codex Link", "restore-points");
    const snapshotId = firstDirectory(restorePointsDir);
    if (!snapshotId) throw new Error("Packaged app did not create a restore point.");
    const snapshotDir = path.join(restorePointsDir, snapshotId);
    const manifest = verifyManifest(snapshotDir);

    await page.click('[data-view="restore"]');
    await page.check('input[name="restoreEnvironmentMode"][value="formal"]');
    await page.fill("#restoreSnapshotInput", snapshotDir);
    await page.fill("#restoreTargetInput", target);
    await page.click("#restorePlanButton");
    await page.waitForFunction(() => {
      const button = document.querySelector("#restoreExecuteButton");
      return button && !button.hidden && !button.disabled;
    }, null, { timeout: 20000 });
    console.log("packaged-e2e: restore plan ready");
    const planText = await page.locator("#restoreSummary").innerText();
    if (!planText.includes("SHA-256 校验通过")) throw new Error("Restore plan did not report verified SHA-256 integrity.");

    await page.click("#restoreExecuteButton");
    console.log("packaged-e2e: restore started");
    const completed = await page.waitForFunction(() => {
      const text = document.querySelector("#restoreSummary")?.textContent || "";
      return text.includes("恢复完成") || text.includes("恢复失败") || text.includes("恢复未完成");
    }, null, { timeout: 30000 }).then(() => true).catch(() => false);
    if (!completed) {
      const diagnostics = await page.evaluate(() => ({
        summary: document.querySelector("#restoreSummary")?.textContent?.replace(/\s+/g, " ").trim(),
        result: document.querySelector("#restoreResult")?.textContent?.slice(0, 1200),
        executeText: document.querySelector("#restoreExecuteButton")?.textContent?.trim(),
        executeDisabled: document.querySelector("#restoreExecuteButton")?.disabled,
      }));
      await page.screenshot({
        path: path.join(process.cwd(), "ui-verification", "desktop-app", "packaged-restore-timeout-1360x900.png"),
        fullPage: true,
      });
      throw new Error("Restore execution did not settle: " + JSON.stringify({ diagnostics, errors }));
    }
    const completionText = await page.locator("#restoreSummary").innerText();
    if (!completionText.includes("恢复完成")) {
      const resultText = await page.locator("#restoreResult").textContent();
      throw new Error("Packaged restore failed: " + resultText.slice(0, 1200));
    }
    const result = JSON.parse(await page.locator("#restoreResult").textContent());
    const restoredContents = fs.readFileSync(path.join(target, "config.toml"), "utf8");
    if (restoredContents !== sourceContents) throw new Error("Restored target content does not match the snapshot.");
    if (!result.postRestoreVerification?.verified) throw new Error("Post-restore verification did not pass.");
    if (!result.rollbackPoint?.path) throw new Error("Restore result is missing its automatic rollback point.");
    const rollbackManifest = verifyManifest(result.rollbackPoint.path);

    await page.screenshot({
      path: path.join(process.cwd(), "ui-verification", "desktop-app", "packaged-restore-complete-1360x900.png"),
      fullPage: true,
    });

    console.log(JSON.stringify({
      status: "passed",
      identity,
      snapshotId,
      snapshotFiles: manifest.integrity.fileCount,
      snapshotIntegrity: "sha256-verified",
      restoredMappings: result.restoredMappings,
      postRestoreVerification: result.postRestoreVerification.verified,
      rollbackPoint: path.basename(result.rollbackPoint.path),
      rollbackFiles: rollbackManifest.integrity.fileCount,
      consoleErrors: errors,
    }, null, 2));
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
