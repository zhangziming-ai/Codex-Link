const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { URL } = require("url");
const { Worker } = require("worker_threads");
const APP_VERSION = require("./package.json").version;
const {
  RestoreExecutionError,
  executeRestoreTransaction,
  finalizeSnapshotManifest,
  listRollbackPoints,
  portablePath,
  readSnapshotManifest,
  recoverInterruptedRestores,
  resolveInside,
  undoRestoreTransaction,
  validateRelativePath,
  verifySnapshotIntegrity
} = require("./lib/restore-engine");
const {
  buildPortableProjectCatalog,
  loadOrRebuildProjectCatalog,
  normalizeProjectPath,
  readSqliteThreads,
  stableProjectId
} = require("./lib/portable-projects");
const {
  createConsistentSQLiteCopy,
  validateSQLiteDatabase
} = require("./lib/sqlite-safety");

const PORT = Number(process.env.CODEX_LINK_PORT || 4387);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_FILE = process.env.CODEX_LINK_CONFIG_FILE
  ? path.resolve(process.env.CODEX_LINK_CONFIG_FILE)
  : path.join(ROOT, "codex-link.config.local.json");
const BACKUP_ROOT_DIR = "Codex Link";
const RESTORE_POINTS_DIR = "restore-points";
const LEGACY_SNAPSHOTS_DIR = "snapshots";
const ROLLBACK_POINTS_DIR = "rollback-points";

const SECTION_DEFS = [
  { key: "config", label: "基础配置", relativePath: "config.toml", priority: "P0" },
  { key: "agents", label: "全局规则", relativePath: "AGENTS.md", priority: "P0" },
  { key: "sessions", label: "对话记录", relativePath: "sessions", priority: "P0" },
  { key: "archivedSessions", label: "归档对话", relativePath: "archived_sessions", priority: "P0" },
  { key: "stateDb", label: "任务索引数据库", relativePath: "state_5.sqlite", priority: "P0" },
  { key: "memories", label: "记忆文件", relativePath: "memories", priority: "P0" },
  { key: "skills", label: "本地 Skills", relativePath: "skills", priority: "P1" },
  { key: "plugins", label: "插件安装缓存", relativePath: "plugins", priority: "P3" },
  { key: "tools", label: "本地工具链", relativePath: "tools", priority: "P2" },
  { key: "auth", label: "登录凭据", relativePath: "auth.json", priority: "P3" }
];

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function pathApiForPlatform(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function isWindowsAbsolutePath(value) {
  const text = String(value || "");
  return /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\]+\\[^\\]+/.test(text);
}

function resolveConfiguredPath(value, fallback, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = pathApiForPlatform(platform);
  const home = options.homeDir || os.homedir();
  let text = String(value || "").trim();
  if (!text) return pathApi.resolve(fallback);
  if (text === "~" || text.startsWith("~/") || text.startsWith("~\\")) {
    text = pathApi.join(home, ...text.slice(2).split(/[\\/]+/).filter(Boolean));
  }
  if (platform === "win32" && text.startsWith("/") && !isWindowsAbsolutePath(text)) {
    return pathApi.resolve(fallback);
  }
  if (platform !== "win32" && isWindowsAbsolutePath(text)) {
    return pathApi.resolve(fallback);
  }
  return pathApi.resolve(text);
}

function defaultCodexHome(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = pathApiForPlatform(platform);
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  return resolveConfiguredPath(env.CODEX_HOME, pathApi.join(home, ".codex"), { platform, homeDir: home });
}

function cloudCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = pathApiForPlatform(platform);
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const existsForPlatform = options.exists || (platform === process.platform ? exists : () => false);
  const raw = [];

  if (platform === "win32") {
    raw.push({
      provider: "Baidu Netdisk",
      label: "备份文件夹",
      path: "G:\\BaiduSyncdisk\\Codex link",
      note: "沿用当前配置里的备份文件夹；如果它位于百度网盘客户端目录内，同步由网盘客户端自行完成。"
    }, {
      provider: "Baidu Netdisk",
      label: "备份文件夹",
      path: "G:\\BaiduSyncdisk\\Codex Link Backups",
      note: "把备份文件夹放在百度网盘客户端的本地同步目录后，可由网盘客户端自行同步。"
    });
  }

  raw.push({
      provider: "Baidu Netdisk",
      label: "备份文件夹",
      path: pathApi.join(home, "BaiduNetdisk", "Codex Link Backups"),
      note: "适合百度网盘 Windows/Mac 客户端的本地同步目录。"
    }, {
      provider: "Baidu Netdisk",
      label: "备份文件夹",
      path: pathApi.join(home, "百度网盘", "Codex Link Backups"),
      note: "如果你的百度网盘客户端使用中文目录名，优先尝试这个路径。"
    }, {
      provider: "Baidu Netdisk",
      label: "备份文件夹",
      path: pathApi.join(home, "BaiduSyncdisk", "Codex Link Backups"),
      note: "部分旧版或企业版百度同步盘可能使用这个目录名。"
    });

  const defaultOneDriveRoot = platform === "darwin"
    ? pathApi.join(home, "Library", "CloudStorage", "OneDrive-Personal")
    : pathApi.join(home, "OneDrive");
  const oneDriveRoot = resolveConfiguredPath(env.OneDrive, defaultOneDriveRoot, { platform, homeDir: home });
  raw.push({
      provider: "OneDrive",
      label: "备份文件夹",
      path: pathApi.join(oneDriveRoot, "Codex Link Backups"),
      note: "适合 Windows 和 macOS OneDrive 本地同步目录。"
    }, {
      provider: "iCloud Drive",
      label: "备份文件夹",
      path: platform === "darwin"
        ? pathApi.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Codex Link Backups")
        : pathApi.join(home, "iCloudDrive", "Codex Link Backups"),
      note: "适合 Mac 家用设备，Windows 上需要安装 iCloud。"
    }, {
      provider: "Nutstore",
      label: "备份文件夹",
      path: pathApi.join(home, "Nutstore", "Codex Link Backups"),
      note: "适合坚果云本地同步目录。"
    }, {
      provider: "Local",
      label: "备份文件夹",
      path: pathApi.join(home, "Documents", "Codex Link Backups"),
      note: "用于先跑通测试；这是普通本地文件夹，不会自动同步到外部位置。"
    });

  if (platform === "win32") {
    raw.push({
      provider: "Local",
      label: "备份文件夹",
      path: "D:\\项目\\Codex Link Backups",
      note: "适合不想放在 C 盘的本地备份；需要外部保存时再自行上传或拷贝。"
    });
  }

  const seen = new Set();
  return raw
    .filter((item) => {
      const key = platform === "win32" ? item.path.toLowerCase() : item.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({
      ...item,
      exists: existsForPlatform(pathApi.dirname(item.path)) || existsForPlatform(item.path),
      exactExists: existsForPlatform(item.path)
    }));
}

function defaultCloudDir(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = pathApiForPlatform(platform);
  const home = options.homeDir || os.homedir();
  const existing = cloudCandidates(options).find((item) => item.exists);
  return existing ? existing.path : pathApi.join(home, "Documents", "Codex Link Backups");
}

function defaultConfig(options = {}) {
  return {
    codexHome: defaultCodexHome(options),
    cloudDir: defaultCloudDir(options),
    include: {
      config: true,
      agents: true,
      sessions: true,
      archivedSessions: true,
      stateDb: true,
      memories: true,
      skills: true,
      plugins: false,
      tools: false,
      auth: false
    },
    retainSnapshots: 5,
    restorePolicy: {
      autoRollback: true,
      crossSystemAdaptation: true,
      excludeHighRisk: true
    }
  };
}

function normalizeConfig(value = {}, options = {}) {
  const platform = options.platform || process.platform;
  const home = options.homeDir || os.homedir();
  const defaults = defaultConfig(options);
  return {
    ...defaults,
    ...value,
    codexHome: resolveConfiguredPath(value.codexHome, defaults.codexHome, { platform, homeDir: home }),
    cloudDir: resolveConfiguredPath(value.cloudDir, defaults.cloudDir, { platform, homeDir: home }),
    include: { ...defaults.include, ...(value.include || {}) },
    retainSnapshots: normalizeRetention(value.retainSnapshots),
    restorePolicy: {
      autoRollback: true,
      crossSystemAdaptation: value.restorePolicy?.crossSystemAdaptation !== false,
      excludeHighRisk: value.restorePolicy?.excludeHighRisk !== false
    }
  };
}

function loadConfig(configFile = CONFIG_FILE, options = {}) {
  for (const candidate of [configFile, `${configFile}.bak`]) {
    try {
      return normalizeConfig(JSON.parse(fs.readFileSync(candidate, "utf8")), options);
    } catch {}
  }
  return defaultConfig(options);
}

function saveConfig(nextConfig, configFile = CONFIG_FILE, options = {}) {
  const normalized = normalizeConfig(nextConfig, options);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  if (exists(configFile)) {
    try {
      JSON.parse(fs.readFileSync(configFile, "utf8"));
      fs.copyFileSync(configFile, `${configFile}.bak`);
    } catch {}
  }
  const tempFile = `${configFile}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tempFile, "wx");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempFile, configFile);
  } catch (error) {
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {}
    throw error;
  }
  return normalized;
}

function applyBackupPolicy(config, body = {}) {
  const include = { ...config.include, ...(body.include || {}) };
  include.auth = false;
  if (config.restorePolicy.excludeHighRisk) {
    include.plugins = false;
    include.tools = false;
  }
  return { ...config, ...body, include, restorePolicy: config.restorePolicy };
}

function enforceRestorePolicy(config, body = {}) {
  if (!config.restorePolicy.crossSystemAdaptation && normalizeOS(body.targetOS) !== currentOSId()) {
    throw new Error("Cross-system adaptation is disabled. Select the current system or enable adaptation in Settings.");
  }
  return body;
}

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function statSafe(target, lstat = false) {
  try {
    return lstat ? fs.lstatSync(target) : fs.statSync(target);
  } catch {
    return null;
  }
}

function toMb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function diskSpaceForPath(targetPath) {
  const requested = path.resolve(targetPath || defaultCloudDir());
  const candidates = [requested, path.dirname(requested), path.parse(requested).root];
  const existingPath = candidates.find((candidate) => candidate && exists(candidate));
  if (!existingPath || typeof fs.statfsSync !== "function") {
    return { path: requested, drive: path.parse(requested).root || "本地", availableBytes: 0, totalBytes: 0, usedPercent: 0 };
  }
  const stats = fs.statfsSync(existingPath);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const usedPercent = totalBytes > 0 ? Math.round(((totalBytes - availableBytes) / totalBytes) * 1000) / 10 : 0;
  return {
    path: requested,
    drive: path.parse(requested).root || existingPath,
    availableBytes,
    totalBytes,
    usedPercent
  };
}

function walk(target, options = {}) {
  const maxFiles = options.maxFiles || 50000;
  const maxDepth = options.maxDepth ?? 20;
  const includeFiles = options.includeFiles ?? true;
  const results = [];
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;

  function visit(current, depth) {
    if (fileCount >= maxFiles || depth > maxDepth) return;
    const st = statSafe(current);
    if (!st) return;
    if (st.isDirectory()) {
      dirCount += 1;
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        visit(path.join(current, entry.name), depth + 1);
        if (fileCount >= maxFiles) break;
      }
      return;
    }
    fileCount += 1;
    totalBytes += st.size;
    if (includeFiles) {
      results.push({
        path: current,
        size: st.size,
        modifiedAt: st.mtime.toISOString()
      });
    }
  }

  visit(target, 0);
  return { files: results, fileCount, dirCount, totalBytes, truncated: fileCount >= maxFiles };
}

function sectionStats(codexHome) {
  return SECTION_DEFS.map((section) => {
    const fullPath = path.join(codexHome, section.relativePath);
    const st = statSafe(fullPath);
    if (!st) {
      return {
        ...section,
        exists: false,
        path: fullPath,
        sizeMb: 0,
        fileCount: 0,
        migrationStatus: "missing"
      };
    }
    if (st.isDirectory()) {
      const info = walk(fullPath, { includeFiles: false, maxFiles: 250000 });
      return {
        ...section,
        exists: true,
        path: fullPath,
        sizeMb: toMb(info.totalBytes),
        fileCount: info.fileCount,
        migrationStatus: section.priority === "P3" ? "verify_or_reauthorize" : "copyable"
      };
    }
    return {
      ...section,
      exists: true,
      path: fullPath,
      sizeMb: toMb(st.size),
      fileCount: 1,
      migrationStatus: section.priority === "P3" ? "verify_or_reauthorize" : "copyable"
    };
  });
}

function readTextSafe(filePath, maxBytes = 1024 * 1024) {
  try {
    const fd = fs.openSync(filePath, "r");
    const st = fs.fstatSync(fd);
    const bytes = Math.min(st.size, maxBytes);
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, 0);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function findSkillFiles(root, type, maxFiles = 300) {
  if (!exists(root)) return [];
  const found = [];
  function visit(current, depth) {
    if (found.length >= maxFiles || depth > 8) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(child, depth + 1);
      } else if (entry.name === "SKILL.md") {
        found.push({ path: child, type });
      }
      if (found.length >= maxFiles) break;
    }
  }
  visit(root, 0);
  return found;
}

function parseSkill(file) {
  const raw = readTextSafe(file.path, 120000);
  const nameMatch = raw.match(/^name:\s*"?([^"\r\n]+)"?/m);
  const descMatch = raw.match(/^description:\s*"?(.+?)"?\s*$/m);
  const displayMatch = raw.match(/^(?:display_name|title):\s*"?([^"\r\n]+)"?/m);
  const headingMatch = raw.match(/^#\s+(.+?)\s*$/m);
  const parent = path.basename(path.dirname(file.path));
  const manifestName = nameMatch ? nameMatch[1].trim() : "";
  const headingName = headingMatch ? headingMatch[1].trim() : "";
  const configuredName = displayMatch ? displayMatch[1].trim() : headingName || manifestName || parent;
  return {
    selectId: `capability:${file.path}`,
    name: configuredName,
    configuredName,
    manifestName: manifestName || parent,
    folderName: parent,
    aliases: [...new Set([configuredName, manifestName, parent].filter(Boolean))],
    description: descMatch ? descMatch[1].replace(/^"|"$/g, "").trim() : "",
    type: file.type,
    path: file.path,
    usageCount: 0,
    usedInProjects: [],
    lastUsedAt: null,
    migrationStatus: file.type === "plugin_skill" ? "reinstall_or_verify_on_target" : "copyable",
    installAction: file.type === "plugin_skill" ? "在新设备安装插件或从恢复点复制插件缓存后重启" : "从恢复点复制"
  };
}

const API_TOOL_CATALOG = [
  {
    id: "volcengine",
    name: "火山引擎",
    provider: "ByteDance Volcengine",
    description: "火山方舟、语音、视频、视觉等 API 能力。迁移时需要在新设备配置 AK/SK 或 API Key。",
    aliases: ["volcengine", "火山", "火山引擎", "火山方舟", "ark", "doubao", "豆包", "seedance"],
    strongNeedles: ["console.volcengine.com", "ark.cn-beijing.volces.com", "doubao-seed", "seedance"],
    envKeys: ["VOLCENGINE_ACCESS_KEY", "VOLCENGINE_SECRET_KEY", "ARK_API_KEY", "DOUBAO_API_KEY", "VOLCENGINE_API_KEY"]
  },
  {
    id: "feishu",
    name: "飞书",
    provider: "Feishu/Lark",
    description: "飞书文档、知识库、多维表格、审批、日历、消息等 OpenAPI 能力。迁移时需要复核应用凭据和用户授权。",
    aliases: ["feishu", "lark", "飞书", "lark-cli", "open_id", "app_token", "tenant_access_token"],
    strongNeedles: ["open.feishu.cn", "open.larksuite.com", "tenant_access_token", "lark-cli"],
    envKeys: ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "LARK_APP_ID", "LARK_APP_SECRET"]
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    provider: "DeepSeek",
    description: "DeepSeek 模型 API。迁移时需要在新设备配置 API Key、Base URL 和调用限额。",
    aliases: ["deepseek", "deepseek-chat", "deepseek-reasoner"],
    strongNeedles: ["api.deepseek.com", "deepseek-chat", "deepseek-reasoner"],
    envKeys: ["DEEPSEEK_API_KEY"]
  },
  {
    id: "banana",
    name: "香蕉模型",
    provider: "Banana",
    description: "香蕉模型或自定义模型 API。迁移时需要确认服务地址、模型名、API Key 和计费方式。",
    aliases: ["banana", "香蕉", "香蕉模型", "banana model"],
    strongNeedles: ["banana.dev", "api.banana.dev", "banana model"],
    envKeys: ["BANANA_API_KEY", "BANANA_MODEL_API_KEY"]
  },
  {
    id: "xiaoyunque",
    name: "小云雀 AI",
    provider: "小云雀 AI",
    description: "小云雀 AI 模型或视频生成 API。迁移时需要确认控制台、模型名、API Key 和额度。",
    aliases: ["小云雀", "小云雀ai", "小云雀 ai", "xiaoyunque", "xiao yunque"],
    strongNeedles: ["小云雀ai", "小云雀 ai", "xiaoyunque"],
    envKeys: ["XIAOYUNQUE_API_KEY", "XIAOYUNQUE_AI_API_KEY"]
  },
  {
    id: "openai",
    name: "OpenAI",
    provider: "OpenAI",
    description: "OpenAI API 或兼容模型调用。迁移时需要重新配置 API Key、组织/项目和额度。",
    aliases: ["openai", "gpt-4", "gpt-5", "responses api", "chat completions"],
    strongNeedles: ["api.openai.com", "OPENAI_API_KEY", "responses.create", "chat.completions"],
    envKeys: ["OPENAI_API_KEY"]
  },
  {
    id: "gemini",
    name: "Gemini",
    provider: "Google",
    description: "Google Gemini API。迁移时需要重新配置 Google API Key 或 Vertex AI 授权。",
    aliases: ["gemini", "google ai", "vertex ai", "google generative ai"],
    strongNeedles: ["generativelanguage.googleapis.com", "vertexai", "gemini-"],
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]
  },
  {
    id: "qwen",
    name: "通义千问/Qwen",
    provider: "Alibaba Cloud",
    description: "通义千问或 DashScope API。迁移时需要重新配置 DashScope Key 和模型名。",
    aliases: ["qwen", "通义", "通义千问", "dashscope", "百炼"],
    strongNeedles: ["dashscope.aliyuncs.com", "dashscope", "qwen-"],
    envKeys: ["DASHSCOPE_API_KEY", "QWEN_API_KEY", "ALIYUN_API_KEY"]
  },
  {
    id: "moonshot",
    name: "Kimi/Moonshot",
    provider: "Moonshot AI",
    description: "Kimi/Moonshot API。迁移时需要重新配置 API Key、Base URL 和模型名。",
    aliases: ["moonshot", "kimi", "kimi k2", "moonshot-v1"],
    strongNeedles: ["api.moonshot.cn", "moonshot-v1", "kimi-k2"],
    envKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY"]
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    provider: "Zhipu AI",
    description: "智谱 GLM API。迁移时需要重新配置 API Key 和模型名。",
    aliases: ["zhipu", "智谱", "glm", "chatglm"],
    strongNeedles: ["open.bigmodel.cn", "glm-4", "chatglm"],
    envKeys: ["ZHIPU_API_KEY", "BIGMODEL_API_KEY"]
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    provider: "SiliconFlow",
    description: "硅基流动模型 API。迁移时需要重新配置 API Key、Base URL 和模型名。",
    aliases: ["siliconflow", "硅基流动"],
    strongNeedles: ["api.siliconflow.cn", "siliconflow"],
    envKeys: ["SILICONFLOW_API_KEY"]
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    provider: "OpenRouter",
    description: "OpenRouter 多模型路由 API。迁移时需要重新配置 API Key、Base URL 和模型路由。",
    aliases: ["openrouter", "open router"],
    strongNeedles: ["openrouter.ai/api", "OPENROUTER_API_KEY"],
    envKeys: ["OPENROUTER_API_KEY"]
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    provider: "Anthropic",
    description: "Anthropic Claude API。迁移时需要重新配置 API Key 和模型名。",
    aliases: ["anthropic", "claude"],
    strongNeedles: ["api.anthropic.com", "claude-"],
    envKeys: ["ANTHROPIC_API_KEY"]
  },
  {
    id: "minimax",
    name: "MiniMax",
    provider: "MiniMax",
    description: "MiniMax 文本、语音或视频 API。迁移时需要重新配置 API Key、Group ID 和模型名。",
    aliases: ["minimax", "海螺", "abab"],
    strongNeedles: ["api.minimax.chat", "api.minimaxi.com", "abab"],
    envKeys: ["MINIMAX_API_KEY", "MINIMAX_GROUP_ID"]
  },
  {
    id: "replicate",
    name: "Replicate",
    provider: "Replicate",
    description: "Replicate 模型托管 API。迁移时需要重新配置 API Token 和模型版本。",
    aliases: ["replicate"],
    strongNeedles: ["api.replicate.com", "replicate.run"],
    envKeys: ["REPLICATE_API_TOKEN", "REPLICATE_API_KEY"]
  },
  {
    id: "stability",
    name: "Stability AI",
    provider: "Stability AI",
    description: "Stability AI 图像生成 API。迁移时需要重新配置 API Key 和模型参数。",
    aliases: ["stability ai", "stable diffusion", "stability"],
    strongNeedles: ["api.stability.ai", "stable-image"],
    envKeys: ["STABILITY_API_KEY"]
  },
  {
    id: "runway",
    name: "Runway",
    provider: "Runway",
    description: "Runway 视频生成 API。迁移时需要重新配置 API Key 和模型名。",
    aliases: ["runway", "gen-3", "gen-4"],
    strongNeedles: ["api.runwayml.com", "runwayml", "gen-4"],
    envKeys: ["RUNWAY_API_KEY", "RUNWAYML_API_SECRET"]
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    provider: "ElevenLabs",
    description: "ElevenLabs 语音 API。迁移时需要重新配置 API Key、Voice ID 和额度。",
    aliases: ["elevenlabs", "eleven labs"],
    strongNeedles: ["api.elevenlabs.io", "xi-api-key"],
    envKeys: ["ELEVENLABS_API_KEY", "ELEVEN_LABS_API_KEY"]
  },
  {
    id: "heygen",
    name: "HeyGen",
    provider: "HeyGen",
    description: "HeyGen 数字人或视频 API。迁移时需要重新配置 API Key 和素材权限。",
    aliases: ["heygen"],
    strongNeedles: ["api.heygen.com", "HEYGEN_API_KEY"],
    envKeys: ["HEYGEN_API_KEY"]
  }
];

const API_CONTEXT_TERMS = [
  "api", "api key", "apikey", "key", "token", "secret", "base_url", "base url", "endpoint",
  "model", "sdk", "curl", "http", "https://", "console", "控制台", "调用", "请求", "模型",
  "密钥", "令牌", "环境变量", "额度", "鉴权", "认证", "openapi", "access key", "ak/sk"
];

function contextAround(text, needle, radius = 180) {
  const index = text.indexOf(needle);
  if (index < 0) return "";
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + needle.length + radius));
}

function hasApiEvidence(tool, text) {
  const haystack = String(text || "").toLowerCase();
  const strongNeedles = [...(tool.strongNeedles || []), ...(tool.envKeys || [])]
    .map((value) => String(value || "").toLowerCase());
  if (strongNeedles.some((needle) => needle && haystack.includes(needle))) return true;
  if (!tool.allowContextEvidence) return false;
  return (tool.aliases || []).some((alias) => {
    const needle = String(alias || "").toLowerCase();
    if (!needle || !haystack.includes(needle)) return false;
    const nearby = contextAround(haystack, needle);
    return API_CONTEXT_TERMS.some((term) => nearby.includes(term));
  });
}

function apiUsageForTool(tool, conversations) {
  const projects = new Map();
  let usageCount = 0;
  let lastUsedAt = null;
  const pathKey = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const appProjectPath = pathKey(process.cwd());
  for (const conversation of conversations) {
    const conversationProjectPath = conversation.projectPath ? pathKey(conversation.projectPath) : "";
    if (conversationProjectPath === appProjectPath) continue;
    if (!hasApiEvidence(tool, conversation.searchText)) continue;
    usageCount += 1;
    const seenAt = conversation.startedAt || conversation.modifiedAt;
    if (!lastUsedAt || seenAt > lastUsedAt) lastUsedAt = seenAt;
    const projectKey = conversation.projectPath || "__unknown__";
    if (!projects.has(projectKey)) {
      projects.set(projectKey, {
        projectName: conversation.projectName,
        projectPath: conversation.projectPath,
        count: 0,
        latestAt: seenAt
      });
    }
    const project = projects.get(projectKey);
    project.count += 1;
    if (seenAt > project.latestAt) project.latestAt = seenAt;
  }
  return {
    usageCount,
    lastUsedAt,
    usedInProjects: [...projects.values()]
      .sort((a, b) => b.latestAt.localeCompare(a.latestAt))
      .slice(0, 8)
  };
}

function titleFromEnvPrefix(prefix) {
  return prefix
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

function customApiToolsFromConfig(configText, knownEnvKeys) {
  const matches = configText.match(/\b[A-Z][A-Z0-9_]{2,}_(?:API_KEY|ACCESS_KEY|SECRET_KEY|TOKEN)\b/gi) || [];
  const seen = new Set();
  return matches
    .map((key) => key.toUpperCase())
    .filter((key) => !knownEnvKeys.has(key))
    .filter((key) => {
      const prefix = key.replace(/_(?:API_KEY|ACCESS_KEY|SECRET_KEY|TOKEN)$/i, "");
      if (!prefix || seen.has(prefix)) return false;
      seen.add(prefix);
      return true;
    })
    .map((key) => {
      const prefix = key.replace(/_(?:API_KEY|ACCESS_KEY|SECRET_KEY|TOKEN)$/i, "");
      const name = `${titleFromEnvPrefix(prefix)} API`;
      return {
        selectId: `api_tool:custom:${prefix.toLowerCase()}`,
        name,
        provider: "Custom API",
        description: "本地配置中识别到的自定义 API 凭据。迁移时需要在新设备重新配置对应 Key、Base URL 和调用限额。",
        aliases: [prefix.toLowerCase(), name.toLowerCase()],
        envKeys: [key],
        type: "api_tool",
        path: `api:custom:${prefix.toLowerCase()}`,
        usageCount: 0,
        usedInProjects: [],
        lastUsedAt: null,
        configured: true,
        migrationStatus: "verify_or_reauthorize",
        installAction: "在新设备重新配置该自定义 API 的 Key、Base URL、模型名和额度；Codex Link 不会明文备份密钥。",
        evidence: {
          configured: true,
          mentionedInConfig: true,
          usageCount: 0
        }
      };
    });
}

function listApiTools(codexHome, conversations) {
  const configText = [
    readTextSafe(path.join(codexHome, "config.toml"), 500000),
    readTextSafe(path.join(codexHome, ".env"), 200000),
    readTextSafe(path.join(codexHome, "AGENTS.md"), 200000)
  ].join("\n").toLowerCase();

  const knownEnvKeys = new Set(API_TOOL_CATALOG.flatMap((tool) => tool.envKeys || []).map((key) => key.toUpperCase()));
  const catalogTools = API_TOOL_CATALOG.map((tool) => {
    const hasConfiguredKey = tool.envKeys.some((key) => Boolean(process.env[key]) || configText.includes(key.toLowerCase()));
    const mentioned = hasApiEvidence(tool, configText);
    const usage = apiUsageForTool(tool, conversations || []);
    return {
      selectId: `api_tool:${tool.id}`,
      name: tool.name,
      provider: tool.provider,
      description: tool.description,
      aliases: tool.aliases,
      envKeys: tool.envKeys,
      type: "api_tool",
      path: `api:${tool.id}`,
      usageCount: usage.usageCount,
      usedInProjects: usage.usedInProjects,
      lastUsedAt: usage.lastUsedAt,
      configured: hasConfiguredKey,
      migrationStatus: hasConfiguredKey ? "verify_or_reauthorize" : (mentioned || usage.usageCount > 0) ? "missing_api_key" : "not_configured",
      installAction: "在新设备配置 API Key、Base URL、模型名和调用限额；Codex Link 不会明文备份密钥。",
      evidence: {
        configured: hasConfiguredKey,
        mentionedInConfig: mentioned,
        usageCount: usage.usageCount
      }
    };
  })
    .filter((tool) => tool.configured || tool.evidence.mentionedInConfig || tool.usageCount > 0)
    .sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));
  return [...catalogTools, ...customApiToolsFromConfig(configText, knownEnvKeys)];
}

function listCapabilities(codexHome) {
  const userSkillRoot = path.join(os.homedir(), ".agents", "skills");
  const files = [
    ...findSkillFiles(path.join(codexHome, "skills"), "local_skill"),
    ...findSkillFiles(userSkillRoot, "user_skill"),
    ...findSkillFiles(path.join(codexHome, "plugins", "cache"), "plugin_skill", 500)
      .filter((item) => item.path.includes(`${path.sep}skills${path.sep}`))
  ];
  const seen = new Set();
  return files
    .map(parseSkill)
    .filter((capability) => {
      const key = `${capability.type}:${capability.name}:${capability.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

function listPlugins(codexHome) {
  const root = path.join(codexHome, "plugins", "cache");
  if (!exists(root)) return [];
  const manifests = [];
  function visit(current, depth) {
    if (manifests.length >= 120 || depth > 7) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(child, depth + 1);
      } else if (entry.name === "plugin.json" && current.endsWith(".codex-plugin")) {
        const raw = readTextSafe(child, 200000);
        let json = {};
        try {
          json = JSON.parse(raw);
        } catch {
          json = {};
        }
        manifests.push({
          name: json.name || path.basename(path.dirname(current)),
          displayName: json.interface?.displayName || json.display_name || json.name || path.basename(path.dirname(current)),
          path: child,
          migrationStatus: "reinstall_or_verify_on_target"
        });
      }
      if (manifests.length >= 120) break;
    }
  }
  visit(root, 0);
  return manifests;
}

function parseMcpServers(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  const text = readTextSafe(configPath, 400000);
  const matches = [...text.matchAll(/^\s*\[mcp_servers\.([^\]\s]+)\]/gm)];
  const names = new Set();
  for (const match of matches) {
    const name = match[1].replace(/^"|"$/g, "");
    if (!/\.(env|tools)(\.|$)/.test(name)) names.add(name);
  }
  return [...names].map((name) => ({
    name,
    source: "config.toml",
    migrationStatus: "check_command_path_and_auth_on_target"
  }));
}

function findWindowsPathRefs(codexHome) {
  const text = readTextSafe(path.join(codexHome, "config.toml"), 800000);
  const refs = new Set();
  for (const match of text.matchAll(/[A-Za-z]:\\[^"'\r\n]+/g)) {
    refs.add(match[0]);
  }
  return [...refs].slice(0, 80);
}

function firstTextFromContent(content) {
  if (!Array.isArray(content)) return "";
  for (const item of content) {
    if (typeof item?.text === "string") return item.text;
  }
  return "";
}

function cleanConversationText(text) {
  return String(text || "")
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/g, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/g, "")
    .replace(/# Files mentioned by the user:[\s\S]*?(?=\n\n|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function projectLabelFromPath(projectPath) {
  if (!projectPath) return "未识别项目";
  const normalized = projectPath.replace(/[\\/]+$/, "");
  const name = path.posix.basename(normalized.replace(/\\/g, "/"));
  return name || projectPath;
}

function inferTimeFromSessionPath(filePath, fallback) {
  const name = path.basename(filePath);
  const match = name.match(/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  if (!match) return fallback;
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function parseConversationFile(file) {
  const text = readTextSafe(file.path, 700000);
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 900);
  let projectPath = "";
  let title = "";
  let lastUserText = "";
  let sessionId = "";
  let startedAt = inferTimeFromSessionPath(file.path, file.modifiedAt);

  for (const line of lines) {
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!startedAt && event.timestamp) startedAt = event.timestamp;
    if (event.timestamp && event.type === "session_meta") startedAt = event.timestamp;
    const payload = event.payload || {};

    if (event.type === "session_meta") {
      sessionId = payload.id || payload.session_id || sessionId;
      projectPath = payload.cwd || projectPath;
      if (payload.timestamp) startedAt = payload.timestamp;
    }
    if (event.type === "turn_context") {
      projectPath = payload.cwd || projectPath;
    }
    if (event.type === "event_msg" && payload.type === "user_message") {
      const cleaned = cleanConversationText(payload.message);
      if (cleaned) {
        lastUserText = cleaned;
        if (!title) title = cleaned;
      }
    }
    if (event.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const cleaned = cleanConversationText(firstTextFromContent(payload.content));
      if (cleaned) {
        lastUserText = cleaned;
        if (!title) title = cleaned;
      }
    }
  }

  const shortTitle = title || lastUserText || path.basename(file.path);
  const projectName = projectLabelFromPath(projectPath);
  return {
    selectId: `conversation:${file.path}`,
    id: sessionId || path.basename(file.path).replace(/\.(jsonl|md)$/i, ""),
    title: shortTitle.length > 96 ? `${shortTitle.slice(0, 96)}...` : shortTitle,
    summary: lastUserText.length > 180 ? `${lastUserText.slice(0, 180)}...` : lastUserText,
    projectName,
    projectPath,
    path: file.path,
    sizeMb: toMb(file.size),
    modifiedAt: file.modifiedAt,
    startedAt,
    bucket: file.bucket,
    searchText: `${shortTitle} ${lastUserText} ${projectPath} ${text.slice(0, 500000)}`.toLowerCase(),
    dateKey: new Date(startedAt || file.modifiedAt).toISOString().slice(0, 10)
  };
}

function listConversationFiles(codexHome) {
  const roots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  const files = [];
  for (const root of roots) {
    if (!exists(root)) continue;
    const info = walk(root, { includeFiles: true, maxFiles: 12000, maxDepth: 8 });
    for (const file of info.files) {
      if (file.path.endsWith(".jsonl") || file.path.endsWith(".md")) {
        files.push({
          path: file.path,
          sizeMb: toMb(file.size),
          modifiedAt: file.modifiedAt,
          bucket: root.endsWith("archived_sessions") ? "archived" : "active"
        });
      }
    }
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function listRecentConversations(codexHome) {
  return listConversationFiles(codexHome)
    .slice(0, 80)
    .map(parseConversationFile)
    .sort((a, b) => (b.startedAt || b.modifiedAt).localeCompare(a.startedAt || a.modifiedAt));
}

function groupConversations(conversations) {
  const map = new Map();
  for (const conversation of conversations) {
    const key = conversation.projectPath || "__unknown__";
    if (!map.has(key)) {
      map.set(key, {
        projectName: conversation.projectName,
        projectPath: conversation.projectPath,
        count: 0,
        latestAt: conversation.startedAt || conversation.modifiedAt,
        conversations: []
      });
    }
    const group = map.get(key);
    group.count += 1;
    group.conversations.push(conversation);
    if ((conversation.startedAt || conversation.modifiedAt) > group.latestAt) {
      group.latestAt = conversation.startedAt || conversation.modifiedAt;
    }
  }
  return [...map.values()]
    .map((group) => ({
      ...group,
      conversations: group.conversations.sort((a, b) => (b.startedAt || b.modifiedAt).localeCompare(a.startedAt || a.modifiedAt))
    }))
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

function enrichCapabilitiesWithUsage(capabilities, conversations) {
  const projectLimit = 8;
  return capabilities.map((capability) => {
    const needles = [capability.name, ...(capability.aliases || [])]
      .map((value) => String(value || "").toLowerCase().trim())
      .filter((value, index, list) => value.length >= 2 && list.indexOf(value) === index);
    if (!needles.length) return capability;
    let usageCount = 0;
    let lastUsedAt = null;
    const projects = new Map();

    for (const conversation of conversations) {
      const haystack = conversation.searchText || "";
      if (!needles.some((needle) => haystack.includes(needle))) continue;
      usageCount += 1;
      const seenAt = conversation.startedAt || conversation.modifiedAt;
      if (!lastUsedAt || seenAt > lastUsedAt) lastUsedAt = seenAt;
      const projectKey = conversation.projectPath || "__unknown__";
      if (!projects.has(projectKey)) {
        projects.set(projectKey, {
          projectName: conversation.projectName,
          projectPath: conversation.projectPath,
          count: 0,
          latestAt: seenAt
        });
      }
      const project = projects.get(projectKey);
      project.count += 1;
      if (seenAt > project.latestAt) project.latestAt = seenAt;
    }

    return {
      ...capability,
      usageCount,
      lastUsedAt,
      usedInProjects: [...projects.values()]
        .sort((a, b) => b.latestAt.localeCompare(a.latestAt))
        .slice(0, projectLimit)
    };
  });
}

function stripPrivateSearchText(conversations) {
  return conversations.map(({ searchText, ...conversation }) => conversation);
}

function listMacManualChecks(codexHome) {
  const toolsPath = path.join(codexHome, "tools");
  if (!exists(toolsPath)) return [];
  return walk(toolsPath, { includeFiles: true, maxFiles: 15000, maxDepth: 12 }).files
    .filter((file) => /\.(exe|dll|bat|cmd|ps1)$/i.test(file.path))
    .slice(0, 80)
    .map((file) => ({
      path: file.path,
      issue: "needs_mac_equivalent_or_manual_check"
    }));
}

function auditCodex(codexHome) {
  const resolvedHome = path.resolve(codexHome || defaultCodexHome());
  const sections = sectionStats(resolvedHome);
  const totalMb = Math.round(sections.reduce((sum, section) => sum + section.sizeMb, 0) * 100) / 100;
  const rawCapabilities = listCapabilities(resolvedHome);
  const plugins = listPlugins(resolvedHome);
  const mcpServers = parseMcpServers(resolvedHome);
  const parsedConversations = listRecentConversations(resolvedHome);
  const capabilities = enrichCapabilitiesWithUsage(rawCapabilities, parsedConversations);
  const apiTools = listApiTools(resolvedHome, parsedConversations);
  const conversations = stripPrivateSearchText(parsedConversations);
  const conversationGroups = groupConversations(conversations);
  const windowsPathRefs = findWindowsPathRefs(resolvedHome);
  const macManualChecks = listMacManualChecks(resolvedHome);
  const recommendedCloudQuota = totalMb > 20000 ? "200GB+" : totalMb > 10000 ? "100GB" : "50GB";
  return {
    generatedAt: new Date().toISOString(),
    sourceOS: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : process.platform,
    targetOSHint: process.platform === "win32" ? "macOS" : "Windows/macOS",
    codexHome: resolvedHome,
    totalMb,
    recommendedCloudQuota,
    sections,
    capabilities,
    apiTools,
    plugins,
    mcpServers,
    conversations,
    conversationGroups,
    windowsPathRefs,
    macManualChecks,
    restorePriority: [
      "P0: sessions, archived_sessions, state_5.sqlite, memories, AGENTS.md, config.toml",
      "P1: skills and project rules, with path conversion",
      "P2: local tools and runtime dependencies",
      "P3: plugins, OAuth connectors, auth.json",
      "P4: Windows-only executable files"
    ]
  };
}

function selectedSections(include) {
  return SECTION_DEFS.filter((section) => include?.[section.key]);
}

function snapshotPlan(codexHome, include) {
  const sections = sectionStats(codexHome);
  const wanted = new Set(selectedSections(include).map((section) => section.key));
  const selected = sections.filter((section) => wanted.has(section.key) && section.exists);
  return {
    selected,
    totalMb: Math.round(selected.reduce((sum, section) => sum + section.sizeMb, 0) * 100) / 100,
    warnings: selected
      .filter((section) => ["plugins", "tools", "auth"].includes(section.key))
      .map((section) => `${section.label} 可能需要在新设备重新校验或重新授权。`)
  };
}

let lastSnapshotTimestamp = "";
let snapshotTimestampSequence = 0;

function timestampId() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  const base = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}`;
  snapshotTimestampSequence = base === lastSnapshotTimestamp ? snapshotTimestampSequence + 1 : 0;
  lastSnapshotTimestamp = base;
  return snapshotTimestampSequence ? `${base}-${snapshotTimestampSequence}` : base;
}

function testRestoreBaseDir(baseDir) {
  return path.resolve(baseDir || path.join(os.homedir(), "Documents", "CodexLink-Restore-Test"));
}

function createTestRestoreEnvironment({ baseDir } = {}) {
  const base = testRestoreBaseDir(baseDir);
  const root = path.join(base, timestampId());
  const codexHome = path.join(root, ".codex");
  const projectsRoot = path.join(root, "projects");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
  const metadata = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    kind: "codex-link-isolated-restore-test",
    root,
    codexHome,
    projectsRoot
  };
  fs.writeFileSync(path.join(root, ".codex-link-test-environment.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return metadata;
}

function deleteTestRestoreEnvironment({ root, baseDir }) {
  const base = testRestoreBaseDir(baseDir);
  const target = path.resolve(root || "");
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Test environment is outside the managed test root.");
  }
  const markerPath = path.join(target, ".codex-link-test-environment.json");
  if (!exists(markerPath)) throw new Error("Managed test environment marker is missing.");
  fs.rmSync(target, { recursive: true, force: true });
  return { deleted: true, root: target };
}

function measureCopyPath(target) {
  const result = { totalBytes: 0, fileCount: 0 };
  function visit(current) {
    const st = statSafe(current, true);
    if (!st) return;
    if (st.isSymbolicLink()) {
      result.totalBytes += Buffer.byteLength(fs.readlinkSync(current));
      result.fileCount += 1;
      return;
    }
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        visit(path.join(current, entry.name));
      }
      return;
    }
    if (st.isFile()) {
      result.totalBytes += st.size;
      result.fileCount += 1;
    }
  }
  visit(target);
  return result;
}

function copyPath(src, dest, options = {}) {
  const onChunk = typeof options.onChunk === "function" ? options.onChunk : () => {};
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  function copyEntry(source, target) {
    const st = statSafe(source, true);
    if (!st) throw new Error(`备份源在复制时消失：${source}`);
    if (st.isSymbolicLink()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { recursive: true, force: true });
      const linkTarget = fs.readlinkSync(source);
      fs.symlinkSync(linkTarget, target);
      onChunk({ bytes: Buffer.byteLength(linkTarget), fileCompleted: true, source });
      return;
    }
    if (st.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        copyEntry(path.join(source, entry.name), path.join(target, entry.name));
      }
      return;
    }
    if (!st.isFile()) throw new Error(`不支持的备份文件类型：${source}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const sourceFd = fs.openSync(source, "r");
    const targetFd = fs.openSync(target, "w", st.mode);
    let copied = 0;
    try {
      while (copied < st.size) {
        const bytesRead = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, st.size - copied), copied);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) {
          written += fs.writeSync(targetFd, buffer, written, bytesRead - written, copied + written);
        }
        copied += bytesRead;
        onChunk({ bytes: bytesRead, fileCompleted: copied >= st.size, source });
      }
      if (st.size === 0) onChunk({ bytes: 0, fileCompleted: true, source });
    } finally {
      fs.closeSync(sourceFd);
      fs.closeSync(targetFd);
    }
    try {
      fs.chmodSync(target, st.mode);
      fs.utimesSync(target, st.atime, st.mtime);
    } catch {}
  }
  copyEntry(src, dest);
}

function createSnapshot({ codexHome, cloudDir, include, selected, retainSnapshots, dryRun, onProgress = () => {} }) {
  onProgress({ progress: 2, stage: "scanning", message: "正在扫描所选备份内容" });
  const resolvedHome = path.resolve(codexHome || defaultCodexHome());
  const resolvedCloud = path.resolve(cloudDir || defaultCloudDir());
  const plan = snapshotPlan(resolvedHome, include);
  const selectedEntries = selectedSnapshotEntries(resolvedHome, selected);
  const copied = selectedEntries.copied.filter((item) => {
    if (item.kind === "conversation" && (include?.sessions || include?.archivedSessions)) return false;
    if (item.kind === "capability" && include?.skills) return false;
    return true;
  });
  const id = timestampId();
  const snapshotDir = path.join(resolvedCloud, BACKUP_ROOT_DIR, RESTORE_POINTS_DIR, id);
  let projectCatalog = buildPortableProjectCatalog({
    codexHome: resolvedHome,
    sourcePlatform: process.platform,
    projectFilesIncluded: false
  });
  const backedConversations = listRecentConversations(resolvedHome).filter((item) =>
    (item.bucket === "archived" ? include?.archivedSessions : include?.sessions)
  );
  const fullSkillCount = include?.skills
    ? findSkillFiles(path.join(resolvedHome, "skills"), "local_skill", 2000).length
    : 0;
  const contentCounts = {
    projects: new Set([
      ...backedConversations.map((item) => item.projectPath || "__unknown__"),
      ...copied.filter((item) => item.kind === "conversation").map((item) => item.projectPath || "__unknown__")
    ]).size,
    conversations: backedConversations.length + copied.filter((item) => item.kind === "conversation").length,
    skills: fullSkillCount + copied.filter((item) => item.kind === "capability").length,
    apiConfigurationNotes: copied.filter((item) => item.kind === "api_tool" || item.metadataOnly).length
  };
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    sourceOS: process.platform,
    sourceArch: process.arch,
    snapshotKind: copied.length ? "raw-unified" : "raw",
    adaptationStrategy: "local_restore_time",
    supportedDeployTargets: ["windows", "macos", "linux"],
    codexHome: resolvedHome,
    include,
    plan,
    selectionMode: copied.length > 0,
    selectedCounts: { ...selectedEntries.selectedCounts, copied: copied.length },
    contentCounts,
    copied,
    portableProjects: {
      schemaVersion: projectCatalog.schemaVersion,
      path: "payload/projects.json",
      projectCount: projectCatalog.projectCount,
      threadCount: projectCatalog.threadCount,
      projectFilesIncluded: false
    },
    appVersion: APP_VERSION
  };

  if (dryRun) {
    onProgress({ progress: 100, stage: "completed", message: "备份计划已生成", completedUnits: 1, totalUnits: 1 });
    return { dryRun: true, snapshotDir, manifest };
  }

  fs.mkdirSync(snapshotDir, { recursive: true });
  const includedSections = selectedSections(include)
    .filter((section) => exists(path.join(resolvedHome, section.relativePath)));
  const copiedEntries = copied.filter((item) => !item.metadataOnly);
  const copyJobs = [
    ...includedSections.map((section) => ({
      source: path.join(resolvedHome, section.relativePath),
      target: path.join(snapshotDir, "payload", section.relativePath),
      label: section.label,
      sqlite: section.key === "stateDb"
    })),
    ...copiedEntries.map((item) => ({
      source: item.source,
      target: path.join(snapshotDir, item.target),
      label: item.title || item.name || item.kind || "所选内容"
    }))
  ].map((job) => ({ ...job, measure: measureCopyPath(job.source) }));
  const totalBytes = copyJobs.reduce((sum, job) => sum + job.measure.totalBytes, 0);
  const totalUnits = Math.max(1, copyJobs.reduce((sum, job) => sum + job.measure.fileCount, 0));
  let completedBytes = 0;
  let completedUnits = 0;
  let lastCopyProgress = 9;
  onProgress({ progress: 10, stage: "preparing", message: `已确认 ${totalUnits} 个文件，准备写入恢复点`, completedUnits, totalUnits, completedBytes, totalBytes });
  for (const job of copyJobs) {
    if (job.sqlite) {
      onProgress({ progress: Math.max(10, lastCopyProgress), stage: "copying", message: "正在通过 SQLite 一致性快照保存任务索引" });
      createConsistentSQLiteCopy(job.source, job.target);
      completedBytes += job.measure.totalBytes;
      completedUnits += Math.max(1, job.measure.fileCount);
      continue;
    }
    copyPath(job.source, job.target, {
      onChunk: ({ bytes, fileCompleted, source }) => {
        completedBytes += Number(bytes || 0);
        if (fileCompleted) completedUnits += 1;
        const ratio = totalBytes > 0 ? completedBytes / totalBytes : completedUnits / totalUnits;
        const progress = Math.min(88, 10 + Math.floor(Math.max(0, Math.min(1, ratio)) * 78));
        if (progress > lastCopyProgress || fileCompleted) {
          lastCopyProgress = Math.max(lastCopyProgress, progress);
          onProgress({
            progress: lastCopyProgress,
            stage: "copying",
            message: `正在写入${job.label} · ${path.basename(source)}`,
            completedUnits,
            totalUnits,
            completedBytes,
            totalBytes
          });
        }
      }
    });
  }
  fs.mkdirSync(path.join(snapshotDir, "payload"), { recursive: true });
  projectCatalog = buildPortableProjectCatalog({
    codexHome: path.join(snapshotDir, "payload"),
    stateDbPath: path.join(snapshotDir, "payload", "state_5.sqlite"),
    sessionRoots: [
      path.join(snapshotDir, "payload", "sessions"),
      path.join(snapshotDir, "payload", "archived_sessions"),
      path.join(snapshotDir, "payload", "selected", "conversations")
    ],
    sourcePlatform: process.platform,
    projectFilesIncluded: false
  });
  Object.assign(manifest.portableProjects, {
    projectCount: projectCatalog.projectCount,
    threadCount: projectCatalog.threadCount
  });
  fs.writeFileSync(path.join(snapshotDir, "payload", "projects.json"), `${JSON.stringify(projectCatalog, null, 2)}\n`, "utf8");
  const sqliteSnapshotPath = path.join(snapshotDir, "payload", "state_5.sqlite");
  if (fs.existsSync(sqliteSnapshotPath)) {
    const sqlite = validateSQLiteDatabase(sqliteSnapshotPath, { requireAllRollouts: false });
    manifest.sqlite = {
      path: "payload/state_5.sqlite",
      size: sqlite.actualSize,
      pageSize: sqlite.pageSize,
      pageCount: sqlite.pageCount,
      threadCount: sqlite.threadCount,
      quickCheck: sqlite.quickCheck,
      integrityCheck: sqlite.integrityCheck
    };
  }
  onProgress({ progress: 92, stage: "verifying", message: "文件写入完成，正在逐项生成 SHA-256 校验", completedUnits, totalUnits, completedBytes, totalBytes });
  let verifiedBytes = 0;
  let verifiedUnits = 0;
  let lastVerifyProgress = 91;
  finalizeSnapshotManifest(snapshotDir, manifest, {
    onHashChunk: ({ bytes }) => {
      verifiedBytes += Number(bytes || 0);
      const ratio = totalBytes > 0 ? verifiedBytes / totalBytes : verifiedUnits / totalUnits;
      const progress = Math.min(98, 92 + Math.floor(Math.max(0, Math.min(1, ratio)) * 6));
      if (progress > lastVerifyProgress) {
        lastVerifyProgress = progress;
        onProgress({
          progress,
          stage: "verifying",
          message: "正在逐文件计算 SHA-256",
          completedUnits: verifiedUnits,
          totalUnits,
          completedBytes: verifiedBytes,
          totalBytes
        });
      }
    },
    onEntry: () => { verifiedUnits += 1; }
  });
  onProgress({ progress: 99, stage: "retention", message: "完整性校验完成，正在整理历史恢复点", completedUnits: totalUnits, totalUnits, completedBytes: totalBytes, totalBytes });
  const retention = enforceSnapshotRetention(resolvedCloud, retainSnapshots, snapshotDir);
  onProgress({ progress: 100, stage: "completed", message: "备份已创建并完成校验", completedUnits: totalUnits, totalUnits });
  return { dryRun: false, snapshotDir, manifest, retention };
}

function safeFileName(value) {
  return String(value || "item")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 120);
}

function relativeOrBasename(base, target) {
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return path.basename(target);
  }
  return relative;
}

function selectedSnapshotEntries(resolvedHome, selected) {
  const selection = selected || {};
  const conversations = Array.isArray(selection.conversations) ? selection.conversations : [];
  const capabilities = Array.isArray(selection.capabilities) ? selection.capabilities : [];
  const copied = [];

  for (const item of conversations) {
    if (!item?.path || !exists(item.path)) continue;
    copied.push({
      kind: "conversation",
      title: item.title || path.basename(item.path),
      threadId: item.id || "",
      projectName: item.projectName || "",
      projectPath: item.projectPath || "",
      startedAt: item.startedAt || item.modifiedAt || null,
      source: item.path,
      target: portablePath(path.join("payload", "selected", "conversations", relativeOrBasename(resolvedHome, item.path)))
    });
  }

  for (const item of capabilities) {
    if (item?.type === "api_tool") {
      copied.push({
        kind: "api_tool",
        name: item.name || "API Tool",
        capabilityType: "api_tool",
        usageCount: item.usageCount || 0,
        usedInProjects: item.usedInProjects || [],
        provider: item.provider || "",
        configured: Boolean(item.configured),
        migrationStatus: item.migrationStatus || "not_configured",
        action: item.action || item.installAction || "Configure API credentials on the target device.",
        metadataOnly: true
      });
      continue;
    }
    if (!item?.path || !exists(item.path)) continue;
    const sourceStat = statSafe(item.path);
    const source = sourceStat?.isFile() && path.basename(item.path).toLowerCase() === "skill.md"
      ? path.dirname(item.path)
      : item.path;
    copied.push({
      kind: "capability",
      name: item.name || path.basename(source),
      capabilityType: item.type || "unknown",
      usageCount: item.usageCount || 0,
      usedInProjects: item.usedInProjects || [],
      source,
      target: portablePath(path.join("payload", "selected", "capabilities", safeFileName(`${item.type || "capability"}-${item.name || path.basename(source)}`)))
    });
  }

  return {
    copied,
    selectedCounts: {
      conversations: conversations.length,
      capabilities: capabilities.length,
      copied: copied.length
    }
  };
}


function createSelectionSnapshot({ codexHome, cloudDir, selected, retainSnapshots, dryRun }) {
  const resolvedHome = path.resolve(codexHome || defaultCodexHome());
  const resolvedCloud = path.resolve(cloudDir || defaultCloudDir());
  const selection = selected || {};
  const conversations = Array.isArray(selection.conversations) ? selection.conversations : [];
  const capabilities = Array.isArray(selection.capabilities) ? selection.capabilities : [];
  const id = timestampId();
  const snapshotDir = path.join(resolvedCloud, BACKUP_ROOT_DIR, RESTORE_POINTS_DIR, `${id}-selected`);
  const copied = [];

  for (const item of conversations) {
    if (!item?.path || !exists(item.path)) continue;
    copied.push({
      kind: "conversation",
      title: item.title || path.basename(item.path),
      threadId: item.id || "",
      projectName: item.projectName || "",
      projectPath: item.projectPath || "",
      startedAt: item.startedAt || item.modifiedAt || null,
      source: item.path,
      target: portablePath(path.join("payload", "selected", "conversations", relativeOrBasename(resolvedHome, item.path)))
    });
  }

  for (const item of capabilities) {
    if (item?.type === "api_tool") {
      copied.push({
        kind: "api_tool",
        name: item.name || "API Tool",
        capabilityType: "api_tool",
        usageCount: item.usageCount || 0,
        usedInProjects: item.usedInProjects || [],
        provider: item.provider || "",
        configured: Boolean(item.configured),
        migrationStatus: item.migrationStatus || "not_configured",
        action: item.action || item.installAction || "Configure API credentials on the target device.",
        metadataOnly: true
      });
      continue;
    }
    if (!item?.path || !exists(item.path)) continue;
    const sourceStat = statSafe(item.path);
    const source = sourceStat?.isFile() && path.basename(item.path).toLowerCase() === "skill.md"
      ? path.dirname(item.path)
      : item.path;
    copied.push({
      kind: "capability",
      name: item.name || path.basename(source),
      capabilityType: item.type || "unknown",
      usageCount: item.usageCount || 0,
      usedInProjects: item.usedInProjects || [],
      source,
      target: portablePath(path.join("payload", "selected", "capabilities", safeFileName(`${item.type || "capability"}-${item.name || path.basename(source)}`)))
    });
  }

  const projectCatalog = buildPortableProjectCatalog({
    codexHome: resolvedHome,
    stateDbPath: "",
    sessionRoots: conversations.map((item) => item?.path).filter(Boolean),
    sourcePlatform: process.platform,
    projectFilesIncluded: false
  });
  const manifest = {
    id: `${id}-selected`,
    createdAt: new Date().toISOString(),
    sourceOS: process.platform,
    sourceArch: process.arch,
    snapshotKind: "raw-selected",
    adaptationStrategy: "local_restore_time",
    supportedDeployTargets: ["windows", "macos", "linux"],
    codexHome: resolvedHome,
    selectionMode: true,
    selectedCounts: {
      conversations: conversations.length,
      capabilities: capabilities.length,
      copied: copied.length
    },
    copied,
    portableProjects: {
      schemaVersion: projectCatalog.schemaVersion,
      path: "payload/projects.json",
      projectCount: projectCatalog.projectCount,
      threadCount: projectCatalog.threadCount,
      projectFilesIncluded: false
    },
    appVersion: APP_VERSION
  };

  if (dryRun) {
    return { dryRun: true, snapshotDir, manifest };
  }

  fs.mkdirSync(snapshotDir, { recursive: true });
  for (const item of copied) {
    if (item.metadataOnly) continue;
    copyPath(item.source, path.join(snapshotDir, item.target));
  }
  fs.mkdirSync(path.join(snapshotDir, "payload"), { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "payload", "projects.json"), `${JSON.stringify(projectCatalog, null, 2)}\n`, "utf8");
  finalizeSnapshotManifest(snapshotDir, manifest);
  const retention = enforceSnapshotRetention(resolvedCloud, retainSnapshots, snapshotDir);
  return { dryRun: false, snapshotDir, manifest, retention };
}

function normalizeRetention(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(30, Math.max(1, Math.trunc(parsed))) : 5;
}

function enforceSnapshotRetention(cloudDir, retainSnapshots, preserveSnapshotDir) {
  const limit = normalizeRetention(retainSnapshots);
  const root = path.resolve(cloudDir || defaultCloudDir(), BACKUP_ROOT_DIR, RESTORE_POINTS_DIR);
  if (!exists(root)) return { limit, removed: [], errors: [] };

  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const snapshotDir = path.join(root, entry.name);
      let createdAt = "";
      try {
        createdAt = JSON.parse(fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8")).createdAt || "";
      } catch {}
      return { id: entry.name, snapshotDir, createdAt, modifiedAt: statSafe(snapshotDir)?.mtimeMs || 0 };
    })
    .sort((a, b) => (b.createdAt || String(b.modifiedAt)).localeCompare(a.createdAt || String(a.modifiedAt)));

  const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const keep = new Set();
  if (preserveSnapshotDir) keep.add(pathKey(preserveSnapshotDir));
  for (const entry of entries) {
    if (keep.size >= limit) break;
    keep.add(pathKey(entry.snapshotDir));
  }

  const removed = [];
  const errors = [];
  for (const entry of entries) {
    if (keep.has(pathKey(entry.snapshotDir))) continue;
    try {
      deleteSnapshot({ cloudDir, snapshotDir: entry.snapshotDir });
      removed.push(entry.id);
    } catch (error) {
      errors.push({ id: entry.id, message: error.message });
    }
  }
  return { limit, removed, errors };
}

function snapshotDisplayStats(snapshotDir, manifest) {
  const embedded = manifest.portableProjects;
  if (embedded && (Number(embedded.projectCount || 0) > 0 || Number(embedded.threadCount || 0) > 0)) {
    return {
      projectCount: Number(embedded.projectCount || 0),
      threadCount: Number(embedded.threadCount || 0),
      projectFilesIncluded: Boolean(embedded.projectFilesIncluded),
      statsSource: "manifest",
      rebuiltFromLegacy: false
    };
  }
  const manifestPath = path.join(snapshotDir, "manifest.json");
  const cachePath = path.join(snapshotDir, "codex-link-derived-metadata.json");
  const manifestMtimeMs = statSafe(manifestPath)?.mtimeMs || 0;
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (cached?.schemaVersion === 1 && cached.manifestMtimeMs === manifestMtimeMs) return cached;
  } catch {}

  try {
    const catalog = loadOrRebuildProjectCatalog(snapshotDir, manifest);
    const derived = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      manifestMtimeMs,
      projectCount: Number(catalog.projectCount || 0),
      threadCount: Number(catalog.threadCount || 0),
      projectFilesIncluded: Boolean(catalog.projectFilesIncluded),
      statsSource: "legacy_rebuilt",
      rebuiltFromLegacy: true
    };
    const temp = `${cachePath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(derived, null, 2)}\n`, "utf8");
    fs.renameSync(temp, cachePath);
    return derived;
  } catch (error) {
    return {
      projectCount: 0,
      threadCount: 0,
      projectFilesIncluded: false,
      statsSource: "unavailable",
      rebuiltFromLegacy: false,
      statsError: error.message
    };
  }
}

function listSnapshots(cloudDir) {
  const base = path.resolve(cloudDir || defaultCloudDir());
  const roots = [
    path.join(base, BACKUP_ROOT_DIR, RESTORE_POINTS_DIR),
    path.join(base, BACKUP_ROOT_DIR, LEGACY_SNAPSHOTS_DIR)
  ];
  return roots
    .filter((root) => exists(root))
    .flatMap((root) => fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const snapshotDir = path.join(root, entry.name);
        let manifest = { id: entry.name };
        try {
          manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8"));
        } catch {}
        const displayStats = snapshotDisplayStats(snapshotDir, manifest);
        return {
          id: entry.name,
          snapshotDir,
          createdAt: manifest.createdAt || null,
          sourceOS: manifest.sourceOS || null,
          totalMb: manifest.plan?.totalMb || 0,
          include: manifest.include || {},
          integrityStatus: manifest.integrity?.algorithm === "sha256" ? "hash_recorded" : "unverified",
          integrityFileCount: manifest.integrity?.fileCount || 0,
          projectCount: displayStats.projectCount,
          threadCount: displayStats.threadCount,
          projectFilesIncluded: displayStats.projectFilesIncluded,
          statsSource: displayStats.statsSource,
          rebuiltFromLegacy: displayStats.rebuiltFromLegacy,
          statsError: displayStats.statsError || null
        };
      }))
    .sort((a, b) => (b.createdAt || b.id).localeCompare(a.createdAt || a.id));
}

function cleanUserSelectedPath(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function resolveRestorePointInput(inputPath) {
  const cleaned = cleanUserSelectedPath(inputPath);
  const resolvedInput = path.resolve(cleaned);
  if (exists(path.join(resolvedInput, "manifest.json"))) {
    return { snapshotDir: resolvedInput, selectedFromRoot: false, inputPath: cleaned };
  }

  const roots = [
    resolvedInput,
    path.join(resolvedInput, RESTORE_POINTS_DIR),
    path.join(resolvedInput, BACKUP_ROOT_DIR, RESTORE_POINTS_DIR)
  ];
  const candidates = [];
  [...new Set(roots.map((root) => path.resolve(root)))].forEach((root) => {
    if (!statSafe(root)?.isDirectory()) return;
    fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((entry) => {
        const snapshotDir = path.join(root, entry.name);
        const manifestPath = path.join(snapshotDir, "manifest.json");
        if (!exists(manifestPath)) return;
        let createdAt = "";
        try {
          createdAt = JSON.parse(fs.readFileSync(manifestPath, "utf8")).createdAt || "";
        } catch {}
        candidates.push({
          snapshotDir,
          sortKey: createdAt || String(statSafe(manifestPath)?.mtimeMs || 0).padStart(20, "0")
        });
      });
  });
  candidates.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  if (candidates.length) {
    return { snapshotDir: candidates[0].snapshotDir, selectedFromRoot: true, inputPath: cleaned };
  }
  return { snapshotDir: resolvedInput, selectedFromRoot: false, inputPath: cleaned };
}

function deleteSnapshot({ cloudDir, snapshotDir, id }) {
  const base = path.resolve(cloudDir || defaultCloudDir());
  const roots = [
    path.resolve(base, BACKUP_ROOT_DIR, RESTORE_POINTS_DIR),
    path.resolve(base, BACKUP_ROOT_DIR, LEGACY_SNAPSHOTS_DIR)
  ];
  const target = path.resolve(snapshotDir || path.join(roots[0], path.basename(String(id || ""))));
  const insideBackupRoot = roots.some((root) => {
    const relative = path.relative(root, target);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (!insideBackupRoot) {
    throw new Error("恢复点路径不在备份文件夹内。");
  }
  const st = statSafe(target);
  if (!st || !st.isDirectory()) {
    throw new Error("没有找到这个恢复点文件夹。");
  }
  fs.rmSync(target, { recursive: true, force: true });
  return {
    deleted: true,
    snapshotDir: target
  };
}

function currentOSId() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function normalizeOS(value) {
  const text = String(value || "").toLowerCase();
  if (["auto", "current", ""].includes(text)) return currentOSId();
  if (["win", "win32", "windows"].includes(text)) return "windows";
  if (["darwin", "mac", "macos", "osx"].includes(text)) return "macos";
  if (["linux", "ubuntu", "debian"].includes(text)) return "linux";
  return currentOSId();
}

function osLabel(osId) {
  return {
    windows: "Windows",
    macos: "macOS",
    linux: "Linux"
  }[osId] || osId;
}

function sourceOSId(value) {
  return normalizeOS(value || process.platform);
}

function pathStyleForOS(osId) {
  return osId === "windows" ? "C:\\Users\\name\\.codex" : "/Users/name/.codex";
}

function looksWindowsPath(value) {
  return /^[a-z]:\\/i.test(String(value || "")) || String(value || "").includes("\\");
}

function looksPosixPath(value) {
  return String(value || "").startsWith("/");
}

function buildAdaptationPlan({ manifest, targetCodexHome, targetOS, activeKeys }) {
  const sourceOS = sourceOSId(manifest.sourceOS);
  const sourceArch = manifest.sourceArch || "unknown";
  const deployOS = normalizeOS(targetOS);
  const crossOS = sourceOS !== deployOS;
  const sourceHome = manifest.codexHome || "";
  const targetHome = targetCodexHome || defaultCodexHome();
  const include = manifest.include || {};
  const selected = manifest.plan?.selected || [];
  const selectedKeys = activeKeys instanceof Set
    ? activeKeys
    : new Set(selected.map((item) => item.key));
  const highRisk = [];
  const tasks = [];
  const pathMappings = [];

  pathMappings.push({
    from: sourceHome || "source Codex home",
    to: targetHome,
    reason: "Codex 主目录按目标设备重新定位"
  });

  if (sourceHome && crossOS) {
    pathMappings.push({
      from: sourceOS === "windows" ? "C:\\Users\\<source-user>" : "/Users/<source-user>",
      to: deployOS === "windows" ? "C:\\Users\\<target-user>" : "/Users/<target-user>",
      reason: "跨系统恢复时用户目录格式不同"
    });
  }

  if (activeKeys ? selectedKeys.has("sessions") : include.sessions || selectedKeys.has("sessions")) {
    tasks.push({ item: "对话记录 sessions", mode: "copy", risk: "low", note: "可作为原始文件恢复到目标 Codex 目录。" });
  }
  if (activeKeys ? selectedKeys.has("archivedSessions") : include.archivedSessions || selectedKeys.has("archivedSessions")) {
    tasks.push({ item: "归档对话 archived_sessions", mode: "copy", risk: "low", note: "可作为原始文件恢复。" });
  }
  if (activeKeys ? selectedKeys.has("stateDb") : include.stateDb || selectedKeys.has("stateDb")) {
    tasks.push({ item: "任务索引 state_5.sqlite", mode: "copy_with_review", risk: crossOS ? "medium" : "low", note: "建议在 Codex 关闭后恢复；跨系统时先备份目标端现有索引。" });
  }
  if (activeKeys ? selectedKeys.has("memories") : include.memories || selectedKeys.has("memories")) {
    tasks.push({ item: "记忆 memories", mode: "copy", risk: "low", note: "文本类内容，跨系统兼容性高。" });
  }
  if (activeKeys ? selectedKeys.has("skills") : include.skills || selectedKeys.has("skills")) {
    tasks.push({ item: "本地 skills", mode: "copy_with_path_review", risk: crossOS ? "medium" : "low", note: "Skill 文档可复制；内部若写死路径，需要按目标系统改写。" });
  }
  if (activeKeys ? selectedKeys.has("config") : include.config || selectedKeys.has("config")) {
    tasks.push({ item: "config.toml", mode: "merge", risk: "medium", note: "建议合并恢复，避免覆盖目标设备已有模型、插件或 MCP 设置。" });
  }
  if (activeKeys ? selectedKeys.has("plugins") : include.plugins || selectedKeys.has("plugins")) {
    highRisk.push({ item: "插件缓存 plugins", reason: "插件可备份，但 OAuth、连接状态和平台缓存可能失效。" });
    tasks.push({ item: "插件缓存 plugins", mode: "restore_then_reauthorize", risk: "high", note: "恢复后需要在目标设备检查插件安装和授权。" });
  }
  if (activeKeys ? selectedKeys.has("tools") : include.tools || selectedKeys.has("tools")) {
    highRisk.push({ item: "本地工具 tools", reason: crossOS ? "跨系统时 exe/bat/ps1/sh、运行时路径差异较大。" : "同系统也可能受本机路径和运行时安装影响。" });
    tasks.push({ item: "本地工具 tools", mode: "reinstall_or_verify", risk: "high", note: `目标系统为 ${osLabel(deployOS)}，需要检测 Node/Python/Git/ffmpeg 等运行时。` });
  }
  if (activeKeys ? selectedKeys.has("auth") : include.auth || selectedKeys.has("auth")) {
    highRisk.push({ item: "登录凭据 auth.json", reason: "凭据可能受系统加密、设备绑定或 token 过期影响。" });
    tasks.push({ item: "登录凭据 auth.json", mode: "prefer_relogin", risk: "high", note: "默认建议在目标设备重新登录，不直接覆盖。" });
  }

  const sourcePathRisk = looksWindowsPath(sourceHome) && deployOS !== "windows"
    ? "源恢复点包含 Windows 路径，恢复到 macOS/Linux 时需要路径映射。"
    : looksPosixPath(sourceHome) && deployOS === "windows"
      ? "源恢复点包含 Unix 路径，恢复到 Windows 时需要路径映射。"
      : null;

  return {
    strategy: "raw_restore_point_local_adaptation",
    sourceOS: osLabel(sourceOS),
    sourceArch,
    deployOS: osLabel(deployOS),
    currentDeviceOS: osLabel(currentOSId()),
    currentDeviceArch: process.arch,
    crossOS,
    sourceCodexHome: sourceHome,
    targetCodexHome: targetHome,
    targetPathExample: pathStyleForOS(deployOS),
    pathMappings,
    tasks,
    highRisk,
    warnings: [
      "备份文件夹只保存一份原始恢复点；转录/适配在目标本地执行。",
      "正式覆盖恢复前应完全退出 Codex，包括后台或托盘进程。",
      "API Key 与登录凭据默认不建议明文恢复，应在目标设备重新配置。",
      ...(sourcePathRisk ? [sourcePathRisk] : [])
    ]
  };
}

function restoreRiskForSection(key) {
  if (["plugins", "tools", "auth"].includes(key)) return "high";
  if (["config", "agents", "stateDb"].includes(key)) return "medium";
  return "low";
}

function restoreConversationItems(section, snapshotDir) {
  const payloadRoot = path.join(snapshotDir, "payload");
  const sectionRoot = path.join(payloadRoot, section.relativePath);
  if (!exists(sectionRoot)) return [];
  const bucket = section.key === "archivedSessions" ? "archived" : "active";
  return walk(sectionRoot, { includeFiles: true, maxFiles: 12000, maxDepth: 16 }).files
    .filter((file) => /\.(jsonl|md)$/i.test(file.path))
    .map((file) => {
      const parsed = parseConversationFile({
        ...file,
        sizeMb: toMb(file.size),
        bucket
      });
      const targetRelative = portablePath(path.relative(payloadRoot, file.path));
      return {
        id: `entry:${section.key}:${targetRelative}`,
        key: section.key,
        kind: "conversation",
        label: parsed.title,
        detail: [parsed.projectName, parsed.startedAt || parsed.modifiedAt].filter(Boolean).join(" · "),
        projectName: parsed.projectName,
        threadId: parsed.id,
        projectId: stableProjectId(parsed.projectPath),
        projectPath: parsed.projectPath,
        bucket: parsed.bucket,
        startedAt: parsed.startedAt || parsed.modifiedAt,
        priority: section.priority,
        risk: "low",
        present: true,
        restorable: true,
        defaultSelected: true,
        blockedReason: null,
        granular: true,
        source: file.path,
        targetRelative
      };
    })
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
}

function restoreSkillItems(section, snapshotDir) {
  const payloadRoot = path.join(snapshotDir, "payload");
  const sectionRoot = path.join(payloadRoot, section.relativePath);
  if (!exists(sectionRoot)) return [];
  const seen = new Set();
  return findSkillFiles(sectionRoot, "snapshot_skill", 2000)
    .map((file) => {
      const skill = parseSkill(file);
      const source = path.dirname(file.path);
      const targetRelative = portablePath(path.relative(payloadRoot, source));
      return {
        id: `entry:skills:${targetRelative}`,
        key: section.key,
        kind: "capability",
        label: skill.name,
        detail: skill.description || `原名称：${skill.manifestName}`,
        configuredName: skill.configuredName,
        manifestName: skill.manifestName,
        folderName: skill.folderName,
        priority: section.priority,
        risk: "low",
        present: true,
        restorable: true,
        defaultSelected: true,
        blockedReason: null,
        granular: true,
        source,
        targetRelative
      };
    })
    .filter((item) => {
      const key = process.platform === "win32" ? item.targetRelative.toLowerCase() : item.targetRelative;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

function restoreGranularItems(section, snapshotDir) {
  if (["sessions", "archivedSessions"].includes(section.key)) {
    return restoreConversationItems(section, snapshotDir);
  }
  if (section.key === "skills") return restoreSkillItems(section, snapshotDir);
  return [];
}

function restoreCatalog(manifest, snapshotDir) {
  const items = [];
  for (const section of selectedSections(manifest.include)) {
    const source = path.join(snapshotDir, "payload", section.relativePath);
    const present = exists(source);
    const credential = section.key === "auth";
    const granularItems = present && !credential ? restoreGranularItems(section, snapshotDir) : [];
    if (granularItems.length) {
      items.push(...granularItems);
      continue;
    }
    items.push({
      id: `section:${section.key}`,
      key: section.key,
      kind: "section",
      label: section.label,
      priority: section.priority,
      risk: restoreRiskForSection(section.key),
      present,
      restorable: present && !credential,
      defaultSelected: present && !credential && !["plugins", "tools", "stateDb"].includes(section.key),
      blockedReason: credential ? "credentials_permanently_excluded" : present ? null : "not_in_restore_point",
      section
    });
  }

  if (Array.isArray(manifest.copied)) {
    manifest.copied.forEach((copied, index) => {
      const metadataOnly = copied.kind === "api_tool" || copied.metadataOnly;
      const portableTarget = copied.target ? portablePath(copied.target) : "";
      const source = portableTarget ? resolveInside(snapshotDir, portableTarget) : "metadata-only";
      const present = metadataOnly || Boolean(portableTarget && exists(source));
      const kindKey = copied.kind === "conversation" ? "sessions" : copied.kind === "capability" ? "skills" : "api";
      items.push({
        id: `selected:${index}:${portableTarget || safeFileName(copied.name || copied.title || copied.kind)}`,
        key: kindKey,
        kind: copied.kind || "selected",
        label: copied.kind === "conversation" ? copied.title : copied.name,
        priority: copied.kind === "conversation" ? "P0" : copied.kind === "capability" ? "P1" : "P3",
        threadId: copied.threadId || "",
        projectId: copied.projectPath ? stableProjectId(copied.projectPath) : "",
        projectName: copied.projectName || "",
        projectPath: copied.projectPath || "",
        risk: metadataOnly ? "high" : "low",
        present,
        restorable: present && !metadataOnly,
        defaultSelected: present && !metadataOnly,
        blockedReason: metadataOnly ? "credentials_must_be_reconfigured" : present ? null : "not_in_restore_point",
        copied,
        source
      });
    });
  }
  return items;
}

function selectRestoreCatalogItems(catalog, restoreSelection = {}) {
  const mode = ["recommended", "all_safe", "all", "custom"].includes(restoreSelection?.mode)
    ? restoreSelection.mode
    : "recommended";
  const requestedItemIds = Array.isArray(restoreSelection?.itemIds)
    ? [...new Set(restoreSelection.itemIds.map(String))]
    : [];
  const requested = new Set(requestedItemIds);
  const known = new Set(catalog.map((item) => item.id));
  const selectedItems = catalog.filter((item) => {
    if (!item.restorable) return false;
    if (mode === "custom") return requested.has(item.id);
    if (mode === "all") return true;
    if (mode === "all_safe") return item.risk !== "high";
    return item.defaultSelected;
  });
  const selectedIds = new Set(selectedItems.map((item) => item.id));
  const rejectedItemIds = mode === "custom"
    ? requestedItemIds.filter((id) => !known.has(id) || !selectedIds.has(id))
    : [];
  return { mode, requestedItemIds, selectedItems, rejectedItemIds };
}


function resolvePortableProjectMappings({ projectCatalog, requestedMappings, targetCodexHome, crossOS, sourceCodexHome, selectedProjectIds, restoreMode }) {
  const allProjects = Array.isArray(projectCatalog?.projects) ? projectCatalog.projects : [];
  const selected = Array.isArray(selectedProjectIds) ? new Set(selectedProjectIds.map(String)) : null;
  const projects = selected ? allProjects.filter((project) => selected.has(String(project.projectId))) : allProjects;
  if (!crossOS) {
    const sourceInfo = normalizeProjectPath(sourceCodexHome);
    const targetInfo = normalizeProjectPath(targetCodexHome);
    const rewriteMappings = sourceInfo && targetInfo && sourceInfo.comparisonKey !== targetInfo.comparisonKey
      ? [{ sourceRoot: sourceCodexHome, targetRoot: targetCodexHome, mode: "codex_home" }]
      : [];
    return {
      required: false,
      confirmed: true,
      mappings: projects.map((project) => ({
        projectId: project.projectId,
        displayName: project.displayName,
        sourceRoot: project.sourceRoot,
        targetRoot: project.sourceRoot,
        mode: "same_system"
      })),
      rewriteMappings
    };
  }

  const requested = Array.isArray(requestedMappings) ? requestedMappings : [];
  const requestedById = new Map(requested.map((item) => [String(item?.projectId || ""), item]));
  const confirmed = projects.length === 0
    || restoreMode === "isolated_test"
    || projects.every((project) => requestedById.has(project.projectId));
  const targetKeys = new Map();
  const mappings = projects.map((project) => {
    const request = requestedById.get(project.projectId)
      || (restoreMode === "isolated_test" ? { mode: "placeholder" } : null);
    if (!request) return { ...project, mode: "pending", targetRoot: null };
    const mode = ["existing", "placeholder", "unresolved"].includes(request.mode) ? request.mode : "unresolved";
    let targetRoot = String(request.targetRoot || "").trim();
    if (mode === "existing") {
      if (!targetRoot) throw new Error(`项目 ${project.displayName} 选择了现有目录，但未提供目标路径。`);
      const stat = statSafe(targetRoot);
      if (!stat?.isDirectory()) throw new Error(`项目目标目录不存在：${targetRoot}`);
    } else if (!targetRoot) {
      const bucket = mode === "placeholder" ? "_codex-link-project-placeholders" : "_codex-link-unresolved";
      targetRoot = path.join(targetCodexHome, bucket, safeFileName(`${project.projectId}-${project.displayName}`));
    }
    const normalizedTarget = normalizeProjectPath(targetRoot);
    const targetKey = normalizedTarget?.comparisonKey || path.resolve(targetRoot).toLowerCase();
    if (targetKeys.has(targetKey)) {
      throw new Error(`多个源项目不能映射到同一目标目录：${targetRoot}`);
    }
    targetKeys.set(targetKey, project.projectId);
    return {
      projectId: project.projectId,
      displayName: project.displayName,
      sourceRoot: project.sourceRoot,
      normalizedSourceRoot: project.normalizedSourceRoot,
      targetRoot,
      mode,
      threadIds: project.threadIds,
      threadCount: project.threadCount,
      projectFilesIncluded: Boolean(project.projectFilesIncluded)
    };
  });

  const rewriteMappings = mappings
    .filter((item) => item.mode !== "pending" && item.targetRoot)
    .map((item) => ({ sourceRoot: item.sourceRoot, targetRoot: item.targetRoot, mode: item.mode, projectId: item.projectId }));
  if (sourceCodexHome) rewriteMappings.push({ sourceRoot: sourceCodexHome, targetRoot: targetCodexHome, mode: "codex_home" });
  const pendingCount = mappings.filter((item) => item.mode === "pending").length;
  const unresolvedCount = mappings.filter((item) => item.mode === "unresolved").length;
  const processedCount = mappings.length - pendingCount;
  const allUnresolvedFormal = restoreMode !== "isolated_test"
    && mappings.length > 0
    && unresolvedCount + pendingCount === mappings.length;
  return {
    required: projects.length > 0,
    confirmed: confirmed && !allUnresolvedFormal,
    mappings,
    rewriteMappings,
    stats: {
      total: mappings.length,
      processed: processedCount,
      pending: pendingCount,
      unresolved: unresolvedCount,
      conflicts: 0,
      allUnresolvedFormal
    }
  };
}

function conversationContentDigest(filePath) {
  if (!filePath || !exists(filePath)) return null;
  const hash = crypto.createHash("sha256");
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let normalized = line;
    try {
      const record = JSON.parse(line);
      if (record?.payload && ["session_meta", "turn_context"].includes(record.type)) {
        const payload = { ...record.payload };
        delete payload.cwd;
        delete payload.rollout_path;
        normalized = JSON.stringify({ ...record, payload });
      }
    } catch {}
    hash.update(normalized);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function analyzeRestoreOverlap({ selectedConversations, targetCodexHome }) {
  const targetThreads = readSqliteThreads(path.join(targetCodexHome, "state_5.sqlite"));
  const targetById = new Map(targetThreads.map((item) => [String(item.id), item]));
  const backupIds = new Set(selectedConversations.map((item) => String(item.threadId || "")).filter(Boolean));
  const items = selectedConversations.map((item) => {
    const threadId = String(item.threadId || "");
    const targetThread = targetById.get(threadId);
    if (!targetThread) return { itemId: item.id, threadId, status: "new", reason: "thread_id_missing_on_target" };
    const relativeTarget = item.targetRelative ? validateRelativePath(item.targetRelative) : "";
    const fallbackTarget = relativeTarget ? path.join(targetCodexHome, ...relativeTarget.split("/")) : "";
    const targetFile = targetThread.rolloutPath && exists(targetThread.rolloutPath) ? targetThread.rolloutPath : fallbackTarget;
    const sourceDigest = conversationContentDigest(item.source);
    const targetDigest = conversationContentDigest(targetFile);
    const identical = Boolean(sourceDigest && targetDigest && sourceDigest === targetDigest);
    return {
      itemId: item.id,
      threadId,
      status: identical ? "duplicate" : "conflict",
      reason: identical ? "same_thread_and_content" : "same_thread_different_content",
      sourceDigest,
      targetDigest,
      targetFile: targetFile || null
    };
  });
  const count = (status) => items.filter((item) => item.status === status).length;
  return {
    backupThreadCount: backupIds.size,
    targetExistingCount: items.length - count("new"),
    newCount: count("new"),
    duplicateCount: count("duplicate"),
    conflictCount: count("conflict"),
    targetOnlyCount: targetThreads.filter((item) => !backupIds.has(String(item.id))).length,
    targetThreadCount: targetThreads.length,
    items
  };
}

function restorePlan({
  snapshotDir,
  targetCodexHome,
  targetOS,
  restoreSelection,
  projectMappings,
  restoreMode = "formal",
  databaseRestoreMode = "merge",
  confirmDatabaseReplace = false,
  onProgress = () => {}
}) {
  const resolvedInput = resolveRestorePointInput(snapshotDir);
  const loaded = readSnapshotManifest(resolvedInput.snapshotDir);
  const resolvedSnapshotDir = loaded.snapshotDir;
  const manifest = loaded.manifest;
  const verificationTotal = Math.max(1, Number(manifest.integrity?.totalBytes || 0));
  let verifiedBytes = 0;
  let lastPlanProgress = 0;
  onProgress({ progress: 1, stage: "planning", message: "正在读取恢复点并核对可恢复条目" });
  const integrity = verifySnapshotIntegrity(resolvedSnapshotDir, {
    onHashChunk: ({ bytes }) => {
      verifiedBytes += Number(bytes || 0);
      const progress = Math.min(7, 1 + Math.floor((verifiedBytes / verificationTotal) * 6));
      if (progress > lastPlanProgress) {
        lastPlanProgress = progress;
        onProgress({
          progress,
          stage: "planning_verification",
          message: "正在逐文件核对恢复点完整性",
          completedBytes: verifiedBytes,
          totalBytes: verificationTotal
        });
      }
    }
  });
  const target = path.resolve(targetCodexHome || defaultCodexHome());
  const catalog = restoreCatalog(manifest, resolvedSnapshotDir);
  const selection = selectRestoreCatalogItems(catalog, restoreSelection);
  const selectedItemIds = new Set(selection.selectedItems.map((item) => item.id));
  const selectedConversations = selection.selectedItems.filter((item) => item.kind === "conversation");
  const selectedThreadIds = [...new Set(selectedConversations.map((item) => String(item.threadId || "")).filter(Boolean))];
  const overlap = analyzeRestoreOverlap({ selectedConversations, targetCodexHome: target });
  const overlapByItem = new Map(overlap.items.map((item) => [item.itemId, item]));
  const actionableThreadIds = overlap.items
    .filter((item) => item.status === "new")
    .map((item) => item.threadId)
    .filter(Boolean);
  const selectedProjectIds = [...new Set(selectedConversations.map((item) => String(item.projectId || "")).filter(Boolean))];
  const fullStateDbSelected = selectedItemIds.has("section:stateDb");
  const requestedDatabaseMode = databaseRestoreMode === "replace" ? "replace" : "merge";
  const databaseReplaceConfirmed = requestedDatabaseMode !== "replace" || confirmDatabaseReplace === true;
  const activeKeys = new Set(selection.selectedItems.map((item) => item.key));
  if (selectedThreadIds.length && !fullStateDbSelected) activeKeys.add("stateDb");
  const adaptationPlan = buildAdaptationPlan({ manifest, targetCodexHome: target, targetOS, activeKeys });
  const projectCatalog = loadOrRebuildProjectCatalog(resolvedSnapshotDir, manifest);
  const portableProjectPlan = resolvePortableProjectMappings({
    projectCatalog,
    requestedMappings: projectMappings,
    targetCodexHome: target,
    crossOS: adaptationPlan.crossOS,
    sourceCodexHome: manifest.codexHome,
    selectedProjectIds: fullStateDbSelected ? undefined : selectedProjectIds,
    restoreMode
  });
  adaptationPlan.projectPathMappings = portableProjectPlan.mappings;
  const mappings = [];
  const skippedMappings = catalog
    .filter((item) => !item.present)
    .map((item) => ({ label: item.label, reason: "not_in_restore_point" }));

  for (const item of selection.selectedItems.filter((candidate) => candidate.granular)) {
    const overlapItem = item.kind === "conversation" ? overlapByItem.get(item.id) : null;
    if (overlapItem && overlapItem.status !== "new") {
      skippedMappings.push({
        label: item.label,
        threadId: item.threadId || "",
        reason: overlapItem.status === "duplicate" ? "duplicate_thread_content" : "thread_content_conflict"
      });
      continue;
    }
    const targetRelative = validateRelativePath(item.targetRelative);
    mappings.push({
      label: item.label,
      source: item.source,
      target: path.join(target, ...targetRelative.split("/")),
      priority: item.priority,
      action: "restore_selected",
      kind: item.kind,
      threadId: item.threadId || "",
      projectId: item.projectId || "",
      projectPath: item.projectPath || ""
    });
  }
  const selectiveStateDbSource = path.join(resolvedSnapshotDir, "payload", "state_5.sqlite");
  const selectiveIndexRequired = actionableThreadIds.length > 0 && !fullStateDbSelected;
  const selectiveIndexAvailable = exists(selectiveStateDbSource) && selectedThreadIds.length === selectedConversations.length;
  if (selectiveIndexRequired && selectiveIndexAvailable) {
    mappings.push({
      label: `所选对话索引（${selectedThreadIds.length} 条）`,
      source: selectiveStateDbSource,
      target: path.join(target, "state_5.sqlite"),
      priority: "P0",
      action: "merge_selected_threads",
      kind: "stateDbMerge",
      selectedThreadIds: actionableThreadIds,
      selectedProjectIds
    });
  }


  if (manifest.selectionMode && Array.isArray(manifest.copied)) {
    for (const [index, item] of manifest.copied.entries()) {
      const itemId = `selected:${index}:${item.target ? portablePath(item.target) : safeFileName(item.name || item.title || item.kind)}`;
      if (!selectedItemIds.has(itemId)) continue;
      if (item.kind === "api_tool") {
        mappings.push({
          label: item.name,
          source: "metadata-only",
          target: "target environment variables / API settings",
          priority: "P3",
          action: "configure_api_credentials",
          provider: item.provider || "",
          usageCount: item.usageCount || 0,
          usedInProjects: item.usedInProjects || []
        });
        continue;
      }
      const portableTarget = portablePath(item.target);
      const selectedRelative = item.kind === "conversation"
        ? portableTarget.replace(/^payload\/selected\/conversations\//, "")
        : path.posix.basename(portableTarget);
      const targetRoot = item.kind === "conversation" ? target : path.join(target, "skills", "_selected_restore");
      mappings.push({
        label: item.kind === "conversation" ? item.title : item.name,
        source: resolveInside(resolvedSnapshotDir, portableTarget),
        target: path.join(targetRoot, ...validateRelativePath(selectedRelative).split("/")),
        priority: item.kind === "conversation" ? "P0" : "P1",
        action: "restore_selected",
        kind: item.kind,
        threadId: item.threadId || "",
        projectId: item.projectPath ? stableProjectId(item.projectPath) : ""
      });
    }
  }
  for (const section of selectedSections(manifest.include)) {
      if (!selectedItemIds.has(`section:${section.key}`)) continue;
      const source = path.join(resolvedSnapshotDir, "payload", section.relativePath);
      if (!exists(source)) {
        skippedMappings.push({
          label: section.label,
          reason: "not_in_restore_point"
        });
        continue;
      }
      const crossSystemConfig = adaptationPlan.crossOS && section.key === "config";
      const mergeStateDatabase = section.key === "stateDb" && requestedDatabaseMode === "merge";
      const stateThreadIds = mergeStateDatabase ? readSqliteThreads(source).map((item) => item.id) : [];
      if (mergeStateDatabase && !stateThreadIds.length) {
        skippedMappings.push({ label: section.label, reason: "state_database_has_no_threads" });
        continue;
      }
      mappings.push({
        label: section.label,
        source,
        target: crossSystemConfig
          ? path.join(target, "_codex-link-import", `config.from-${adaptationPlan.sourceOS.toLowerCase()}.toml`)
          : path.join(target, section.relativePath),
        priority: section.priority,
        kind: mergeStateDatabase ? "stateDbMerge" : section.key,
        action: mergeStateDatabase
          ? "merge_selected_threads"
          : crossSystemConfig
            ? "import_for_manual_merge"
            : section.key === "auth" ? "optional_restore_or_relogin" : "restore",
        ...(mergeStateDatabase ? { selectedThreadIds: stateThreadIds, selectedProjectIds } : {})
      });
    }

  const warnings = [
    "恢复执行前会再次完成逐文件 SHA-256 校验。",
    "恢复前会自动创建本机回滚点，恢复后会再次校验写入结果。",
    "恢复时应完全退出 Codex，包括后台或托盘进程。",
    ...(resolvedInput.selectedFromRoot ? [`已从所选备份目录自动使用最新恢复点：${resolvedSnapshotDir}`] : []),
    ...(portableProjectPlan.required && !portableProjectPlan.confirmed ? ["跨系统恢复必须先确认每个项目的目标路径或明确标记为未关联。"] : []),
    ...(projectCatalog.migratedFromLegacy ? ["旧版恢复点没有项目清单，已从 SQLite 与 JSONL 重建候选项目。"] : []),
    ...(manifest.selectionMode ? ["备份时单独选择的对话与能力会恢复到独立暂存目录，避免覆盖其他内容。"] : []),
    ...(catalog.some((item) => item.granular) ? ["恢复点内的对话与 Skills 可逐条选择；未勾选条目不会写入目标目录。"] : []),
    ...(selectiveIndexRequired && !exists(selectiveStateDbSource) ? ["此恢复点缺少 state_5.sqlite，无法把所选对话注册到 Codex 项目分组。"] : []),
    ...(selectiveIndexRequired && selectedThreadIds.length !== selectedConversations.length ? ["部分所选对话缺少 thread ID，已禁止线程级恢复以防索引错配。"] : []),
    ...(overlap.duplicateCount ? [`${overlap.duplicateCount} 条相同 thread ID 与内容已识别为重复，不会重复写入 JSONL。`] : []),
    ...(overlap.conflictCount ? [`${overlap.conflictCount} 条同 ID 内容冲突已保留目标端版本，需明确选择后才能覆盖。`] : []),
    ...(fullStateDbSelected && requestedDatabaseMode === "merge" ? ["完整任务索引默认按 thread ID 合并；目标端独有和已有同 ID 记录会保留。"] : []),
    ...(fullStateDbSelected && requestedDatabaseMode === "replace" && !databaseReplaceConfirmed ? ["整库替换属于高级危险操作，必须经过明确警告和二次确认。"] : []),
    ...(selection.rejectedItemIds.length ? [`${selection.rejectedItemIds.length} 个请求项不存在或按安全规则不可恢复，已排除。`] : []),
    ...(skippedMappings.length ? [skippedMappings.length + " 个已勾选条目未写入此恢复点，恢复时将自动跳过。"] : []),
    ...(integrity.status === "unverified" ? ["此恢复点创建于哈希清单启用前，执行时需要额外确认。"] : []),
    ...(integrity.status === "failed" ? ["恢复点完整性校验失败，已禁止执行恢复。"] : [])
  ];

  return {
    appVersion: APP_VERSION,
    snapshotId: manifest.id,
    snapshotDir: resolvedSnapshotDir,
    targetCodexHome: target,
    restoreMode: restoreMode === "isolated_test" ? "isolated_test" : "formal",
    targetRiskLevel: restoreMode === "isolated_test" ? "isolated_test" : "formal_codex_home",
    deployOS: adaptationPlan.deployOS,
    databaseRestoreMode: requestedDatabaseMode,
    requiresDatabaseReplaceConfirmation: requestedDatabaseMode === "replace" && !databaseReplaceConfirmed,
    selectionMode: Boolean(manifest.selectionMode || catalog.some((item) => item.granular)),
    restoreSelection: {
      mode: selection.mode,
      selectedItemIds: selection.selectedItems.map((item) => item.id),
      requestedItemIds: selection.requestedItemIds,
      rejectedItemIds: selection.rejectedItemIds
    },
    availableItems: catalog.map(({ section, copied, source, ...item }) => ({
      ...item,
      selected: selectedItemIds.has(item.id)
    })),
    adaptationPlan,
    portableProjects: projectCatalog,
    projectPathMappings: portableProjectPlan.mappings,
    projectMappingStats: portableProjectPlan.stats || { total: portableProjectPlan.mappings.length, processed: portableProjectPlan.mappings.length, pending: 0, unresolved: 0, conflicts: 0 },
    pathRewriteMappings: portableProjectPlan.rewriteMappings,
    sqliteMetadata: manifest.sqlite || null,
    requiresProjectMapping: portableProjectPlan.required && !portableProjectPlan.confirmed,
    selectiveRestore: {
      enabled: selectiveIndexRequired,
      indexAvailable: selectiveIndexAvailable,
      selectedThreadIds,
      actionableThreadIds,
      selectedProjectIds
    },
    projectMappingsConfirmed: portableProjectPlan.confirmed,
    mappings,
    skippedMappings,
    overlap,
    countTrace: {
      userSelectedCount: selection.selectedItems.length,
      logicalRestoreItemCount: selection.selectedItems.length,
      fileMappingCount: mappings.filter((item) => item.source !== "metadata-only").length,
      metadataOnlyCount: mappings.filter((item) => item.source === "metadata-only").length,
      skippedCount: skippedMappings.length,
      skippedItems: skippedMappings
    },
    integrity,
    canExecute: integrity.status !== "failed" && databaseReplaceConfirmed && portableProjectPlan.confirmed && (!selectiveIndexRequired || selectiveIndexAvailable) && mappings.some((item) => item.source !== "metadata-only"),
    requiresUnverifiedConfirmation: integrity.status === "unverified",
    requiresHighRiskConfirmation: Boolean(adaptationPlan.crossOS || adaptationPlan.highRisk?.length),
    warnings
  };
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendError(res, error, status = 500) {
  console.error(error);
  const payload = { error: error.message || String(error) };
  if (error?.details) payload.details = error.details;
  sendJson(res, payload, status);
}

function beginOperationStream(res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.flushHeaders?.();
}

function writeOperationEvent(res, payload) {
  if (!res.writableEnded) res.write(`${JSON.stringify(payload)}\n`);
}

function createOperationReporter(res) {
  const startedAt = Date.now();
  let lastProgress = 0;
  return (event = {}) => {
    const progress = Math.max(lastProgress, Math.min(100, Math.round(Number(event.progress || 0))));
    lastProgress = progress;
    const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
    const etaSeconds = progress > 1 && progress < 100
      ? Math.max(1, Math.round((elapsedSeconds / progress) * (100 - progress)))
      : 0;
    writeOperationEvent(res, {
      type: "progress",
      ...event,
      progress,
      elapsedSeconds: Math.round(elapsedSeconds * 10) / 10,
      etaSeconds
    });
  };
}

function writeOperationFailure(res, error) {
  writeOperationEvent(res, {
    type: "error",
    error: error.message || String(error),
    details: error.details || null
  });
  res.end();
}

function runOperationWorker(operation, payload, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(ROOT, "lib", "operation-worker.js"), {
      workerData: { operation, payload }
    });
    let settled = false;
    worker.on("message", (message) => {
      if (message?.type === "progress") {
        onProgress(message.event || {});
        return;
      }
      if (message?.type === "result") {
        settled = true;
        resolve(message.result);
        return;
      }
      if (message?.type === "error") {
        settled = true;
        const error = new Error(message.error || "后台操作未能完成");
        error.details = message.details || null;
        if (message.stack) error.stack = message.stack;
        reject(error);
      }
    });
    worker.on("error", (error) => {
      if (!settled) reject(error);
    });
    worker.on("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`后台操作进程异常退出（${code}）。`));
      else if (!settled) reject(new Error("后台操作结束但没有返回结果。"));
    });
  });
}

function serveStatic(req, res, pathname) {
  let filePath =
    pathname === "/codex-link-latest-demo.html"
      ? path.join(ROOT, "codex-link-latest-demo.html")
      : pathname === "/"
        ? path.join(PUBLIC_DIR, "index.html")
        : path.join(PUBLIC_DIR, pathname);
  filePath = path.normalize(filePath);
  const allowedRoot = pathname === "/codex-link-latest-demo.html" ? ROOT : PUBLIC_DIR;
  if (!filePath.startsWith(allowedRoot)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!exists(filePath) || statSafe(filePath)?.isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY
  });
  fs.createReadStream(filePath).pipe(res);
}

let restoreInProgress = false;
let restoreRecoveryStatus = {
  checkedAt: null,
  results: []
};

function recoverPendingRestores(cloudDir) {
  const results = recoverInterruptedRestores(cloudDir || loadConfig().cloudDir || defaultCloudDir());
  restoreRecoveryStatus = {
    checkedAt: new Date().toISOString(),
    results
  };
  return restoreRecoveryStatus;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/api/config" && req.method === "GET") {
      sendJson(res, loadConfig());
      return;
    }
    if (url.pathname === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      saveConfig({ ...loadConfig(), ...body });
      sendJson(res, loadConfig());
      return;
    }
    if ((url.pathname === "/api/backup-folder-candidates" || url.pathname === "/api/cloud-candidates") && req.method === "GET") {
      sendJson(res, cloudCandidates());
      return;
    }
    if (url.pathname === "/api/disk-space" && req.method === "GET") {
      const targetPath = url.searchParams.get("path") || loadConfig().cloudDir || defaultCloudDir();
      sendJson(res, diskSpaceForPath(targetPath));
      return;
    }
    if (url.pathname === "/api/audit" && req.method === "GET") {
      const codexHome = url.searchParams.get("codexHome") || loadConfig().codexHome || defaultCodexHome();
      sendJson(res, auditCodex(codexHome));
      return;
    }
    if (url.pathname === "/api/snapshot-plan" && req.method === "POST") {
      const body = await readBody(req);
      const config = loadConfig();
      sendJson(res, createSnapshot({ ...applyBackupPolicy(config, body), dryRun: true }));
      return;
    }
    if (url.pathname === "/api/snapshots" && req.method === "POST") {
      const body = await readBody(req);
      const config = loadConfig();
      sendJson(res, createSnapshot({ ...applyBackupPolicy(config, body), dryRun: Boolean(body.dryRun) }));
      return;
    }
    if (url.pathname === "/api/snapshot-operation" && req.method === "POST") {
      const body = await readBody(req);
      const config = loadConfig();
      beginOperationStream(res);
      const report = createOperationReporter(res);
      try {
        const result = await runOperationWorker("backup", {
          ...applyBackupPolicy(config, body),
          dryRun: Boolean(body.dryRun)
        }, report);
        writeOperationEvent(res, { type: "result", result });
        res.end();
      } catch (error) {
        writeOperationFailure(res, error);
      }
      return;
    }
    if (url.pathname === "/api/selection-snapshot" && req.method === "POST") {
      const body = await readBody(req);
      sendJson(res, createSelectionSnapshot({ ...loadConfig(), ...body, dryRun: Boolean(body.dryRun) }));
      return;
    }
    if (url.pathname === "/api/snapshots" && req.method === "GET") {
      const cloudDir = url.searchParams.get("cloudDir") || loadConfig().cloudDir || defaultCloudDir();
      sendJson(res, listSnapshots(cloudDir));
      return;
    }
    if (url.pathname === "/api/rollback-points" && req.method === "GET") {
      const cloudDir = url.searchParams.get("cloudDir") || loadConfig().cloudDir || defaultCloudDir();
      sendJson(res, listRollbackPoints(cloudDir));
      return;
    }
    if (url.pathname === "/api/rollback-points/undo" && req.method === "POST") {
      if (restoreInProgress) {
        sendJson(res, { error: "已有恢复或回滚任务正在执行，请等待完成。" }, 409);
        return;
      }
      const body = await readBody(req);
      if (body.confirmUndo !== true) {
        sendJson(res, { error: "撤销恢复前需要明确确认。" }, 400);
        return;
      }
      const config = loadConfig();
      restoreInProgress = true;
      try {
        sendJson(res, undoRestoreTransaction({
          cloudDir: body.cloudDir || config.cloudDir || defaultCloudDir(),
          rollbackDir: body.rollbackDir,
          id: body.id
        }));
      } finally {
        restoreInProgress = false;
      }
      return;
    }
    if (url.pathname === "/api/snapshots" && req.method === "DELETE") {
      const body = await readBody(req);
      sendJson(res, deleteSnapshot({ ...loadConfig(), ...body }));
      return;
    }
    if (url.pathname === "/api/test-restore-environments" && req.method === "POST") {
      sendJson(res, createTestRestoreEnvironment());
      return;
    }
    if (url.pathname === "/api/test-restore-environments" && req.method === "DELETE") {
      const body = await readBody(req);
      sendJson(res, deleteTestRestoreEnvironment(body));
      return;
    }
    if (url.pathname === "/api/restore-plan" && req.method === "POST") {
      const body = await readBody(req);
      const config = loadConfig();
      sendJson(res, restorePlan(enforceRestorePolicy(config, body)));
      return;
    }
    if (url.pathname === "/api/restore-validate" && req.method === "POST") {
      const body = await readBody(req);
      sendJson(res, verifySnapshotIntegrity(body.snapshotDir));
      return;
    }
    if (url.pathname === "/api/restore-recovery-status" && req.method === "GET") {
      sendJson(res, restoreRecoveryStatus);
      return;
    }
    if (url.pathname === "/api/restore-execute" && req.method === "POST") {
      if (restoreInProgress) {
        sendJson(res, { error: "已有恢复任务正在执行，请等待完成。" }, 409);
        return;
      }
      const body = await readBody(req);
      if (body.confirmRestore !== true) {
        sendJson(res, { error: "执行真实恢复前需要明确确认。" }, 400);
        return;
      }
      const config = loadConfig();
      const restoreCloudDir = body.cloudDir || config.cloudDir || defaultCloudDir();
      const pendingRecovery = recoverPendingRestores(restoreCloudDir);
      if (pendingRecovery.results.length) {
        sendJson(res, {
          error: "检测到上次未完成的恢复任务，已先处理自动回退。请查看结果并重新校验恢复计划。",
          details: pendingRecovery
        }, 409);
        return;
      }
      const plan = restorePlan(enforceRestorePolicy(config, body));
      restoreInProgress = true;
      try {
        const result = executeRestoreTransaction({
          plan,
          cloudDir: restoreCloudDir,
          allowUnverified: Boolean(body.allowUnverified),
          confirmHighRisk: Boolean(body.confirmHighRisk)
        });
        sendJson(res, result);
      } finally {
        restoreInProgress = false;
      }
      return;
    }
    if (url.pathname === "/api/restore-operation" && req.method === "POST") {
      const body = await readBody(req);
      beginOperationStream(res);
      const report = createOperationReporter(res);
      if (restoreInProgress) {
        writeOperationFailure(res, new Error("已有恢复任务正在执行，请等待完成。"));
        return;
      }
      if (body.confirmRestore !== true) {
        writeOperationFailure(res, new Error("执行真实恢复前需要明确确认。"));
        return;
      }
      const config = loadConfig();
      const restoreCloudDir = body.cloudDir || config.cloudDir || defaultCloudDir();
      try {
        const pendingRecovery = recoverPendingRestores(restoreCloudDir);
        if (pendingRecovery.results.length) {
          const recoveryError = new Error("检测到上次未完成的恢复任务，已先处理自动回退。请查看结果并重新校验恢复计划。");
          recoveryError.details = pendingRecovery;
          throw recoveryError;
        }
        restoreInProgress = true;
        const result = await runOperationWorker("restore", {
          planInput: enforceRestorePolicy(config, body),
          cloudDir: restoreCloudDir,
          allowUnverified: Boolean(body.allowUnverified),
          confirmHighRisk: Boolean(body.confirmHighRisk)
        }, report);
        writeOperationEvent(res, { type: "result", result });
        res.end();
      } catch (error) {
        writeOperationFailure(res, error);
      } finally {
        restoreInProgress = false;
      }
      return;
    }
    serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (error) {
    sendError(res, error);
  }
});

if (require.main === module) {
  try {
    const recovery = recoverPendingRestores();
    if (recovery.results.length) {
      console.warn(`Codex Link recovered ${recovery.results.length} interrupted restore transaction(s).`);
    }
  } catch (error) {
    restoreRecoveryStatus = {
      checkedAt: new Date().toISOString(),
      results: [{ status: "recovery_failed", error: error.message }]
    };
    console.error("Codex Link could not inspect interrupted restore transactions.", error);
  }
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Codex Link is running at http://localhost:${PORT}`);
  });
}

module.exports = {
  applyBackupPolicy,
  cloudCandidates,
  createSelectionSnapshot,
  createSnapshot,
  createTestRestoreEnvironment,
  deleteTestRestoreEnvironment,
  defaultCloudDir,
  loadConfig,
  listSnapshots,
  listRollbackPoints,
  normalizeConfig,
  recoverPendingRestores,
  resolveRestorePointInput,
  resolveConfiguredPath,
  restorePlan,
  saveConfig,
  undoRestoreTransaction,
  server
};
