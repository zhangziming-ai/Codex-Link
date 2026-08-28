const { _electron } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-settings-e2e-"));
  const source = path.join(root, "source", ".codex");
  const cloud = path.join(root, "backups");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(cloud, { recursive: true });
  fs.writeFileSync(path.join(source, "config.toml"), 'model = "settings-test"\n');

  let app;
  try {
    app = await _electron.launch({
      executablePath: path.join(process.cwd(), "dist", "win-unpacked", "Codex Link.exe"),
      args: [`--user-data-dir=${path.join(root, "user-data")}`],
      env: { ...process.env, CODEX_HOME: source },
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector(".app-shell");
    await page.waitForFunction(() => document.querySelector("#sidebarRunState")?.textContent?.includes("扫描完成"), null, { timeout: 15000 });

    const bridge = await page.evaluate(async () => ({
      isDesktop: window.codexLinkDesktop?.isDesktop,
      selectDirectory: typeof window.codexLinkDesktop?.selectDirectory,
      openPath: typeof window.codexLinkDesktop?.openPath,
      invalidOpen: await window.codexLinkDesktop?.openPath("relative-folder")
    }));
    if (!bridge.isDesktop || bridge.selectDirectory !== "function" || bridge.openPath !== "function") {
      throw new Error(`Desktop bridge is incomplete: ${JSON.stringify(bridge)}`);
    }
    if (bridge.invalidOpen?.ok !== false) throw new Error("Desktop bridge accepted a relative path.");

    await page.click('[data-view="settings"]');
    const defaults = await page.evaluate(() => ({
      rollbackChecked: document.querySelector("#settingsAutoRollback")?.checked,
      rollbackDisabled: document.querySelector("#settingsAutoRollback")?.disabled,
      crossChecked: document.querySelector("#settingsCrossSystem")?.checked,
      excludeChecked: document.querySelector("#settingsExcludeHighRisk")?.checked,
      highRiskDisabled: [...document.querySelectorAll('[data-include="plugins"], [data-include="tools"], [data-include="auth"]')].every((input) => input.disabled),
      openFolderVisible: getComputedStyle(document.querySelector("#openBackupFolderButton")).display !== "none"
    }));
    if (!defaults.rollbackChecked || !defaults.rollbackDisabled || !defaults.crossChecked || !defaults.excludeChecked) {
      throw new Error(`Default safety policy is incorrect: ${JSON.stringify(defaults)}`);
    }
    if (!defaults.highRiskDisabled || !defaults.openFolderVisible) throw new Error(`Settings UI policy is incomplete: ${JSON.stringify(defaults)}`);

    await page.locator("#settingsExcludeHighRisk").locator("xpath=ancestor::label").click();
    await page.locator("#settingsCrossSystem").locator("xpath=ancestor::label").click();
    const adjusted = await page.evaluate(() => ({
      optionalHighRiskEnabled: [...document.querySelectorAll('[data-include="plugins"], [data-include="tools"]')].every((input) => !input.disabled),
      credentialsPermanentlyExcluded: (() => {
        const auth = document.querySelector('[data-include="auth"]');
        return Boolean(auth?.disabled) && !auth?.checked && auth?.closest(".check-item")?.innerText.includes("永久排除");
      })(),
      alternateSystemsDisabled: [...document.querySelectorAll('input[name="restoreTargetOS"]')].filter((input) => input.value !== "auto").every((input) => input.disabled)
    }));
    if (!adjusted.optionalHighRiskEnabled || !adjusted.credentialsPermanentlyExcluded || !adjusted.alternateSystemsDisabled) {
      throw new Error(`Adjusted policy was not applied: ${JSON.stringify(adjusted)}`);
    }

    await page.fill("#settingsBackupDir", cloud);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/config") && response.request().method() === "POST"),
      page.click("#saveSettingsButton")
    ]);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#sidebarRunState")?.textContent?.includes("扫描完成"), null, { timeout: 15000 });
    await page.click('[data-view="settings"]');
    const persisted = await page.evaluate(() => ({
      crossChecked: document.querySelector("#settingsCrossSystem")?.checked,
      excludeChecked: document.querySelector("#settingsExcludeHighRisk")?.checked,
      backupDir: document.querySelector("#settingsBackupDir")?.value
    }));
    if (persisted.crossChecked || persisted.excludeChecked || persisted.backupDir !== cloud) {
      throw new Error(`Settings did not persist: ${JSON.stringify(persisted)}`);
    }
    if (errors.length) throw new Error(`Renderer errors: ${errors.join(" | ")}`);
    console.log(JSON.stringify({ status: "passed", bridge, defaults, adjusted, persisted, consoleErrors: errors }, null, 2));
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
