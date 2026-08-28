"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow, nativeImage, session } = require("electron");
const { DatabaseSync } = require("node:sqlite");

const views = [
  ["overview", "overview"],
  ["backup", "backup"],
  ["restore", "restore"],
  ["manager", "manager"],
  ["settings", "settings"]
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureFresh(browserWindow, rect) {
  await browserWindow.webContents.capturePage(rect);
  await wait(90);
  return browserWindow.webContents.capturePage(rect);
}

async function waitForScan(window) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(
      "document.querySelector('#sidebarRunState')?.textContent?.includes('扫描完成') || false"
    );
    if (ready) return;
    await wait(200);
  }
  throw new Error("Timed out waiting for the initial scan.");
}

async function startServer() {
  const backend = require("../server");
  backend.recoverPendingRestores();
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      backend.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      backend.server.off("error", onError);
      resolve();
    };
    backend.server.once("error", onError);
    backend.server.once("listening", onListening);
    backend.server.listen(0, "127.0.0.1");
  });
  return backend;
}

(async () => {
  const referencePath = process.argv[2] || "";
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-prism-"));
  const source = path.join(tempRoot, "source", ".codex");
  const output = path.join(process.cwd(), "ui-verification", "prism-buttons-20260825");
  fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(source, "archived_sessions"), { recursive: true });
  fs.mkdirSync(path.join(source, "memories"), { recursive: true });
  fs.mkdirSync(path.join(source, "skills", "director-motion"), { recursive: true });
  fs.mkdirSync(path.join(source, "skills", "storyboard-rhythm"), { recursive: true });
  fs.writeFileSync(path.join(source, "config.toml"), 'model = "codex-link"\ncustom_provider = "MY_STUDIO_API_KEY"\n');
  fs.writeFileSync(path.join(source, "AGENTS.md"), "# Local rules\n");
  fs.writeFileSync(path.join(source, "sessions", "sample.jsonl"), [
    '{"type":"session_meta","timestamp":"2026-08-24T08:00:00.000Z","payload":{"id":"session-1","cwd":"D:\\\\项目\\\\Codex Link"}}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"调整恢复页的逐条选择"}}'
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(source, "sessions", "sample-2.jsonl"), [
    '{"type":"session_meta","timestamp":"2026-08-25T09:00:00.000Z","payload":{"id":"session-2","cwd":"D:\\\\项目\\\\Mac版制作"}}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"制作适配 M 系列芯片的 Mac 版"}}'
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(source, "archived_sessions", "archived-sample.jsonl"), [
    '{"type":"session_meta","timestamp":"2026-08-23T07:00:00.000Z","payload":{"id":"archived-session-1","cwd":"D:\\\\项目\\\\归档对话"}}',
    '{"type":"event_msg","payload":{"type":"user_message","message":"这是一条已归档的测试对话"}}'
  ].join("\n") + "\n");
  const stateDb = new DatabaseSync(path.join(source, "state_5.sqlite"));
  stateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, title TEXT)");
  const insertThread = stateDb.prepare("INSERT INTO threads (id, cwd, rollout_path, title) VALUES (?, ?, ?, ?)");
  insertThread.run("session-1", "D:\\项目\\Codex Link", path.join(source, "sessions", "sample.jsonl"), "调整恢复页的逐条选择");
  insertThread.run("session-2", "D:\\项目\\Mac版制作", path.join(source, "sessions", "sample-2.jsonl"), "制作适配 M 系列芯片的 Mac 版");
  insertThread.run("archived-session-1", "D:\\项目\\归档对话", path.join(source, "archived_sessions", "archived-sample.jsonl"), "归档测试对话");
  stateDb.close();
  fs.writeFileSync(path.join(source, "memories", "sample.md"), "Local memory\n");
  fs.writeFileSync(path.join(source, "memories", "large-progress.bin"), Buffer.alloc(12 * 1024 * 1024, 112));
  fs.writeFileSync(path.join(source, "skills", "director-motion", "SKILL.md"), [
    "---",
    "name: director-motion-video-generation",
    "description: 生成导演级运镜与视频提示词。",
    "---",
    "# 导演运镜视频生成",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(source, "skills", "storyboard-rhythm", "SKILL.md"), [
    "---",
    "name: storyboard-rhythm-internal",
    "display_name: 分镜节奏控制",
    "description: 调整镜头长度、节奏变化与转场衔接。",
    "---",
    "# 分镜节奏控制",
    ""
  ].join("\n"));
  fs.mkdirSync(output, { recursive: true });
  const stylesheet = fs.readFileSync(path.join(process.cwd(), "public", "styles.css"), "utf8");
  if (!stylesheet.includes("@media (prefers-reduced-motion: reduce)") || !stylesheet.includes('content: url("assets/brand-glass-still.png")')) {
    throw new Error("Brand reduced-motion fallback is missing.");
  }
  process.env.CODEX_HOME = source;
  process.env.CODEX_LINK_CONFIG_FILE = path.join(tempRoot, "codex-link.config.local.json");

  let backend;
  let window;
  const consoleErrors = [];
  try {
    await app.whenReady();
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    backend = await startServer();
    const cloudDir = path.join(tempRoot, "backup-library");
    const savedConfig = backend.saveConfig({
      ...backend.loadConfig(),
      codexHome: source,
      cloudDir,
      retainSnapshots: 5
    });
    backend.createSnapshot({ ...savedConfig, codexHome: source, cloudDir, dryRun: false });
    fs.writeFileSync(path.join(source, "config.toml"), 'model = "codex-link-second"\ncustom_provider = "MY_STUDIO_API_KEY"\n');
    await wait(12);
    backend.createSnapshot({ ...savedConfig, codexHome: source, cloudDir, dryRun: false });
    const address = backend.server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    window = new BrowserWindow({
      width: 1360,
      height: 900,
      show: false,
      backgroundColor: "#f4f7fa",
      webPreferences: {
        preload: path.join(__dirname, "..", "desktop", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    window.webContents.on("console-message", (_event, levelOrDetails, legacyMessage) => {
      const details = typeof levelOrDetails === "object" ? levelOrDetails : null;
      const level = details?.level || levelOrDetails;
      const message = details?.message || legacyMessage || "";
      if (level === "error" || Number(level) >= 3) consoleErrors.push(String(message));
    });
    await window.loadURL(`${origin}/#overview`);
    await waitForScan(window);
    await wait(1200);
    const initialContentSize = window.getContentSize();
    const motionFreezeKey = await window.webContents.insertCSS(
      "*, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }"
    );

    for (const [view, label] of views) {
      await window.webContents.executeJavaScript(
        `switchView("${view}", { updateHash: false });
         document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'instant' });
         window.scrollTo({ top: 0, behavior: 'instant' });`
      );
      if (view === "restore") {
        await window.webContents.executeJavaScript(
          "(async () => { const backup = state.backups[0]; if (!backup) throw new Error('No restore point for UI capture'); document.querySelector('#restoreSnapshotInput').value = backup.snapshotDir; resetRestoreSelection(); await restorePlan(); return { available: state.restoreAvailableItems.length, selected: state.restoreSelectedItemIds.size, canExecute: state.restorePlan?.canExecute }; })()"
        );
      }
      await wait(520);
      const captureState = await window.webContents.executeJavaScript(
        "({ title: document.querySelector('#viewTitle')?.textContent, active: document.querySelector('.nav-item.active')?.dataset.view })"
      );
      console.log(`Capturing ${label}: ${captureState.title} (${captureState.active})`);
      const image = await captureFresh(window);
      fs.writeFileSync(path.join(output, `${label}.png`), image.toPNG());
    }

    const buttonAudit = await window.webContents.executeJavaScript(
      "(() => { const buttons = [...document.querySelectorAll('button')]; const missing = buttons.filter((button) => !button.classList.contains('semantic-action') && !button.classList.contains('nav-item') && !button.classList.contains('danger')).map((button) => ({ text: button.innerText.trim(), id: button.id, className: button.className })); const colorless = buttons.filter((button) => { const style = getComputedStyle(button); return !button.disabled && style.display !== 'none' && style.backgroundImage === 'none' && style.backgroundColor === 'rgba(0, 0, 0, 0)'; }).map((button) => button.id || button.innerText.trim()); return { total: buttons.length, missing, colorless }; })()"
    );
    if (buttonAudit.missing.length || buttonAudit.colorless.length) {
      throw new Error("Global button semantic audit failed: " + JSON.stringify(buttonAudit));
    }
    console.log("Global button semantic audit:", JSON.stringify(buttonAudit));

    const restoreContract = await window.webContents.executeJavaScript(
      "(async () => {\n  switchView('restore', { updateHash: false });\n  const expected = ['对话记录','归档对话','任务索引','个人记忆','规则与配置','全局规则','Skills'];\n  const selectionGroups = [...document.querySelectorAll('[data-restore-group-key]')].map((details) => ({ key: details.dataset.restoreGroupKey, label: details.querySelector('.restore-category-copy strong')?.textContent, tone: [...details.classList].find((name) => name.startsWith('tone-')), open: details.open }));\n  const categoryGroups = selectionGroups.filter((group) => group.key !== 'projects');\n  const projectGroup = selectionGroups.find((group) => group.key === 'projects');\n  const labelsMatch = expected.every((label) => categoryGroups.some((group) => group.label === label));\n  const projectPriority = projectGroup?.label === '项目记录' && projectGroup.open === true;\n  const tonesMatch = categoryGroups.filter((group) => ['sessions','archivedSessions','stateDb'].includes(group.key)).every((group) => group.tone === 'tone-cyan') && categoryGroups.filter((group) => ['memories','config','agents'].includes(group.key)).every((group) => group.tone === 'tone-violet') && categoryGroups.find((group) => group.key === 'skills')?.tone === 'tone-mint';\n  const initiallyCollapsed = categoryGroups.every((group) => !group.open);\n  const restorable = state.restoreAvailableItems.filter((item) => item.restorable).length;\n  const conversations = state.restoreAvailableItems.filter((item) => item.kind === 'conversation');\n  const skillNames = state.restoreAvailableItems.filter((item) => item.kind === 'capability').map((item) => item.label);\n  document.querySelector('#restoreClearButton').click();\n  const cleared = state.restoreSelectedItemIds.size;\n  const clearOverview = document.querySelector('#restorePlanOverview')?.innerText || '';\n  const clearOverviewSynced = clearOverview.includes('用户选择项') && clearOverview.includes('0 项') && clearOverview.includes('当前没有选中的恢复内容');\n  const conversationGroup = document.querySelector('[data-restore-group-key=sessions]');\n  conversationGroup.querySelector('summary')?.click();\n  const rowClickOpened = conversationGroup.open === true;\n  const visibleWithoutSearch = document.querySelectorAll('[data-restore-group-key=sessions] [data-restore-item]').length > 0;\n  const projectRow = document.querySelector('[data-restore-project-expand-row]');\n  const projectInitiallyClosed = projectRow?.getAttribute('aria-expanded') === 'false';\n  projectRow?.querySelector('strong')?.click();\n  const openedProjectRow = document.querySelector('[data-restore-project-expand-row]');\n  const projectRowClickOpened = openedProjectRow?.getAttribute('aria-expanded') === 'true' && !openedProjectRow?.closest('[data-restore-project-node]')?.querySelector('.restore-project-conversations')?.hidden;\n  const projectInput = document.querySelector('[data-restore-project]');\n  projectInput?.click();\n  const projectSelected = state.restoreSelectedItemIds.size > 0 && document.querySelector('[data-restore-project-expand]')?.getAttribute('aria-expanded') === 'true';\n  document.querySelector('#restoreClearButton').click();\n  const firstConversationInput = [...document.querySelectorAll('[data-restore-item]')].find((input) => input.dataset.restoreItem === conversations[0]?.id);\n  firstConversationInput?.click();\n  await restorePlan();\n  const singleSelected = state.restorePlan?.restoreSelection?.selectedItemIds?.length || 0;\n  const singleMappings = state.restorePlan?.mappings?.length || 0;\n  document.querySelector('#restoreSelectAllButton').click();\n  const selectedAll = state.restoreSelectedItemIds.size;\n  await restorePlan();\n  const overviewGroups = [...document.querySelectorAll('[data-restore-overview-group]')].map((details) => ({ key: details.dataset.restoreOverviewGroup, label: details.querySelector('summary > strong')?.textContent, tone: [...details.classList].find((name) => name.startsWith('tone-')), open: details.open }));\n  const overviewMatches = expected.every((label) => overviewGroups.some((group) => group.label === label)) && overviewGroups.every((group) => !group.open);\n  return { restorable, cleared, selectedAll, planned: state.restorePlan?.restoreSelection?.selectedItemIds?.length || 0, mappings: state.restorePlan?.mappings?.length || 0, conversationItems: conversations.length, skillNames, singleSelected, singleMappings, labelsMatch, projectPriority, tonesMatch, initiallyCollapsed, clearOverviewSynced, rowClickOpened, visibleWithoutSearch, projectInitiallyClosed, projectRowClickOpened, projectSelected, overviewMatches };\n})()"
    );
    if (
      !restoreContract.restorable ||
      restoreContract.cleared !== 0 ||
      restoreContract.selectedAll !== restoreContract.restorable ||
      restoreContract.planned !== restoreContract.restorable ||
      restoreContract.conversationItems < 2 ||
      !restoreContract.skillNames.includes("导演运镜视频生成") ||
      restoreContract.singleSelected !== 1 ||
      restoreContract.singleMappings !== 2 ||
      !restoreContract.labelsMatch ||
      !restoreContract.projectPriority ||
      !restoreContract.tonesMatch ||
      !restoreContract.initiallyCollapsed ||
      !restoreContract.clearOverviewSynced ||
      !restoreContract.rowClickOpened ||
      !restoreContract.visibleWithoutSearch ||
      !restoreContract.projectInitiallyClosed ||
      !restoreContract.projectRowClickOpened ||
      !restoreContract.projectSelected ||
      !restoreContract.overviewMatches
    ) {
      throw new Error("Restore selection UI contract failed: " + JSON.stringify(restoreContract));
    }
    console.log("Restore selection contract:", JSON.stringify(restoreContract));
    const restoreSummaryContract = await window.webContents.executeJavaScript(
      "(() => { const details = document.querySelector('#restoreTechnicalDetails'); const plan = state.restorePlan; const overview = document.querySelector('#restorePlanOverview')?.innerText || ''; let raw = null; try { raw = JSON.parse(document.querySelector('#restoreResult')?.textContent || '{}'); } catch {} const selectedCount = (plan?.availableItems || []).filter((item) => item.selected).length; const samePlan = raw?.snapshotDir === plan?.snapshotDir && raw?.mappings?.length === plan?.mappings?.length && overview.includes(selectedCount + ' 项') && overview.includes((plan?.mappings?.length || 0) + ' 个'); renderRestorePlanOverview({ restoredMappings: 3, rollbackPoint: { path: 'rollback-test' }, completedAt: new Date().toISOString() }, 'complete'); const completeState = document.querySelector('#restorePlanOverview')?.innerText.includes('恢复与写入校验均已完成') || false; renderRestorePlanOverview({ details: { rollback: { verified: true } } }, 'error'); const rollbackState = document.querySelector('#restorePlanOverview')?.innerText.includes('原文件已回退') || false; renderRestorePlanOverview({ results: [{ status: 'recovered_rolled_back' }] }, 'recovery'); const recoveryState = document.querySelector('#restorePlanOverview')?.innerText.includes('上次中断已安全回退') || false; renderRestorePlanOverview(plan); return { technicalClosed: !details?.open, readable: overview.includes('恢复') && overview.includes('目标'), rawValid: Boolean(raw?.snapshotDir), samePlan, completeState, rollbackState, recoveryState }; })()"
    );
    if (!Object.values(restoreSummaryContract).every(Boolean)) {
      throw new Error("Restore summary contract failed: " + JSON.stringify(restoreSummaryContract));
    }
    console.log("Restore summary contract:", JSON.stringify(restoreSummaryContract));

    const backupSelectionContract = await window.webContents.executeJavaScript(
      "(() => { switchView('backup', { updateHash: false }); renderAdvancedOptions(); const covered = [...document.querySelectorAll('[data-select-conversation]')].every((input) => input.checked && input.disabled); const coveredText = document.querySelector('[data-advanced-category=conversations] [data-advanced-count=conversations]')?.textContent.includes('全量已包含') || false; const uniqueMainEntry = document.querySelectorAll('#createBackupButton').length === 1 && !document.querySelector('[data-create-selected]'); const conversationName = document.querySelector('[data-advanced-category=conversations] .advanced-category-copy strong')?.textContent === '对话记录'; setIncluded('sessions', false); setIncluded('archivedSessions', false); setIncluded('skills', false); renderAdvancedOptions(); const fineEnabled = [...document.querySelectorAll('[data-select-conversation]')].some((input) => !input.disabled); state.advancedQueries.skills = '分镜节奏控制'; state.advancedOpen.add('skills'); renderAdvancedOptions(); const skillRows = [...document.querySelectorAll('[data-advanced-category=skills] .selection-item')]; const skillSearch = skillRows.length === 1 && skillRows[0].textContent.includes('分镜节奏控制') && (skillRows[0].dataset.tooltip || '').includes('调整镜头长度'); const skillDebug = skillRows.map((row) => ({ text: row.textContent.trim(), tooltip: row.dataset.tooltip || '' })); state.advancedQueries.skills = ''; renderAdvancedOptions(); const skillSearchCleared = document.querySelectorAll('[data-advanced-category=skills] .selection-item').length >= 2; state.advancedQueries.api = 'My Studio API'; state.advancedOpen.add('api'); renderAdvancedOptions(); const apiRows = [...document.querySelectorAll('[data-advanced-category=api] .selection-item')]; const apiOriginalName = apiRows.length === 1 && apiRows[0].textContent.includes('My Studio API'); const apiHelp = (apiRows[0]?.dataset.tooltip || '').includes('Custom API') && (apiRows[0]?.dataset.tooltip || '').includes('不保存 API Key'); const apiDebug = apiRows.map((row) => ({ text: row.textContent.trim(), tooltip: row.dataset.tooltip || '' })); state.advancedQueries.api = ''; setDefaultBackupSelection('recommended'); const recommendedRestored = isIncluded('sessions') && isIncluded('archivedSessions') && isIncluded('skills'); return { covered, coveredText, fineEnabled, recommendedRestored, uniqueMainEntry, conversationName, skillSearch, skillSearchCleared, apiOriginalName, apiHelp, skillDebug, apiDebug }; })()"
    );
    if (!["covered", "coveredText", "fineEnabled", "recommendedRestored", "uniqueMainEntry", "conversationName", "skillSearch", "skillSearchCleared", "apiOriginalName", "apiHelp"].every((key) => backupSelectionContract[key])) {
      throw new Error("Backup selection linkage failed: " + JSON.stringify(backupSelectionContract));
    }
    console.log("Backup selection linkage:", JSON.stringify(backupSelectionContract));

    const credentialContract = await window.webContents.executeJavaScript(
      "(() => { switchView('settings', { updateHash: false }); const risk = document.querySelector('#settingsExcludeHighRisk'); risk.checked = false; risk.dispatchEvent(new Event('change', { bubbles: true })); const auth = document.querySelector('[data-include=auth]'); const label = auth?.closest('.check-item'); const result = { disabled: Boolean(auth?.disabled), checked: Boolean(auth?.checked), permanentText: label?.innerText.includes('永久排除') || false }; risk.checked = true; risk.dispatchEvent(new Event('change', { bubbles: true })); return result; })()"
    );
    if (!credentialContract.disabled || credentialContract.checked || !credentialContract.permanentText) {
      throw new Error("Credential exclusion UI contract failed: " + JSON.stringify(credentialContract));
    }
    console.log("Credential exclusion contract:", JSON.stringify(credentialContract));

    const rollbackEntryContract = await window.webContents.executeJavaScript(
      "(async () => { switchView('settings', { updateHash: false }); const button = document.querySelector('#viewRollbackPointsButton'); button?.click(); await new Promise((resolve) => requestAnimationFrame(resolve)); const panel = document.querySelector('.manager-rollback-panel'); return { button: Boolean(button), managerActive: document.querySelector('.nav-item.active')?.dataset.view === 'manager', panelFocused: document.activeElement === panel, heading: panel?.querySelector('h2')?.textContent || '' }; })()"
    );
    if (!rollbackEntryContract.button || !rollbackEntryContract.managerActive || !rollbackEntryContract.panelFocused || rollbackEntryContract.heading !== "事务回滚点") {
      throw new Error("Rollback entry UI contract failed: " + JSON.stringify(rollbackEntryContract));
    }
    console.log("Rollback entry contract:", JSON.stringify(rollbackEntryContract));

    const targetOsContract = await window.webContents.executeJavaScript(
      "(async () => { switchView('restore', { updateHash: false }); const readHint = (value) => { const input = document.querySelector('input[name=restoreTargetOS][value=' + value + ']'); input.checked = true; renderRestoreTargetHint(); return document.querySelector('#restoreTargetHint')?.innerText || ''; }; const windows = readHint('windows'); const macos = readHint('macos'); const linux = readHint('linux'); document.querySelector('input[name=restoreTargetOS][value=macos]').checked = true; renderRestoreTargetHint(); await restorePlan(); const macPlan = state.restorePlan; const crossRisk = Boolean(macPlan?.adaptationPlan?.crossOS && macPlan?.requiresHighRiskConfirmation); document.querySelector('input[name=restoreTargetOS][value=auto]').checked = true; renderRestoreTargetHint(); await restorePlan(); return { distinct: new Set([windows, macos, linux]).size === 3, windows: windows.includes('C:\\\\Users') && windows.includes('exe/bat/ps1'), macos: macos.includes('/Users/') && macos.includes('Apple Silicon') && macos.includes('执行权限'), linux: linux.includes('/home/') && linux.includes('Unix 权限'), crossRisk }; })()"
    );
    if (!Object.values(targetOsContract).every(Boolean)) {
      throw new Error("Target OS guidance contract failed: " + JSON.stringify(targetOsContract));
    }
    console.log("Target OS guidance contract:", JSON.stringify(targetOsContract));

    const progressContract = await window.webContents.executeJavaScript(
      "(async () => { const actualEvents = []; startBackupOperation('create'); await streamApi('/api/snapshot-operation', { codexHome: document.querySelector('#settingsCodexHome').value.trim(), cloudDir: currentBackupDir(), include: selectedInclude(), selected: selectedPayload('all'), dryRun: false }, (event) => { actualEvents.push(event); updateBackupOperationProgress(event); }); const actualMidPercents = [...new Set(actualEvents.filter((event) => event.progress > 1 && event.progress < 100).map((event) => event.progress))]; const actualByteUpdates = actualEvents.filter((event) => event.completedBytes > 0).length; startBackupOperation('create'); updateBackupOperationProgress({ progress: 57, etaSeconds: 9, stage: 'copying', message: '已写入对话记录', completedBytes: 7340032, totalBytes: 12582912 }); startRestoreOperation(); updateRestoreOperationProgress({ progress: 63, etaSeconds: 7, stage: 'applying', message: '正在恢复：对话记录', completedBytes: 8388608, totalBytes: 12582912 }); const backup = { value: Number(document.querySelector('#backupProgress .backup-progress-track')?.getAttribute('aria-valuenow')), text: document.querySelector('#backupProgressEta')?.textContent || '' }; const restore = { hidden: document.querySelector('#restoreProgress')?.hidden, value: Number(document.querySelector('#restoreProgress .backup-progress-track')?.getAttribute('aria-valuenow')), text: document.querySelector('#restoreProgressEta')?.textContent || '' }; stopBackupOperation(false); state.restoreOperation = null; renderRestoreProgress(); return { backup, restore, actualMidPercents, actualByteUpdates }; })()"
    );
    if (progressContract.backup.value !== 57 || !progressContract.backup.text.includes("已写入") || !progressContract.backup.text.includes("MB") || progressContract.restore.hidden || progressContract.restore.value !== 63 || !progressContract.restore.text.includes("正在恢复") || progressContract.actualMidPercents.length < 4 || progressContract.actualByteUpdates < 2) {
      throw new Error("Operation progress UI contract failed: " + JSON.stringify(progressContract));
    }
    console.log("Operation progress UI contract:", JSON.stringify(progressContract));

    await window.webContents.executeJavaScript(
      "switchView('restore', { updateHash: false }); startRestoreOperation(); updateRestoreOperationProgress({ progress: 63, etaSeconds: 7, stage: 'applying', message: '正在恢复：对话记录' }); document.querySelector('.main')?.scrollTo({ top: 720, behavior: 'instant' });"
    );
    await wait(180);
    const restoreProgressImage = await captureFresh(window);
    fs.writeFileSync(path.join(output, "restore-progress.png"), restoreProgressImage.toPNG());
    await window.webContents.executeJavaScript("state.restoreOperation = null; renderRestoreProgress();");

    const restoreAllImage = await captureFresh(window);
    fs.writeFileSync(path.join(output, "restore-all-selected.png"), restoreAllImage.toPNG());

    const stageOutput = path.join(process.cwd(), "ui-verification", "flow-audit-20260813");
    fs.mkdirSync(stageOutput, { recursive: true });
    const stageSizes = [
      { width: 1440, height: 1000, start: 32 },
      { width: 1280, height: 720, start: 37 },
      { width: 1365, height: 1170, start: 45 },
      { width: 1276, height: 1136, start: 50 }
    ];
    const layoutViolations = [];
    for (const size of stageSizes) {
      window.setContentSize(size.width, size.height);
      for (let index = 0; index < views.length; index += 1) {
        const [view, label] = views[index];
        await window.webContents.executeJavaScript(
          `switchView("${view}", { updateHash: false });
           document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'instant' });
           window.scrollTo({ top: 0, behavior: 'instant' });`
        );
        await wait(320);
        const layoutState = await window.webContents.executeJavaScript(
          "(() => { const active = document.querySelector('.view.active'); const docOverflow = document.documentElement.scrollWidth - window.innerWidth; const activeOverflow = active ? active.scrollWidth - active.clientWidth : 0; const clipped = [...document.querySelectorAll('.view.active button:not([hidden]), .view.active input:not([type=hidden])')].filter((element) => { const style = getComputedStyle(element); if (style.display === 'none' || style.visibility === 'hidden') return false; const rect = element.getBoundingClientRect(); return rect.right > window.innerWidth + 2 || rect.left < -2; }).map((element) => element.id || element.innerText?.trim() || element.getAttribute('aria-label') || element.tagName); const offenders = active ? [...active.querySelectorAll('*')].filter((element) => { const style = getComputedStyle(element); if (style.display === 'none' || style.visibility === 'hidden') return false; const rect = element.getBoundingClientRect(); return rect.right > window.innerWidth + 2 || rect.left < -2; }).slice(0, 12).map((element) => ({ tag: element.tagName, id: element.id, className: String(element.className || '').slice(0, 90), right: Math.round(element.getBoundingClientRect().right), width: Math.round(element.getBoundingClientRect().width) })) : []; return { docOverflow, activeOverflow, clipped, offenders }; })()"
        );
        if (layoutState.docOverflow > 2 || layoutState.activeOverflow > 12 || layoutState.clipped.length || layoutState.offenders.length) {
          layoutViolations.push({ size: `${size.width}x${size.height}`, view, ...layoutState });
        }
        const image = await captureFresh(window);
        const fileName = `${size.start + index}-${label === "overview" ? "home" : label}-final-${size.width}x${size.height}.png`;
        fs.writeFileSync(path.join(stageOutput, fileName), image.toPNG());
      }
    }
    if (layoutViolations.length) {
      throw new Error("Responsive layout audit failed: " + JSON.stringify(layoutViolations));
    }
    console.log("Responsive layout audit:", JSON.stringify({ sizes: stageSizes.length, views: views.length, violations: 0 }));
    window.setContentSize(initialContentSize[0], initialContentSize[1]);

    await window.webContents.executeJavaScript(
      "document.querySelector('[data-view=\"backup\"]')?.click(); startBackupOperation('create'); setBackupVisual('busy'); updateBackupOperationProgress({ progress: 68, etaSeconds: 18, stage: 'copying', message: '正在写入恢复点并校验文件' });"
    );
    await wait(300);
    const busyImage = await captureFresh(window);
    fs.writeFileSync(path.join(output, "backup-busy.png"), busyImage.toPNG());

    const rect = await window.webContents.executeJavaScript(
      "(() => { const rect = document.querySelector('#createBackupButton').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()"
    );
    window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(rect.x), y: Math.round(rect.y) });
    await wait(500);
    const hoverImage = await captureFresh(window);
    fs.writeFileSync(path.join(output, "backup-hover.png"), hoverImage.toPNG());

    const progressRect = await window.webContents.executeJavaScript(
      "(() => { const rect = document.querySelector('#backupResultVisual').getBoundingClientRect(); return { x: Math.max(0, Math.floor(rect.x - 10)), y: Math.max(0, Math.floor(rect.y - 10)), width: Math.ceil(rect.width + 20), height: Math.ceil(rect.height + 20) }; })()"
    );
    const progressCrop = hoverImage.crop(progressRect);
    fs.writeFileSync(path.join(output, "backup-progress-focus.png"), progressCrop.toPNG());

    const buttonRect = await window.webContents.executeJavaScript(
      "(() => { const rect = document.querySelector('#createBackupButton').getBoundingClientRect(); return { x: Math.max(0, Math.floor(rect.x - 28)), y: Math.max(0, Math.floor(rect.y - 24)), width: Math.ceil(rect.width + 56), height: Math.ceil(rect.height + 48) }; })()"
    );
    const buttonCrop = hoverImage.crop(buttonRect);
    fs.writeFileSync(path.join(output, "backup-button-focus.png"), buttonCrop.toPNG());

    await window.webContents.executeJavaScript("document.querySelector('[data-view=\"overview\"]')?.click();");
    await wait(180);
    const idleNavBefore = await window.webContents.executeJavaScript(
      "(() => { const button = document.querySelector('[data-view=\"settings\"]'); const style = getComputedStyle(button); return { transform: style.transform, filter: style.filter, shadow: style.boxShadow }; })()"
    );
    const idleNavRect = await window.webContents.executeJavaScript(
      "(() => { const rect = document.querySelector('[data-view=\"settings\"]').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()"
    );
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    await wait(80);
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: idleNavRect.x, y: idleNavRect.y });
    await wait(420);
    const idleNavHover = await window.webContents.executeJavaScript(
      "(() => { const button = document.querySelector('[data-view=\"settings\"]'); const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); const style = getComputedStyle(button); const before = getComputedStyle(button, '::before'); const after = getComputedStyle(button, '::after'); return { hovered: button.matches(':hover'), hit: hit?.className || hit?.tagName, transform: style.transform, filter: style.filter, shadow: style.boxShadow, beforeAnimation: before.animationName, afterAnimation: after.animationName, beforeOpacity: before.opacity, afterOpacity: after.opacity }; })()"
    );
    if (!idleNavHover.hovered || idleNavHover.filter === idleNavBefore.filter || idleNavHover.shadow === idleNavBefore.shadow || idleNavHover.beforeAnimation === "none" || idleNavHover.afterAnimation === "none") {
      throw new Error("Sidebar hover motion is not visibly distinct: " + JSON.stringify({ before: idleNavBefore, hover: idleNavHover }));
    }
    const sidebarHoverImage = await captureFresh(window);
    fs.writeFileSync(path.join(output, "sidebar-hover.png"), sidebarHoverImage.toPNG());
    console.log("Sidebar hover contract:", JSON.stringify({ before: idleNavBefore, hover: idleNavHover }));
    window.webContents.debugger.detach();

    await window.webContents.removeInsertedCSS(motionFreezeKey);
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-view=\"overview\"]')?.click(); document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'instant' });"
    );
    await wait(180);
    const brandRect = await window.webContents.executeJavaScript(
      "(() => { const rect = document.querySelector('.brand').getBoundingClientRect(); return { x: Math.max(0, Math.floor(rect.x - 6)), y: Math.max(0, Math.floor(rect.y - 6)), width: Math.ceil(rect.width + 12), height: Math.ceil(rect.height + 12) }; })()"
    );
    const brandMotionFrames = [];
    for (let index = 0; index < 3; index += 1) {
      if (index > 0) await wait(2500);
      const frame = await captureFresh(window, brandRect);
      brandMotionFrames.push(frame);
      fs.writeFileSync(path.join(output, `brand-motion-frame-${index + 1}.png`), frame.toPNG());
    }
    const brandCenterContract = await window.webContents.executeJavaScript(
      "(() => { const mark = document.querySelector('.brand-mark')?.getBoundingClientRect(); const overlay = document.querySelector('.brand-mark-letters')?.getBoundingClientRect(); return { text: document.querySelector('.brand-mark-letters')?.textContent?.trim(), deltaX: Math.abs((mark.x + mark.width / 2) - (overlay.x + overlay.width / 2)), deltaY: Math.abs((mark.y + mark.height / 2) - (overlay.y + overlay.height / 2)) }; })()"
    );
    const firstPixels = brandMotionFrames[0].toBitmap();
    const lastPixels = brandMotionFrames.at(-1).toBitmap();
    let changedBytes = 0;
    for (let index = 0; index < Math.min(firstPixels.length, lastPixels.length); index += 16) {
      if (firstPixels[index] !== lastPixels[index] || firstPixels[index + 1] !== lastPixels[index + 1] || firstPixels[index + 2] !== lastPixels[index + 2]) changedBytes += 1;
    }
    if (brandCenterContract.text !== "CL" || brandCenterContract.deltaX > 1 || brandCenterContract.deltaY > 1 || changedBytes < 20) {
      throw new Error("Brand motion contract failed: " + JSON.stringify({ ...brandCenterContract, changedBytes }));
    }
    console.log("Brand motion contract:", JSON.stringify({ ...brandCenterContract, changedBytes }));

    const brandReferencePath = path.join(
      process.cwd(),
      "ui-verification",
      "motion-references",
      "brand-icon-gif",
      "reference-contact-sheet.jpg"
    );
    if (fs.existsSync(brandReferencePath)) {
      const brandReference = nativeImage.createFromPath(brandReferencePath).resize({ width: 720 });
      const brandComparison = new BrowserWindow({
        width: 1180,
        height: 730,
        show: false,
        backgroundColor: "#f3f6fa",
        webPreferences: { sandbox: true }
      });
      const brandFrameUrls = brandMotionFrames
        .map((frame) => frame.resize({ width: 320 }).toDataURL())
        .map((url, index) => `<figure><img src="${url}"><figcaption>${index * 2.5}s</figcaption></figure>`)
        .join("");
      const brandComparisonHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
        *{box-sizing:border-box} body{margin:0;padding:26px;background:#eef3f8;color:#172033;font-family:system-ui,sans-serif}
        h1{margin:0 0 18px;font-size:25px} h2{margin:0 0 10px;font-size:16px}.card{padding:16px;border:1px solid rgba(55,110,150,.16);border-radius:20px;background:#fff;box-shadow:0 14px 34px rgba(40,70,100,.1)}
        .reference{display:block;width:720px;max-height:330px;object-fit:contain;margin:auto;border-radius:14px}.frames{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.frames figure{margin:0}.frames img{display:block;width:100%;height:150px;object-fit:contain;border-radius:14px;background:#f8fbfd}.frames figcaption{text-align:center;margin-top:6px;color:#667085;font-size:12px}
      </style></head><body><h1>Codex Link · 品牌图标动效对照</h1><section class="card"><h2>参考 GIF · 10 秒循环关键帧</h2><img class="reference" src="${brandReference.toDataURL()}"></section><section class="card" style="margin-top:18px"><h2>实际侧栏图标 · CL 固定居中</h2><div class="frames">${brandFrameUrls}</div></section></body></html>`;
      await brandComparison.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(brandComparisonHtml)}`);
      await wait(240);
      const brandComparisonImage = await captureFresh(brandComparison);
      fs.writeFileSync(path.join(output, "brand-motion-comparison.png"), brandComparisonImage.toPNG());
      brandComparison.destroy();
    }

    if (referencePath && fs.existsSync(referencePath)) {
      const reference = nativeImage.createFromPath(referencePath).resize({ width: 720 });
      const implementation = restoreProgressImage.resize({ width: 720 });
      const buttonDetail = buttonCrop.resize({ width: 420 });
      const progressDetail = progressCrop.resize({ width: 420 });
      const comparison = new BrowserWindow({
        width: 1540,
        height: 1180,
        show: false,
        backgroundColor: "#f3f6fa",
        webPreferences: { sandbox: true }
      });
      const comparisonHtml = `<!doctype html>
        <html><head><meta charset="utf-8"><style>
          *{box-sizing:border-box} body{margin:0;padding:28px;background:#eef3f8;color:#172033;font-family:system-ui,sans-serif}
          h1{margin:0 0 22px;font-size:26px} h2{margin:0 0 12px;font-size:17px}
          .grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
          .card{padding:18px;border:1px solid rgba(55,110,150,.16);border-radius:20px;background:#fff;box-shadow:0 14px 34px rgba(40,70,100,.1)}
          img{display:block;width:100%;height:auto;border-radius:14px}
          .details{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:24px}
          .details img{max-height:250px;object-fit:contain;background:#f8fbfd}
          p{margin:10px 0 0;color:#667085;font-size:13px}
        </style></head><body>
          <h1>Codex Link · Prism Lens 视觉对照</h1>
          <div class="grid">
            <section class="card"><h2>确认稿</h2><img src="${reference.toDataURL()}"><p>蓝青主色内核、淡珊瑚折射、连续玻璃高光。</p></section>
            <section class="card"><h2>实际运行界面</h2><img src="${implementation.toDataURL()}"><p>恢复页 · 逐条选择与实际进度状态。</p></section>
          </div>
          <div class="details">
            <section class="card"><h2>按钮局部</h2><img src="${buttonDetail.toDataURL()}"></section>
            <section class="card"><h2>进度局部</h2><img src="${progressDetail.toDataURL()}"></section>
          </div>
        </body></html>`;
      await comparison.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(comparisonHtml)}`);
      await wait(300);
      const comparisonImage = await captureFresh(comparison);
      fs.writeFileSync(path.join(output, "design-comparison.png"), comparisonImage.toPNG());
      fs.writeFileSync(path.join(output, "design-comparison-preview.jpg"), comparisonImage.resize({ width: 770 }).toJPEG(55));
      comparison.destroy();
    }

    for (const fileName of fs.readdirSync(output).filter((name) => name.endsWith(".png"))) {
      const sourcePath = path.join(output, fileName);
      const previewPath = path.join(output, fileName.replace(/\.png$/, "-preview.jpg"));
      const preview = nativeImage.createFromPath(sourcePath).resize({ width: 680 });
      fs.writeFileSync(previewPath, preview.toJPEG(46));
    }

    if (consoleErrors.length) {
      throw new Error(`Renderer console errors: ${consoleErrors.join(" | ")}`);
    }
    console.log(`Captured Prism UI verification screenshots in ${output}`);
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (backend?.server?.listening) await new Promise((resolve) => backend.server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
