const { _electron } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const views = [
  ["overview", "home"],
  ["backup", "backup"],
  ["restore", "restore"],
  ["manager", "manager"],
  ["settings", "settings"],
];

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-screens-"));
  const source = path.join(root, "source", ".codex");
  const cloud = path.join(root, "backups");
  const output = path.join(process.cwd(), "ui-verification", "flow-audit-20260813");
  fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(source, "memories"), { recursive: true });
  fs.writeFileSync(path.join(source, "config.toml"), 'model = "codex-link"\n');
  fs.writeFileSync(path.join(source, "AGENTS.md"), "# Local rules\n");
  fs.writeFileSync(path.join(source, "sessions", "sample.jsonl"), '{"type":"session"}\n');
  fs.writeFileSync(path.join(source, "memories", "sample.md"), "Local memory\n");
  fs.mkdirSync(output, { recursive: true });

  let app;
  try {
    app = await _electron.launch({
      executablePath: path.join(process.cwd(), "dist", "win-unpacked", "Codex Link.exe"),
      args: [`--user-data-dir=${path.join(root, "user-data")}`],
      env: { ...process.env, CODEX_HOME: source },
    });
    const page = await app.firstWindow();
    await page.waitForSelector(".app-shell");
    await page.waitForFunction(() => document.querySelector("#sidebarRunState")?.textContent?.includes("扫描完成"), null, { timeout: 15000 });

    for (const size of [{ width: 1440, height: 1000 }, { width: 1280, height: 720 }]) {
      await page.setViewportSize(size);
      for (let index = 0; index < views.length; index += 1) {
        const [view, fileLabel] = views[index];
        await page.click(`[data-view="${view}"]`);
        await page.waitForTimeout(180);
        const number = size.width === 1440 ? 32 + index : 37 + index;
        const fileName = `${number}-${fileLabel}-final-${size.width}x${size.height}.png`;
        await page.screenshot({ path: path.join(output, fileName) });
      }
    }
    console.log(`Captured 10 desktop screenshots in ${output}`);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
