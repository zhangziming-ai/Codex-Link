const { _electron } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const compact = (value, limit = 300) => String(value || "").replace(/\s+/g, " ").slice(0, limit);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-packaged-debug-"));
  const source = path.join(root, "source", ".codex");
  const cloud = path.join(root, "backups");
  const userData = path.join(root, "user-data");
  const executablePath = path.join(process.cwd(), "dist", "win-unpacked", "Codex Link.exe");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "config.toml"), 'model = "debug"\n');

  let app;
  try {
    app = await _electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      env: { ...process.env, CODEX_HOME: source },
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(compact(message.text()));
    });
    page.on("pageerror", (error) => errors.push(compact(error.message)));

    await page.waitForSelector(".app-shell");
    await page.waitForFunction(() => {
      const text = document.querySelector("#sidebarRunState")?.textContent || "";
      return text.includes("扫描完成") || text.includes("启动失败");
    }, null, { timeout: 15000 });

    const before = await page.evaluate(() => ({
      status: document.querySelector("#sidebarRunState")?.textContent?.trim(),
      config: document.querySelector("#settingsCodexHome")?.value,
    }));
    await page.click('[data-view="backup"]');
    await page.fill("#backupDirInput", cloud);
    await page.click("#createBackupButton");
    await page.waitForFunction(() => {
      const title = document.querySelector("#backupResultVisualTitle")?.textContent || "";
      return title !== "正在生成";
    }, null, { timeout: 20000 }).catch(() => {});

    const after = await page.evaluate(() => ({
      title: document.querySelector("#backupResultVisualTitle")?.textContent?.trim(),
      body: document.querySelector("#backupResultVisualBody")?.textContent?.trim(),
      result: document.querySelector("#backupResult")?.textContent?.trim(),
      button: document.querySelector("#createBackupButton")?.textContent?.trim(),
      disabled: document.querySelector("#createBackupButton")?.disabled,
    }));
    console.log(JSON.stringify({
      before,
      after: { ...after, result: compact(after.result) },
      errors: errors.slice(0, 5),
      snapshotDirectories: fs.existsSync(cloud) ? fs.readdirSync(cloud) : [],
    }, null, 2));
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
