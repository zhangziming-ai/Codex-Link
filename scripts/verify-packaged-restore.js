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
  const projectRoot = path.join(root, "projects", "项目甲");
  const cloud = path.join(root, "backups");
  const userData = path.join(root, "user-data");
  const executablePath = path.join(process.cwd(), "dist", "win-unpacked", "Codex Link.exe");
  const sourceContents = 'model = "restored-from-snapshot"\n';
  const originalTargetContents = 'model = "original-target"\n';
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(source, "config.toml"), sourceContents);
  fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
  for (let index = 1; index <= 34; index += 1) {
    const fixtureProject = index === 1 ? projectRoot : path.join(root, "projects", `项目-${index}`);
    fs.mkdirSync(fixtureProject, { recursive: true });
    fs.writeFileSync(path.join(source, "sessions", `project-thread-${index}.jsonl`),
      JSON.stringify({ type: "session_meta", timestamp: "2026-09-04T00:00:00.000Z", payload: { id: `project-thread-${index}`, cwd: fixtureProject, title: `项目 ${index} 测试对话` } }) + "\n");
  }
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
    if (identity.version !== "1.2.0" || identity.documentTitle !== "Codex Link v1.2" || identity.nativeTitle !== "Codex Link v1.2") {
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
    await page.waitForFunction(() => document.querySelector("[data-restore-overview-project-toggle]"), null, { timeout: 20000 });
    console.log("packaged-e2e: project restore plan ready");
    const accordionState = await page.evaluate(() => {
      const selectionToggle = document.querySelector('[data-restore-group-toggle]:not([data-restore-group-toggle="projects"])');
      const selectionBody = selectionToggle
        ? document.getElementById(selectionToggle.getAttribute("aria-controls"))
        : null;
      const overviewToggle = document.querySelector("[data-restore-overview-toggle]");
      const overviewBody = overviewToggle
        ? document.getElementById(overviewToggle.getAttribute("aria-controls"))
        : null;
      const selectionKey = selectionToggle?.dataset.restoreGroupToggle || null;
      if (selectionToggle?.getAttribute("aria-expanded") !== "true") selectionToggle.click();
      overviewToggle?.click();
      const currentSelectionToggle = selectionKey
        ? document.querySelector(`[data-restore-group-toggle="${selectionKey}"]`)
        : null;
      const currentSelectionBody = currentSelectionToggle
        ? document.getElementById(currentSelectionToggle.getAttribute("aria-controls"))
        : null;
      const projectGroupToggle = document.querySelector('[data-restore-overview-toggle="projects"]');
      if (projectGroupToggle?.getAttribute("aria-expanded") !== "true") projectGroupToggle.click();
      const projectToggle = document.querySelector("[data-restore-overview-project-toggle]");
      if (projectToggle?.getAttribute("aria-expanded") !== "true") projectToggle.click();
      const projectBody = projectToggle
        ? document.getElementById(projectToggle.getAttribute("aria-controls"))
        : null;
      const selectionProjectToggle = document.querySelector('[data-restore-group-toggle="projects"]');
      if (selectionProjectToggle?.getAttribute("aria-expanded") !== "true") selectionProjectToggle.click();
      const currentSelectionProjectToggle = document.querySelector('[data-restore-group-toggle="projects"]');
      const projectCountTarget = currentSelectionProjectToggle?.querySelector(".restore-category-count");
      const projectChevronTarget = currentSelectionProjectToggle?.querySelector(".restore-category-chevron");
      projectCountTarget?.click();
      const closedFromCount = currentSelectionProjectToggle?.getAttribute("aria-expanded") === "false";
      projectCountTarget?.click();
      const reopenedFromCount = currentSelectionProjectToggle?.getAttribute("aria-expanded") === "true";
      projectChevronTarget?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const closedFromChevron = currentSelectionProjectToggle?.getAttribute("aria-expanded") === "false";
      projectChevronTarget?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const reopenedFromChevron = currentSelectionProjectToggle?.getAttribute("aria-expanded") === "true";
      const selectionProjectBody = currentSelectionProjectToggle
        ? document.getElementById(currentSelectionProjectToggle.getAttribute("aria-controls"))
        : null;
      const selectionProjectGrid = selectionProjectBody?.querySelector(".restore-project-grid");
      const selectionProjectNode = selectionProjectBody?.querySelector(".restore-project-node");
      const selectionProjectName = selectionProjectNode?.querySelector(".restore-project-toggle strong");
      const nextSelectionGroup = currentSelectionProjectToggle?.closest(".restore-selection-group")?.nextElementSibling;
      const projectNameRect = selectionProjectName?.getBoundingClientRect();
      const projectBodyRect = selectionProjectBody?.getBoundingClientRect();
      const nextGroupRect = nextSelectionGroup?.getBoundingClientRect();
      const overviewExpandedBeforeAction = overviewToggle?.getAttribute("aria-expanded") === "true";
      const overviewVisibleBeforeAction = Boolean(overviewBody && !overviewBody.hidden && overviewBody.getBoundingClientRect().height > 0);
      const overviewProjectVisibleBeforeAction = Boolean(projectBody && !projectBody.hidden && projectBody.getBoundingClientRect().height > 0);
      if (selectionProjectBody) selectionProjectBody.scrollTop = 120;
      const projectSelectButton = selectionProjectNode?.querySelector("[data-restore-project-select]");
      projectSelectButton?.click();
      const bodyAfterProjectAction = document.getElementById("restore-selection-body-projects");
      const buttonAfterProjectAction = document.querySelector("[data-restore-project-select]");
      const scrollAfterFirstProjectAction = bodyAfterProjectAction?.scrollTop ?? -1;
      buttonAfterProjectAction?.click();
      const finalSelectionProjectToggle = document.querySelector('[data-restore-group-toggle="projects"]');
      const finalSelectionProjectBody = document.getElementById("restore-selection-body-projects");
      const finalSelectionProjectGrid = finalSelectionProjectBody?.querySelector(".restore-project-grid");
      const finalSelectionProjectNode = finalSelectionProjectBody?.querySelector(".restore-project-node");
      const finalSelectionProjectName = finalSelectionProjectNode?.querySelector(".restore-project-toggle strong");
      const finalProjectNameRect = finalSelectionProjectName?.getBoundingClientRect();
      const finalProjectBodyRect = finalSelectionProjectBody?.getBoundingClientRect();
      const finalNextGroupRect = finalSelectionProjectToggle?.closest(".restore-selection-group")?.nextElementSibling?.getBoundingClientRect();
      const scrollAfterSecondProjectAction = finalSelectionProjectBody?.scrollTop ?? -1;
      return {
        selectionExpanded: document.querySelector('[data-restore-group-toggle="' + selectionKey + '"]')?.getAttribute("aria-expanded") === "true",
        selectionVisible: Boolean(document.getElementById("restore-selection-body-" + selectionKey)?.getBoundingClientRect().height > 0),
        overviewExpanded: overviewExpandedBeforeAction,
        overviewVisible: overviewVisibleBeforeAction,
        projectGrouped: Boolean(projectToggle),
        projectVisible: overviewProjectVisibleBeforeAction,
        selectionProjectExpanded: finalSelectionProjectToggle?.getAttribute("aria-expanded") === "true",
        repeatedHitTargetsReliable: Boolean(closedFromCount && reopenedFromCount && closedFromChevron && reopenedFromChevron),
        selectionProjectHidden: finalSelectionProjectBody?.hidden ?? null,
        selectionProjectBodyHeight: finalSelectionProjectBody?.getBoundingClientRect().height ?? -1,
        selectionProjectGridHeight: finalSelectionProjectGrid?.getBoundingClientRect().height ?? -1,
        selectionProjectNodeHeight: finalSelectionProjectNode?.getBoundingClientRect().height ?? -1,
        selectionProjectName: finalSelectionProjectName?.textContent?.trim() || "",
        selectionProjectNameVisible: Boolean(
          finalSelectionProjectName &&
          getComputedStyle(finalSelectionProjectName).visibility !== "hidden" &&
          finalProjectNameRect &&
          finalProjectNameRect.width > 0 &&
          finalProjectNameRect.height > 0
        ),
        selectionGroupsDoNotOverlap: Boolean(
          finalProjectBodyRect &&
          finalNextGroupRect &&
          finalNextGroupRect.top >= finalProjectBodyRect.bottom
        ),
        projectSelectionActionVisible: Boolean(projectSelectButton?.textContent?.trim()),
        projectSelectionKeepsScroll: scrollAfterFirstProjectAction >= 100 && scrollAfterSecondProjectAction >= 100,
        selectionProjectCount: finalSelectionProjectBody?.querySelectorAll(".restore-project-node").length || 0,
        overviewProjectCount: document.querySelectorAll("[data-restore-overview-project]").length,
        selectionKey,
        overviewKey: overviewToggle?.dataset.restoreOverviewToggle || null
      };
    });
    if (!accordionState.selectionExpanded || !accordionState.selectionVisible || !accordionState.overviewExpanded ||
        !accordionState.overviewVisible || !accordionState.projectGrouped || !accordionState.projectVisible ||
        !accordionState.selectionProjectExpanded || !accordionState.repeatedHitTargetsReliable || accordionState.selectionProjectBodyHeight <= 0 ||
        accordionState.selectionProjectNodeHeight <= 0 || !accordionState.selectionProjectNameVisible ||
        !accordionState.selectionProjectName || !accordionState.selectionGroupsDoNotOverlap ||
        !accordionState.projectSelectionActionVisible || !accordionState.projectSelectionKeepsScroll ||
        accordionState.selectionProjectCount !== 34 ||
        accordionState.overviewProjectCount !== 34) {
      throw new Error("Restore accordion content did not become visible: " + JSON.stringify(accordionState));
    }
    const planText = await page.locator("#restoreSummary").innerText();
    if (!planText.includes("SHA-256 校验通过")) throw new Error("Restore plan did not report verified SHA-256 integrity.");

    await page.evaluate(() => {
      for (let index = 0; index < 1000; index += 1) {
        const selectedConversation = document.querySelector('[data-restore-item^="entry:sessions:"]:checked');
        if (!selectedConversation) break;
        selectedConversation.click();
      }
    });
    await page.click("#restorePlanButton");
    try {
      await page.waitForFunction(() => {
        const button = document.querySelector("#restoreExecuteButton");
        return button && !button.hidden && !button.disabled;
      }, null, { timeout: 20000 });
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        summary: document.querySelector("#restoreSummary")?.textContent?.replace(/\s+/g, " ").trim(),
        result: document.querySelector("#restoreResult")?.textContent?.slice(0, 2000),
        executeHidden: document.querySelector("#restoreExecuteButton")?.hidden,
        executeDisabled: document.querySelector("#restoreExecuteButton")?.disabled,
        mappingPanelHidden: document.querySelector("#projectMappingPanel")?.hidden
      }));
      throw new Error("Restore plan did not become executable: " + JSON.stringify({ diagnostics, cause: error.message }));
    }
    console.log("packaged-e2e: executable restore plan ready");

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
      accordionState,
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
