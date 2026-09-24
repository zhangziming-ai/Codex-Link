/* UI-01 appearance preferences are device-local, never part of a backup. */
(() => {
  "use strict";
  const key = "codex-link.ui01.appearance.v1";
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  const systemMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let prefs = { theme: "light", reduceMotion: false };
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && ["light", "dark", "system"].includes(saved.theme)) prefs.theme = saved.theme;
    if (saved?.reduceMotion === true) prefs.reduceMotion = true;
  } catch { /* Unavailable storage must not prevent the app from opening. */ }
  const shell = document.querySelector(".app-shell");
  function apply() {
    const dark = prefs.theme === "dark" || (prefs.theme === "system" && systemDark.matches);
    const reduce = prefs.reduceMotion || systemMotion.matches;
    document.body.dataset.theme = dark ? "dark" : "light";
    document.body.dataset.reduceMotion = String(reduce);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.querySelectorAll("[data-ui01-theme]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.ui01Theme === prefs.theme)));
    document.querySelector("#ui01ReduceMotion").checked = prefs.reduceMotion;
    const logo = document.querySelector(".brand-mark-motion");
    logo.src = reduce ? "/assets/brand-glass-still.png" : "/assets/brand-glass-motion.gif";
    if (reduce) { shell.style.removeProperty("--light-x"); shell.style.removeProperty("--light-y"); }
  }
  let revision = 0;
  let pendingSave = Promise.resolve();
  function save() {
    revision += 1;
    const saveRevision = revision;
    apply();
    const status = document.querySelector("#ui01AppearanceStatus");
    const appearance = { ...prefs };
    status.textContent = "正在保存外观…";
    try { localStorage.setItem(key, JSON.stringify(appearance)); } catch {}
    pendingSave = pendingSave.catch(() => {}).then(async () => {
      const response = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appearance }) });
      if (!response.ok) throw new Error("Appearance could not be saved");
      if (saveRevision === revision) status.textContent = "已保存到这台设备";
    }).catch(() => { status.textContent = "已应用，但保存失败；请重新选择后重试"; });
  }
  document.querySelectorAll("[data-ui01-theme]").forEach(button => button.addEventListener("click", () => { prefs.theme = button.dataset.ui01Theme; save(); }));
  document.querySelector("#ui01ReduceMotion").addEventListener("change", event => { prefs.reduceMotion = event.target.checked; save(); });
  systemDark.addEventListener("change", apply);
  systemMotion.addEventListener("change", apply);
  let frame = 0;
  function move(x, y) {
    if (document.body.dataset.reduceMotion === "true") return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { shell.style.setProperty("--light-x", `${x}px`); shell.style.setProperty("--light-y", `${y}px`); });
  }
  shell.addEventListener("pointermove", event => {
    if (event.pointerType === "touch") return;
    const bounds = shell.getBoundingClientRect();
    move((event.clientX - bounds.left - bounds.width / 2) / bounds.width * 14, (event.clientY - bounds.top - bounds.height / 2) / bounds.height * 10);
  });
  shell.addEventListener("pointerleave", () => move(0, 0));
  shell.addEventListener("focusin", event => { const r = event.target.getBoundingClientRect(); move((r.x / innerWidth - .5) * 12, (r.y / innerHeight - .5) * 8); });
  const errorBox = document.querySelector("#ui01Error");
  errorBox.querySelector("button").addEventListener("click", () => { errorBox.hidden = true; });
  window.ui01 = { showError(message) { errorBox.querySelector("span").textContent = message; errorBox.hidden = false; } };
  apply();
  window.ui01.ready = fetch("/api/config").then(response => {
    if (!response.ok) throw new Error("Config unavailable");
    return response.json();
  }).then(config => {
    if (revision === 0 && config.appearance) {
      prefs = { theme: config.appearance.theme, reduceMotion: config.appearance.reduceMotion === true };
      apply();
    }
  }).catch(() => {});
})();
