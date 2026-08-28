#!/usr/bin/env node

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { MANUAL_MAX, validateManualReview } = require("../lib/manual-review");
const { validateMacosReleaseEvidence } = require("../lib/macos-release-evidence");

const ROOT = path.resolve(__dirname, "..");
const REPORT_DIR = path.join(ROOT, "qa", "reports");
const args = process.argv.slice(2);
const profile = optionValue("--profile") || "release";
const manualPath = optionValue("--manual");

if (!new Set(["release", "stage"]).has(profile)) {
  console.error("--profile 只支持 release 或 stage");
  process.exit(1);
}

const DIMENSIONS = {
  productValue: { label: "产品价值", weight: 10 },
  coreReliability: { label: "核心任务可靠性", weight: 25 },
  usability: { label: "易用性", weight: 15 },
  informationArchitecture: { label: "信息架构", weight: 10 },
  trustAndSafety: { label: "信任与安全", weight: 20 },
  visualExperience: { label: "UI 与视觉体验", weight: 10 },
  engineeringQuality: { label: "性能与工程质量", weight: 5 },
  userSatisfaction: { label: "用户满意度", weight: 5 }
};

const checks = [];
const startedAt = new Date();
let serverProcess = null;
let fixtureRoot = null;

function optionValue(name) {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1];
  const prefixed = args.find((item) => item.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : null;
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function addCheck({ id, dimension, title, points, pass, evidence, critical = false, external = false, stageAllowed = false }) {
  checks.push({
    id,
    dimension,
    title,
    points,
    awarded: pass ? points : 0,
    pass: Boolean(pass),
    evidence: String(evidence || ""),
    critical,
    external,
    stageAllowed
  });
}

function nodeCheck(file) {
  const result = spawnSync(process.execPath, ["--check", path.join(ROOT, file)], { encoding: "utf8" });
  return { pass: result.status === 0, evidence: (result.stderr || result.stdout || "语法检查通过").trim() };
}

function pngSize(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.length < 24 || data.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function manualReview() {
  if (!manualPath) return { supplied: false, valid: true, scores: {}, pending: Object.keys(MANUAL_MAX), evidence: "未提供人工验收文件" };
  const resolved = path.resolve(ROOT, manualPath);
  const review = validateManualReview(resolved, path.join(ROOT, "qa", "manual-review.example.json"));
  if (review.valid) review.evidence = `人工验收文件：${path.relative(ROOT, resolved)}`;
  return review;
}

function makeFixture() {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-link-self-check-"));
  const codexHome = path.join(fixtureRoot, "source-codex-home");
  const backupDir = path.join(fixtureRoot, "backup-folder");
  const restoreTarget = path.join(fixtureRoot, "restore-target");
  fs.mkdirSync(path.join(codexHome, "sessions", "2026", "08", "13"), { recursive: true });
  fs.mkdirSync(path.join(codexHome, "archived_sessions"), { recursive: true });
  fs.mkdirSync(path.join(codexHome, "memories"), { recursive: true });
  fs.mkdirSync(path.join(codexHome, "skills", "fixture-skill"), { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(restoreTarget, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"fixture-model\"\ncustom_provider = \"MY_STUDIO_API_KEY\"\n", "utf8");
  fs.writeFileSync(path.join(restoreTarget, "config.toml"), "model = \"original-target-model\"\n", "utf8");
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "# Fixture rules\n", "utf8");
  const stateDb = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  stateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, title TEXT)");
  const insertThread = stateDb.prepare("INSERT INTO threads (id, cwd, rollout_path, title) VALUES (?, ?, ?, ?)");
  fs.writeFileSync(path.join(codexHome, "memories", "MEMORY.md"), "# Fixture memory\n", "utf8");
  fs.writeFileSync(path.join(codexHome, "skills", "fixture-skill", "SKILL.md"), [
    "---",
    "name: fixture-skill-internal",
    "description: 用于验证用户配置的 Skill 名称。",
    "---",
    "# 我的导演技能",
    ""
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ apiKey: "SHOULD_NOT_BE_COPIED" }), "utf8");
  for (let index = 0; index < 300; index += 1) {
    const id = String(index).padStart(4, "0");
    const lines = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-08-13T08:00:00.000Z", payload: { id: `fixture-${id}`, cwd: `D:\\fixture\\project-${index % 12}` } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `Fixture conversation ${id}` } })
    ];
    fs.writeFileSync(path.join(codexHome, "sessions", "2026", "08", "13", `rollout-${id}.jsonl`), `${lines.join("\n")}\n`, "utf8");
    insertThread.run(`fixture-${id}`, `D:\\fixture\\project-${index % 12}`, path.join(codexHome, "sessions", "2026", "08", "13", `rollout-${id}.jsonl`), `Fixture conversation ${id}`);
  }
  stateDb.close();
  return { codexHome, backupDir, restoreTarget };
}

async function waitForServer(baseUrl, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("测试服务器未在规定时间内启动");
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { response, body };
}

async function requestOperation(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const events = text.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { type: "invalid", raw: line }; }
  });
  const result = events.findLast((event) => event.type === "result")?.result || null;
  const failure = events.findLast((event) => event.type === "error") || null;
  return { response, events, result, failure };
}

async function runRuntimeChecks(serverSource) {
  const fixture = makeFixture();
  const port = 46000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, CODEX_LINK_PORT: String(port), CODEX_HOME: fixture.codexHome },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer(baseUrl);

  const page = await request(baseUrl, "/");
  addCheck({ id: "engineering.http", dimension: "engineeringQuality", title: "应用可在隔离端口启动并提供首页", points: 1, pass: page.response.ok && String(page.body.raw || "").includes("Codex Link"), evidence: `GET / 返回 ${page.response.status}` });

  const auditStart = Date.now();
  const audit = await request(baseUrl, `/api/audit?codexHome=${encodeURIComponent(fixture.codexHome)}`);
  const auditMs = Date.now() - auditStart;
  const configuredSkill = (audit.body.capabilities || []).find((item) => item.name === "我的导演技能");
  const configuredApi = (audit.body.apiTools || []).find((item) => item.name === "My Studio API");
  const auditPass = audit.response.ok && (audit.body.conversations?.length || 0) >= 80 && configuredSkill && configuredApi;
  addCheck({ id: "reliability.audit", dimension: "coreReliability", title: "大批量扫描保留对话、Skill 与 API 原名", points: 2, pass: auditPass, evidence: auditPass ? `输入 300 条测试对话，返回 ${audit.body.conversations.length} 条；Skill=我的导演技能；API=My Studio API；耗时 ${auditMs}ms` : `扫描或原名保留失败；对话 ${audit.body.conversations?.length || 0} 条，Skill=${configuredSkill?.name || "缺失"}，API=${configuredApi?.name || "缺失"}` });
  addCheck({ id: "engineering.performance", dimension: "engineeringQuality", title: "300 条对话扫描性能", points: 2, pass: auditMs < 3000, evidence: `扫描耗时 ${auditMs}ms，门槛 3000ms` });

  const include = { config: true, agents: true, sessions: true, archivedSessions: true, stateDb: true, memories: true, skills: true, plugins: false, tools: false, auth: false };
  const payload = { codexHome: fixture.codexHome, cloudDir: fixture.backupDir, include };
  const plan = await request(baseUrl, "/api/snapshot-plan", { method: "POST", body: JSON.stringify(payload) });
  addCheck({ id: "reliability.preview", dimension: "coreReliability", title: "创建前可生成备份计划", points: 2, pass: plan.response.ok && plan.body.dryRun === true && plan.body.manifest?.plan?.selected?.length > 0, evidence: plan.response.ok ? `计划包含 ${plan.body.manifest.plan.selected.length} 类内容` : plan.body.error });

  const createdOperation = await requestOperation(baseUrl, "/api/snapshot-operation", payload);
  const created = { response: createdOperation.response, body: createdOperation.result || { error: createdOperation.failure?.error || "备份操作未返回结果" } };
  const progressEvents = createdOperation.events.filter((event) => event.type === "progress");
  const intermediatePercents = new Set(progressEvents.filter((event) => event.progress > 1 && event.progress < 100).map((event) => event.progress));
  const byteProgressEvents = progressEvents.filter((event) => Number(event.completedBytes) > 0 && Number(event.totalBytes) > 0);
  const runtimeProgressPass = intermediatePercents.size >= 4 && byteProgressEvents.length >= 2;
  const durationCheck = checks.find((check) => check.id === "usability.duration-feedback");
  if (durationCheck) {
    durationCheck.pass = durationCheck.pass && runtimeProgressPass;
    durationCheck.awarded = durationCheck.pass ? durationCheck.points : 0;
    durationCheck.evidence = durationCheck.pass
      ? `后台线程在最终结果前发送 ${intermediatePercents.size} 个中间百分比和 ${byteProgressEvents.length} 条真实字节进度`
      : `流式进度不足：中间百分比 ${intermediatePercents.size} 个，字节进度 ${byteProgressEvents.length} 条`;
  }
  const snapshotDir = created.body.snapshotDir;
  const manifestPath = snapshotDir ? path.join(snapshotDir, "manifest.json") : "";
  const copiedConfig = snapshotDir ? path.join(snapshotDir, "payload", "config.toml") : "";
  const copiedAuth = snapshotDir ? path.join(snapshotDir, "payload", "auth.json") : "";
  const backupCreated = created.response.ok && snapshotDir && fs.existsSync(manifestPath) && fs.existsSync(copiedConfig);
  addCheck({ id: "p0.backup-create", dimension: "coreReliability", title: "P0 真实备份写入", points: 5, pass: backupCreated, critical: true, evidence: backupCreated ? `恢复点已写入 ${snapshotDir}` : created.body.error || "没有生成恢复点" });

  const copiedSessionDir = snapshotDir ? path.join(snapshotDir, "payload", "sessions", "2026", "08", "13") : "";
  const copiedSessionCount = copiedSessionDir && fs.existsSync(copiedSessionDir) ? fs.readdirSync(copiedSessionDir).filter((name) => name.endsWith(".jsonl")).length : 0;
  const byteEqual = backupCreated && sha256(path.join(fixture.codexHome, "config.toml")) === sha256(copiedConfig) && copiedSessionCount === 300;
  addCheck({ id: "reliability.copy-byte-equal", dimension: "coreReliability", title: "备份文件完整复制且字节一致", points: 2, pass: byteEqual, evidence: byteEqual ? "config.toml SHA-256 一致，300 条测试对话全部复制" : `哈希或文件数量不一致，复制 ${copiedSessionCount}/300 条对话` });

  const authExcluded = backupCreated && !fs.existsSync(copiedAuth);
  addCheck({ id: "p0.sensitive-exclusion", dimension: "trustAndSafety", title: "P0 登录凭据默认排除", points: 4, pass: authExcluded, critical: true, evidence: authExcluded ? "包含诱饵密钥的 auth.json 未进入恢复点" : "auth.json 被复制到恢复点" });

  const listed = await request(baseUrl, `/api/snapshots?cloudDir=${encodeURIComponent(fixture.backupDir)}`);
  addCheck({ id: "reliability.list", dimension: "coreReliability", title: "创建后可在备份管理中列出恢复点", points: 2, pass: listed.response.ok && listed.body.some?.((item) => item.snapshotDir === snapshotDir), evidence: `备份管理返回 ${Array.isArray(listed.body) ? listed.body.length : 0} 个恢复点` });

  const planPayload = { snapshotDir, targetCodexHome: fixture.restoreTarget, targetOS: process.platform === "win32" ? "windows" : "macos" };
  const restorePlan = await request(baseUrl, "/api/restore-plan", { method: "POST", body: JSON.stringify(planPayload) });
  const conversationItems = (restorePlan.body.availableItems || []).filter((item) => item.kind === "conversation");
  const restoreSkill = (restorePlan.body.availableItems || []).find((item) => item.kind === "capability" && item.label === "我的导演技能");
  const firstConversation = conversationItems[0];
  const singlePlan = firstConversation ? await request(baseUrl, "/api/restore-plan", {
    method: "POST",
    body: JSON.stringify({ ...planPayload, restoreSelection: { mode: "custom", itemIds: [firstConversation.id] } })
  }) : { response: { ok: false }, body: {} };
  const granularRestorePass = restorePlan.response.ok
    && conversationItems.length === 300
    && restoreSkill
    && singlePlan.response.ok
    && singlePlan.body.restoreSelection?.selectedItemIds?.length === 1
    && singlePlan.body.selectiveRestore?.selectedThreadIds?.length === 1
    && singlePlan.body.mappings?.length === 2;
  addCheck({ id: "reliability.restore-plan", dimension: "coreReliability", title: "恢复计划支持对话与 Skills 逐条选择", points: 3, pass: granularRestorePass, evidence: granularRestorePass ? `可逐条选择 300 条对话和 Skill“我的导演技能”；单选生成会话文件与线程索引 2 条映射` : `逐条恢复证据不足：对话 ${conversationItems.length}/300，Skill=${restoreSkill ? "存在" : "缺失"}，单选映射=${singlePlan.body.mappings?.length || 0}` });

  const selectedItemIds = restorePlan.body.restoreSelection?.selectedItemIds || [];
  const restoreOperation = await requestOperation(baseUrl, "/api/restore-operation", {
    ...planPayload,
    cloudDir: fixture.backupDir,
    restoreSelection: { mode: "custom", itemIds: selectedItemIds },
    confirmRestore: true,
    confirmHighRisk: true
  });
  const restoreResult = restoreOperation.result || {};
  const restoreProgressEvents = restoreOperation.events.filter((event) => event.type === "progress");
  const restoreIntermediatePercents = new Set(
    restoreProgressEvents.filter((event) => event.progress > 1 && event.progress < 100).map((event) => event.progress)
  );
  const restoreByteEvents = restoreProgressEvents.filter(
    (event) => Number(event.completedBytes) > 0 && Number(event.totalBytes) > 0
  );
  const restoredConfigPath = path.join(fixture.restoreTarget, "config.toml");
  const sourceConfig = fs.readFileSync(path.join(fixture.codexHome, "config.toml"), "utf8");
  const restoredConfig = fs.existsSync(restoredConfigPath) ? fs.readFileSync(restoredConfigPath, "utf8") : "";
  const restoreExecuted = restoreOperation.response.ok
    && !restoreOperation.failure
    && restoredConfig === sourceConfig
    && restoreResult.postRestoreVerification?.verified === true
    && Number(restoreResult.restoredMappings || 0) === Number(restorePlan.body.mappings?.length || 0);
  addCheck({
    id: "p0.restore-execution",
    dimension: "coreReliability",
    title: "P0 真实恢复执行与结果验证",
    points: 4,
    pass: restoreExecuted,
    critical: true,
    stageAllowed: true,
    evidence: restoreExecuted
      ? `实际写入并校验 ${restoreResult.restoredMappings} 条恢复映射，目标 config.toml 与源文件字节一致`
      : `真实恢复失败：HTTP ${restoreOperation.response.status}；映射 ${restoreResult.restoredMappings || 0}/${restorePlan.body.mappings?.length || 0}；写入校验=${Boolean(restoreResult.postRestoreVerification?.verified)}`
  });

  const rollbackPoint = restoreResult.rollbackPoint?.path || "";
  const rollbackManifest = rollbackPoint ? path.join(rollbackPoint, "manifest.json") : "";
  const rollbackConfig = rollbackPoint ? path.join(rollbackPoint, "payload", "config.toml") : "";
  let rollbackManifestValue = null;
  try {
    rollbackManifestValue = rollbackManifest && fs.existsSync(rollbackManifest)
      ? JSON.parse(fs.readFileSync(rollbackManifest, "utf8"))
      : null;
  } catch {}
  const rollbackConfigEntry = rollbackManifestValue?.integrity?.files?.find(
    (entry) => entry.type === "file" && entry.path === "config.toml"
  );
  const rollbackVerified = Boolean(
    rollbackPoint
    && fs.existsSync(rollbackManifest)
    && fs.existsSync(rollbackConfig)
    && fs.readFileSync(rollbackConfig, "utf8") === "model = \"original-target-model\"\n"
    && rollbackManifestValue?.integrity?.algorithm === "sha256"
    && rollbackConfigEntry?.sha256 === sha256(rollbackConfig)
  );
  addCheck({
    id: "p0.rollback",
    dimension: "trustAndSafety",
    title: "P0 恢复前自动回滚保护",
    points: 3,
    pass: rollbackVerified,
    critical: true,
    stageAllowed: true,
    evidence: rollbackVerified
      ? `回滚点 ${path.basename(rollbackPoint)} 保留了恢复前 config.toml，并通过完整性校验`
      : "真实恢复未生成可验证的恢复前回滚点，或回滚内容与原目标不一致"
  });

  const integrityVerified = restorePlan.response.ok
    && restorePlan.body.integrity?.status === "verified"
    && restorePlan.body.integrity?.algorithm === "sha256"
    && Number(restorePlan.body.integrity?.fileCount || 0) > 0;
  addCheck({
    id: "p0.integrity-verification",
    dimension: "trustAndSafety",
    title: "P0 恢复点具有持久化完整性校验",
    points: 3,
    pass: integrityVerified,
    critical: true,
    stageAllowed: true,
    evidence: integrityVerified
      ? `恢复前实际完成 SHA-256 校验，共 ${restorePlan.body.integrity.fileCount} 个文件`
      : `恢复计划完整性状态=${restorePlan.body.integrity?.status || "缺失"}`
  });

  const restoreProgressPass = restoreIntermediatePercents.size >= 4 && restoreByteEvents.length >= 2;
  if (durationCheck) {
    durationCheck.pass = durationCheck.pass && restoreProgressPass;
    durationCheck.awarded = durationCheck.pass ? durationCheck.points : 0;
    durationCheck.evidence = durationCheck.pass
      ? `备份 ${intermediatePercents.size} 个、恢复 ${restoreIntermediatePercents.size} 个中间百分比；真实字节进度 ${byteProgressEvents.length + restoreByteEvents.length} 条`
      : `恢复流式进度不足：中间百分比 ${restoreIntermediatePercents.size} 个，字节进度 ${restoreByteEvents.length} 条`;
  }

  const outside = path.join(fixtureRoot, "outside-sentinel.txt");
  fs.writeFileSync(outside, "do-not-delete", "utf8");
  const outsideDelete = await request(baseUrl, "/api/snapshots", { method: "DELETE", body: JSON.stringify({ cloudDir: fixture.backupDir, snapshotDir: outside }) });
  const pathIsolated = !outsideDelete.response.ok && fs.existsSync(outside);
  addCheck({ id: "p0.path-isolation", dimension: "trustAndSafety", title: "P0 删除操作不能越出备份文件夹", points: 3, pass: pathIsolated, critical: true, evidence: pathIsolated ? "越界删除被拒绝，哨兵文件保留" : "越界路径保护失败" });

}

function runStaticChecks() {
  const html = read("public/index.html");
  const app = read("public/app.js");
  const css = read("public/styles.css");
  const server = read("server.js");
  const operationWorker = read("lib/operation-worker.js");
  const visibleSource = `${html}\n${app}`;

  const serverSyntax = nodeCheck("server.js");
  const appSyntax = nodeCheck("public/app.js");
  addCheck({ id: "engineering.syntax", dimension: "engineeringQuality", title: "服务端与前端脚本语法", points: 2, pass: serverSyntax.pass && appSyntax.pass, evidence: serverSyntax.pass && appSyntax.pass ? "node --check 全部通过" : `${serverSyntax.evidence}\n${appSyntax.evidence}` });

  const navLabels = ["总览", "创建备份", "从备份恢复", "备份管理", "设置"];
  const navPass = navLabels.every((label) => html.includes(`<span>${label}</span>`));
  addCheck({ id: "ia.primary-nav", dimension: "informationArchitecture", title: "五个固定一级导航完整", points: 3, pass: navPass, evidence: navPass ? navLabels.join("、") : "一级导航缺失" });

  const extraNav = ["对话记录", "能力库", "个人记忆", "安全检查"].filter((label) => new RegExp(`nav-item[\\s\\S]{0,180}${label}`).test(html));
  addCheck({ id: "ia.no-extra-nav", dimension: "informationArchitecture", title: "内容资产未升级为一级导航", points: 2, pass: extraNav.length === 0, evidence: extraNav.length ? `发现额外导航：${extraNav.join("、")}` : "对话、能力、记忆和安全均保留在内容或流程中" });

  const homeCore = ["备份文件夹", "最近备份恢复点", "创建备份", "从备份恢复"].every((text) => visibleSource.includes(text));
  addCheck({ id: "value.home-core", dimension: "productValue", title: "总览呈现核心价值和下一步操作", points: 2, pass: homeCore, evidence: homeCore ? "备份文件夹、恢复点和两个主操作均存在" : "总览核心信息不完整" });

  const localPositioning = visibleSource.includes("任意本地路径") && visibleSource.includes("不会由 Codex Link 自动上传或同步");
  addCheck({ id: "value.local-positioning", dimension: "productValue", title: "本地备份产品定位明确", points: 2, pass: localPositioning, evidence: localPositioning ? "明确本地文件夹与自主上传边界" : "本地产品边界文案不足" });

  const forbidden = ["资产矩阵", "记忆晶格", "云端产品", "云端备份"].filter((term) => visibleSource.includes(term));
  const snapshotVisible = /[>"'`]([^<>"'`]{0,30}快照|快照[^<>"'`]{0,30})[<"'`]/.test(visibleSource);
  addCheck({ id: "value.copy-boundary", dimension: "productValue", title: "用户文案遵守备份与恢复点边界", points: 2, pass: forbidden.length === 0 && !snapshotVisible, evidence: forbidden.length || snapshotVisible ? `发现禁用表达：${[...forbidden, ...(snapshotVisible ? ["快照"] : [])].join("、")}` : "未发现资产矩阵、云端产品或快照式用户文案" });

  const personalMemoryIndependent = /title:\s*["']个人记忆["']/.test(app) && /tone:\s*["']memory["']/.test(app);
  addCheck({ id: "ia.memory-independent", dimension: "informationArchitecture", title: "个人记忆保持独立资产", points: 2, pass: personalMemoryIndependent, evidence: personalMemoryIndependent ? "个人记忆具有独立模块" : "个人记忆独立性证据不足" });

  const advancedCategories = ["项目记录", "对话记录", "Skills", "MCP", "插件", "本地工具", "API 接入记录", "规则与配置"];
  const advancedPass = advancedCategories.every((name) => app.includes(`title: \"${name}\"`));
  addCheck({ id: "ia.advanced-options", dimension: "informationArchitecture", title: "高级选项八类结构完整", points: 1, pass: advancedPass, evidence: advancedPass ? advancedCategories.join("、") : "高级选项分类不完整" });

  const advancedExpandable = html.includes("advancedCategoryGrid") && app.includes("advanced-category") && app.includes("data-advanced-category");
  addCheck({ id: "usability.progressive-disclosure", dimension: "usability", title: "高级内容采用渐进披露", points: 2, pass: advancedExpandable, evidence: advancedExpandable ? "八类高级选项可独立展开" : "高级内容缺少折叠层级" });

  const backupSchemeHierarchy = html.includes("默认备份方案")
    && html.includes("selectAllDefaultButton")
    && html.includes("resetRecommendedButton")
    && app.includes("精细选择 · 同步加入主备份")
    && app.includes("全量已包含")
    && app.includes('selected: selectedPayload("all")')
    && !app.includes("data-create-selected")
    && !app.includes("createSelectionSnapshot");
  addCheck({ id: "ia.backup-scheme-hierarchy", dimension: "informationArchitecture", title: "默认方案与精细选择职责清晰", points: 2, pass: backupSchemeHierarchy, evidence: backupSchemeHierarchy ? "上方主方案与下方精细选择联动，最终统一进入底部主备份" : "主方案与精细选择联动说明不完整" });

  const batchScopes = ["projects", "conversations", "skills", "api"];
  const batchSelection = batchScopes.every((scope) => app.includes(`data-select-all-${scope}`) && app.includes(`data-clear-${scope}`))
    && (app.match(/全选全部/g) || []).length === 4
    && app.includes("const clearButton = document.querySelector(`[data-clear-${key}]`)")
    && html.includes("restoreSelectAllButton")
    && html.includes("restoreClearButton")
    && app.includes("data-restore-group-action");
  addCheck({ id: "usability.batch-selection", dimension: "usability", title: "备份与恢复均支持批量和逐项选择", points: 2, pass: batchSelection, evidence: batchSelection ? "备份的项目、对话、Skills、API 与恢复分组均具备全选、清空和逐项勾选" : "备份或恢复批量选择能力不完整" });

  const durationFeedback = html.includes("backupTimeStatus")
    && html.includes("backupTimeEstimate")
    && app.includes("estimateBackupDuration")
    && app.includes("实际用时")
    && app.includes('startBackupOperation("preview")')
    && app.includes('startBackupOperation("create")')
    && html.includes("实际时间受磁盘速度和小文件数量影响");
  const realProgressFeedback = durationFeedback
    && app.includes('streamApi("/api/snapshot-operation"')
    && app.includes('streamApi("/api/restore-operation"')
    && app.includes("updateBackupOperationProgress")
    && app.includes("updateRestoreOperationProgress")
    && app.includes("completedBytes")
    && app.includes("totalBytes")
    && operationWorker.includes('workerData.operation === "backup"')
    && operationWorker.includes('workerData.operation === "restore"');
  addCheck({ id: "usability.duration-feedback", dimension: "usability", title: "备份与恢复提供真实进度和剩余时间", points: 2, pass: realProgressFeedback, evidence: realProgressFeedback ? "备份和恢复均接收服务端实际阶段、百分比与预计剩余时间" : "真实进度反馈覆盖不完整" });

  const availabilityCopy = app.includes("备份可用性检查")
    && app.includes('pathRisks ? "需确认" : "可读取"')
    && !visibleSource.includes("备份验证")
    && !visibleSource.includes("已验证");
  addCheck({ id: "trust.availability-copy", dimension: "trustAndSafety", title: "可用性检查不冒充完整性验证", points: 2, pass: availabilityCopy, evidence: availabilityCopy ? "状态仅表达文件夹与路径可读取或需确认" : "发现超出当前能力的验证表达" });
  const actionCopy = ["等待生成", "正在创建", "扫描中", "扫描失败", "恢复计划尚未生成"].every((term) => app.includes(term) || html.includes(term));
  addCheck({ id: "usability.feedback", dimension: "usability", title: "关键流程具备等待、进行、失败反馈", points: 2, pass: actionCopy, evidence: actionCopy ? "创建、扫描和恢复均有状态文案" : "关键反馈状态不完整" });

  const safetyCopy = visibleSource.includes("API Key 与登录凭据重新配置") && visibleSource.includes("密钥与登录凭据不会写入备份");
  addCheck({ id: "safety.user-copy", dimension: "trustAndSafety", title: "敏感内容规则对用户可见", points: 1, pass: safetyCopy, evidence: safetyCopy ? "备份与恢复页面均提示凭据处理方式" : "敏感内容提示不足" });

  const defaultAuthFalse = /auth:\s*false/.test(server);
  addCheck({ id: "safety.default-policy", dimension: "trustAndSafety", title: "登录凭据默认关闭", points: 1, pass: defaultAuthFalse, evidence: defaultAuthFalse ? "默认配置 auth=false" : "默认配置未证明排除登录凭据" });

  const destructiveConfirm = app.includes("window.confirm") && app.includes("删除恢复点");
  addCheck({ id: "usability.destructive-confirm", dimension: "usability", title: "删除恢复点前明确确认", points: 1, pass: destructiveConfirm, evidence: destructiveConfirm ? "删除前展示恢复点确认" : "删除操作缺少确认" });

  const labelsPresent = (html.match(/aria-label|aria-describedby|sr-only/g) || []).length >= 8;
  addCheck({ id: "usability.accessibility", dimension: "usability", title: "基础可访问名称与说明", points: 1, pass: labelsPresent, evidence: `发现 ${(html.match(/aria-label|aria-describedby|sr-only/g) || []).length} 处辅助标签证据` });

  const onePrimaryPattern = css.includes(".button.primary")
    && (html.match(/id=\"createBackupButton\"/g) || []).length === 1
    && html.includes("id=\"restorePlanButton\"")
    && !app.includes("data-create-selected")
    && !app.includes("createSelectionSnapshot");
  addCheck({ id: "usability.primary-actions", dimension: "usability", title: "核心页面具有明确且唯一的主操作", points: 2, pass: onePrimaryPattern, evidence: onePrimaryPattern ? "创建备份页仅保留底部主入口；恢复计划保留单一主按钮" : "发现重复创建入口或主操作证据不足" });

  const semanticColors = ["#2267", "#35c8", "#ff8", "#46cf", "#8068", "#f266"].filter((token) => css.toLowerCase().includes(token)).length;
  addCheck({ id: "visual.semantic-color", dimension: "visualExperience", title: "颜色语义覆盖蓝青、橙、薄荷、紫和珊瑚", points: 2, pass: semanticColors >= 4, evidence: `匹配 ${semanticColors}/6 组基准色` });

  const glassEvidence = (css.match(/backdrop-filter/g) || []).length >= 3 && /box-shadow/.test(css) && /inset/.test(css);
  addCheck({ id: "visual.glass-system", dimension: "visualExperience", title: "玻璃材质具有模糊、高光和双层阴影证据", points: 2, pass: glassEvidence, evidence: `backdrop-filter 出现 ${(css.match(/backdrop-filter/g) || []).length} 次` });

  const states = [":hover", ":active", ":focus-visible", ":disabled"].every((state) => css.includes(state))
    && css.includes("prismGlassSweep")
    && css.includes("prismEdgeFlow")
    && css.includes(".nav-item):not(:disabled):hover");
  addCheck({ id: "visual.control-states", dimension: "visualExperience", title: "全局按钮状态与玻璃动效完整", points: 1, pass: states, evidence: states ? "hover、active、focus-visible、disabled、玻璃扫光和边缘流光均覆盖侧栏按钮" : "按钮状态或侧栏动效不完整" });

  const screenshots = [
    ["overview", "32-home-final-1440x1000.png", 1440, 1000], ["backup", "33-backup-final-1440x1000.png", 1440, 1000],
    ["restore", "34-restore-final-1440x1000.png", 1440, 1000], ["manager", "35-manager-final-1440x1000.png", 1440, 1000],
    ["settings", "36-settings-final-1440x1000.png", 1440, 1000], ["overview", "37-home-final-1280x720.png", 1280, 720],
    ["backup", "38-backup-final-1280x720.png", 1280, 720], ["restore", "39-restore-final-1280x720.png", 1280, 720],
    ["manager", "40-manager-final-1280x720.png", 1280, 720], ["settings", "41-settings-final-1280x720.png", 1280, 720]
  ];
  const screenshotRoot = path.join(ROOT, "ui-verification", "flow-audit-20260813");
  const sourceMtime = Math.max(...["public/index.html", "public/app.js", "public/styles.css"].map((file) => fs.statSync(path.join(ROOT, file)).mtimeMs));
  const screenshotResults = screenshots.map(([, name, width, height]) => {
    const file = path.join(screenshotRoot, name);
    if (!fs.existsSync(file)) return { name, pass: false, reason: "缺失" };
    const size = pngSize(file);
    const fresh = fs.statSync(file).mtimeMs >= sourceMtime;
    return { name, pass: size?.width === width && size?.height === height && fresh, reason: !fresh ? "早于当前 UI 代码" : `${size?.width}x${size?.height}` };
  });
  const screenshotPass = screenshotResults.every((item) => item.pass);
  addCheck({ id: "visual.desktop-evidence", dimension: "visualExperience", title: "五页双尺寸截图与当前代码同步", points: 1, pass: screenshotPass, evidence: screenshotPass ? "10 张桌面验收截图尺寸正确且为最新" : screenshotResults.filter((item) => !item.pass).map((item) => `${item.name}: ${item.reason}`).join("；") });

  const packageJson = JSON.parse(read("package.json"));
  const macEvidence = validateMacosReleaseEvidence(
    path.join(REPORT_DIR, "macos-arm64-release-latest.json"),
    packageJson.version
  );
  addCheck({
    id: "external.macos-arm64-runtime",
    dimension: "engineeringQuality",
    title: "外部门禁：Apple Silicon 最终 DMG/ZIP 与启动8秒",
    points: 0,
    pass: macEvidence.pass,
    external: true,
    stageAllowed: true,
    evidence: macEvidence.evidence
  });

  return server;
}

function scoreReport(manual) {
  const byDimension = {};
  for (const [key, definition] of Object.entries(DIMENSIONS)) {
    const automated = checks.filter((check) => check.dimension === key).reduce((sum, check) => sum + check.awarded, 0);
    const automatedMax = checks.filter((check) => check.dimension === key).reduce((sum, check) => sum + check.points, 0);
    const manualItem = manual.scores[key];
    byDimension[key] = {
      ...definition,
      automated,
      automatedMax,
      manual: manualItem?.score ?? null,
      manualMax: MANUAL_MAX[key] || 0,
      total: automated + (manualItem?.score || 0)
    };
  }
  const automated = checks.reduce((sum, check) => sum + check.awarded, 0);
  const automatedMax = checks.reduce((sum, check) => sum + check.points, 0);
  const manualScore = Object.values(manual.scores).reduce((sum, item) => sum + item.score, 0);
  const manualMax = Object.values(MANUAL_MAX).reduce((sum, value) => sum + value, 0);
  return { byDimension, automated, automatedMax, manualScore, manualMax, total: automated + manualScore };
}

function verdictFor(manual, score) {
  const criticalFailures = checks.filter((check) => check.critical && !check.pass && !(profile === "stage" && check.stageAllowed));
  const externalPending = checks.filter((check) => check.external && !check.pass && !(profile === "stage" && check.stageAllowed));
  if (!manual.valid || criticalFailures.length) return { code: "FAIL", label: "不予发布", criticalFailures, externalPending };
  if (externalPending.length || !manual.supplied || manual.pending.length) {
    const label = externalPending.length && (!manual.supplied || manual.pending.length)
      ? "等待 Mac 实机与人工验收"
      : externalPending.length ? "等待 Mac 实机验收" : "自动检查完成，等待人工验收";
    return { code: "INCOMPLETE", label, criticalFailures: [], externalPending };
  }
  if (score.total >= 90) return { code: "PASS", label: "通过正式验收", criticalFailures: [], externalPending: [] };
  if (score.total >= 80) return { code: "CONDITIONAL", label: "可内测，正式发布前需整改", criticalFailures: [], externalPending: [] };
  return { code: "FAIL", label: "总分未达到发布标准", criticalFailures: [], externalPending: [] };
}

function renderMarkdown(result) {
  const lines = [];
  lines.push("# Codex Link 产品自检报告", "", `- 执行时间：${result.finishedAt}`, `- 验收模式：${profile === "release" ? "正式发布" : "开发阶段"}`, `- 判定：**${result.verdict.code} · ${result.verdict.label}**`, `- 当前得分：**${result.score.total}/100**`, `- 自动得分：${result.score.automated}/${result.score.automatedMax}`, `- 人工得分：${result.score.manualScore}/${result.score.manualMax}${result.manual.supplied ? "" : "（未提交）"}`, "");
  if (result.verdict.criticalFailures.length) {
    lines.push("## P0 阻断项", "");
    for (const check of result.verdict.criticalFailures) lines.push(`- **${check.title}**：${check.evidence}`);
    lines.push("");
  }
  if (result.verdict.externalPending.length) {
    lines.push("## 外部完成门禁", "");
    for (const check of result.verdict.externalPending) lines.push(`- **${check.title}**：${check.evidence}`);
    lines.push("");
  }
  lines.push("## 八维评分", "", "| 维度 | 自动 | 人工 | 当前总分 | 权重 |", "|---|---:|---:|---:|---:|");
  for (const item of Object.values(result.score.byDimension)) lines.push(`| ${item.label} | ${item.automated}/${item.automatedMax} | ${item.manual === null ? "待验收" : `${item.manual}/${item.manualMax}`} | ${item.total} | ${item.weight} |`);
  lines.push("", "## 自动检查明细", "", "| 结果 | 级别 | 维度 | 检查项 | 得分 | 证据 |", "|---|---|---|---|---:|---|");
  for (const check of checks) {
    const status = check.pass ? "通过" : profile === "stage" && check.stageAllowed ? "阶段缺口" : check.external ? "外部待验" : "失败";
    lines.push(`| ${status} | ${check.critical ? "P0" : check.external ? "外部门禁" : "普通"} | ${DIMENSIONS[check.dimension].label} | ${check.title} | ${check.awarded}/${check.points} | ${check.evidence.replaceAll("|", "\\|").replaceAll("\n", " ")} |`);
  }
  lines.push("", "## 人工验收", "");
  if (!result.manual.supplied) lines.push("尚未提供人工验收。复制并填写 `qa/manual-review.example.json`，再使用 `--manual` 重新运行。", "");
  else if (!result.manual.valid) lines.push(`人工验收文件无效：${result.manual.evidence}`, "");
  else {
    lines.push(
      `- 验收人：${result.manual.reviewer}`,
      `- 验收角色：${result.manual.reviewerRole}`,
      `- 验收日期：${result.manual.reviewedAt}`,
      `- 体验者：${result.manual.participants.total} 位（首次使用者 ${result.manual.participants.firstTimeUsers} 位；目标用户 ${result.manual.participants.targetUsers} 位）`,
      `- 证据附件：${result.manual.artifacts.length} 项`,
      ""
    );
    for (const [key, max] of Object.entries(MANUAL_MAX)) {
      const item = result.manual.scores[key];
      lines.push(`- ${DIMENSIONS[key].label}：${item ? `${item.score}/${max}，${item.evidence}` : `待验收（满分 ${max}）`}`);
    }
    lines.push("");
  }
  lines.push("## 发布规则", "", "总分不能抵消 P0 失败。正式发布必须具备真实恢复执行、回滚保护、恢复点完整性验证、敏感凭据排除和路径隔离。", "");
  return `${lines.join("\n")}\n`;
}

async function main() {
  let serverSource;
  try {
    serverSource = runStaticChecks();
    await runRuntimeChecks(serverSource);
  } catch (error) {
    addCheck({ id: "engineering.runner", dimension: "engineeringQuality", title: "自检运行器完成隔离测试", points: 0, pass: false, critical: true, evidence: error.stack || error.message });
  } finally {
    if (serverProcess && !serverProcess.killed) serverProcess.kill();
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  const manual = manualReview();
  const score = scoreReport(manual);
  const verdict = verdictFor(manual, score);
  const result = {
    schemaVersion: 1,
    profile,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    verdict,
    score,
    manual,
    checks
  };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, "self-check-latest.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(REPORT_DIR, "self-check-latest.md"), renderMarkdown(result), "utf8");

  console.log(`Codex Link 自检：${verdict.code} · ${verdict.label}`);
  console.log(`当前得分：${score.total}/100（自动 ${score.automated}/${score.automatedMax}，人工 ${score.manualScore}/${score.manualMax}）`);
  console.log(`报告：${path.join(REPORT_DIR, "self-check-latest.md")}`);
  if (verdict.criticalFailures.length) {
    console.log("P0 阻断项：");
    for (const check of verdict.criticalFailures) console.log(`- ${check.title}: ${check.evidence}`);
  }
  process.exitCode = verdict.code === "PASS" || verdict.code === "CONDITIONAL" ? 0 : verdict.code === "INCOMPLETE" ? 2 : 1;
}

main();
