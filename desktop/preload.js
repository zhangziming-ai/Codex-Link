"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexLinkDesktop", Object.freeze({
  isDesktop: true,
  platform: process.platform,
  selectDirectory: (options) => ipcRenderer.invoke("codex-link:select-directory", options),
  openPath: (targetPath) => ipcRenderer.invoke("codex-link:open-path", targetPath)
}));

window.addEventListener("DOMContentLoaded", () => {
  document.body.classList.add("desktop-runtime");
});
