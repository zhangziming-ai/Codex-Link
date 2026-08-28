"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

function sqliteHeader(filePath) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  const header = Buffer.alloc(100);
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (header.subarray(0, 16).toString("binary") !== "SQLite format 3\0") throw new Error("SQLite header is invalid.");
  let pageSize = header.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  const headerPageCount = header.readUInt32BE(28);
  return { size: stat.size, pageSize, headerPageCount, declaredBytes: pageSize * headerPageCount };
}

function validateSQLiteDatabase(filePath, options = {}) {
  const report = {
    path: filePath,
    quickCheck: null,
    integrityCheck: null,
    actualSize: 0,
    expectedSize: options.expectedSize ?? null,
    pageSize: 0,
    pageCount: 0,
    headerPageCount: 0,
    threadCount: 0,
    expectedThreadCount: options.expectedThreadCount ?? null,
    missingRolloutCount: 0,
    missingRollouts: [],
    checkedRolloutCount: 0,
    valid: false
  };
  const header = sqliteHeader(filePath);
  Object.assign(report, { actualSize: header.size, pageSize: header.pageSize, headerPageCount: header.headerPageCount });
  if (header.declaredBytes !== header.size) throw Object.assign(new Error("SQLite file is truncated or has trailing bytes."), { report });
  if (report.expectedSize != null && Number(report.expectedSize) !== header.size) throw Object.assign(new Error("SQLite size does not match the restore manifest."), { report });

  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    report.quickCheck = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
    report.integrityCheck = db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
    report.pageCount = Number(Object.values(db.prepare("PRAGMA page_count").get())[0]);
    if (report.pageCount !== header.headerPageCount) throw Object.assign(new Error("SQLite page count does not match its header."), { report });
    if (report.quickCheck.length !== 1 || report.quickCheck[0] !== "ok") throw Object.assign(new Error("SQLite quick_check failed."), { report });
    if (report.integrityCheck.length !== 1 || report.integrityCheck[0] !== "ok") throw Object.assign(new Error("SQLite integrity_check failed."), { report });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!tables.has("threads")) throw Object.assign(new Error("SQLite critical table threads is missing."), { report });
    report.threadCount = Number(db.prepare("SELECT COUNT(*) AS count FROM threads").get().count);
    if (report.expectedThreadCount != null && report.threadCount !== Number(report.expectedThreadCount)) {
      throw Object.assign(new Error("SQLite thread count does not match the restore plan."), { report });
    }
    const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((row) => row.name));
    if (columns.has("rollout_path") && options.rolloutResolver) {
      const rows = db.prepare("SELECT id, rollout_path FROM threads WHERE rollout_path IS NOT NULL AND rollout_path <> ''").all();
      const selectedThreadIds = options.threadIds ? new Set(options.threadIds.map(String)) : null;
      for (const row of rows) {
        if (selectedThreadIds && !selectedThreadIds.has(String(row.id))) continue;
        report.checkedRolloutCount += 1;
        const resolved = options.rolloutResolver(String(row.rollout_path));
        if (!resolved || !fs.existsSync(resolved)) report.missingRollouts.push({ threadId: String(row.id), rolloutPath: String(row.rollout_path) });
      }
      report.missingRolloutCount = report.missingRollouts.length;
      if (report.missingRolloutCount && options.requireAllRollouts !== false) {
        throw Object.assign(new Error("One or more SQLite rollout_path values do not point to restored session files."), { report });
      }
    }
    report.valid = true;
    return report;
  } finally {
    db.close();
  }
}

function createConsistentSQLiteCopy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const escaped = target.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
  return validateSQLiteDatabase(target, { requireAllRollouts: false });
}

function relevantRunningProcesses(options = {}) {
  if (Array.isArray(options.processes)) return options.processes;
  const command = process.platform === "win32"
    ? spawnSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true })
    : spawnSync("ps", ["-axo", "comm="], { encoding: "utf8" });
  if (command.error || command.status !== 0) return [];
  const ownPid = process.pid;
  return String(command.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .filter((line) => /(?:^|[\\/\s"])(?:codex(?:\.exe)?|codex link(?:\.exe)?|chatgpt(?:\.exe)?)(?:["\s]|$)/i.test(line))
    .filter((line) => !line.includes(String(ownPid)));
}

function isRealUserCodexHome(targetRoot) {
  const expected = path.resolve(os.homedir(), ".codex");
  return path.resolve(targetRoot) === expected;
}

function assertSQLiteTargetSafe({ targetDatabase, targetRoot, processes, realUserTarget }) {
  const conflicts = [`${targetDatabase}-wal`, `${targetDatabase}-shm`].filter((item) => fs.existsSync(item));
  if (conflicts.length) {
    const error = new Error("Target SQLite WAL/SHM files are present. Close Codex/ChatGPT and checkpoint or preserve them before restoring.");
    error.details = { phase: "sqlite_preflight", walShmConflicts: conflicts };
    throw error;
  }
  const running = relevantRunningProcesses({ processes });
  const realTarget = realUserTarget === undefined ? isRealUserCodexHome(targetRoot) : Boolean(realUserTarget);
  if (running.length && realTarget) {
    const error = new Error("Codex or ChatGPT is still running. Fully exit it before restoring state_5.sqlite.");
    error.details = { phase: "sqlite_preflight", runningProcesses: running };
    throw error;
  }
  return { runningProcessesDetected: running, isolatedTarget: !realTarget, walShmConflicts: [] };
}

module.exports = {
  assertSQLiteTargetSafe,
  createConsistentSQLiteCopy,
  isRealUserCodexHome,
  relevantRunningProcesses,
  sqliteHeader,
  validateSQLiteDatabase
};
