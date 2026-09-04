"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require("electron");

let mainWindow = null;
let localServer = null;
let localOrigin = "";
let quitting = false;

const gotSingleInstanceLock = process.env.CODEX_LINK_ALLOW_TEST_INSTANCE === "1"
  || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.on("second-instance", focusMainWindow);

function isNativeAbsolutePath(value) {
  if (typeof value !== "string" || !value) return false;
  if (process.platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
  }
  return value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value);
}

function startLocalService() {
  if (!process.env.CODEX_LINK_CONFIG_FILE) {
    process.env.CODEX_LINK_CONFIG_FILE = path.join(app.getPath("userData"), "codex-link.config.local.json");
  }
  const backend = require("../server");
  backend.recoverPendingRestores();

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      backend.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      backend.server.off("error", onError);
      const address = backend.server.address();
      localServer = backend.server;
      localOrigin = `http://127.0.0.1:${address.port}`;
      resolve(localOrigin);
    };

    backend.server.once("error", onError);
    backend.server.once("listening", onListening);
    backend.server.listen(0, "127.0.0.1");
  });
}

function secureSession() {
  const currentSession = session.defaultSession;
  currentSession.setPermissionCheckHandler(() => false);
  currentSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

function registerDesktopHandlers() {
  ipcMain.handle("codex-link:select-directory", async (_event, options = {}) => {
    const requestedDefault = typeof options.defaultPath === "string" ? options.defaultPath : "";
    const defaultPath = isNativeAbsolutePath(requestedDefault) ? requestedDefault : undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: typeof options.title === "string" ? options.title.slice(0, 80) : "选择文件夹",
      defaultPath,
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("codex-link:open-path", async (_event, targetPath) => {
    if (!isNativeAbsolutePath(targetPath)) {
      return { ok: false, error: "只能打开本机绝对路径。" };
    }
    let stat;
    try {
      stat = fs.statSync(targetPath);
    } catch {
      return { ok: false, error: "文件夹不存在或不可访问。" };
    }
    if (!stat.isDirectory()) return { ok: false, error: "所选路径不是文件夹。" };
    const error = await shell.openPath(targetPath);
    return error ? { ok: false, error } : { ok: true };
  });
}

function createMainWindow(origin) {
  const platformIcon = process.platform === "darwin"
    ? {}
    : { icon: path.join(__dirname, "..", "build", "icon.png") };
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1120,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f4f7fa",
    title: "Codex Link v1.2",
    ...platformIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });

  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    let targetOrigin = "";
    try {
      targetOrigin = new URL(targetUrl).origin;
    } catch {
      event.preventDefault();
      return;
    }
    if (targetOrigin !== origin) event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(`${origin}/#overview`);
}

function closeLocalService() {
  if (!localServer?.listening) return;
  localServer.close();
  localServer = null;
}

if (gotSingleInstanceLock) {
  app.whenReady()
    .then(async () => {
      if (process.platform === "win32") {
        app.setAppUserModelId("com.codexlink.desktop");
      }
      if (process.platform === "darwin") {
        app.setAboutPanelOptions({
          applicationName: "Codex Link",
          applicationVersion: app.getVersion(),
          version: app.getVersion(),
          copyright: "Copyright © 2026 Codex Link"
        });
      }
      secureSession();
      registerDesktopHandlers();
      const origin = await startLocalService();
      createMainWindow(origin);
    })
    .catch((error) => {
      console.error("Codex Link failed to start.", error);
      app.exit(1);
    });

  app.on("activate", () => {
    if (mainWindow) {
      focusMainWindow();
    } else if (localOrigin) {
      createMainWindow(localOrigin);
    }
  });

  app.on("before-quit", () => {
    quitting = true;
    closeLocalService();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" || quitting) app.quit();
  });
}
