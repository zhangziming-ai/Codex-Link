const state = {
  config: null,
  audit: null,
  backups: [],
  rollbackPoints: [],
  folderCandidates: [],
  diskSpace: null,
  selectedProjects: new Map(),
  selectedConversations: new Map(),
  selectedCapabilities: new Map(),
  advancedQueries: { projects: "", conversations: "", skills: "", api: "", plugins: "" },
  advancedOpen: new Set(),
  backupOperation: null,
  restoreOperation: null,
  restorePlan: null,
  restoreAvailableItems: [],
  restoreSelectedItemIds: new Set(),
  restoreSelectionInitialized: false,
  restoreSelectionQuery: "",
  restoreOpenProjectIds: new Set(),
  restoreExpandedGroups: new Set(),
  restoreOverviewExpandedGroups: new Set(),
  restoreRecovery: null,
  testRestoreEnvironment: null,
  diagnosticArtifact: null
};

const titles = {
  overview: ["Local backup", "总览", "查看本机 Codex 数据状态，并完成创建备份或从备份恢复。"],
  backup: ["Create backup", "创建备份", "选择备份文件夹，生成可移动、可校验的 Codex 恢复点。"],
  restore: ["Restore locally", "从备份恢复", "选择已有备份文件夹，生成恢复计划并按本机环境适配。"],
  manager: ["Backup folder", "备份管理", "管理备份文件夹、历史恢复点和恢复入口。"],
  settings: ["Preferences", "设置", "配置 Codex 主目录、备份文件夹和备份策略。"]
};

const viewAliases = {
  snapshots: "backup",
  cloud: "manager",
  projects: "backup",
  capabilities: "backup",
  safety: "restore"
};

const sectionLabels = {
  config: "规则与配置",
  agents: "全局规则",
  sessions: "当前对话",
  archivedSessions: "归档对话",
  stateDb: "任务索引",
  memories: "个人记忆",
  skills: "Skills",
  plugins: "插件缓存",
  tools: "本地工具",
  auth: "登录凭据"
};

const includeDefinitions = [
  { key: "sessions", label: "对话记录", detail: "当前对话历史", group: "核心数据" },
  { key: "archivedSessions", label: "归档对话", detail: "已归档的历史任务", group: "核心数据" },
  { key: "stateDb", label: "任务索引", detail: "本地侧边栏和任务元数据索引；不能单独保证跨系统项目结构", group: "核心数据" },
  { key: "memories", label: "个人记忆", detail: "偏好、长期上下文和项目记忆", group: "核心数据" },
  { key: "config", label: "规则与配置", detail: "config.toml", group: "配置" },
  { key: "agents", label: "全局规则", detail: "AGENTS.md", group: "配置" },
  { key: "skills", label: "Skills", detail: "本地可迁移能力", group: "能力" },
  { key: "plugins", label: "插件缓存", detail: "需恢复后重新授权", group: "高级" },
  { key: "tools", label: "本地工具", detail: "跨系统需复核", group: "高级" },
  { key: "auth", label: "登录凭据", detail: "默认不建议备份", group: "高级" }
];

const recommendedIncludeKeys = new Set([
  "sessions",
  "archivedSessions",
  "stateDb",
  "memories",
  "config",
  "agents",
  "skills"
]);

const statusLabels = {
  copyable: "可直接复制",
  verify_or_reauthorize: "需复核授权",
  reinstall_or_verify_on_target: "需重装或复核",
  check_command_path_and_auth_on_target: "检查命令与授权",
  needs_mac_equivalent_or_manual_check: "需平台替代",
  missing_api_key: "需配置 API Key",
  not_configured: "未配置",
  missing: "缺失",
  restore_selected: "恢复所选"
};

function $(selector) {
  return document.querySelector(selector);
}

function $all(selector) {
  return [...document.querySelectorAll(selector)];
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function streamApi(url, payload, onProgress = () => {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok || !response.body) {
    let failure = {};
    try {
      failure = await response.json();
    } catch {
      failure = { error: `Request failed: ${response.status}` };
    }
    const error = new Error(failure.error || `Request failed: ${response.status}`);
    error.payload = failure;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result;
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "progress") {
      onProgress(event);
      return;
    }
    if (event.type === "error") {
      const error = new Error(event.error || "操作未能完成");
      error.payload = { error: event.error, details: event.details };
      throw error;
    }
    if (event.type === "result") result = event.result;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (result === undefined) throw new Error("操作结束但未返回结果。");
  return result;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtMb(value) {
  const size = Number(value || 0);
  if (size >= 1024) return `${(size / 1024).toFixed(2)} GB`;
  return `${size.toFixed(2)} MB`;
}

function fmtBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function fmtDate(value) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function shortPath(value, max = 90) {
  const text = String(value || "");
  if (text.length <= max) return text;
  const head = Math.floor((max - 3) * 0.42);
  const tail = max - 3 - head;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function setStatus(kind, text) {
  const dot = $("#statusDot");
  const label = $("#statusText");
  const visibleLabel = $("#sidebarRunState");
  const card = document.querySelector(".sidebar-status-card");
  if (dot) dot.className = `status-dot ${kind || ""}`;
  if (label) label.textContent = text;
  if (visibleLabel) visibleLabel.textContent = text;
  if (card) card.dataset.status = kind || "idle";
}

function renderDiskSpace() {
  const disk = state.diskSpace;
  const name = $("#sidebarDiskName");
  const capacity = $("#sidebarDiskCapacity");
  const progress = $("#sidebarDiskProgress");
  if (!name || !capacity || !progress) return;
  const drive = String(disk?.drive || "").replace(/[\\/]$/, "");
  name.textContent = drive ? `本地磁盘 (${drive})` : "本地磁盘";
  capacity.textContent = disk?.totalBytes
    ? `可用 ${fmtBytes(disk.availableBytes)} / 共 ${fmtBytes(disk.totalBytes)}`
    : "暂时无法读取容量";
  progress.style.width = `${Math.max(0, Math.min(100, Number(disk?.usedPercent || 0)))}%`;
}

async function loadDiskSpace() {
  const targetPath = encodeURIComponent(currentBackupDir() || state.config?.cloudDir || "");
  state.diskSpace = await api(`/api/disk-space?path=${targetPath}`);
  renderDiskSpace();
}

function sectionByKey(key) {
  return (state.audit?.sections || []).find((item) => item.key === key);
}

function sectionSize(keys) {
  return keys.reduce((sum, key) => sum + Number(sectionByKey(key)?.sizeMb || 0), 0);
}

function riskCount() {
  return (state.audit?.macManualChecks || []).length + (state.audit?.windowsPathRefs || []).length;
}

function capabilityCount() {
  return (state.audit?.capabilities || []).length + (state.audit?.apiTools || []).length + (state.audit?.mcpServers || []).length;
}

function currentBackupDir() {
  return $("#backupDirInput")?.value || $("#settingsBackupDir")?.value || state.config?.cloudDir || "";
}

function selectedInclude() {
  const include = {};
  $all("[data-include]").forEach((input) => {
    include[input.dataset.include] = input.checked;
  });
  return include;
}

function renderBackupActionContext() {
  const target = $("#backupActionContext");
  if (!target) return;
  const include = selectedInclude();
  const selectedCount = Object.values(include).filter(Boolean).length;
  const sensitiveCount = ["plugins", "tools", "auth"].filter((key) => include[key]).length;
  const fineConversationCount = fineSelectionCoveredByDefault("conversations") ? 0 : state.selectedConversations.size;
  const fineSkillCount = fineSelectionCoveredByDefault("skills")
    ? 0
    : [...state.selectedCapabilities.values()].filter((item) => item.type !== "api_tool").length;
  const fineApiCount = [...state.selectedCapabilities.values()].filter((item) => item.type === "api_tool").length;
  const fineCount = fineConversationCount + fineSkillCount + fineApiCount;
  target.innerHTML = `
    <strong>主方案 ${selectedCount} 项${fineCount ? ` · 精细选择 ${fineCount} 项` : ""}</strong>
    <span>${sensitiveCount ? `${sensitiveCount} 项需在恢复时复核` : "高级单项选择会同步加入这一份主备份"}</span>
  `;
}

function isIncluded(key) {
  const input = document.querySelector(`[data-include="${key}"]`);
  if (input) return input.checked;
  return Boolean(state.config?.include?.[key]);
}

function setIncluded(key, next) {
  const input = document.querySelector(`[data-include="${key}"]`);
  if (input) input.checked = next;
  if (state.config?.include) state.config.include[key] = next;
}

function fineSelectionCoveredByDefault(scope) {
  if (["projects", "conversations"].includes(scope)) {
    return isIncluded("sessions") || isIncluded("archivedSessions");
  }
  if (scope === "skills") return isIncluded("skills");
  return false;
}

function setDefaultBackupSelection(mode) {
  $all("[data-include]").forEach((input) => {
    const next = mode === "all" ? !input.disabled : recommendedIncludeKeys.has(input.dataset.include);
    input.checked = next;
    if (state.config?.include) state.config.include[input.dataset.include] = next;
  });
  renderBackupActionContext();
  renderOverview();
  renderAdvancedOptions();
}

function selectedPayload(scope = "all") {
  const selectedProjectConversations = [...state.selectedProjects.values()]
    .flatMap((project) => project.conversations || []);
  const uniqueProjectConversations = [...new Map(selectedProjectConversations.map((item) => [item.selectId, item])).values()];
  const conversations = scope === "projects" ? uniqueProjectConversations : [...state.selectedConversations.values()];
  const capabilities = [...state.selectedCapabilities.values()];
  return {
    conversations: ["capabilities", "skills", "api"].includes(scope) ? [] : conversations,
    capabilities: ["conversations", "projects"].includes(scope)
      ? []
      : capabilities.filter((item) => scope === "skills" ? item.type !== "api_tool" : scope === "api" ? item.type === "api_tool" : true)
  };
}

function switchView(viewId, options = {}) {
  const targetId = viewAliases[viewId] || viewId;
  if (!titles[targetId]) return;
  $all(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === targetId);
  });
  $all(".view").forEach((view) => {
    view.classList.toggle("active", view.id === targetId);
  });
  $("#viewEyebrow").textContent = titles[targetId][0];
  $("#viewTitle").textContent = titles[targetId][1];
  $("#viewSubtitle").textContent = titles[targetId][2];
  if (options.updateHash !== false && window.location.hash.slice(1) !== targetId) {
    history.replaceState(null, "", `#${targetId}`);
  }
  renderIcons();
}

function renderIcons() {
  if (!window.lucide) return;
  window.lucide.createIcons({
    attrs: {
      "stroke-width": 1.8,
      "vector-effect": "non-scaling-stroke"
    }
  });
}

function renderSettings() {
  if (!state.config) return;
  $("#backupDirInput").value = state.config.cloudDir || "";
  $("#restoreTargetInput").value = state.config.codexHome || "";
  $("#settingsCodexHome").value = state.config.codexHome || "";
  $("#settingsBackupDir").value = state.config.cloudDir || "";
  $("#settingsRetain").value = state.config.retainSnapshots || 5;

  const include = state.config.include || {};
  const restorePolicy = state.config.restorePolicy || { autoRollback: true, crossSystemAdaptation: true, excludeHighRisk: true };
  state.config.include.auth = false;
  $("#settingsAutoRollback").checked = true;
  $("#settingsCrossSystem").checked = restorePolicy.crossSystemAdaptation !== false;
  $("#settingsExcludeHighRisk").checked = restorePolicy.excludeHighRisk !== false;
  $("#includeOptions").innerHTML = includeDefinitions.map((item) => {
    const isAdvanced = item.group === "\u9ad8\u7ea7";
    const permanentlyExcluded = item.key === "auth";
    const blockedByPolicy = permanentlyExcluded || (isAdvanced && restorePolicy.excludeHighRisk !== false);
    const detail = permanentlyExcluded ? "永久排除 · 恢复后重新登录" : item.detail;
    return `
      <label class="check-item ${isAdvanced ? "advanced" : ""} ${permanentlyExcluded ? "credential-excluded" : ""}" ${permanentlyExcluded ? 'title="auth.json、登录 Token 和账号会话永久不进入备份"' : ""}>
        <input type="checkbox" data-include="${item.key}" ${!permanentlyExcluded && include[item.key] ? "checked" : ""} ${blockedByPolicy ? "disabled" : ""} />
        <span>
          <strong>${escapeHtml(item.label)}</strong>
          <small>${escapeHtml(detail)}</small>
        </span>
      </label>
    `;
  }).join("");
  $all("[data-include]").forEach((input) => {
    input.addEventListener("change", renderBackupActionContext);
    input.addEventListener("change", () => {
      setIncluded(input.dataset.include, input.checked);
      renderOverview();
      renderAdvancedOptions();
    });
  });
  renderBackupActionContext();
  applyRestorePolicy();

  renderFolderCards();
}

function renderFolderCards() {
  const path = currentBackupDir();
  const current = state.folderCandidates.find((item) => item.path === path);
  const label = "备份文件夹";
  const stateText = current?.exactExists ? "已存在" : current?.exists ? "可创建" : path ? "自定义" : "未设置";
  const note = current?.note || "需要放到其他位置时，可以自行上传到网盘、拷贝到移动硬盘或放入 NAS。";
  const totalMb = state.backups.reduce((sum, item) => sum + Number(item.totalMb || 0), 0);
  const latest = state.backups[0];
  const pathRisks = state.audit?.windowsPathRefs?.length || 0;
  const healthState = pathRisks ? "需确认" : "可读取";
  const folderReady = Boolean(path);
  const consoleHtml = `
    <div class="console-status-grid">
      <article class="console-status-card folder-status luminous-card">
        <div class="status-card-copy">
          <span>备份文件夹</span>
          <strong>${escapeHtml(path ? label : "尚未设置")}</strong>
          <p>${escapeHtml(path || "选择一个本地文件夹开始备份")}</p>
          <div class="folder-readiness ${folderReady ? "ready" : ""}">
            <span class="readiness-icon" aria-hidden="true"><i data-lucide="${folderReady ? "circle-check" : "folder-plus"}"></i></span>
            <span>
              <b>${folderReady ? "已就绪" : "等待设置"}</b>
              <small>${folderReady ? "备份文件夹可正常使用，需要时可从恢复点还原。" : "选择备份文件夹后即可创建第一份备份。"}</small>
            </span>
          </div>
          <div class="status-card-metrics">
            <span><i data-lucide="clock-3" aria-hidden="true"></i><span>上次备份<b>${latest ? fmtDate(latest.createdAt) : "暂无"}</b></span></span>
            <span><i data-lucide="hard-drive" aria-hidden="true"></i><span>备份大小<b>${fmtMb(totalMb)}</b></span></span>
          </div>
          <button class="button primary semantic-action action-backup" data-view-button="backup" type="button">
            <span class="button-icon" aria-hidden="true"><i data-lucide="archive"></i></span>
            <span>创建备份</span>
          </button>
        </div>
      </article>
      <article class="console-status-card restore-status luminous-card ${latest ? "has-restore" : ""}">
        <span class="status-card-icon" aria-hidden="true"><i data-lucide="history"></i></span>
        <div class="status-card-copy">
          <span>最近备份恢复点</span>
          <strong>${latest ? fmtDate(latest.createdAt) : "暂无恢复点"}</strong>
          <p>${escapeHtml(latest ? latest.id : "创建第一份备份后会显示在这里")}</p>
          <button class="button secondary restore-entry-button semantic-action action-restore" data-view-button="restore" type="button">
            <span class="button-icon" aria-hidden="true"><i data-lucide="refresh-cw"></i></span>
            <span>从备份恢复</span>
          </button>
        </div>
        <em>${latest ? fmtMb(latest.totalMb) : `${state.backups.length} 个`}</em>
      </article>
      <article class="console-status-card health-status">
        <span class="status-card-icon" aria-hidden="true"><i data-lucide="shield-check"></i></span>
        <div class="status-card-copy">
          <span>备份可用性检查</span>
          <strong>${escapeHtml(healthState)}</strong>
          <p>${pathRisks ? `发现路径差异，恢复计划会逐项提示` : "备份文件夹与核心资产均可读取"}</p>
        </div>
        <em class="health-badge"><i></i>${pathRisks ? "需确认" : "可读取"}</em>
      </article>
    </div>
  `;
  const managerFolderHtml = `
    <div class="manager-folder-row">
      <button class="manager-folder-float semantic-action action-folder" data-open-folder-picker type="button" title="更换备份文件夹">
        <span class="manager-folder-icon" aria-hidden="true"><i data-lucide="folder-open"></i></span>
        <span class="manager-folder-copy">
          <strong>备份文件夹</strong>
          <small>${escapeHtml(path || "请选择备份文件夹")}</small>
        </span>
        <span class="manager-folder-chevron" aria-hidden="true"><i data-lucide="chevron-right"></i></span>
      </button>
      <span class="manager-folder-state ${current?.exists || path ? "ready" : ""}"><i></i>${escapeHtml(stateText)}</span>
    </div>
    <div class="manager-folder-facts">
      <span><b>${state.backups.length}</b> 个恢复点</span>
      <span><b>${fmtMb(totalMb)}</b> 已用</span>
      <span><b>${latest ? fmtDate(latest.createdAt).slice(5, 16) : "暂无"}</b> 最近备份</span>
    </div>
  `;
  const html = `
    <div class="location-card">
      <div>
        <span class="location-eyebrow">${escapeHtml(label)}</span>
        <strong>${escapeHtml(path || "尚未设置备份文件夹")}</strong>
        <p>${escapeHtml(note)}</p>
      </div>
      <span class="cloud-state ${current?.exists || path ? "ready" : ""}">${escapeHtml(stateText)}</span>
    </div>
  `;
  const consoleTarget = $("#homeConsoleStatus");
  if (consoleTarget) consoleTarget.innerHTML = consoleHtml;
  const heroTitle = $("#homeHeroTitle");
  const heroMessage = $("#homeHeroMessage");
  if (heroTitle) heroTitle.textContent = latest ? "备份状态正常" : path ? "备份文件夹已就绪" : "先选择备份文件夹";
  if (heroMessage) {
    heroMessage.textContent = latest
      ? `最近备份恢复点创建于 ${fmtDate(latest.createdAt)}，需要时可直接进入恢复流程。`
      : path
        ? "备份文件夹可以正常使用；还没有恢复点。"
        : "选择备份文件夹后，即可创建第一份备份。";
  }
  const settingsPathSummary = $("#settingsBackupPathSummary");
  if (settingsPathSummary) settingsPathSummary.textContent = shortPath(path || "尚未设置", 54);
  ["#managerLocationCard"].forEach((selector) => {
    const target = $(selector);
    if (target) target.innerHTML = managerFolderHtml;
  });
  ["#backupLocationCard", "#settingsBackupLocationCard"].forEach((selector) => {
    const target = $(selector);
    if (target) target.innerHTML = html;
  });

  const list = $("#folderPickerList");
  if (list) {
    list.innerHTML = state.folderCandidates.map((item) => {
      const stateLabel = item.exactExists ? "已存在" : item.exists ? "可创建" : "建议";
      return `
        <button class="folder-preset semantic-action action-folder" data-folder-path="${escapeHtml(item.path)}" type="button">
          <span class="folder-title">
            <strong>备份文件夹</strong>
            <em>${escapeHtml(stateLabel)}</em>
          </span>
          <span>${escapeHtml(item.path)}</span>
          <small>${escapeHtml(`${item.provider ? `${item.provider} · ` : ""}${item.note || "本地路径"}`)}</small>
        </button>
      `;
    }).join("");
  }

  $all("[data-folder-path]").forEach((button) => {
    button.addEventListener("click", () => applyBackupDirectory(button.dataset.folderPath).catch(showError));
  });
  renderIcons();
}

function renderOverview() {
  if (!state.audit) return;
  const conversations = state.audit.conversations || [];
  const memorySection = sectionByKey("memories");
  const memoryItems = Number(memorySection?.fileCount || 0);
  const memoryProgress = Math.max(10, Math.min(100, Math.round((memoryItems / 200) * 100)));
  $("#homeCodexPath").textContent = shortPath(state.audit.codexHome, 80);
  $("#navBackupCount").textContent = state.backups.length ? String(state.backups.length) : "-";

  const cards = [
    {
      title: "最近备份记录",
      keys: [],
      icon: "history",
      desc: state.backups.length ? `${state.backups.length} 个可用恢复点` : "还没有恢复点",
      tone: "timeline",
      detail: state.backups.length
        ? state.backups.slice(0, 4).map((item) => `<li><i></i><span><b>${escapeHtml(fmtDate(item.createdAt))}</b><small>${escapeHtml(item.id)} · ${fmtMb(item.totalMb)}</small></span></li>`).join("")
        : `<li class="empty"><i></i><span><b>等待第一份备份</b><small>创建后会在这里形成恢复点时间线</small></span></li>`
    },
    { title: "个人记忆", keys: ["memories"], icon: "brain", desc: "偏好、长期上下文与项目记忆", tone: "memory" },
    { title: "对话记录", keys: ["sessions", "archivedSessions"], icon: "messages-square", desc: `${conversations.length} 条最近对话`, tone: "core" },
    { title: "能力库", keys: ["skills"], icon: "blocks", desc: `${capabilityCount()} 个 Skills 与工具项`, tone: "skills" },
    {
      title: "安全检查",
      keys: ["plugins", "tools", "auth"],
      icon: "shield-alert",
      desc: "凭据与授权需单独确认",
      tone: "risk"
    }
  ];

  $("#assetCards").innerHTML = cards.map((card) => {
    const exists = card.tone === "timeline" ? state.backups.length > 0 : card.keys.some((key) => sectionByKey(key)?.exists);
    const includedCount = card.keys.filter((key) => isIncluded(key)).length;
    const allIncluded = card.keys.length > 0 && includedCount === card.keys.length;
    const action = allIncluded ? "已纳入备份" : includedCount ? "部分纳入" : card.tone === "risk" ? "恢复时复核" : "未纳入";
    return `
      <article class="asset-card ${card.tone === "risk" ? "warn" : ""} ${allIncluded ? "selected" : ""} tone-${card.tone}">
        <span class="asset-icon"><i data-lucide="${card.icon}"></i></span>
        <div>
          <strong>${escapeHtml(card.title)}</strong>
          <p>${escapeHtml(card.desc)}</p>
          ${card.tone === "timeline"
            ? `<ol class="backup-timeline">${card.detail}</ol>
               <button class="timeline-link semantic-action action-preview" data-view-button="manager" type="button">查看全部备份记录<i data-lucide="chevron-right"></i></button>`
            : card.tone === "memory"
              ? `<div class="memory-asset-value"><b>${memoryItems}</b><span>条记忆资产</span></div>
                 <div class="memory-asset-progress"><i style="width:${memoryProgress}%"></i></div>
                 <small>${exists ? fmtMb(sectionSize(card.keys)) : "未发现"} · ${escapeHtml(action)}</small>`
              : `<small>${card.tone === "risk" ? `路径差异 ${state.audit.windowsPathRefs?.length || 0} 类` : exists ? fmtMb(sectionSize(card.keys)) : "未发现"} · ${escapeHtml(action)}</small>`}
        </div>
      </article>
    `;
  }).join("");
  renderIcons();
}

function capabilitySelectionItems() {
  return [
    ...(state.audit?.capabilities || []),
    ...(state.audit?.apiTools || [])
  ].filter((item) => item.selectId);
}

function selectionMatches(item, query, fields) {
  if (!query) return true;
  const haystack = fields.map((field) => item?.[field] || "").join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function updateSelectionActions() {
  const conversationCount = state.selectedConversations.size;
  const skillCount = [...state.selectedCapabilities.values()].filter((item) => item.type !== "api_tool").length;
  const apiCount = [...state.selectedCapabilities.values()].filter((item) => item.type === "api_tool").length;
  const counts = { projects: state.selectedProjects.size, conversations: conversationCount, skills: skillCount, api: apiCount };
  Object.entries(counts).forEach(([key, value]) => {
    const label = document.querySelector(`[data-advanced-count="${key}"]`);
    const clearButton = document.querySelector(`[data-clear-${key}]`);
    const coveredByDefault = fineSelectionCoveredByDefault(key);
    if (label) label.textContent = coveredByDefault ? "全量已包含" : value ? `已选 ${value}` : "未选择";
    if (clearButton) clearButton.disabled = coveredByDefault || value === 0;
  });
  renderBackupActionContext();
}

function advancedSearch(queryKey, placeholder) {
  return `<label class="selection-search advanced-search">
    <span class="sr-only">${escapeHtml(placeholder)}</span>
    <i data-lucide="search" aria-hidden="true"></i>
    <input type="search" data-advanced-search="${queryKey}" value="${escapeHtml(state.advancedQueries[queryKey] || "")}" placeholder="${escapeHtml(placeholder)}" />
  </label>`;
}

function selectionHoverDescription(item, kind) {
  if (kind === "conversation") {
    return item.summary || ("对话记录 · " + (item.projectName || "未归类项目") + " · 可独立恢复");
  }
  if (item.type === "api_tool") {
    const projects = Array.isArray(item.usedInProjects) && item.usedInProjects.length
      ? " · 使用项目：" + item.usedInProjects.slice(0, 4).join("、")
      : "";
    return (item.provider ? item.provider + " · " : "") +
      (item.description || item.action || item.installAction || "API 接入记录") +
      projects +
      " · 仅备份用途和重配说明，不保存 API Key";
  }
  return item.description || item.action || item.installAction ||
    ((item.type || "Skill") + " · 恢复后可在目标设备继续使用或复核");
}

function selectionList(items, kind, queryKey, emptyText, fields) {
  const query = state.advancedQueries[queryKey] || "";
  const visible = items.filter((item) => selectionMatches(item, query, fields)).slice(0, query ? 60 : 20);
  const coveredByDefault = fineSelectionCoveredByDefault(queryKey);
  return `<div class="selection-list advanced-selection-list">${visible.length ? visible.map((item) => {
    const isConversation = kind === "conversation";
    const selected = coveredByDefault || (isConversation ? state.selectedConversations.has(item.selectId) : state.selectedCapabilities.has(item.selectId));
    const detail = isConversation
      ? `${item.projectName || "未归类项目"} · ${item.dateKey || fmtDate(item.modifiedAt).slice(0, 10)}`
      : `${statusLabels[item.migrationStatus] || item.migrationStatus || "待检查"}${item.usageCount ? ` · 使用 ${Number(item.usageCount)} 次` : ""}`;
    const hoverDescription = selectionHoverDescription(item, kind);
    return `<label class="selection-item has-hover-description" title="${escapeHtml(hoverDescription)}" data-tooltip="${escapeHtml(hoverDescription)}" tabindex="0">
      <input type="checkbox" data-select-${kind}="${escapeHtml(item.selectId)}" ${selected ? "checked" : ""} ${coveredByDefault ? "disabled" : ""} />
      <span><strong>${escapeHtml(item.title || item.name || "未命名")}</strong><small>${escapeHtml(coveredByDefault ? "已由上方主方案全量包含" : detail)}</small></span>
      <span class="selection-hover-help" aria-hidden="true"><i data-lucide="info"></i></span>
    </label>`;
  }).join("") : `<div class="selection-empty">${escapeHtml(emptyText)}</div>`}</div>`;
}

function categoryIncludeRow(key, label, detail, tone = "neutral") {
  return `<label class="advanced-include-row tone-${tone}">
    <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span>
    <input type="checkbox" data-advanced-include="${key}" ${isIncluded(key) ? "checked" : ""} />
  </label>`;
}

function advancedCategory({ key, icon, title, subtitle, count, tone = "blue", body, open = false }) {
  return `<details class="advanced-category tone-${tone}" data-advanced-category="${key}" ${open ? "open" : ""}>
    <summary>
      <span class="advanced-category-icon"><i data-lucide="${icon}" aria-hidden="true"></i></span>
      <span class="advanced-category-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle)}</small></span>
      <span class="advanced-category-count" data-advanced-count="${key}">${escapeHtml(count)}</span>
      <i class="advanced-category-chevron" data-lucide="chevron-down" aria-hidden="true"></i>
    </summary>
    <div class="advanced-category-body">${body}</div>
  </details>`;
}

function renderAdvancedOptions() {
  const container = $("#advancedCategoryGrid");
  if (!container || !state.audit) return;
  const projects = state.audit.conversationGroups || [];
  const conversations = state.audit.conversations || [];
  const skills = (state.audit.capabilities || []).filter((item) => item.type !== "plugin_skill");
  const apiTools = state.audit.apiTools || [];
  const mcpServers = state.audit.mcpServers || [];
  const plugins = state.audit.plugins || [];
  const toolSection = sectionByKey("tools");
  const conversationsCovered = fineSelectionCoveredByDefault("conversations");
  const skillsCovered = fineSelectionCoveredByDefault("skills");
  const projectQuery = state.advancedQueries.projects || "";
  const visibleProjects = projects.filter((item) =>
    selectionMatches(item, projectQuery, ["projectName", "projectPath"])
  ).slice(0, projectQuery ? 60 : 24);
  const pluginQuery = state.advancedQueries.plugins || "";
  const visiblePlugins = plugins.filter((item) =>
    selectionMatches(item, pluginQuery, ["displayName", "name", "description"])
  ).slice(0, pluginQuery ? 60 : 20);
  const projectRows = visibleProjects.map((item) => {
    const projectId = item.projectPath || item.projectName;
    return `<label class="selection-item project-selection-item">
      <input type="checkbox" data-select-project="${escapeHtml(projectId)}" ${conversationsCovered || state.selectedProjects.has(projectId) ? "checked" : ""} ${conversationsCovered ? "disabled" : ""} />
      <span><strong>${escapeHtml(item.projectName || "未命名项目")}</strong><small>${escapeHtml(conversationsCovered ? "已由上方主方案全量包含" : Number(item.count || item.conversations?.length || 0) + " 条记录 · " + shortPath(item.projectPath || "", 44))}</small></span>
    </label>`;
  }).join("");
  const mcpRows = mcpServers.length ? mcpServers.map((item) => `<div class="advanced-data-row"><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.source || "配置文件")}</small></span><em>${escapeHtml(statusLabels[item.migrationStatus] || "需复核")}</em></div>`).join("") : `<div class="selection-empty">未扫描到 MCP 接入。</div>`;
  const pluginRows = visiblePlugins.map((item) => `<div class="advanced-data-row has-hover-description" title="${escapeHtml(item.description || "插件缓存；恢复后需要重新授权或重装")}" data-tooltip="${escapeHtml(item.description || "插件缓存；恢复后需要重新授权或重装")}" tabindex="0"><span><strong>${escapeHtml(item.displayName || item.name)}</strong><small>${escapeHtml(item.name)}</small></span><em>需复核</em></div>`).join("");
  const selectedSkillCount = [...state.selectedCapabilities.values()].filter((item) => item.type !== "api_tool").length;
  const selectedApiCount = [...state.selectedCapabilities.values()].filter((item) => item.type === "api_tool").length;

  container.innerHTML = [`<div class="advanced-group-label tone-mint"><strong>精细选择 · 同步加入主备份</strong><small>上方已全量勾选时，这里自动显示“已包含”；取消全量后可选择单项</small></div>`,
    advancedCategory({
      key: "projects", icon: "folder-kanban", title: "项目记录", tone: "cyan",
      subtitle: `${projects.length} 个项目 · ${conversations.length} 条关联记录`,
      count: conversationsCovered ? "全量已包含" : state.selectedProjects.size ? `已选 ${state.selectedProjects.size}` : "未选择",
      open: state.advancedOpen.has("projects"),
      body: `${advancedSearch("projects", "搜索项目名称或路径")}<p class="advanced-category-note">取消上方对话全量备份后，可在这里按项目精细选择；所选记录会加入底部主备份。</p><div class="selection-list advanced-selection-list">${projectRows || `<div class="selection-empty">没有匹配的项目记录。</div>`}</div><div class="selection-actions batch-actions"><button class="mini-button semantic-action action-adjust" data-select-all-projects type="button" title="选择全部项目，包括当前未显示的项目" ${conversationsCovered ? "disabled" : ""}>全选全部 ${projects.length} 个</button><button class="mini-button semantic-action action-reset" data-clear-projects type="button" ${conversationsCovered || !state.selectedProjects.size ? "disabled" : ""}>清空</button></div>`
    }),
    advancedCategory({
      key: "conversations", icon: "messages-square", title: "对话记录", tone: "blue",
      subtitle: `${conversations.length} 条对话 · 可按项目、标题或日期筛选`,
      count: conversationsCovered ? "全量已包含" : state.selectedConversations.size ? `已选 ${state.selectedConversations.size}` : "未选择",
      open: state.advancedOpen.has("conversations"),
      body: `${advancedSearch("conversations", "搜索项目、标题或日期")}${selectionList(conversations, "conversation", "conversations", "没有匹配的对话。", ["title", "summary", "projectName", "dateKey"])}<div class="selection-actions batch-actions"><button class="mini-button semantic-action action-adjust" data-select-all-conversations type="button" title="选择全部对话，包括当前搜索未显示的内容" ${conversationsCovered ? "disabled" : ""}>全选全部 ${conversations.length} 条</button><button class="mini-button semantic-action action-reset" data-clear-conversations type="button" ${conversationsCovered || !state.selectedConversations.size ? "disabled" : ""}>清空</button></div>`
    }),
    advancedCategory({
      key: "skills", icon: "sparkles", title: "Skills", tone: "mint",
      subtitle: `${skills.length} 项本地与用户技能`, count: skillsCovered ? "全量已包含" : selectedSkillCount ? `已选 ${selectedSkillCount}` : "未选择",
      open: state.advancedOpen.has("skills"),
      body: `${advancedSearch("skills", "搜索 Skill 名称、说明或来源")}${selectionList(skills, "capability", "skills", "没有匹配的 Skill。", ["name", "configuredName", "manifestName", "folderName", "description", "type", "path"])}<div class="selection-actions batch-actions"><button class="mini-button semantic-action action-adjust" data-select-all-skills type="button" title="选择全部 Skills，包括当前搜索未显示的内容" ${skillsCovered ? "disabled" : ""}>全选全部 ${skills.length} 项</button><button class="mini-button semantic-action action-reset" data-clear-skills type="button" ${skillsCovered || !selectedSkillCount ? "disabled" : ""}>清空</button></div>`
    }),
    advancedCategory({
      key: "api", icon: "plug-zap", title: "API 接入记录", tone: "coral",
      subtitle: `${apiTools.length} 个 Provider · 不保存密钥`, count: selectedApiCount ? `已选 ${selectedApiCount}` : "未选择",
      open: state.advancedOpen.has("api"),
      body: `${advancedSearch("api", "搜索 Provider、工具或使用项目")}${selectionList(apiTools, "capability", "api", "没有匹配的 API 接入记录。", ["name", "provider", "description", "usedInProjects", "action", "installAction"])}<div class="selection-actions batch-actions"><button class="mini-button semantic-action action-adjust" data-select-all-api type="button" title="选择全部 API 接入记录，包括当前搜索未显示的内容">全选全部 ${apiTools.length} 项</button><button class="mini-button semantic-action action-reset" data-clear-api type="button" ${selectedApiCount ? "" : "disabled"}>清空</button></div>`
    }),
    `<div class="advanced-group-label tone-blue"><strong>调整默认备份方案</strong><small>MCP、插件、本地工具与规则配置</small></div>`,
    advancedCategory({
      key: "mcp", icon: "network", title: "MCP", tone: "cyan",
      subtitle: `${mcpServers.length} 项接入配置`, count: isIncluded("config") ? "已纳入配置" : "未纳入",
      open: state.advancedOpen.has("mcp"),
      body: `${mcpRows}${categoryIncludeRow("config", "纳入 MCP 配置", "随 config.toml 保存，恢复时复核路径与授权", "cyan")}`
    }),
    advancedCategory({
      key: "plugins", icon: "blocks", title: "插件", tone: "coral",
      subtitle: `${plugins.length} 项已发现插件`, count: isIncluded("plugins") ? "已纳入" : "默认排除",
      open: state.advancedOpen.has("plugins"),
      body: `${advancedSearch("plugins", "搜索插件名称或说明")}<div class="selection-list advanced-selection-list compact">${pluginRows || `<div class="selection-empty">没有匹配的插件。</div>`}</div>${categoryIncludeRow("plugins", "纳入插件缓存", "恢复后仍需要重装或重新授权", "coral")}`
    }),
    advancedCategory({
      key: "tools", icon: "wrench", title: "本地工具", tone: "orange",
      subtitle: toolSection?.exists ? `${fmtMb(toolSection.sizeMb)} · 跨系统需复核` : "未发现可备份的本地工具",
      count: isIncluded("tools") ? "已纳入" : "默认排除", open: state.advancedOpen.has("tools"),
      body: `<div class="advanced-data-row"><span><strong>${escapeHtml(toolSection?.label || "本地工具目录")}</strong><small>${escapeHtml(shortPath(toolSection?.path || "未发现目录", 58))}</small></span><em>${toolSection?.exists ? "已发现" : "未发现"}</em></div>${categoryIncludeRow("tools", "纳入本地工具", "可能依赖当前系统路径，恢复前需复核", "orange")}`
    }),
    advancedCategory({
      key: "rules", icon: "file-cog", title: "规则与配置", tone: "purple",
      subtitle: "全局规则与 Codex 配置文件", count: isIncluded("config") && isIncluded("agents") ? "已纳入" : "部分纳入",
      open: state.advancedOpen.has("rules"),
      body: `${categoryIncludeRow("config", "Codex 配置", "config.toml 与基础运行配置", "purple")}${categoryIncludeRow("agents", "全局规则", "AGENTS.md 与工作规则", "purple")}`
    })
  ].join("");

  bindAdvancedOptionEvents();
  updateSelectionActions();
  renderIcons();
}

function bindAdvancedOptionEvents() {
  $all("[data-advanced-category]").forEach((details) => details.addEventListener("toggle", () => {
    if (details.open) state.advancedOpen.add(details.dataset.advancedCategory);
    else state.advancedOpen.delete(details.dataset.advancedCategory);
  }));
  $all("[data-advanced-search]").forEach((input) => input.addEventListener("input", () => {
    state.advancedQueries[input.dataset.advancedSearch] = input.value;
    renderAdvancedOptions();
    const next = document.querySelector(`[data-advanced-search="${input.dataset.advancedSearch}"]`);
    next?.focus();
    next?.setSelectionRange(next.value.length, next.value.length);
  }));
  $all("[data-select-conversation]").forEach((input) => input.addEventListener("change", () => {
    const item = (state.audit.conversations || []).find((entry) => entry.selectId === input.dataset.selectConversation);
    if (input.checked && item) state.selectedConversations.set(item.selectId, item);
    else state.selectedConversations.delete(input.dataset.selectConversation);
    updateSelectionActions();
  }));
  $all("[data-select-capability]").forEach((input) => input.addEventListener("change", () => {
    const item = capabilitySelectionItems().find((entry) => entry.selectId === input.dataset.selectCapability);
    if (input.checked && item) state.selectedCapabilities.set(item.selectId, item);
    else state.selectedCapabilities.delete(input.dataset.selectCapability);
    updateSelectionActions();
  }));
  $all("[data-select-project]").forEach((input) => input.addEventListener("change", () => {
    const item = (state.audit.conversationGroups || []).find((entry) => (entry.projectPath || entry.projectName) === input.dataset.selectProject);
    if (!item) return;
    const projectId = item.projectPath || item.projectName;
    if (input.checked) state.selectedProjects.set(projectId, item);
    else state.selectedProjects.delete(projectId);
    renderAdvancedOptions();
  }));
  $all("[data-advanced-include]").forEach((input) => input.addEventListener("change", () => {
    setIncluded(input.dataset.advancedInclude, input.checked);
    renderOverview();
    renderAdvancedOptions();
  }));
  $("[data-select-all-projects]")?.addEventListener("click", selectAllProjects);
  $("[data-clear-projects]")?.addEventListener("click", clearProjects);
  $("[data-select-all-conversations]")?.addEventListener("click", selectAllConversations);
  $("[data-clear-conversations]")?.addEventListener("click", clearConversations);
  $("[data-select-all-skills]")?.addEventListener("click", selectAllSkills);
  $("[data-clear-skills]")?.addEventListener("click", clearSkills);
  $("[data-select-all-api]")?.addEventListener("click", selectAllApi);
  $("[data-clear-api]")?.addEventListener("click", clearApi);
}

function selectAllProjects() {
  (state.audit?.conversationGroups || []).forEach((item) => {
    state.selectedProjects.set(item.projectPath || item.projectName, item);
  });
  renderAdvancedOptions();
}

function clearProjects() {
  state.selectedProjects.clear();
  renderAdvancedOptions();
}

function selectAllConversations() {
  (state.audit?.conversations || []).forEach((item) => state.selectedConversations.set(item.selectId, item));
  renderAdvancedOptions();
}

function clearConversations() {
  state.selectedConversations.clear();
  renderAdvancedOptions();
}

function selectAllSkills() {
  (state.audit?.capabilities || []).filter((item) => item.type !== "plugin_skill")
    .forEach((item) => state.selectedCapabilities.set(item.selectId, item));
  renderAdvancedOptions();
}

function clearSkills() {
  [...state.selectedCapabilities.entries()].forEach(([id, item]) => {
    if (item.type !== "api_tool") state.selectedCapabilities.delete(id);
  });
  renderAdvancedOptions();
}

function selectAllApi() {
  (state.audit?.apiTools || []).forEach((item) => state.selectedCapabilities.set(item.selectId, item));
  renderAdvancedOptions();
}

function clearApi() {
  [...state.selectedCapabilities.entries()].forEach(([id, item]) => {
    if (item.type === "api_tool") state.selectedCapabilities.delete(id);
  });
  renderAdvancedOptions();
}

function renderBackups() {
  $("#navBackupCount").textContent = state.backups.length ? String(state.backups.length) : "-";
  const list = $("#backupList");
  if (!list) return;
  list.innerHTML = state.backups.length ? state.backups.map((item, index) => `
    <article class="snapshot-card ${index === 0 ? "is-latest" : ""}">
      <div class="card-title-row">
        <div>
          <div class="card-title">${escapeHtml(item.id)}</div>
          <div class="card-desc">${fmtDate(item.createdAt)} · ${escapeHtml(item.sourceOS || "未知系统")} · ${item.projectCount || 0} 个项目 / ${item.threadCount || 0} 个对话 · ${item.projectFilesIncluded ? "包含项目文件" : "不含项目文件"}${item.rebuiltFromLegacy ? " · 由旧版备份重建" : ""}</div>
        </div>
        <span class="badge">${fmtMb(item.totalMb)}</span>
      </div>
      <div class="card-meta">${escapeHtml(item.snapshotDir)}</div>
      <div class="action-row">
        <button class="mini-button restore-choice-button semantic-action action-restore" data-use-backup="${escapeHtml(item.snapshotDir)}" type="button">用于恢复</button>
        <button class="mini-button danger" data-delete-backup="${escapeHtml(item.snapshotDir)}" data-backup-id="${escapeHtml(item.id)}" type="button">删除</button>
      </div>
    </article>
  `).join("") : `
    <div class="empty-state recovery-empty">
      <span class="empty-icon" aria-hidden="true"><i data-lucide="archive"></i></span>
      <strong>还没有恢复点</strong>
      <p>可使用上方操作创建第一份备份，或更换到已有恢复点的备份文件夹。</p>
    </div>
  `;

  const detail = $("#managerBackupDetail");
  const latest = state.backups[0];
  if (detail) {
    detail.innerHTML = latest ? `
      <div class="restore-point-detail">
        <span class="detail-icon" aria-hidden="true"><i data-lucide="history"></i></span>
        <div>
          <span>最近备份恢复点</span>
          <strong>${escapeHtml(fmtDate(latest.createdAt))}</strong>
          <p>${escapeHtml(shortPath(latest.snapshotDir, 78))}</p>
        </div>
        <dl>
          <div><dt>恢复点大小</dt><dd>${fmtMb(latest.totalMb)}</dd></div>
          <div><dt>来源系统</dt><dd>${escapeHtml(latest.sourceOS || "未知")}</dd></div>
          <div><dt>项目与对话</dt><dd>${latest.projectCount || 0} 个项目 · ${latest.threadCount || 0} 个对话${latest.rebuiltFromLegacy ? " · 由旧版备份重建" : ""}</dd></div>
          <div><dt>项目源文件</dt><dd>${latest.projectFilesIncluded ? "已包含" : "未包含"}</dd></div>
        </dl>
        <button class="button secondary restore-point-action semantic-action action-restore" data-use-backup="${escapeHtml(latest.snapshotDir)}" type="button">
          <span class="button-icon" aria-hidden="true"><i data-lucide="refresh-cw"></i></span>
          <span>再次恢复此备份</span>
        </button>
      </div>
    ` : `
      <div class="manager-detail-empty">
        <span class="detail-icon" aria-hidden="true"><i data-lucide="clock-3"></i></span>
        <strong>等待恢复点</strong>
        <p>创建第一份备份后，这里会显示恢复点详情。</p>
      </div>
    `;
  }

  renderManagerLibrary();

  $all("[data-use-backup]").forEach((button) => {
    button.addEventListener("click", () => {
      $("#restoreSnapshotInput").value = button.dataset.useBackup;
      resetRestoreSelection();
      switchView("restore");
      restorePlan().catch(showError);
    });
  });
  $all("[data-delete-backup]").forEach((button) => {
    button.addEventListener("click", () => deleteBackup(button.dataset.deleteBackup, button.dataset.backupId));
  });
  renderIcons();
}

function rollbackStatusLabel(status) {
  return {
    completed: "可以撤销",
    manual_rolled_back: "已撤销",
    rolled_back: "已自动回退",
    recovered_rolled_back: "中断后已回退",
    rollback_failed: "回滚失败",
    invalid: "数据无效"
  }[status] || status || "未知状态";
}

function renderRollbackPoints() {
  const list = $("#rollbackPointList");
  if (!list) return;
  const points = state.rollbackPoints || [];
  list.innerHTML = points.length ? points.map((item, index) => `
    <article class="snapshot-card ${index === 0 ? "is-latest" : ""}">
      <div class="card-title-row">
        <div>
          <div class="card-title">${escapeHtml(item.id)}</div>
          <div class="card-desc">${fmtDate(item.createdAt)} · ${escapeHtml(rollbackStatusLabel(item.status))} · ${item.threadCount || 0} 个线程 / ${item.fileCount || 0} 个文件</div>
        </div>
        <span class="badge">${escapeHtml(item.status || "unknown")}</span>
      </div>
      <div class="card-meta">源备份：${escapeHtml(item.sourceSnapshotId || "未知")}<br />目标目录：${escapeHtml(item.targetCodexHome || "未知")}</div>
      <div class="action-row">
        <button class="mini-button danger" data-undo-rollback="${escapeHtml(item.rollbackDir)}" data-rollback-id="${escapeHtml(item.id)}" type="button" ${item.canUndo ? "" : "disabled"}>撤销这次恢复</button>
        <button class="mini-button" data-export-rollback="${escapeHtml(item.id)}" data-export-format="json" type="button">JSON 报告</button>
        <button class="mini-button" data-export-rollback="${escapeHtml(item.id)}" data-export-format="md" type="button">Markdown 报告</button>
      </div>
    </article>
  `).join("") : `
    <div class="empty-state recovery-empty">
      <span class="empty-icon" aria-hidden="true"><i data-lucide="rotate-ccw"></i></span>
      <strong>还没有事务回滚点</strong>
      <p>完成一次真实恢复后，这里会显示可用于撤销该事务的回滚点。</p>
    </div>
  `;
  $all("[data-undo-rollback]").forEach((button) => {
    button.addEventListener("click", () => undoRollbackPoint(button.dataset.undoRollback, button.dataset.rollbackId));
  });
  $all("[data-export-rollback]").forEach((button) => {
    button.addEventListener("click", () => {
      const point = state.rollbackPoints.find((item) => item.id === button.dataset.exportRollback);
      if (point) downloadDiagnostic(button.dataset.exportFormat, { phase: "rollback-point", data: point });
    });
  });
  renderIcons();
}

async function undoRollbackPoint(rollbackDir, id) {
  const point = state.rollbackPoints.find((item) => item.id === id);
  const summary = point ? `\n\n将处理 ${point.fileCount || 0} 个文件、${point.threadCount || 0} 个线程。\n目标：${point.targetCodexHome || "未知"}` : "";
  if (!window.confirm(`撤销恢复事务 ${id}？${summary}\n\n恢复后被修改的文件会触发冲突并保留，不会强制删除。`)) return;
  const result = await api("/api/rollback-points/undo", {
    method: "POST",
    body: JSON.stringify({ cloudDir: currentBackupDir(), rollbackDir, id, confirmUndo: true })
  });
  setDiagnosticArtifact("rollback", result);
  if (result.status === "rollback_conflict") {
    const error = new Error(`检测到 ${result.conflictCount} 个恢复后修改冲突，未执行撤销。`);
    error.payload = result;
    throw error;
  }
  await loadBackups();
}

function renderManagerLibrary() {
  if (!state.audit) return;
  const conversations = state.audit.conversations || [];
  const projects = state.audit.conversationGroups || [];
  const skills = state.audit.capabilities || [];
  const mcpServers = state.audit.mcpServers || [];
  const plugins = state.audit.plugins || [];
  const apiTools = state.audit.apiTools || [];
  const memory = sectionByKey("memories");
  const rulesSize = sectionSize(["config", "agents"]);
  const libraryCards = [
    {
      tone: "blue",
      icon: "messages-square",
      title: "对话与项目",
      value: conversations.length,
      unit: "条对话",
      detail: `${projects.length} 个项目分组 · 含归档记录`
    },
    {
      tone: "purple",
      icon: "brain",
      title: "个人记忆",
      value: Number(memory?.fileCount || 0),
      unit: "条记忆资产",
      detail: `${fmtMb(memory?.sizeMb || 0)} · 独立核心资产`
    },
    {
      tone: "mint",
      icon: "blocks",
      title: "能力与技能",
      value: skills.length,
      unit: "项能力",
      detail: `${mcpServers.length} 个 MCP · ${plugins.length} 个插件`
    },
    {
      tone: "coral",
      icon: "plug-zap",
      title: "API 接入记录",
      value: apiTools.length,
      unit: "项接入",
      detail: "仅保存服务与使用记录，不显示密钥"
    },
    {
      tone: "violet",
      icon: "file-cog",
      title: "规则与配置",
      value: 2,
      unit: "组配置",
      detail: `${fmtMb(rulesSize)} · config 与全局规则`
    }
  ];
  const library = $("#managerLibraryGrid");
  if (library) {
    library.innerHTML = libraryCards.map((card) => `
      <article class="manager-library-card tone-${card.tone}">
        <span class="manager-library-icon" aria-hidden="true"><i data-lucide="${card.icon}"></i></span>
        <div>
          <strong>${escapeHtml(card.title)}</strong>
          <p><b>${card.value}</b> ${escapeHtml(card.unit)}</p>
          <small>${escapeHtml(card.detail)}</small>
        </div>
      </article>
    `).join("");
  }

  const pathRisk = (state.audit.windowsPathRefs || []).length > 0;
  const credentialRisk = Boolean(sectionByKey("auth")?.exists);
  const integrationRisk = plugins.length > 0 || apiTools.length > 0;
  const riskCategories = [pathRisk, credentialRisk, integrationRisk].filter(Boolean).length;
  const safety = $("#managerSafetySummary");
  if (safety) {
    safety.innerHTML = `
      <div class="manager-safety-state ${riskCategories ? "review" : "safe"}">
        <span class="manager-safety-icon" aria-hidden="true"><i data-lucide="${riskCategories ? "shield-alert" : "shield-check"}"></i></span>
        <div><strong>${riskCategories ? `${riskCategories} 类需要确认` : "检查通过"}</strong><p>${riskCategories ? "恢复计划会逐项解释并给出下一步。" : "当前没有需要处理的恢复风险。"}</p></div>
      </div>
      <div class="manager-safety-list">
        <span class="${pathRisk ? "review" : "safe"}"><i data-lucide="route"></i><b>路径适配</b><small>${pathRisk ? "恢复时检查" : "正常"}</small></span>
        <span class="${credentialRisk ? "review" : "safe"}"><i data-lucide="key-round"></i><b>凭据授权</b><small>${credentialRisk ? "建议重新登录" : "未包含"}</small></span>
        <span class="${integrationRisk ? "review" : "safe"}"><i data-lucide="plug"></i><b>插件与 API</b><small>${integrationRisk ? "恢复后验证" : "正常"}</small></span>
      </div>
      <button class="button secondary manager-safety-action semantic-action action-risk" data-view-button="restore" type="button">
        <span class="button-icon" aria-hidden="true"><i data-lucide="clipboard-check"></i></span>
        <span>进入恢复检查</span>
      </button>
    `;
  }
}

function setButtonBusy(selector, busy, busyLabel) {
  const button = $(selector);
  if (!button) return;
  const label = [...button.querySelectorAll(":scope > span")].at(-1);
  const labelTarget = label || (button.childElementCount === 0 ? button : null);
  if (labelTarget && !button.dataset.idleLabel) button.dataset.idleLabel = labelTarget.textContent;
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
  if (labelTarget) labelTarget.textContent = busy ? busyLabel : button.dataset.idleLabel;
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  if (value < 60) return `${value} 秒`;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function operationWorkText(operation) {
  if (Number(operation?.totalBytes) > 0) {
    return `已处理 ${fmtBytes(operation.completedBytes || 0)} / ${fmtBytes(operation.totalBytes)}`;
  }
  if (Number(operation?.totalUnits) > 0) {
    return `已处理 ${Number(operation.completedUnits || 0)} / ${Number(operation.totalUnits)} 项`;
  }
  return "";
}

function estimateBackupDuration({ mode = "create", selected } = {}) {
  if (mode === "preview") return { min: 2, max: 6, totalMb: 0, itemCount: 0 };
  if (selected) {
    const itemCount = Number(selected.conversations?.length || 0) + Number(selected.capabilities?.length || 0);
    const conversationMb = (selected.conversations || []).reduce((sum, item) => sum + Number(item.sizeMb || 0), 0);
    const seconds = 3 + itemCount * 0.16 + conversationMb / 75;
    return { min: Math.max(3, Math.ceil(seconds * 0.7)), max: Math.max(8, Math.ceil(seconds * 1.45)), totalMb: conversationMb, itemCount };
  }
  const include = selectedInclude();
  const sections = (state.audit?.sections || []).filter((section) => include[section.key] && section.exists);
  const totalMb = sections.reduce((sum, section) => sum + Number(section.sizeMb || 0), 0);
  const selectedCount = sections.length;
  const smallFileWeight = ["sessions", "archivedSessions", "plugins", "tools"].filter((key) => include[key]).length;
  const seconds = 4 + totalMb / 55 + selectedCount * 0.7 + smallFileWeight * 7;
  return {
    min: Math.max(8, Math.ceil(seconds * 0.72)),
    max: Math.max(15, Math.ceil(seconds * 1.35)),
    totalMb,
    itemCount: selectedCount
  };
}

function renderBackupTimeStatus() {
  const target = $("#backupTimeStatus");
  const estimate = $("#backupTimeEstimate");
  const elapsed = $("#backupTimeElapsed");
  const operation = state.backupOperation;
  renderBackupProgress();
  if (!target || !estimate || !elapsed) return;
  if (!operation) {
    target.hidden = true;
    return;
  }
  target.hidden = false;
  const elapsedSeconds = Math.max(0, (Date.now() - operation.startedAt) / 1000);
  if (operation.finishedAt) {
    estimate.textContent = operation.kind === "preview" ? "计划生成完成" : "备份创建完成";
    elapsed.textContent = `实际用时 ${formatDuration((operation.finishedAt - operation.startedAt) / 1000)}`;
    target.classList.add("complete");
    target.classList.remove("overtime");
    return;
  }
  estimate.textContent = `预计 ${formatDuration(operation.estimate.min)}–${formatDuration(operation.estimate.max)}`;
  elapsed.textContent = elapsedSeconds > operation.estimate.max
    ? `已用 ${formatDuration(elapsedSeconds)}，仍在处理中`
    : `已用 ${formatDuration(elapsedSeconds)}`;
  target.classList.toggle("overtime", elapsedSeconds > operation.estimate.max);
  target.classList.remove("complete");
}

function renderBackupProgress() {
  const progress = $("#backupProgress");
  const track = progress?.querySelector(".backup-progress-track");
  const fill = $("#backupProgressFill");
  const percent = $("#backupProgressPercent");
  const eta = $("#backupProgressEta");
  const operation = state.backupOperation;
  if (!progress || !track || !fill || !percent || !eta) return;
  if (!operation) {
    progress.hidden = true;
    return;
  }

  const now = operation.finishedAt || Date.now();
  const elapsedSeconds = Math.max(0, (now - operation.startedAt) / 1000);
  const expectedSeconds = Math.max(1, (operation.estimate.min + operation.estimate.max) / 2);
  const complete = Boolean(operation.finishedAt);
  const hasActualProgress = Number.isFinite(operation.progress);
  const value = complete
    ? 100
    : hasActualProgress
      ? Math.min(99, Math.max(1, Math.round(operation.progress)))
      : Math.min(94, Math.max(3, Math.round((elapsedSeconds / expectedSeconds) * 100)));
  const remainingSeconds = Number.isFinite(operation.etaSeconds)
    ? operation.etaSeconds
    : Math.max(0, expectedSeconds - elapsedSeconds);

  progress.hidden = false;
  progress.classList.toggle("complete", complete);
  fill.style.width = `${value}%`;
  percent.textContent = `${value}%`;
  track.setAttribute("aria-valuenow", String(value));
  eta.textContent = complete
    ? "已完成"
    : [
        operation.stageMessage || "正在处理实际文件",
        operationWorkText(operation),
        remainingSeconds > 0 ? `预计剩余 ${formatDuration(Math.max(1, remainingSeconds))}` : ""
      ].filter(Boolean).join(" · ");
}

function startBackupOperation(kind, options = {}) {
  stopBackupOperation(false);
  state.backupOperation = {
    kind,
    startedAt: Date.now(),
    finishedAt: null,
    estimate: estimateBackupDuration({ mode: kind, selected: options.selected }),
    progress: 0,
    etaSeconds: null,
    stageMessage: kind === "preview" ? "正在扫描备份内容" : "正在准备恢复点"
  };
  renderBackupTimeStatus();
  state.backupOperation.timer = window.setInterval(renderBackupTimeStatus, 1000);
}

function updateBackupOperationProgress(event) {
  if (!state.backupOperation) return;
  state.backupOperation.progress = Number(event.progress || 0);
  state.backupOperation.etaSeconds = Number.isFinite(Number(event.etaSeconds)) ? Number(event.etaSeconds) : null;
  state.backupOperation.stage = event.stage || "";
  state.backupOperation.stageMessage = event.message || "正在处理实际文件";
  state.backupOperation.completedUnits = event.completedUnits;
  state.backupOperation.totalUnits = event.totalUnits;
  state.backupOperation.completedBytes = event.completedBytes;
  state.backupOperation.totalBytes = event.totalBytes;
  renderBackupTimeStatus();
  if ($("#backupResultVisual")?.classList.contains("busy")) {
    const body = $("#backupResultVisualBody");
    if (body) body.textContent = state.backupOperation.stageMessage;
  }
}

function stopBackupOperation(completed = true) {
  const operation = state.backupOperation;
  if (!operation) return;
  if (operation.timer) window.clearInterval(operation.timer);
  operation.timer = null;
  if (completed) {
    operation.finishedAt = Date.now();
    renderBackupTimeStatus();
  } else {
    state.backupOperation = null;
    renderBackupTimeStatus();
  }
}

function renderRestoreProgress(status = "running") {
  const progress = $("#restoreProgress");
  const track = progress?.querySelector(".backup-progress-track");
  const fill = $("#restoreProgressFill");
  const percent = $("#restoreProgressPercent");
  const eta = $("#restoreProgressEta");
  const operation = state.restoreOperation;
  if (!progress || !track || !fill || !percent || !eta) return;
  if (!operation) {
    progress.hidden = true;
    return;
  }
  const value = Math.max(0, Math.min(100, Math.round(Number(operation.progress || 0))));
  progress.hidden = false;
  progress.classList.toggle("complete", status === "complete");
  progress.classList.toggle("has-error", status === "error");
  fill.style.width = `${Math.max(1, value)}%`;
  percent.textContent = `${value}%`;
  track.setAttribute("aria-valuenow", String(value));
  const etaText = status === "complete"
    ? "恢复完成，逐项校验通过"
    : status === "error"
      ? operation.stageMessage || "恢复未完成，请查看右侧摘要"
      : [
          operation.stageMessage || "正在执行恢复事务",
          operationWorkText(operation),
          operation.etaSeconds > 0 ? `预计剩余 ${formatDuration(operation.etaSeconds)}` : ""
        ].filter(Boolean).join(" · ");
  eta.textContent = etaText;
}

function startRestoreOperation() {
  state.restoreOperation = {
    startedAt: Date.now(),
    finishedAt: null,
    progress: 0,
    etaSeconds: null,
    stage: "preparing",
    stageMessage: "正在准备安全恢复事务"
  };
  renderRestoreProgress("running");
}

function updateRestoreOperationProgress(event) {
  if (!state.restoreOperation) startRestoreOperation();
  state.restoreOperation.progress = Number(event.progress || 0);
  state.restoreOperation.etaSeconds = Number(event.etaSeconds || 0);
  state.restoreOperation.stage = event.stage || "";
  state.restoreOperation.stageMessage = event.message || "正在执行恢复事务";
  state.restoreOperation.completedUnits = event.completedUnits;
  state.restoreOperation.totalUnits = event.totalUnits;
  state.restoreOperation.completedBytes = event.completedBytes;
  state.restoreOperation.totalBytes = event.totalBytes;
  renderRestoreProgress(event.stage === "completed" ? "complete" : "running");
}

function stopRestoreOperation(status = "complete", error) {
  if (!state.restoreOperation) return;
  state.restoreOperation.finishedAt = Date.now();
  if (status === "complete") {
    state.restoreOperation.progress = 100;
    state.restoreOperation.stageMessage = "恢复完成，逐项校验通过";
  } else if (error) {
    const rolledBack = error.payload?.details?.rollback?.verified;
    state.restoreOperation.stageMessage = rolledBack
      ? "恢复未完成，原文件已自动回退并校验"
      : error.message;
  }
  renderRestoreProgress(status);
}

function setBackupVisual(visualState, result) {
  const visual = $("#backupResultVisual");
  const kicker = $("#backupResultVisualKicker");
  const title = $("#backupResultVisualTitle");
  const body = $("#backupResultVisualBody");
  const progress = $("#backupProgress");
  if (!visual || !kicker || !title || !body) return;
  visual.classList.toggle("ready", visualState === "plan" || visualState === "created");
  visual.classList.toggle("busy", visualState === "busy");
  visual.classList.toggle("error", visualState === "error");
  if (progress) progress.hidden = visualState !== "busy";

  if (visualState === "busy") {
    kicker.textContent = "正在处理";
    title.textContent = state.backupOperation?.kind === "preview" ? "正在生成计划" : "正在创建备份";
    body.textContent = state.backupOperation?.stageMessage || (state.backupOperation?.kind === "preview"
      ? "正在检查备份文件夹并计算包含内容。"
      : "正在整理所选内容并写入恢复点，请保持备份文件夹可用。");
    renderBackupTimeStatus();
    return;
  }
  if (visualState === "error") {
    kicker.textContent = "需要处理";
    title.textContent = "未能完成";
    body.textContent = result?.message || "请检查路径和所选内容后重试。";
    return;
  }
  if (visualState === "plan" || visualState === "created") {
    const selectionMode = Boolean(result?.manifest?.selectionMode);
    kicker.textContent = selectionMode ? "Selected backup" : visualState === "plan" ? "Backup plan" : "Backup complete";
    title.textContent = selectionMode ? "所选内容已备份" : visualState === "plan" ? "计划已就绪" : "备份已创建";
    body.textContent = visualState === "plan"
      ? "确认包含内容和恢复点路径后，即可创建备份。"
      : "恢复点已经写入备份文件夹。";
  }
}

function renderPlanSummary(targetSelector, result, mode) {
  const target = $(targetSelector);
  if (!target) return;
  if (!result) {
    target.innerHTML = `<div class="empty-state">等待执行。</div>`;
    return;
  }

  const manifest = result.manifest || {};
  const plan = manifest.plan || {};
  const restore = result.adaptationPlan || {};
  const selected = plan.selected || [];
  const isRestore = mode === "restore";
  const isSelection = Boolean(manifest.selectionMode);
  const selectedCounts = manifest.selectedCounts || {};
  const title = isRestore ? "恢复计划与校验已完成" : result.dryRun ? "备份计划已生成" : "备份已创建";
  const path = isRestore ? result.snapshotDir : result.snapshotDir;
  const total = isRestore
    ? `${(result.mappings || []).length} 个恢复映射`
    : isSelection
      ? `${selectedCounts.copied || 0} 个所选资产`
      : fmtMb(plan.totalMb || 0);
  const risk = isRestore
    ? result.integrity?.status === "verified"
      ? "SHA-256 校验通过"
      : result.integrity?.status === "failed"
        ? "完整性校验失败"
        : "旧恢复点需确认"
    : isSelection
      ? `${(manifest.copied || []).filter((item) => item.metadataOnly).length} 个需重新配置`
      : `${plan.warnings?.length || 0} 个提醒`;
  const scope = isRestore
    ? `目标：${restore.deployOS || "当前系统"}`
    : isSelection
      ? `对话 ${selectedCounts.conversations || 0} · 能力 ${selectedCounts.capabilities || 0}`
      : `${selected.length} 个分区 · 项目 ${manifest.portableProjects?.projectCount || 0} · 对话 ${manifest.portableProjects?.threadCount || 0} · ${manifest.portableProjects?.projectFilesIncluded ? "含项目文件" : "不含项目文件"}`;

  target.innerHTML = `
    <div class="summary-card">
      <span>${escapeHtml(title)}</span>
      <strong>${escapeHtml(total)}</strong>
      <p>${escapeHtml(shortPath(path || "未返回路径", 120))}</p>
      <div class="summary-pills">
        <em>${escapeHtml(risk)}</em>
        <em>${escapeHtml(scope)}</em>
      </div>
    </div>
  `;
}

const restoreCategoryDefinitions = [
  { key: "sessions", label: "对话记录", tone: "cyan", icon: "messages-square" },
  { key: "archivedSessions", label: "归档对话", tone: "cyan", icon: "archive" },
  { key: "stateDb", label: "任务索引", tone: "cyan", icon: "database" },
  { key: "memories", label: "个人记忆", tone: "violet", icon: "brain" },
  { key: "config", label: "规则与配置", tone: "violet", icon: "file-cog" },
  { key: "agents", label: "全局规则", tone: "violet", icon: "scroll-text" },
  { key: "skills", label: "Skills", tone: "mint", icon: "sparkles" },
  { key: "plugins", label: "插件缓存", tone: "coral", icon: "blocks" },
  { key: "tools", label: "本地工具", tone: "coral", icon: "wrench" },
  { key: "auth", label: "登录凭据", tone: "gray", icon: "key-round" },
  { key: "api", label: "API 接入", tone: "coral", icon: "plug-zap" }
];

const restoreCategoryByKey = new Map(restoreCategoryDefinitions.map((item) => [item.key, item]));

function restoreItemCategory(item) {
  const inferredKey = item?.key
    || (item?.kind === "conversation" ? "sessions"
      : item?.kind === "capability" ? "skills"
        : item?.kind === "api_tool" ? "api" : "config");
  return restoreCategoryByKey.get(inferredKey) || {
    key: inferredKey,
    label: sectionLabels[inferredKey] || item?.label || "其他内容",
    tone: item?.risk === "high" ? "coral" : "gray",
    icon: item?.risk === "high" ? "shield-alert" : "folder"
  };
}

function restoreItemGroup(item) {
  return restoreItemCategory(item).key;
}

function groupRestoreItems(items) {
  const groups = new Map();
  (items || []).forEach((item) => {
    const meta = restoreItemCategory(item);
    if (!groups.has(meta.key)) groups.set(meta.key, { meta, items: [] });
    groups.get(meta.key).items.push(item);
  });
  return [
    ...restoreCategoryDefinitions.filter((meta) => groups.has(meta.key)).map((meta) => groups.get(meta.key)),
    ...[...groups.values()].filter(({ meta }) => !restoreCategoryByKey.has(meta.key))
  ];
}

function restoreItemDetail(item) {
  const details = {
    config: "Codex 配置文件；跨系统恢复时会转入待合并目录。",
    agents: "全局 AGENTS.md 规则。",
    sessions: "当前对话历史与会话文件。",
    archivedSessions: "已经归档的历史对话。",
    stateDb: "高级选项：完整替换任务索引数据库；选择项目或对话时无需勾选，系统会自动仅合并所选线程。",
    memories: "偏好、长期上下文和项目记忆。",
    skills: "本地 Skills 与可迁移能力。",
    plugins: "插件缓存；恢复后需要重新授权。",
    tools: "本地工具；跨系统恢复后需要复核。",
    auth: "登录凭据永久排除，恢复后重新登录。",
    api: "仅显示重新配置信息，不恢复 API Key。"
  };
  if (item.blockedReason === "not_in_restore_point") return "此恢复点中没有该内容。";
  if (item.blockedReason === "credentials_permanently_excluded") return "安全规则：登录凭据不可从备份恢复。";
  if (item.blockedReason === "credentials_must_be_reconfigured") return "仅保留配置说明，密钥需要重新填写。";
  if (item.detail) return item.detail;
  return details[item.key] || (item.kind === "conversation"
    ? "独立恢复这条对话，不覆盖其他会话。"
    : item.kind === "capability"
      ? "独立恢复这项 Skill 或能力。"
      : "按恢复点清单写入目标目录。");
}

function restoreRiskLabel(item) {
  if (!item.restorable) return "不可恢复";
  if (item.risk === "high") return "需确认";
  if (item.priority === "P0") return "核心数据";
  return "可恢复";
}

function resetRestoreSelection() {
  state.restoreAvailableItems = [];
  state.restoreSelectedItemIds = new Set();
  state.restoreSelectionInitialized = false;
  state.restoreSelectionQuery = "";
  state.restoreOpenProjectIds = new Set();
  state.restoreExpandedGroups = new Set();
  state.restoreOverviewExpandedGroups = new Set();
  state.restoreOperation = null;
  const mappingPanel = $("#projectMappingPanel");
  if (mappingPanel) mappingPanel.hidden = true;
  const mappingList = $("#projectMappingList");
  if (mappingList) mappingList.innerHTML = "";
  const search = $("#restoreSelectionSearch");
  if (search) search.value = "";
  renderRestoreSelection();
  renderRestorePlanOverview(null);
  renderRestoreProgress();
  setRestoreActionState(null);
}

function currentRestoreSelectionPayload() {
  if (!state.restoreSelectionInitialized) return null;
  return {
    mode: "custom",
    itemIds: [...state.restoreSelectedItemIds]
  };
}

function restoreProjectKey(item) {
  return item?.projectId || `unlinked:${item?.projectPath || item?.projectName || "unknown"}`;
}

function restoreProjectSelectionItems(projectKey) {
  return state.restoreAvailableItems.filter((item) =>
    item.restorable && item.kind === "conversation" && restoreProjectKey(item) === projectKey
  );
}

function restoreSelectionDraftResult() {
  const availableItems = state.restoreAvailableItems.map((item) => ({
    ...item,
    selected: state.restoreSelectedItemIds.has(item.id)
  }));
  const selectedItems = availableItems.filter((item) => item.selected);
  return {
    availableItems,
    mappings: [],
    warnings: selectedItems.length
      ? ["选择已更新，请重新生成计划以校验写入范围。"]
      : ["请至少选择一个可恢复项目或恢复项。"],
    overlap: {},
    countTrace: {
      userSelectedCount: selectedItems.length,
      logicalRestoreItemCount: selectedItems.length,
      fileMappingCount: 0,
      metadataOnlyCount: 0,
      skippedCount: 0
    },
    integrity: state.restorePlan?.integrity || null,
    adaptationPlan: state.restorePlan?.adaptationPlan || {
      sourceOS: "当前系统",
      deployOS: selectedRestoreTargetOS ? selectedRestoreTargetOS() : "当前系统",
      crossOS: false,
      tasks: []
    },
    canExecute: false
  };
}

function invalidateRestorePlanForSelectionChange() {
  setRestoreActionState(null);
  if (state.restoreSelectionInitialized && state.restoreAvailableItems.length) {
    renderRestorePlanOverview(restoreSelectionDraftResult());
  } else {
    renderRestorePlanOverview(null);
  }
}

function restoreItemCard(item) {
  const selected = state.restoreSelectedItemIds.has(item.id);
  const riskClass = !item.restorable ? "is-blocked" : item.risk === "high" ? "is-risk" : "";
  return [
    '<label class="restore-item ' + riskClass + " " + (selected ? "is-selected" : "") + '" title="' + escapeHtml(restoreItemDetail(item)) + '">',
    '<input type="checkbox" data-restore-item="' + escapeHtml(item.id) + '" ' + (selected ? "checked" : "") + " " + (item.restorable ? "" : "disabled") + " />",
    '<span class="restore-item-check" aria-hidden="true"><i data-lucide="' + (selected ? "check" : item.restorable ? "plus" : "lock-keyhole") + '"></i></span>',
    '<span class="restore-item-copy"><strong>' + escapeHtml(item.label) + "</strong><small>" + escapeHtml(restoreItemDetail(item)) + "</small></span>",
    "<em>" + escapeHtml(restoreRiskLabel(item)) + "</em>",
    "</label>"
  ].join("");
}

function restoreConversationProjects(items) {
  const projects = new Map();
  (items || []).forEach((item) => {
    const projectKey = restoreProjectKey(item);
    if (!projects.has(projectKey)) projects.set(projectKey, {
      projectId: projectKey,
      projectName: item.projectName || "未关联项目",
      projectPath: item.projectPath || "未记录项目路径",
      items: []
    });
    projects.get(projectKey).items.push(item);
  });
  return [...projects.values()].sort((a, b) => a.projectName.localeCompare(b.projectName, "zh-CN"));
}

function renderConversationProjectTree(items, { collapsible = false } = {}) {
  return restoreConversationProjects(items).map((project) => {
    const restorable = project.items.filter((item) => item.restorable);
    const selected = restorable.filter((item) => state.restoreSelectedItemIds.has(item.id)).length;
    const allSelected = restorable.length > 0 && selected === restorable.length;
    const partial = selected > 0 && !allSelected;
    const open = !collapsible || state.restoreOpenProjectIds.has(project.projectId);
    const conversationHtml = project.items.map(restoreItemCard).join("");
    return [
      '<section class="restore-project-node ' + (selected ? "has-selection" : "") + '" data-restore-project-node="' + escapeHtml(project.projectId) + '">',
      '<div class="restore-project-header" data-restore-project-expand-row="' + escapeHtml(project.projectId) + '" role="button" tabindex="0" aria-expanded="' + String(open) + '">',
      '<label class="restore-project-toggle">',
      '<input class="restore-project-checkbox" type="checkbox" data-restore-project="' + escapeHtml(project.projectId) + '" ' + (allSelected ? "checked" : "") + ' data-indeterminate="' + (partial ? "true" : "false") + '" />',
      '<span><i data-lucide="folder-kanban" aria-hidden="true"></i></span>',
      '<strong>' + escapeHtml(project.projectName) + '</strong>',
      '<em>' + selected + " / " + restorable.length + " 条</em>",
      "</label>",
      collapsible ? '<button class="restore-project-expand semantic-action action-adjust" type="button" data-restore-project-expand="' + escapeHtml(project.projectId) + '" aria-expanded="' + String(open) + '"><span>' + (open ? "收起明细" : "查看明细") + '</span><i data-lucide="chevron-down" aria-hidden="true"></i></button>' : "",
      '<small title="' + escapeHtml(project.projectPath) + '">' + escapeHtml(shortPath(project.projectPath, 86)) + "</small>",
      "</div>",
      '<div class="restore-project-conversations" ' + (open ? "" : "hidden") + ">" + conversationHtml + "</div>",
      "</section>"
    ].join("");
  }).join("");
}

function renderRestoreProjectSelection(items) {
  const conversationItems = (items || []).filter((item) => item.kind === "conversation");
  if (!conversationItems.length) return "";
  const projects = restoreConversationProjects(conversationItems);
  const totalRestorable = projects.reduce((sum, project) => sum + project.items.filter((item) => item.restorable).length, 0);
  const selectedTotal = conversationItems.filter((item) => item.restorable && state.restoreSelectedItemIds.has(item.id)).length;
  return '<details class="restore-selection-group restore-project-priority tone-cyan" data-restore-group-key="projects" open>' +
    '<summary id="restore-selection-summary-projects" class="restore-selection-group-title" aria-expanded="true" aria-controls="restore-selection-body-projects">' +
    '<span class="restore-category-icon"><i data-lucide="folder-kanban"></i></span>' +
    '<span class="restore-category-copy"><strong>项目记录</strong><small>优先按项目恢复，自动带出项目下的对话与索引</small></span>' +
    '<span class="restore-category-count">' + selectedTotal + " / " + totalRestorable + ' 条</span><i class="restore-category-chevron" data-lucide="chevron-down"></i>' +
    '</summary><div id="restore-selection-body-projects" class="restore-selection-group-body" role="region" aria-labelledby="restore-selection-summary-projects">' +
    '<div class="restore-item-grid restore-project-grid">' + renderConversationProjectTree(conversationItems, { collapsible: true }) + "</div></div></details>";
}

function toggleRestoreProjectDetails(projectKey) {
  if (!projectKey) return;
  if (state.restoreOpenProjectIds.has(projectKey)) state.restoreOpenProjectIds.delete(projectKey);
  else state.restoreOpenProjectIds.add(projectKey);
  renderRestoreSelection();
}

function openRollbackManager() {
  switchView("manager");
  requestAnimationFrame(() => {
    const panel = document.querySelector(".manager-rollback-panel");
    if (!panel) return;
    panel.setAttribute("tabindex", "-1");
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    panel.focus({ preventScroll: true });
  });
}

function renderRestoreSelection(items = state.restoreAvailableItems) {
  state.restoreAvailableItems = Array.isArray(items) ? items : [];
  const panel = $("#restoreSelectionPanel");
  const groupsTarget = $("#restoreSelectionGroups");
  const empty = $("#restoreSelectionEmpty");
  const meta = $("#restoreSelectionMeta");
  const searchWrap = $("#restoreSelectionSearchWrap");
  const allButton = $("#restoreSelectAllButton");
  const clearButton = $("#restoreClearButton");
  if (!panel || !groupsTarget || !empty || !meta || !searchWrap || !allButton || !clearButton) return;

  const hasItems = state.restoreAvailableItems.length > 0;
  const restorable = state.restoreAvailableItems.filter((item) => item.restorable);
  const selectedCount = restorable.filter((item) => state.restoreSelectedItemIds.has(item.id)).length;
  const selectedHighRisk = restorable.filter((item) => item.risk === "high" && state.restoreSelectedItemIds.has(item.id)).length;
  panel.classList.toggle("is-ready", hasItems);
  empty.hidden = hasItems;
  groupsTarget.hidden = !hasItems;
  searchWrap.hidden = state.restoreAvailableItems.length < 8;
  allButton.disabled = !hasItems || selectedCount === restorable.length;
  clearButton.disabled = !hasItems || selectedCount === 0;
  meta.textContent = hasItems
    ? "已选 " + selectedCount + " / " + restorable.length + " 项" +
      (selectedHighRisk ? " · " + selectedHighRisk + " 项高风险需二次确认" : "") +
      "；未勾选的内容不会写入目标目录。"
    : "选择恢复点后，点击“读取恢复内容”查看可恢复项目。";

  if (!hasItems) {
    groupsTarget.innerHTML = "";
    return;
  }

  const query = state.restoreSelectionQuery.trim().toLowerCase();
  const visible = state.restoreAvailableItems.filter((item) => {
    const searchText = ([item.label, item.key, item.projectName, item.projectPath, item.threadId, restoreItemDetail(item)].filter(Boolean).join(" ")).toLowerCase();
    return !query || searchText.includes(query);
  });
  const grouped = groupRestoreItems(visible);
  const projectHtml = renderRestoreProjectSelection(visible);
  const groupHtml = grouped.map(({ meta: group, items: groupItems }) => {
    const groupRestorable = groupItems.filter((item) => item.restorable);
    const groupSelected = groupRestorable.filter((item) => state.restoreSelectedItemIds.has(item.id)).length;
    const open = Boolean(query) || state.restoreExpandedGroups.has(group.key);
    const countText = groupRestorable.length
      ? groupSelected + " / " + groupRestorable.length + " 项"
      : groupItems.length + " 项 · 不可恢复";
    const itemHtml = groupItems.map(restoreItemCard).join("");
    const summaryId = "restore-selection-summary-" + group.key;
    const bodyId = "restore-selection-body-" + group.key;
    return '<details class="restore-selection-group tone-' + escapeHtml(group.tone) + '" data-restore-group-key="' +
      escapeHtml(group.key) + '" ' + (open ? "open" : "") + '><summary id="' + escapeHtml(summaryId) +
      '" class="restore-selection-group-title" aria-expanded="' + String(open) + '" aria-controls="' + escapeHtml(bodyId) + '">' +
      '<span class="restore-category-icon"><i data-lucide="' + escapeHtml(group.icon) + '"></i></span>' +
      '<span class="restore-category-copy"><strong>' + escapeHtml(group.label) + '</strong><small>与创建备份分类一致 · 展开后可逐项选择</small></span>' +
      '<span class="restore-category-count">' + escapeHtml(countText) + '</span><i class="restore-category-chevron" data-lucide="chevron-down"></i>' +
      '</summary><div id="' + escapeHtml(bodyId) + '" class="restore-selection-group-body" role="region" aria-labelledby="' +
      escapeHtml(summaryId) + '"><div class="restore-group-actions"><button class="mini-button semantic-action action-adjust" type="button" data-restore-group-action="all" data-restore-group="' +
      escapeHtml(group.key) + '" ' + (!groupRestorable.length || groupSelected === groupRestorable.length ? "disabled" : "") + '>本组全选</button><button class="mini-button semantic-action action-reset" type="button" data-restore-group-action="clear" data-restore-group="' +
      escapeHtml(group.key) + '" ' + (!groupSelected ? "disabled" : "") + '>清空本组</button></div><div class="restore-item-grid">' + itemHtml + "</div></div></details>";
  }).join("");
  groupsTarget.innerHTML = (projectHtml + groupHtml) ||
    '<div class="restore-selection-empty inline"><span>没有符合“' + escapeHtml(state.restoreSelectionQuery) + "”的恢复项。</span></div>";
  groupsTarget.querySelectorAll(".restore-project-checkbox[data-indeterminate=\"true\"]").forEach((input) => {
    input.indeterminate = true;
  });
  renderIcons();
}

function applyRestoreSelectionResult(result) {
  if (!state.restoreSelectionInitialized) {
    state.restoreOpenProjectIds = new Set();
    state.restoreExpandedGroups = new Set();
    state.restoreOverviewExpandedGroups = new Set();
  }
  state.restoreAvailableItems = Array.isArray(result?.availableItems) ? result.availableItems : [];
  state.restoreSelectedItemIds = new Set(result?.restoreSelection?.selectedItemIds || []);
  state.restoreSelectionInitialized = true;
  renderRestoreSelection();
}

function confirmHighRiskRestoreSelection(items) {
  const highRiskItems = (items || []).filter((item) => item?.restorable && item.risk === "high");
  if (!highRiskItems.length) return true;
  return window.confirm(
    "将选择以下高风险恢复内容：\n\n" +
    highRiskItems.map((item) => "• " + item.label).join("\n") +
    "\n\n这些内容恢复后可能需要重新授权、重装或检查本机路径。确认选择吗？"
  );
}

function renderRestorePlanOverview(result, mode = "plan") {
  const target = $("#restorePlanOverview");
  if (!target) return;
  if (!result) {
    target.innerHTML = '<div class="restore-overview-empty"><i data-lucide="list-tree" aria-hidden="true"></i><span>读取恢复点后，这里会显示恢复范围、目标系统和风险提醒。</span></div>';
    renderIcons();
    return;
  }

  if (mode === "complete") {
    const rollbackPath = result.rollbackPoint?.path || "已保留自动回滚点";
    target.innerHTML = [
      '<div class="restore-overview-status is-success"><i data-lucide="badge-check" aria-hidden="true"></i><div><strong>恢复与写入校验均已完成</strong><p>',
      escapeHtml(String(result.restoredMappings || 0)),
      " 个恢复映射已经写入目标目录。</p></div></div>",
      '<div class="restore-overview-metrics">',
      '<span><small>写入结果</small><b>SHA-256 通过</b></span>',
      '<span><small>自动回滚点</small><b>已保留</b></span>',
      '<span><small>完成时间</small><b>' + escapeHtml(fmtDate(result.completedAt || new Date().toISOString())) + "</b></span>",
      "</div>",
      '<div class="restore-overview-path"><i data-lucide="shield-check" aria-hidden="true"></i><span><small>回滚点位置</small><b>' + escapeHtml(shortPath(rollbackPath, 88)) + "</b></span></div>"
    ].join("");
    renderIcons();
    return;
  }

  if (mode === "recovery") {
    const recoveredCount = (result?.results || []).filter((item) => item.status === "recovered_rolled_back").length;
    target.innerHTML = [
      '<div class="restore-overview-status is-success"><i data-lucide="shield-check" aria-hidden="true"></i><div><strong>上次中断已安全回退</strong><p>',
      escapeHtml(String(recoveredCount)),
      " 个中断任务已经恢复到执行前状态，可重新生成恢复计划。</p></div></div>",
      '<div class="restore-overview-metrics"><span><small>回退任务</small><b>' + recoveredCount +
      ' 个</b></span><span><small>原文件状态</small><b>校验通过</b></span></div>'
    ].join("");
    renderIcons();
    return;
  }

  if (mode === "error") {
    const detail = result?.payload?.details || result?.details || {};
    const rolledBack = detail.rollback?.verified || detail.results?.some?.((item) => item.status === "recovered_rolled_back");
    target.innerHTML = [
      '<div class="restore-overview-status is-error"><i data-lucide="' + (rolledBack ? "shield-check" : "triangle-alert") + '" aria-hidden="true"></i><div><strong>',
      rolledBack ? "恢复失败，原文件已回退" : "恢复计划未完成",
      "</strong><p>",
      escapeHtml(rolledBack ? "自动回滚校验通过，目标目录已恢复到执行前状态。" : "请检查恢复点、目标路径或技术详情后重试。"),
      "</p></div></div>"
    ].join("");
    renderIcons();
    return;
  }

  const selectedItems = (result.availableItems || []).filter((item) => item.selected);
  const mappings = result.mappings || [];
  const adaptation = result.adaptationPlan || {};
  const warnings = result.warnings || [];
  const overlap = result.overlap || {};
  const countTrace = result.countTrace || {};
  const duplicateOnly = Number(overlap.backupThreadCount || 0) > 0
    && Number(overlap.newCount || 0) === 0
    && Number(overlap.conflictCount || 0) === 0;
  const highRiskCount = selectedItems.filter((item) => item.risk === "high").length;
  const integrityText = result.integrity?.status === "verified"
    ? "SHA-256 通过"
    : result.integrity?.status === "failed"
      ? "校验失败"
      : "执行前需确认";
  const selectedGroupHtml = groupRestoreItems(selectedItems).map(({ meta: group, items: groupItems }) => {
    const open = state.restoreOverviewExpandedGroups.has(group.key);
    const itemHtml = groupItems.map((item) =>
      '<li class="' + (item.risk === "high" ? "is-risk" : "") + '"><i data-lucide="' +
      (item.risk === "high" ? "shield-alert" : "check") + '" aria-hidden="true"></i><span><b>' +
      escapeHtml(item.label) + "</b><small>" + escapeHtml(restoreItemDetail(item)) + "</small></span></li>"
    ).join("");
    const summaryId = "restore-overview-summary-" + group.key;
    const bodyId = "restore-overview-body-" + group.key;
    return '<details class="restore-overview-group tone-' + escapeHtml(group.tone) + '" data-restore-overview-group="' +
      escapeHtml(group.key) + '" ' + (open ? "open" : "") + '><summary id="' + escapeHtml(summaryId) +
      '" aria-expanded="' + String(open) + '" aria-controls="' + escapeHtml(bodyId) + '"><span class="restore-category-icon"><i data-lucide="' +
      escapeHtml(group.icon) + '"></i></span><strong>' + escapeHtml(group.label) + '</strong><em>' +
      groupItems.length + ' 项</em><i class="restore-category-chevron" data-lucide="chevron-down"></i></summary>' +
      '<div id="' + escapeHtml(bodyId) + '" class="restore-overview-group-body" role="region" aria-labelledby="' +
      escapeHtml(summaryId) + '"><ul class="restore-overview-list">' + itemHtml + "</ul></div></details>";
  }).join("");
  const warningHtml = warnings.slice(0, 3).map((warning) =>
    '<li><i data-lucide="info" aria-hidden="true"></i><span>' + escapeHtml(warning) + "</span></li>"
  ).join("");
  const adaptationTasks = adaptation.tasks || [];
  const adaptationTaskHtml = adaptationTasks.slice(0, 5).map((task) =>
    '<li class="' + (task.risk === "high" ? "is-risk" : task.risk === "medium" ? "is-medium" : "") +
    '"><i data-lucide="' + (task.risk === "high" ? "shield-alert" : task.risk === "medium" ? "git-merge" : "check") +
    '" aria-hidden="true"></i><span><b>' + escapeHtml(task.item) + "</b><small>" + escapeHtml(task.note) + "</small></span></li>"
  ).join("");
  target.innerHTML = [
    '<div class="restore-overview-status ' + (result.canExecute || duplicateOnly ? "is-ready" : "is-error") + '"><i data-lucide="' +
      (result.canExecute ? "route" : duplicateOnly ? "badge-check" : "shield-x") + '" aria-hidden="true"></i><div><strong>' +
      (result.canExecute ? "恢复计划可以执行" : duplicateOnly ? "无需再次写入" : "当前计划不能执行") + "</strong><p>" +
      escapeHtml(result.canExecute
        ? "仅恢复下列已选内容，未选择项目不会写入目标目录。"
        : duplicateOnly
          ? "所选线程已全部存在且内容一致，本次计划为零新增、零文件写入。"
          : "请检查完整性结果、冲突或至少选择一个可恢复项目。") +
      "</p></div></div>",
    '<div class="restore-overview-metrics">',
      '<span><small>用户选择项</small><b>' + Number(countTrace.userSelectedCount ?? selectedItems.length) + " 项</b></span>",
      '<span><small>文件映射</small><b>' + Number(countTrace.fileMappingCount ?? mappings.length) + " 个</b></span>",
      '<span><small>跳过/合并</small><b>' + Number(countTrace.skippedCount || 0) + " 项</b></span>",
      '<span><small>完整性</small><b>' + escapeHtml(integrityText) + "</b></span>",
      '<span><small>目标系统</small><b>' + escapeHtml(adaptation.deployOS || result.deployOS || "当前系统") + "</b></span>",
    "</div>",
    Number(overlap.backupThreadCount || 0) || Number(overlap.targetThreadCount || 0)
      ? '<div class="restore-overview-metrics restore-overlap-metrics">' +
        '<span><small>备份线程</small><b>' + Number(overlap.backupThreadCount || 0) + " 条</b></span>" +
        '<span><small>目标端已有</small><b>' + Number(overlap.targetExistingCount || 0) + " 条</b></span>" +
        '<span><small>新增</small><b>' + Number(overlap.newCount || 0) + " 条</b></span>" +
        '<span><small>重复</small><b>' + Number(overlap.duplicateCount || 0) + " 条</b></span>" +
        '<span><small>冲突</small><b>' + Number(overlap.conflictCount || 0) + " 条</b></span>" +
        '<span><small>目标端独有并保留</small><b>' + Number(overlap.targetOnlyCount || 0) + " 条</b></span>" +
        "</div>"
      : "",
    '<div class="restore-overview-system ' + (adaptation.crossOS ? "is-cross" : "") + '"><i data-lucide="' +
      (adaptation.crossOS ? "shuffle" : "monitor-check") + '" aria-hidden="true"></i><span><small>' +
      (adaptation.crossOS ? "跨系统适配" : "系统适配") + "</small><b>" +
      escapeHtml((adaptation.sourceOS || "当前系统") + " → " + (adaptation.deployOS || result.deployOS || "当前系统")) +
      "</b></span><em>" + (adaptation.crossOS ? "需复核路径与工具" : "同系统恢复") + "</em></div>",
    '<section class="restore-overview-section"><div class="restore-overview-section-title"><strong>将恢复的内容</strong><span>' +
      selectedItems.length + " 项" + (highRiskCount ? " · " + highRiskCount + " 项需确认" : "") +
      '</span></div><div class="restore-overview-groups">' +
      (selectedGroupHtml || '<div class="restore-overview-empty compact"><span>当前没有选中的恢复内容。</span></div>') +
      "</div></section>",
    adaptationTaskHtml ? '<section class="restore-overview-section is-adaptation"><div class="restore-overview-section-title"><strong>' +
      (adaptation.crossOS ? "跨系统处理" : "恢复处理方式") + "</strong><span>" +
      adaptationTasks.length + " 项任务 · " + (adaptation.pathMappings?.length || 0) +
      ' 条路径映射</span></div><ul class="restore-overview-list">' + adaptationTaskHtml + "</ul></section>" : "",
    warningHtml ? '<section class="restore-overview-section is-warning"><div class="restore-overview-section-title"><strong>执行前提醒</strong><span>' +
      warnings.length + ' 条</span></div><ul class="restore-warning-list">' + warningHtml + "</ul></section>" : ""
  ].join("");
  renderIcons();
}

function setRestoreActionState(result) {
  state.restorePlan = result || null;
  const planButton = $("#restorePlanButton");
  const executeButton = $("#restoreExecuteButton");
  if (!planButton || !executeButton) return;

  const ready = Boolean(result);
  planButton.classList.toggle("primary", !ready);
  planButton.classList.toggle("secondary", ready);
  const planLabel = planButton.querySelector(":scope > span:last-child");
  if (planLabel) {
    planLabel.textContent = ready
      ? "重新校验当前选择"
      : state.restoreSelectionInitialized
        ? "按选择生成计划"
        : "读取恢复内容";
    planButton.dataset.idleLabel = planLabel.textContent;
  }

  executeButton.hidden = !ready;
  executeButton.disabled = ready && !result.canExecute;
  const executeLabel = executeButton.querySelector(":scope > span:last-child");
  if (executeLabel) {
    executeLabel.textContent = result?.canExecute
      ? "开始恢复"
      : result?.requiresProjectMapping ? "先确认项目映射" : "完整性校验未通过";
    executeButton.dataset.idleLabel = executeLabel.textContent;
  }
}

function renderProjectMappings(result) {
  const panel = $("#projectMappingPanel");
  const list = $("#projectMappingList");
  if (!panel || !list) return;
  const mappings = Array.isArray(result?.projectPathMappings) ? result.projectPathMappings : [];
  const visible = Boolean(result?.adaptationPlan?.crossOS && mappings.length);
  panel.hidden = !visible;
  if (!visible) {
    list.innerHTML = "";
    return;
  }
  const stats = result?.projectMappingStats || {
    total: mappings.length,
    processed: mappings.filter((item) => item.mode !== "pending").length,
    pending: mappings.filter((item) => item.mode === "pending").length,
    unresolved: mappings.filter((item) => item.mode === "unresolved").length,
    conflicts: 0
  };
  const statsHtml = '<div class="restore-overview-metrics project-mapping-stats"><span><small>项目总数</small><b>' + stats.total + '</b></span><span><small>已处理</small><b>' + stats.processed + '</b></span><span><small>未处理</small><b>' + stats.pending + '</b></span><span><small>未关联</small><b>' + stats.unresolved + '</b></span><span><small>冲突</small><b>' + stats.conflicts + '</b></span></div>';
  list.innerHTML = statsHtml + mappings.map((item) => {
    const mode = item.mode === "pending" ? "unresolved" : item.mode;
    return `
      <div class="project-mapping-row" data-project-id="${escapeHtml(item.projectId)}" data-source-root="${escapeHtml(item.sourceRoot || "")}">
        <div class="project-mapping-source">
          <strong>${escapeHtml(item.displayName || "未命名项目")}</strong>
          <small>${escapeHtml(item.sourceRoot || "")}</small>
          <em>${escapeHtml(String(item.threadCount || 0))} 个对话 · ${item.projectFilesIncluded ? "包含项目源文件" : "不包含项目源文件"}</em>
        </div>
        <select class="project-mapping-mode" aria-label="${escapeHtml(item.displayName || "项目")} 映射方式">
          <option value="existing" ${mode === "existing" ? "selected" : ""}>选择现有目录</option>
          <option value="placeholder" ${mode === "placeholder" ? "selected" : ""}>创建占位目录</option>
          <option value="unresolved" ${mode === "unresolved" ? "selected" : ""}>暂不映射</option>
        </select>
        <input class="project-mapping-target" value="${escapeHtml(item.targetRoot || "")}" placeholder="目标项目目录；占位/未关联可留空" />
      </div>
    `;
  }).join("");
}

function currentProjectMappingsPayload() {
  const panel = $("#projectMappingPanel");
  if (!panel || panel.hidden) return null;
  return [...document.querySelectorAll(".project-mapping-row")].map((row) => ({
    projectId: row.dataset.projectId,
    sourceRoot: row.dataset.sourceRoot,
    mode: row.querySelector(".project-mapping-mode")?.value || "unresolved",
    targetRoot: row.querySelector(".project-mapping-target")?.value.trim() || ""
  }));
}

function buildDiagnosticReport(data, phase) {
  const value = data || {};
  const overlap = value.overlap || {};
  const counts = value.countTrace || {};
  return {
    reportSchemaVersion: 1,
    generatedAt: new Date().toISOString(),
    phase,
    appVersion: value.appVersion || "1.0.0",
    sourceSystem: value.adaptationPlan?.sourceOS || value.sourceSystem || null,
    targetSystem: value.adaptationPlan?.deployOS || value.deployOS || null,
    sourceRestorePoint: value.snapshotDir || value.sourceSnapshotId || null,
    targetCodexHome: value.targetCodexHome || null,
    restoreMode: value.restoreMode || null,
    projects: value.portableProjects?.projectCount ?? value.projectMappings?.length ?? null,
    conversations: overlap.backupThreadCount ?? value.sqliteMerge?.selectedThreadCount ?? null,
    counts: {
      selected: counts.userSelectedCount ?? null,
      fileMappings: counts.fileMappingCount ?? value.restoredMappings ?? null,
      new: overlap.newCount ?? value.sqliteMerge?.insertedThreadCount ?? null,
      duplicate: overlap.duplicateCount ?? value.sqliteMerge?.preservedThreadCount ?? null,
      overwrite: value.sqliteMerge?.updatedThreadCount ?? 0,
      skipped: counts.skippedCount ?? null,
      conflicts: overlap.conflictCount ?? value.conflictCount ?? 0,
      targetOnlyPreserved: overlap.targetOnlyCount ?? null
    },
    sqlite: value.sqliteValidation || value.sqliteMerge || null,
    walShm: value.sqlitePreflight || null,
    pathMappings: value.projectPathMappings || value.projectMappings || [],
    writtenFiles: value.restoredMappings ?? counts.fileMappingCount ?? null,
    rollbackPoint: value.rollbackPoint || null,
    warnings: value.warnings || [],
    errors: value.conflicts || value.issues || value.error || null
  };
}

function diagnosticMarkdown(report) {
  const lines = [
    `# Codex Link ${report.appVersion} 诊断报告`,
    "",
    `- 阶段：${report.phase}`,
    `- 生成时间：${report.generatedAt}`,
    `- 源系统：${report.sourceSystem || "未知"}`,
    `- 目标系统：${report.targetSystem || "未知"}`,
    `- 源恢复点：${report.sourceRestorePoint || "未知"}`,
    `- 目标 Codex 目录：${report.targetCodexHome || "未知"}`,
    `- 恢复模式：${report.restoreMode || "未知"}`,
    "",
    "## 数量",
    "",
    ...Object.entries(report.counts).map(([key, value]) => `- ${key}: ${value ?? "未知"}`),
    "",
    "## SQLite 与 WAL/SHM",
    "",
    "~~~json",
    JSON.stringify({ sqlite: report.sqlite, walShm: report.walShm }, null, 2),
    "~~~",
    "",
    "## 路径映射",
    "",
    "~~~json",
    JSON.stringify(report.pathMappings, null, 2),
    "~~~",
    "",
    "## 回滚点、警告与错误",
    "",
    "~~~json",
    JSON.stringify({ rollbackPoint: report.rollbackPoint, warnings: report.warnings, errors: report.errors }, null, 2),
    "~~~",
    ""
  ];
  return lines.join("\n");
}

function downloadDiagnostic(format, artifact = state.diagnosticArtifact) {
  if (!artifact) return;
  const report = buildDiagnosticReport(artifact.data, artifact.phase);
  const markdown = format === "md";
  const content = markdown ? diagnosticMarkdown(report) : JSON.stringify(report, null, 2) + "\n";
  const blob = new Blob([content], { type: markdown ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `codex-link-${artifact.phase}-report-${Date.now()}.${markdown ? "md" : "json"}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function setDiagnosticArtifact(phase, data) {
  state.diagnosticArtifact = data ? { phase, data } : null;
  const actions = $("#diagnosticExportActions");
  if (actions) actions.hidden = !data;
}

function renderRestoreSummary(result) {
  if (result) {
    applyRestoreSelectionResult(result);
    setDiagnosticArtifact("plan", result);
  }
  renderProjectMappings(result);
  renderPlanSummary("#restoreSummary", result, "restore");
  renderRestorePlanOverview(result);
  const panel = $(".restore-summary-panel");
  panel?.classList.toggle("is-empty", !result);
  panel?.classList.remove("has-error");
  setRestoreActionState(result);
}

function renderRestoreExecutionResult(result) {
  setDiagnosticArtifact("restore-complete", result);
  const target = $("#restoreSummary");
  if (target) {
    target.innerHTML = `
      <div class="summary-card restore-complete-card">
        <span>恢复完成</span>
        <strong>${escapeHtml(result.restoredMappings || 0)} 个恢复映射</strong>
        <p>恢复后 SHA-256 校验已通过，自动回滚点已保留。</p>
        <div class="summary-pills">
          <em>校验通过</em>
          <em>可从回滚点撤回</em>
        </div>
      </div>
    `;
  }
  $(".restore-summary-panel")?.classList.remove("is-empty", "has-error");
  renderRestorePlanOverview(result, "complete");
  $("#restoreResult").textContent = JSON.stringify(result, null, 2);
  setRestoreActionState(null);
  renderIcons();
}

function renderRestoreExecutionError(error) {
  setDiagnosticArtifact("restore-error", error?.payload || { error: error.message });
  const details = error?.payload?.details || {};
  const interruptedRollback = details.results?.some((item) => item.status === "recovered_rolled_back");
  const rolledBack = details.rollback?.verified || interruptedRollback;
  const target = $("#restoreSummary");
  if (target) {
    target.innerHTML = `
      <div class="friendly-error-state">
        <span class="friendly-error-icon"><i data-lucide="${rolledBack ? "shield-check" : "circle-alert"}"></i></span>
        <div>
          <strong>${rolledBack ? "恢复失败，已自动回退" : "恢复未完成"}</strong>
          <p>${rolledBack ? "原文件已从自动回滚点恢复并通过校验。" : "目标数据可能需要人工检查，请保留回滚点并查看详情。"}</p>
        </div>
      </div>
    `;
  }
  $(".restore-summary-panel")?.classList.remove("is-empty");
  $(".restore-summary-panel")?.classList.add("has-error");
  renderRestorePlanOverview(error, "error");
  $("#restoreResult").textContent = JSON.stringify(error?.payload || { error: error.message }, null, 2);
  setRestoreActionState(null);
  renderIcons();
}

function renderRestoreError(error) {
  const message = String(error?.message || error || "");
  const notFound = /not found|404/i.test(message);
  const target = $("#restoreSummary");
  if (target) {
    target.innerHTML = `
      <div class="friendly-error-state">
        <span class="friendly-error-icon"><i data-lucide="${notFound ? "folder-search" : "circle-alert"}"></i></span>
        <div>
          <strong>${notFound ? "没有找到可读取的恢复点" : "恢复点暂时无法读取"}</strong>
          <p>${notFound ? "请从备份管理重新选择恢复点，或检查文件夹路径。" : "请检查恢复点文件夹后重试，原始数据不会被修改。"}</p>
        </div>
      </div>
    `;
  }
  const detail = $("#restoreResult");
  if (detail) detail.textContent = "恢复计划尚未生成。请确认恢复点文件夹可访问后重新读取。";
  renderRestorePlanOverview(error, "error");
  $(".restore-summary-panel")?.classList.add("is-empty", "has-error");
  setRestoreActionState(null);
  renderIcons();
}

function renderJson(targetSelector, result) {
  const target = $(targetSelector);
  if (target) target.textContent = JSON.stringify(result, null, 2);
}

function toggleBackupResult() {
  const panel = $("#backupResultPanel");
  if (!panel) return;
  panel.classList.toggle("collapsed");
  $("#toggleBackupResultButton").textContent = panel.classList.contains("collapsed") ? "展开" : "收起";
}

async function loadRestoreRecoveryStatus() {
  const status = await api("/api/restore-recovery-status");
  state.restoreRecovery = status;
  const results = status?.results || [];
  if (!results.length) return;

  const failed = results.some((item) => item.status === "recovery_failed");
  const target = $("#restoreSummary");
  if (target) {
    target.innerHTML = `
      <div class="friendly-error-state restore-recovery-state ${failed ? "is-failed" : ""}">
        <span class="friendly-error-icon"><i data-lucide="${failed ? "triangle-alert" : "shield-check"}"></i></span>
        <div>
          <strong>${failed ? "中断恢复需要人工检查" : "已处理上次中断的恢复"}</strong>
          <p>${failed ? "部分原文件未能确认，请查看回滚点详情后再继续。" : "原文件已从自动回滚点恢复并完成校验，可以重新生成恢复计划。"}</p>
        </div>
      </div>
    `;
  }
  $(".restore-summary-panel")?.classList.remove("is-empty");
  $(".restore-summary-panel")?.classList.toggle("has-error", failed);
  renderRestorePlanOverview(status, failed ? "error" : "recovery");
  $("#restoreResult").textContent = JSON.stringify(status, null, 2);
  renderIcons();
}

async function loadConfig() {
  state.config = await api("/api/config");
  renderSettings();
}

async function loadFolderCandidates() {
  state.folderCandidates = await api("/api/backup-folder-candidates");
  renderFolderCards();
}

async function runAudit() {
  try {
    setStatus("busy", "扫描中");
    const codexHome = encodeURIComponent($("#settingsCodexHome")?.value || state.config?.codexHome || "");
    state.audit = await api(`/api/audit?codexHome=${codexHome}`);
    renderOverview();
    renderAdvancedOptions();
    setStatus("ready", "扫描完成");
  } catch (error) {
    setStatus("error", "扫描失败");
    state.diskSpace = null;
    renderDiskSpace();
    showError(error);
  }
}

async function loadBackups() {
  const backupDir = encodeURIComponent(currentBackupDir());
  const [backups, rollbackPoints] = await Promise.all([
    api(`/api/snapshots?cloudDir=${backupDir}`),
    api(`/api/rollback-points?cloudDir=${backupDir}`)
  ]);
  state.backups = backups;
  state.rollbackPoints = rollbackPoints;
  renderBackups();
  renderRollbackPoints();
  renderFolderCards();
  renderOverview();
  await loadDiskSpace();
}

async function previewBackup() {
  setButtonBusy("#previewBackupButton", true, "正在生成");
  startBackupOperation("preview");
  setBackupVisual("busy");
  try {
    const payload = {
      codexHome: $("#settingsCodexHome").value.trim(),
      cloudDir: currentBackupDir(),
      include: selectedInclude(),
      selected: selectedPayload("all"),
      dryRun: true
    };
    const result = await streamApi("/api/snapshot-operation", payload, updateBackupOperationProgress);
    renderPlanSummary("#backupResultSummary", result, "backup");
    renderJson("#backupResult", result);
    stopBackupOperation(true);
    setBackupVisual("plan", result);
  } catch (error) {
    stopBackupOperation(false);
    setBackupVisual("error", error);
    showError(error);
  } finally {
    setButtonBusy("#previewBackupButton", false);
  }
}

async function createBackup() {
  setButtonBusy("#createBackupButton", true, "正在创建");
  startBackupOperation("create");
  setBackupVisual("busy");
  try {
    const payload = {
      codexHome: $("#settingsCodexHome").value.trim(),
      cloudDir: currentBackupDir(),
      include: selectedInclude(),
      selected: selectedPayload("all"),
      dryRun: false
    };
    const result = await streamApi("/api/snapshot-operation", payload, updateBackupOperationProgress);
    renderPlanSummary("#backupResultSummary", result, "backup");
    renderJson("#backupResult", result);
    stopBackupOperation(true);
    setBackupVisual("created", result);
    await loadBackups();
  } catch (error) {
    stopBackupOperation(false);
    setBackupVisual("error", error);
    showError(error);
  } finally {
    setButtonBusy("#createBackupButton", false);
  }
}

function applyRestorePolicy() {
  const enabled = state.config?.restorePolicy?.crossSystemAdaptation !== false;
  $all("input[name='restoreTargetOS']").forEach((input) => {
    input.disabled = !enabled && input.value !== "auto";
  });
  if (!enabled) document.querySelector("input[name='restoreTargetOS'][value='auto']").checked = true;
  renderRestoreTargetHint();
}

function selectedRestoreMode() {
  return document.querySelector("input[name='restoreEnvironmentMode']:checked")?.value || "isolated_test";
}

async function prepareTestRestoreEnvironment() {
  const environment = await api("/api/test-restore-environments", {
    method: "POST",
    body: "{}"
  });
  state.testRestoreEnvironment = environment;
  $("#restoreTargetInput").value = environment.codexHome;
  $("#restoreTargetInput").readOnly = true;
  $("#projectMappingBaseInput").value = environment.projectsRoot;
  $("#deleteTestEnvironmentButton").hidden = false;
  $("#restoreEnvironmentHint").textContent = `隔离目录：${environment.root}；不会替换正式 Codex 数据。`;
  document.querySelector("input[name='restoreTargetOS'][value='auto']").checked = true;
  setRestoreActionState(null);
  renderRestoreTargetHint();
  return environment;
}

async function applyRestoreEnvironmentMode() {
  const isolated = selectedRestoreMode() === "isolated_test";
  if (isolated) {
    if (!state.testRestoreEnvironment) await prepareTestRestoreEnvironment();
    return;
  }
  $("#restoreTargetInput").readOnly = false;
  $("#restoreTargetInput").value = state.config?.codexHome || "";
  $("#deleteTestEnvironmentButton").hidden = true;
  $("#restoreEnvironmentHint").textContent = "正式模式会写入当前 Codex 数据；执行前必须完全退出 Codex、ChatGPT 和 Codex Link 相关占用进程。";
  setRestoreActionState(null);
}

async function deleteCurrentTestEnvironment() {
  const environment = state.testRestoreEnvironment;
  if (!environment) return;
  if (!window.confirm(`删除独立测试环境？\n\n${environment.root}\n\n只会删除带有 Codex Link 测试标记的隔离目录。`)) return;
  await api("/api/test-restore-environments", {
    method: "DELETE",
    body: JSON.stringify({ root: environment.root })
  });
  state.testRestoreEnvironment = null;
  $("#restoreTargetInput").value = "";
  $("#deleteTestEnvironmentButton").hidden = true;
  $("#restoreEnvironmentHint").textContent = "测试环境已安全删除；再次生成计划时会创建新的隔离目录。";
  setRestoreActionState(null);
}

function selectedRestoreTargetOS() {
  if (state.config?.restorePolicy?.crossSystemAdaptation === false) return "auto";
  return document.querySelector("input[name='restoreTargetOS']:checked")?.value || "auto";
}

function renderRestoreTargetHint() {
  const target = $("#restoreTargetHint");
  if (!target) return;
  const selected = selectedRestoreTargetOS();
  const hints = {
    auto: {
      icon: "monitor-check",
      title: "当前系统",
      path: state.config?.codexHome || "沿用当前 Codex 主目录",
      note: "同系统恢复仍会复核插件授权和本地工具运行时。"
    },
    windows: {
      icon: "monitor",
      title: "Windows",
      path: "C:\\Users\\<用户>\\.codex",
      note: "检查盘符、反斜杠、exe/bat/ps1 与本机授权。"
    },
    macos: {
      icon: "laptop",
      title: "macOS",
      path: "/Users/<用户>/.codex",
      note: "Apple Silicon 环境需复核工具架构、执行权限与钥匙串授权。"
    },
    linux: {
      icon: "terminal",
      title: "Linux",
      path: "/home/<用户>/.codex",
      note: "检查 Unix 权限、shell 脚本、运行时路径与插件授权。"
    }
  };
  const hint = hints[selected] || hints.auto;
  target.innerHTML = [
    '<i data-lucide="' + hint.icon + '" aria-hidden="true"></i>',
    '<span><small>' + escapeHtml(hint.title + " 目标路径示例") + "</small><b>" + escapeHtml(hint.path) + "</b><em>" +
    escapeHtml(hint.note) + "</em></span>"
  ].join("");
  renderIcons();
}

async function restorePlan() {
  const snapshotDir = $("#restoreSnapshotInput").value.trim();
  if (!snapshotDir) {
    renderPlanSummary("#restoreSummary", null, "restore");
    $(".restore-summary-panel")?.classList.add("is-empty");
    $(".restore-summary-panel")?.classList.remove("has-error");
    $("#restoreResult").textContent = "请先从备份管理选择一个恢复点，或粘贴恢复点文件夹路径。";
    $("#restoreSnapshotInput").focus();
    return;
  }
  setButtonBusy("#restorePlanButton", true, "正在检查");
  try {
    if (selectedRestoreMode() === "isolated_test" && !state.testRestoreEnvironment) {
      await prepareTestRestoreEnvironment();
    }
    const payload = {
      snapshotDir,
      targetCodexHome: $("#restoreTargetInput").value.trim(),
      targetOS: selectedRestoreTargetOS(),
      restoreMode: selectedRestoreMode(),
      databaseRestoreMode: $("#databaseRestoreMode").value,
      confirmDatabaseReplace: $("#confirmDatabaseReplace").checked
    };
    const restoreSelection = currentRestoreSelectionPayload();
    if (restoreSelection) payload.restoreSelection = restoreSelection;
    const projectMappings = currentProjectMappingsPayload();
    if (projectMappings) payload.projectMappings = projectMappings;
    let result = await api("/api/restore-plan", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (selectedRestoreMode() === "isolated_test" && result.requiresProjectMapping && state.testRestoreEnvironment) {
      const separator = state.testRestoreEnvironment.projectsRoot.includes("\\") ? "\\" : "/";
      payload.projectMappings = (result.projectPathMappings || []).map((item) => ({
        projectId: item.projectId,
        mode: "placeholder",
        targetRoot: state.testRestoreEnvironment.projectsRoot.replace(/[\\/]+$/, "") + separator + item.displayName
      }));
      result = await api("/api/restore-plan", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }
    renderRestoreSummary(result);
    renderJson("#restoreResult", result);
  } catch (error) {
    renderRestoreError(error);
  } finally {
    setButtonBusy("#restorePlanButton", false);
  }
}

async function executeRestore() {
  const plan = state.restorePlan;
  if (!plan?.canExecute) return;

  const integrityWarning = plan.requiresUnverifiedConfirmation
    ? "\n\n这个旧恢复点没有可信哈希基线，只能校验当前可读性。建议优先使用新创建的恢复点。"
    : "";
  const isolated = plan.restoreMode === "isolated_test";
  const confirmed = window.confirm(
    `即将把恢复点恢复到：\n${plan.targetCodexHome}\n\n系统会先创建自动回滚点，并在写入后逐文件校验。${integrityWarning}\n\n${isolated ? "这是独立测试环境，不会替换正式 Codex 数据。" : "请确认 Codex 已完全退出。"}继续恢复吗？`
  );
  if (!confirmed) return;
  if (plan.databaseRestoreMode === "replace" && !window.confirm(
    "二次确认：整库替换会移除目标端独有任务索引。\n\n确认继续执行危险的完整数据库替换吗？"
  )) return;

  let confirmHighRisk = false;
  if (plan.requiresHighRiskConfirmation) {
    confirmHighRisk = window.confirm(
      "恢复计划包含跨系统适配或凭据、插件、本地工具等高风险内容。\n\n这些内容恢复后可能需要重新授权或人工调整。确认继续吗？"
    );
    if (!confirmHighRisk) return;
  }

  setButtonBusy("#restoreExecuteButton", true, "正在恢复");
  setButtonBusy("#restorePlanButton", true, "请稍候");
  startRestoreOperation();
  try {
    const result = await streamApi("/api/restore-operation", {
      snapshotDir: plan.snapshotDir,
      targetCodexHome: plan.targetCodexHome,
      targetOS: selectedRestoreTargetOS(),
      restoreMode: plan.restoreMode || selectedRestoreMode(),
      databaseRestoreMode: plan.databaseRestoreMode || "merge",
      confirmDatabaseReplace: $("#confirmDatabaseReplace").checked,
      restoreSelection: {
        mode: "custom",
        itemIds: plan.restoreSelection?.selectedItemIds || []
      },
      cloudDir: currentBackupDir(),
      confirmRestore: true,
      allowUnverified: Boolean(plan.requiresUnverifiedConfirmation),
      confirmHighRisk,
      projectMappings: plan.projectPathMappings || []
    }, updateRestoreOperationProgress);
    stopRestoreOperation("complete");
    renderRestoreExecutionResult(result);
    await runAudit();
  } catch (error) {
    stopRestoreOperation("error", error);
    renderRestoreExecutionError(error);
  } finally {
    setButtonBusy("#restoreExecuteButton", false);
    setButtonBusy("#restorePlanButton", false);
  }
}

async function deleteBackup(snapshotDir, snapshotId) {
  const ok = window.confirm(`删除恢复点 ${snapshotId || ""}？\n\n只会删除备份文件夹中的这一份备份。`);
  if (!ok) return;
  const result = await api("/api/snapshots", {
    method: "DELETE",
    body: JSON.stringify({ cloudDir: currentBackupDir(), snapshotDir })
  });
  renderJson("#backupResult", result);
  await loadBackups();
}

async function saveSettings() {
  const next = {
    codexHome: $("#settingsCodexHome").value.trim(),
    cloudDir: $("#settingsBackupDir").value.trim(),
    retainSnapshots: Number($("#settingsRetain").value || 5),
    include: selectedInclude(),
    restorePolicy: {
      autoRollback: true,
      crossSystemAdaptation: $("#settingsCrossSystem").checked,
      excludeHighRisk: $("#settingsExcludeHighRisk").checked
    }
  };
  state.config = await api("/api/config", {
    method: "POST",
    body: JSON.stringify(next)
  });
  $("#backupDirInput").value = state.config.cloudDir || "";
  renderSettings();
  await runAudit();
  await loadBackups();
}

function adjustRetention(delta) {
  const input = $("#settingsRetain");
  const value = Number(input.value || 5);
  input.value = String(Math.min(30, Math.max(1, value + delta)));
}

function resetSettings() {
  $("#settingsCodexHome").value = state.audit?.codexHome || state.config?.codexHome || "";
  const defaultFolder = state.folderCandidates.find((item) => item.exactExists)?.path || state.config?.cloudDir || "";
  $("#settingsBackupDir").value = defaultFolder;
  $("#backupDirInput").value = defaultFolder;
  $("#settingsRetain").value = "5";
  $all("[data-setting-toggle]").forEach((input) => { input.checked = true; });
  renderFolderCards();
}

async function applyBackupDirectory(selected) {
  if (!selected) return;
  $("#backupDirInput").value = selected;
  $("#settingsBackupDir").value = selected;
  closeFolderPicker();
  state.config = await api("/api/config", {
    method: "POST",
    body: JSON.stringify({ cloudDir: selected })
  });
  renderSettings();
  await loadBackups();
}

async function openFolderPicker() {
  const desktop = window.codexLinkDesktop;
  if (desktop?.selectDirectory) {
    const selected = await desktop.selectDirectory({
      title: "选择备份文件夹",
      defaultPath: currentBackupDir()
    });
    await applyBackupDirectory(selected);
    return;
  }
  const modal = $("#folderPickerModal");
  if (modal) modal.hidden = false;
  renderFolderCards();
}

async function openCurrentBackupFolder() {
  const targetPath = currentBackupDir();
  if (!targetPath) throw new Error("请先选择备份文件夹。");
  const result = await window.codexLinkDesktop?.openPath?.(targetPath);
  if (!result?.ok) throw new Error(result?.error || "当前环境无法打开本地文件夹。");
}

function closeFolderPicker() {
  const modal = $("#folderPickerModal");
  if (modal) modal.hidden = true;
}

function showError(error) {
  const message = error?.message || String(error);
  const backupResult = $("#backupResult");
  const restoreResult = $("#restoreResult");
  if (backupResult) backupResult.textContent = message;
  if (restoreResult) restoreResult.textContent = message;
}

function wireEvents() {
  document.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view-button]");
    if (viewButton) switchView(viewButton.dataset.viewButton);
    const folderButton = event.target.closest("[data-open-folder-picker]");
    if (folderButton) openFolderPicker().catch(showError);
  });

  $all(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  $("#refreshButton").addEventListener("click", runAudit);
  $("#sidebarRetryButton").addEventListener("click", runAudit);
  $("#previewBackupButton").addEventListener("click", previewBackup);
  $("#createBackupButton").addEventListener("click", createBackup);
  $("#selectAllDefaultButton").addEventListener("click", () => setDefaultBackupSelection("all"));
  $("#resetRecommendedButton").addEventListener("click", () => setDefaultBackupSelection("recommended"));
  $("#toggleBackupResultButton").addEventListener("click", toggleBackupResult);
  $("#loadBackupsButton").addEventListener("click", loadBackups);
  $("#restorePlanButton").addEventListener("click", restorePlan);
  $("#restoreExecuteButton").addEventListener("click", executeRestore);
  $("#projectMappingList").addEventListener("input", () => setRestoreActionState(null));
  $("#projectMappingList").addEventListener("change", (event) => {
    const row = event.target.closest(".project-mapping-row");
    if (!row || !event.target.matches(".project-mapping-mode")) return;
    const target = row.querySelector(".project-mapping-target");
    if (event.target.value === "unresolved" && target) target.value = "";
    setRestoreActionState(null);
  });
  $("#projectMappingBatchButton").addEventListener("click", () => {
    const base = $("#projectMappingBaseInput").value.trim().replace(/[\\/]+$/, "");
    if (!base) {
      $("#projectMappingBaseInput").focus();
      return;
    }
    const separator = selectedRestoreTargetOS() === "windows" ? "\\" : "/";
    document.querySelectorAll(".project-mapping-row").forEach((row) => {
      const name = row.querySelector(".project-mapping-source strong")?.textContent?.trim() || row.dataset.projectId;
      row.querySelector(".project-mapping-mode").value = "existing";
      row.querySelector(".project-mapping-target").value = `${base}${separator}${name}`;
    });
    setRestoreActionState(null);
  });
  $("#restoreSelectAllButton").addEventListener("click", () => {
    const restorable = state.restoreAvailableItems.filter((item) => item.restorable);
    const newlySelectedHighRisk = restorable.filter(
      (item) => item.risk === "high" && !state.restoreSelectedItemIds.has(item.id)
    );
    if (!confirmHighRiskRestoreSelection(newlySelectedHighRisk)) return;
    state.restoreSelectedItemIds = new Set(restorable.map((item) => item.id));
    invalidateRestorePlanForSelectionChange();
    renderRestoreSelection();
  });
  $("#restoreClearButton").addEventListener("click", () => {
    state.restoreSelectedItemIds = new Set();
    state.restoreOpenProjectIds = new Set();
    invalidateRestorePlanForSelectionChange();
    renderRestoreSelection();
  });
  $("#restoreSelectionSearch").addEventListener("input", (event) => {
    state.restoreSelectionQuery = event.target.value || "";
    renderRestoreSelection();
  });
  $("#restoreSelectionGroups").addEventListener("change", (event) => {
    const projectInput = event.target.closest("[data-restore-project]");
    if (projectInput) {
      const projectKey = projectInput.dataset.restoreProject;
      const items = restoreProjectSelectionItems(projectKey);
      if (projectInput.checked) {
        const highRisk = items.filter((item) => item.risk === "high" && !state.restoreSelectedItemIds.has(item.id));
        if (!confirmHighRiskRestoreSelection(highRisk)) return renderRestoreSelection();
        items.forEach((item) => state.restoreSelectedItemIds.add(item.id));
      } else {
        items.forEach((item) => state.restoreSelectedItemIds.delete(item.id));
      }
      if (projectInput.checked) state.restoreOpenProjectIds.add(projectKey);
      invalidateRestorePlanForSelectionChange();
      renderRestoreSelection();
      return;
    }
    const input = event.target.closest("[data-restore-item]");
    if (!input) return;
    const item = state.restoreAvailableItems.find((candidate) => candidate.id === input.dataset.restoreItem);
    if (input.checked && item?.risk === "high" && !confirmHighRiskRestoreSelection([item])) {
      input.checked = false;
      return;
    }
    if (input.checked) state.restoreSelectedItemIds.add(input.dataset.restoreItem);
    else state.restoreSelectedItemIds.delete(input.dataset.restoreItem);
    invalidateRestorePlanForSelectionChange();
    renderRestoreSelection();
  });
  $("#restoreSelectionGroups").addEventListener("toggle", (event) => {
    const details = event.target.closest("[data-restore-group-key]");
    if (!details) return;
    details.querySelector("summary")?.setAttribute("aria-expanded", String(details.open));
    if (state.restoreSelectionQuery.trim()) return;
    if (details.open) state.restoreExpandedGroups.add(details.dataset.restoreGroupKey);
    else state.restoreExpandedGroups.delete(details.dataset.restoreGroupKey);
  }, true);
  $("#restoreSelectionGroups").addEventListener("click", (event) => {
    const projectExpand = event.target.closest("[data-restore-project-expand]");
    if (projectExpand) {
      toggleRestoreProjectDetails(projectExpand.dataset.restoreProjectExpand);
      return;
    }
    const projectRow = event.target.closest("[data-restore-project-expand-row]");
    if (projectRow && !event.target.closest("input, button, a")) {
      event.preventDefault();
      toggleRestoreProjectDetails(projectRow.dataset.restoreProjectExpandRow);
      return;
    }
    const button = event.target.closest("[data-restore-group-action]");
    if (!button) return;
    const group = button.dataset.restoreGroup;
    const items = state.restoreAvailableItems.filter((item) => item.restorable && restoreItemGroup(item) === group);
    if (button.dataset.restoreGroupAction === "all") {
      const highRisk = items.filter((item) => item.risk === "high" && !state.restoreSelectedItemIds.has(item.id));
      if (!confirmHighRiskRestoreSelection(highRisk)) return;
      items.forEach((item) => state.restoreSelectedItemIds.add(item.id));
    } else {
      items.forEach((item) => state.restoreSelectedItemIds.delete(item.id));
    }
    invalidateRestorePlanForSelectionChange();
    renderRestoreSelection();
  });
  $("#restoreSelectionGroups").addEventListener("keydown", (event) => {
    const projectRow = event.target.closest("[data-restore-project-expand-row]");
    if (!projectRow || event.target.closest("input, button, a") || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    toggleRestoreProjectDetails(projectRow.dataset.restoreProjectExpandRow);
  });
  $("#restorePlanOverview").addEventListener("toggle", (event) => {
    const details = event.target.closest("[data-restore-overview-group]");
    if (!details) return;
    details.querySelector("summary")?.setAttribute("aria-expanded", String(details.open));
    if (details.open) state.restoreOverviewExpandedGroups.add(details.dataset.restoreOverviewGroup);
    else state.restoreOverviewExpandedGroups.delete(details.dataset.restoreOverviewGroup);
  }, true);
  $("#saveSettingsButton").addEventListener("click", saveSettings);
  $("#decreaseRetainButton").addEventListener("click", () => adjustRetention(-1));
  $("#increaseRetainButton").addEventListener("click", () => adjustRetention(1));
  $("#resetSettingsButton").addEventListener("click", resetSettings);
  $("#validateSettingsButton").addEventListener("click", runAudit);
  $("#viewRollbackPointsButton").addEventListener("click", openRollbackManager);
  $("#openBackupFolderButton").addEventListener("click", () => openCurrentBackupFolder().catch(showError));
  $("#settingsCrossSystem").addEventListener("change", (event) => {
    state.config.restorePolicy = { ...state.config.restorePolicy, crossSystemAdaptation: event.target.checked };
    applyRestorePolicy();
  });
  $("#settingsExcludeHighRisk").addEventListener("change", (event) => {
    state.config.restorePolicy = { ...state.config.restorePolicy, excludeHighRisk: event.target.checked };
    if (event.target.checked) {
      ["plugins", "tools", "auth"].forEach((key) => { state.config.include[key] = false; });
    }
    renderSettings();
  });
  $("#closeFolderPickerButton").addEventListener("click", closeFolderPicker);
  $("#folderPickerModal").addEventListener("click", (event) => {
    if (event.target.id === "folderPickerModal") closeFolderPicker();
  });
  $("#backupDirInput").addEventListener("input", () => {
    $("#settingsBackupDir").value = $("#backupDirInput").value;
    renderFolderCards();
  });
  $("#settingsBackupDir").addEventListener("input", () => {
    $("#backupDirInput").value = $("#settingsBackupDir").value;
    renderFolderCards();
  });
  $("#restoreSnapshotInput").addEventListener("input", resetRestoreSelection);
  $("#restoreTargetInput").addEventListener("input", () => setRestoreActionState(null));
  $("#databaseRestoreMode").addEventListener("change", (event) => {
    const replacing = event.target.value === "replace";
    $("#databaseReplaceConfirmRow").hidden = !replacing;
    if (!replacing) $("#confirmDatabaseReplace").checked = false;
    setRestoreActionState(null);
  });
  $("#confirmDatabaseReplace").addEventListener("change", () => setRestoreActionState(null));
  $all("input[name='restoreEnvironmentMode']").forEach((input) => {
    input.addEventListener("change", () => applyRestoreEnvironmentMode().catch(showError));
  });
  $("#prepareTestEnvironmentButton").addEventListener("click", () => prepareTestRestoreEnvironment().catch(showError));
  $("#deleteTestEnvironmentButton").addEventListener("click", () => deleteCurrentTestEnvironment().catch(showError));
  $("#exportDiagnosticJsonButton").addEventListener("click", () => downloadDiagnostic("json"));
  $("#exportDiagnosticMarkdownButton").addEventListener("click", () => downloadDiagnostic("md"));
  $all("input[name='restoreTargetOS']").forEach((input) => {
    input.addEventListener("change", () => {
      renderRestoreTargetHint();
      if ($("#restoreSnapshotInput").value.trim()) restorePlan().catch(showError);
    });
  });
  window.addEventListener("hashchange", () => {
    switchView(window.location.hash.slice(1), { updateHash: false });
  });
}

async function init() {
  wireEvents();
  renderIcons();
  await loadConfig();
  await loadRestoreRecoveryStatus();
  await loadFolderCandidates();
  await runAudit();
  await loadBackups();
  const initialView = window.location.hash.slice(1);
  if (initialView) switchView(initialView, { updateHash: false });
  renderIcons();
}

init().catch((error) => {
  setStatus("error", "启动失败");
  showError(error);
});
