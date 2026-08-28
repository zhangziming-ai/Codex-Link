"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const APP_VERSION = require("../package.json").version;
const {
  deleteSqliteThreadAssociations,
  fingerprintSqliteThreadAssociations,
  fingerprintSqliteThreads,
  normalizeProjectPath,
  mergeSelectedSqliteThreads,
  rewriteJsonlPathMetadata,
  rewriteSqlitePaths,
  walkJsonl
} = require("./portable-projects");
const {
  assertSQLiteTargetSafe,
  createConsistentSQLiteCopy,
  validateSQLiteDatabase
} = require("./sqlite-safety");

class RestoreExecutionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "RestoreExecutionError";
    this.details = details;
  }
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

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sha256File(filePath, onChunk = () => {}) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) {
        hash.update(buffer.subarray(0, bytesRead));
        onChunk(bytesRead);
      }
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function portablePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function validateRelativePath(value) {
  const raw = String(value || "");
  const normalized = portablePath(raw).replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);
  if (
    !normalized
    || path.posix.isAbsolute(raw)
    || path.win32.isAbsolute(raw)
    || parts.some((part) => part === ".." || part === ".")
  ) {
    throw new Error("Unsafe relative path in restore metadata.");
  }
  return parts.join("/");
}

function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const relative = validateRelativePath(relativePath);
  const target = path.resolve(resolvedRoot, ...relative.split("/"));
  const check = path.relative(resolvedRoot, target);
  if (!check || check.startsWith("..") || path.isAbsolute(check)) {
    throw new Error("Restore path escapes its allowed root.");
  }
  return target;
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function collectEntries(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const rootStat = statSafe(resolvedRoot, true);
  if (!rootStat) return { rootType: "missing", entries: [] };

  const entries = [];
  function visit(current, relative) {
    const stat = statSafe(current, true);
    if (!stat) throw new Error(`File disappeared while hashing: ${current}`);
    if (stat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(current);
      const item = {
        path: portablePath(relative || path.basename(current)),
        type: "symlink",
        size: Buffer.byteLength(linkTarget),
        sha256: sha256Text(linkTarget),
        linkTarget
      };
      entries.push(item);
      options.onHashChunk?.({ bytes: item.size, path: item.path, type: item.type });
      options.onEntry?.(item);
      return;
    }
    if (stat.isDirectory()) {
      const children = fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        visit(path.join(current, child.name), relative ? path.join(relative, child.name) : child.name);
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported filesystem entry: ${current}`);
    }
    const item = {
      path: portablePath(relative || path.basename(current)),
      type: "file",
      size: stat.size,
      sha256: sha256File(current, (bytes) => options.onHashChunk?.({
        bytes,
        path: portablePath(relative || path.basename(current)),
        type: "file"
      }))
    };
    entries.push(item);
    options.onEntry?.(item);
  }

  visit(resolvedRoot, "");
  return {
    rootType: rootStat.isDirectory() ? "directory" : rootStat.isSymbolicLink() ? "symlink" : "file",
    entries
  };
}

function manifestCore(manifest) {
  const core = { ...manifest };
  delete core.integrity;
  return core;
}

function manifestCoreDigest(manifest) {
  return sha256Text(JSON.stringify(manifestCore(manifest)));
}

function buildSnapshotIntegrity(snapshotDir, manifest, options = {}) {
  const payloadDir = path.join(path.resolve(snapshotDir), "payload");
  const { entries } = collectEntries(payloadDir, options);
  return {
    version: 1,
    algorithm: "sha256",
    generatedAt: new Date().toISOString(),
    manifestSha256: manifestCoreDigest(manifest),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, item) => sum + Number(item.size || 0), 0),
    files: entries
  };
}

function finalizeSnapshotManifest(snapshotDir, manifest, options = {}) {
  manifest.formatVersion = 4;
  manifest.integrity = buildSnapshotIntegrity(snapshotDir, manifest, options);
  const manifestPath = path.join(snapshotDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function readSnapshotManifest(snapshotDir) {
  const resolved = path.resolve(snapshotDir || "");
  const stat = statSafe(resolved);
  if (!stat || !stat.isDirectory()) throw new Error("Restore point folder was not found.");
  const manifestPath = path.join(resolved, "manifest.json");
  if (!exists(manifestPath)) throw new Error("Restore point manifest.json was not found.");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Restore point manifest.json is unreadable.");
  }
  return { snapshotDir: resolved, manifest };
}

function verificationIssue(kind, relativePath, detail) {
  return { kind, path: relativePath || "", detail };
}

function verifySnapshotIntegrity(snapshotDir, options = {}) {
  const { snapshotDir: resolved, manifest } = readSnapshotManifest(snapshotDir);
  const integrity = manifest.integrity;
  if (!integrity || integrity.algorithm !== "sha256" || !Array.isArray(integrity.files)) {
    return {
      status: "unverified",
      verified: false,
      legacy: true,
      algorithm: null,
      fileCount: collectEntries(path.join(resolved, "payload")).entries.length,
      totalBytes: 0,
      issueCount: 0,
      issues: [],
      message: "This restore point predates per-file hash manifests."
    };
  }

  const issues = [];
  if (integrity.manifestSha256 !== manifestCoreDigest(manifest)) {
    issues.push(verificationIssue("manifest_mismatch", "manifest.json", "Manifest metadata no longer matches its recorded digest."));
  }

  const expected = new Map();
  for (const raw of integrity.files) {
    let relative;
    try {
      relative = validateRelativePath(raw.path);
    } catch {
      issues.push(verificationIssue("unsafe_path", raw.path, "Integrity manifest contains an unsafe path."));
      continue;
    }
    if (expected.has(relative)) {
      issues.push(verificationIssue("duplicate_path", relative, "Integrity manifest contains this path more than once."));
      continue;
    }
    expected.set(relative, raw);
  }

  const actualEntries = collectEntries(path.join(resolved, "payload"), options).entries;
  const actual = new Map(actualEntries.map((item) => [validateRelativePath(item.path), item]));

  for (const [relative, wanted] of expected) {
    const found = actual.get(relative);
    if (!found) {
      issues.push(verificationIssue("missing", relative, "File is missing from the restore point."));
      continue;
    }
    if (found.type !== wanted.type) {
      issues.push(verificationIssue("type_mismatch", relative, `Expected ${wanted.type}, found ${found.type}.`));
    } else if (Number(found.size) !== Number(wanted.size)) {
      issues.push(verificationIssue("size_mismatch", relative, `Expected ${wanted.size} bytes, found ${found.size}.`));
    } else if (found.sha256 !== wanted.sha256) {
      issues.push(verificationIssue("hash_mismatch", relative, "SHA-256 digest does not match."));
    }
    actual.delete(relative);
  }

  for (const relative of actual.keys()) {
    issues.push(verificationIssue("unexpected", relative, "Unexpected file is present in the restore point."));
  }

  return {
    status: issues.length ? "failed" : "verified",
    verified: issues.length === 0,
    legacy: false,
    algorithm: "sha256",
    fileCount: integrity.fileCount,
    totalBytes: integrity.totalBytes,
    issueCount: issues.length,
    issues: issues.slice(0, 200),
    message: issues.length ? "Restore point integrity verification failed." : "Every recorded file passed SHA-256 verification."
  };
}

function removePath(target) {
  if (!exists(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function measurePath(target) {
  const result = { totalBytes: 0, fileCount: 0 };
  function visit(current) {
    const stat = statSafe(current, true);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      result.totalBytes += Buffer.byteLength(fs.readlinkSync(current));
      result.fileCount += 1;
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) visit(path.join(current, entry.name));
      return;
    }
    if (stat.isFile()) {
      result.totalBytes += stat.size;
      result.fileCount += 1;
    }
  }
  visit(target);
  return result;
}

function copyPath(source, target, options = {}) {
  const stat = statSafe(source, true);
  if (!stat) throw new Error(`Restore source is missing: ${source}`);
  const onChunk = typeof options.onChunk === "function" ? options.onChunk : () => {};
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  function copyEntry(currentSource, currentTarget) {
    const currentStat = statSafe(currentSource, true);
    if (!currentStat) throw new Error(`Restore source is missing: ${currentSource}`);
    if (currentStat.isSymbolicLink()) {
      fs.mkdirSync(path.dirname(currentTarget), { recursive: true });
      removePath(currentTarget);
      const linkTarget = fs.readlinkSync(currentSource);
      fs.symlinkSync(linkTarget, currentTarget);
      onChunk({ bytes: Buffer.byteLength(linkTarget), fileCompleted: true, source: currentSource });
      return;
    }
    if (currentStat.isDirectory()) {
      fs.mkdirSync(currentTarget, { recursive: true });
      for (const entry of fs.readdirSync(currentSource, { withFileTypes: true })) {
        copyEntry(path.join(currentSource, entry.name), path.join(currentTarget, entry.name));
      }
      return;
    }
    if (!currentStat.isFile()) throw new Error(`Unsupported restore entry: ${currentSource}`);
    fs.mkdirSync(path.dirname(currentTarget), { recursive: true });
    const sourceFd = fs.openSync(currentSource, "r");
    const targetFd = fs.openSync(currentTarget, "w", currentStat.mode);
    let copied = 0;
    try {
      while (copied < currentStat.size) {
        const bytesRead = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, currentStat.size - copied), copied);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) {
          written += fs.writeSync(targetFd, buffer, written, bytesRead - written, copied + written);
        }
        copied += bytesRead;
        onChunk({ bytes: bytesRead, fileCompleted: copied >= currentStat.size, source: currentSource });
      }
      if (currentStat.size === 0) onChunk({ bytes: 0, fileCompleted: true, source: currentSource });
    } finally {
      fs.closeSync(sourceFd);
      fs.closeSync(targetFd);
    }
    try {
      fs.chmodSync(currentTarget, currentStat.mode);
      fs.utimesSync(currentTarget, currentStat.atime, currentStat.mtime);
    } catch {}
  }
  copyEntry(source, target);
}

function comparePaths(expectedPath, actualPath, options = {}) {
  const expected = collectEntries(expectedPath, options);
  const actual = collectEntries(actualPath, options);
  const issues = [];
  if (expected.rootType !== actual.rootType) {
    issues.push({ kind: "root_type_mismatch", path: "", detail: `Expected ${expected.rootType}, found ${actual.rootType}.` });
    return issues;
  }
  if (expected.rootType !== "directory") {
    const wanted = expected.entries[0];
    const found = actual.entries[0];
    if (!wanted || !found) {
      issues.push({ kind: "missing", path: "", detail: "Restored file is missing." });
    } else if (
      wanted.type !== found.type
      || wanted.size !== found.size
      || wanted.sha256 !== found.sha256
      || wanted.linkTarget !== found.linkTarget
    ) {
      issues.push({ kind: "content_mismatch", path: "", detail: "Restored file does not match staged content." });
    }
    return issues;
  }

  const actualMap = new Map(actual.entries.map((item) => [item.path, item]));
  for (const wanted of expected.entries) {
    const found = actualMap.get(wanted.path);
    if (!found) {
      issues.push({ kind: "missing", path: wanted.path, detail: "Restored file is missing." });
      continue;
    }
    if (wanted.type !== found.type || wanted.size !== found.size || wanted.sha256 !== found.sha256) {
      issues.push({ kind: "content_mismatch", path: wanted.path, detail: "Restored file does not match staged content." });
    }
    actualMap.delete(wanted.path);
  }
  if (!options.allowUnexpected) {
    for (const relative of actualMap.keys()) {
      issues.push({ kind: "unexpected", path: relative, detail: "Unexpected file remains at the restored target." });
    }
  }
  return issues;
}

function validateTargetHome(targetCodexHome, snapshotDir) {
  const target = path.resolve(targetCodexHome || "");
  const root = path.parse(target).root;
  if (!targetCodexHome || target === root) throw new Error("Refusing to restore into a filesystem root.");
  if (target === path.resolve(snapshotDir) || isInside(snapshotDir, target)) {
    throw new Error("Restore target cannot be inside the selected restore point.");
  }
  return target;
}

function validatedMappings(plan) {
  const snapshotRoot = path.resolve(plan.snapshotDir);
  const payloadRoot = path.join(snapshotRoot, "payload");
  const targetRoot = validateTargetHome(plan.targetCodexHome, snapshotRoot);
  const mappings = [];
  const targetKeys = new Set();

  for (const mapping of plan.mappings || []) {
    if (!mapping.source || mapping.source === "metadata-only" || mapping.action === "configure_api_credentials") continue;
    const source = path.resolve(mapping.source);
    if (!isInside(payloadRoot, source) && source !== payloadRoot) {
      throw new Error(`Restore source is outside payload: ${mapping.label || source}`);
    }
    if (!exists(source)) throw new Error(`Restore source is missing: ${mapping.label || source}`);

    const target = path.resolve(mapping.target);
    if (!isInside(targetRoot, target)) {
      throw new Error(`Restore target is outside the Codex home: ${mapping.label || target}`);
    }
    const relativeTarget = validateRelativePath(path.relative(targetRoot, target));
    const key = process.platform === "win32" ? relativeTarget.toLowerCase() : relativeTarget;
    if (targetKeys.has(key)) throw new Error(`Duplicate restore target: ${relativeTarget}`);
    targetKeys.add(key);
    mappings.push({ ...mapping, source, target, relativeTarget });
  }

  if (!mappings.length) throw new Error("Restore plan contains no file mappings.");
  return { mappings, targetRoot };
}

function rollbackRootFor(cloudDir) {
  return path.join(path.resolve(cloudDir), "Codex Link", "rollback-points");
}

function createRollbackPoint({ mappings, targetRoot, rollbackRoot, sourceSnapshotId, onProgress = () => {} }) {
  const id = `rollback-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const rollbackDir = path.join(path.resolve(rollbackRoot), id);
  const items = [];
  fs.mkdirSync(rollbackDir, { recursive: true });

  let completedUnits = 0;
  for (const [mappingIndex, mapping] of mappings.entries()) {
    const staged = collectEntries(mapping.stageTarget);
    const stagedEntries = staged.rootType === "directory"
      ? staged.entries
      : [{ ...staged.entries[0], path: "" }];
    for (const stagedEntry of stagedEntries) {
      const target = stagedEntry.path
        ? path.join(mapping.target, ...stagedEntry.path.split("/"))
        : mapping.target;
      const relativeTarget = portablePath(path.relative(targetRoot, target));
      const before = statSafe(target, true);
      const existed = Boolean(before);
      const rollbackRelative = path.join("payload", ...relativeTarget.split("/"));
      let beforeHash = null;
      if (existed) {
        const beforeEntry = collectEntries(target).entries[0];
        beforeHash = beforeEntry?.sha256 || null;
        copyPath(target, path.join(rollbackDir, rollbackRelative));
      }
      items.push({
        label: mapping.label || mapping.relativeTarget,
        targetPath: target,
        target,
        relativeTarget,
        operation: mapping.kind === "stateDbMerge" ? "merge" : existed ? "overwrite" : "create",
        beforeHash,
        afterHash: stagedEntry.sha256,
        rollbackPayloadPath: existed ? portablePath(rollbackRelative) : null,
        rollbackRelative: existed ? portablePath(rollbackRelative) : null,
        threadId: mapping.threadId || null,
        selectedThreadIds: mapping.kind === "stateDbMerge" ? mapping.selectedThreadIds || [] : undefined,
        insertedThreadIds: mapping.kind === "stateDbMerge" ? mapping.transactionDetails?.insertedThreadIds || [] : undefined,
        insertedThreadFingerprints: mapping.kind === "stateDbMerge" ? mapping.transactionDetails?.insertedThreadFingerprints || {} : undefined,
        insertedAssociationFingerprints: mapping.kind === "stateDbMerge" ? mapping.transactionDetails?.insertedAssociationFingerprints || {} : undefined,
        preservedThreadIds: mapping.kind === "stateDbMerge" ? mapping.transactionDetails?.preservedThreadIds || [] : undefined,
        mappingIndex,
        existed
      });
    }
    completedUnits += 1;
    onProgress({ completedUnits, totalUnits: mappings.length, mapping });
  }

  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    snapshotKind: "automatic-rollback",
    sourceSnapshotId: sourceSnapshotId || null,
    targetCodexHome: targetRoot,
    items,
    appVersion: APP_VERSION,
    transactionSchemaVersion: 2
  };
  finalizeSnapshotManifest(rollbackDir, manifest);
  return { id, rollbackDir, manifest };
}

function currentEntryHash(target) {
  if (!exists(target)) return null;
  const entry = collectEntries(target).entries[0];
  return entry?.sha256 || null;
}

function mergedSqliteConflicts(item) {
  const expected = item.insertedThreadFingerprints || {};
  if (!Object.keys(expected).length) return null;
  const target = item.targetPath || item.target;
  const threadIds = Object.keys(expected);
  const actual = fingerprintSqliteThreads(target, threadIds);
  const conflicts = Object.entries(expected)
    .filter(([id, hash]) => actual[id] !== null && actual[id] !== hash)
    .map(([id]) => ({ path: item.relativeTarget, operation: "merge", threadId: id, reason: "restored_thread_changed_after_restore" }));
  const expectedAssociations = item.insertedAssociationFingerprints || {};
  if (Object.keys(expectedAssociations).length) {
    const actualAssociations = fingerprintSqliteThreadAssociations(target, threadIds);
    conflicts.push(...Object.entries(expectedAssociations)
      .filter(([key, hash]) => actualAssociations[key] !== hash)
      .map(([key]) => ({ path: item.relativeTarget, operation: "merge", associationKey: key, reason: "restored_thread_association_changed_after_restore" })));
  }
  return conflicts;
}

function undoMergedSqliteItem(item) {
  const target = item.targetPath || item.target;
  const insertedIds = Object.keys(item.insertedThreadFingerprints || {});
  if (!insertedIds.length || !exists(target)) return { removedThreadCount: 0 };
  const conflicts = mergedSqliteConflicts(item) || [];
  if (conflicts.length) return { conflicts };
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.codex-link-undo-${process.pid}-${crypto.randomBytes(3).toString("hex")}`);
  try {
    createConsistentSQLiteCopy(target, temp);
    const db = new DatabaseSync(temp);
    let removedThreadCount = 0;
    let remainingThreadCount = 0;
    try {
      db.exec("BEGIN IMMEDIATE");
      deleteSqliteThreadAssociations(db, insertedIds);
      const remove = db.prepare("DELETE FROM threads WHERE id = ?");
      for (const id of insertedIds) removedThreadCount += Number(remove.run(id).changes || 0);
      db.exec("COMMIT");
      remainingThreadCount = Number(db.prepare("SELECT COUNT(*) AS count FROM threads").get().count);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      db.close();
    }
    validateSQLiteDatabase(temp, { expectedThreadCount: remainingThreadCount, requireAllRollouts: false });
    if (!item.existed && remainingThreadCount === 0) {
      removePath(target);
      return { removedThreadCount, removedTarget: true };
    }
    installSQLiteAtomically(temp, target);
    return { removedThreadCount, remainingThreadCount };
  } finally {
    removePath(temp);
  }
}

function restoreFromRollback(rollback, { failAfterItems = 0 } = {}) {
  const issues = [];
  let processedItems = 0;
  const modern = Number(rollback.manifest.transactionSchemaVersion || 0) >= 2;
  const items = [...rollback.manifest.items]
    .sort((a, b) => b.relativeTarget.split("/").length - a.relativeTarget.split("/").length);

  const targetRoot = path.resolve(rollback.manifest.targetCodexHome || "");
  for (const item of items) {
    if (failAfterItems && processedItems >= failAfterItems) {
      throw new Error("Injected manual undo failure.");
    }
    processedItems += 1;
    const target = path.resolve(item.targetPath || item.target || "");
    const relativeTarget = validateRelativePath(item.relativeTarget);
    if (!targetRoot || !isInside(targetRoot, target) || validateRelativePath(path.relative(targetRoot, target)) !== relativeTarget) {
      throw new Error("Rollback metadata contains a target outside the original Codex home.");
    }

    if (!modern) {
      removePath(target);
      if (item.existed) {
        const source = resolveInside(rollback.rollbackDir, item.rollbackRelative);
        copyPath(source, target);
        issues.push(...comparePaths(source, target).map((issue) => ({ ...issue, target })));
      } else if (exists(target)) {
        issues.push({ kind: "rollback_remove_failed", path: item.relativeTarget, detail: "A newly created target could not be removed." });
      }
      continue;
    }

    if (item.operation === "merge" && Object.keys(item.insertedThreadFingerprints || {}).length) {
      const mergeUndo = undoMergedSqliteItem(item);
      if (mergeUndo.conflicts?.length) {
        issues.push(...mergeUndo.conflicts.map((conflict) => ({ kind: "rollback_hash_conflict", ...conflict })));
      }
      continue;
    }

    const currentHash = currentEntryHash(target);
    if (item.operation === "create") {
      if (currentHash === null) continue;
      if (currentHash !== item.afterHash) {
        issues.push({ kind: "rollback_hash_conflict", path: item.relativeTarget, detail: "The file changed after restore and was preserved." });
        continue;
      }
      removePath(target);
      continue;
    }

    if (currentHash === item.beforeHash) continue;
    if (currentHash !== item.afterHash) {
      issues.push({ kind: "rollback_hash_conflict", path: item.relativeTarget, detail: "The file changed after restore and was preserved." });
      continue;
    }
    const source = resolveInside(rollback.rollbackDir, item.rollbackPayloadPath || item.rollbackRelative);
    removePath(target);
    copyPath(source, target);
    issues.push(...comparePaths(source, target).map((issue) => ({ ...issue, target })));
  }
  return {
    status: issues.length ? "rollback_failed" : "rolled_back",
    verified: issues.length === 0,
    issueCount: issues.length,
    restoredCount: items.length - issues.length,
    conflictCount: issues.filter((item) => item.kind === "rollback_hash_conflict").length,
    issues: issues.slice(0, 200)
  };
}

const TRANSACTION_FILE = "restore-transaction.json";
const TERMINAL_TRANSACTION_STATES = new Set([
  "completed",
  "rolled_back",
  "rollback_failed",
  "recovered_rolled_back",
  "recovery_failed",
  "manual_rolled_back"
]);

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonDurable(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  const fd = fs.openSync(tempPath, "w");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

function updateTransactionJournal(rollback, status, details = {}) {
  const journalPath = path.join(rollback.rollbackDir, TRANSACTION_FILE);
  const previous = readJsonSafe(journalPath) || {};
  const journal = {
    version: 1,
    transactionId: rollback.id,
    sourceSnapshotId: rollback.manifest.sourceSnapshotId || null,
    targetCodexHome: rollback.manifest.targetCodexHome,
    rollbackDir: rollback.rollbackDir,
    createdAt: previous.createdAt || new Date().toISOString(),
    ...previous,
    ...details,
    status,
    updatedAt: new Date().toISOString()
  };
  writeJsonDurable(journalPath, journal);
  return journal;
}

function cleanupRecordedStage(journal) {
  const stageRoot = journal?.stageRoot ? path.resolve(journal.stageRoot) : "";
  const targetRoot = journal?.targetCodexHome ? path.resolve(journal.targetCodexHome) : "";
  if (!stageRoot || !targetRoot) return;
  const sameParent = path.dirname(stageRoot) === path.dirname(targetRoot);
  const safeName = path.basename(stageRoot).includes(".codex-link-stage-");
  if (sameParent && safeName) removePath(stageRoot);
}

function recoverInterruptedRestores(cloudDir) {
  const root = rollbackRootFor(cloudDir);
  if (!exists(root)) return [];
  const results = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rollbackDir = path.join(root, entry.name);
    const journalPath = path.join(rollbackDir, TRANSACTION_FILE);
    const journal = readJsonSafe(journalPath);
    if (!journal || TERMINAL_TRANSACTION_STATES.has(journal.status)) continue;

    try {
      const integrity = verifySnapshotIntegrity(rollbackDir);
      if (integrity.status !== "verified") {
        throw new Error("Automatic rollback point failed integrity verification.");
      }
      const loaded = readSnapshotManifest(rollbackDir);
      if (loaded.manifest.snapshotKind !== "automatic-rollback") {
        throw new Error("Pending transaction does not reference an automatic rollback point.");
      }
      const rollback = { id: loaded.manifest.id, rollbackDir, manifest: loaded.manifest };
      updateTransactionJournal(rollback, "recovering", { recoveredAt: new Date().toISOString() });
      const rollbackResult = restoreFromRollback(rollback);
      cleanupRecordedStage(journal);
      updateTransactionJournal(
        rollback,
        rollbackResult.verified ? "recovered_rolled_back" : "recovery_failed",
        { recoveryResult: rollbackResult, recoveredAt: new Date().toISOString() }
      );
      results.push({
        transactionId: rollback.id,
        status: rollbackResult.verified ? "recovered_rolled_back" : "recovery_failed",
        rollbackPoint: rollbackDir,
        rollback: rollbackResult
      });
    } catch (error) {
      const fallback = {
        transactionId: journal.transactionId || entry.name,
        status: "recovery_failed",
        rollbackPoint: rollbackDir,
        error: error.message
      };
      try {
        const loaded = readSnapshotManifest(rollbackDir);
        updateTransactionJournal(
          { id: loaded.manifest.id, rollbackDir, manifest: loaded.manifest },
          "recovery_failed",
          { recoveryError: error.message, recoveredAt: new Date().toISOString() }
        );
      } catch {}
      results.push(fallback);
    }
  }
  return results;
}

function sqliteRestoreMapping(mappings) {
  return mappings.find((mapping) => mapping.kind === "stateDb" || path.basename(mapping.target).toLowerCase() === "state_5.sqlite") || null;
}

function integrityEntryForMapping(plan, mapping) {
  const payloadRoot = path.join(path.resolve(plan.snapshotDir), "payload");
  const relative = portablePath(path.relative(payloadRoot, mapping.source));
  return plan.integrity?.files?.find((item) => portablePath(item.path) === relative) || null;
}

function stagedRolloutResolver(stageRoot, targetRoot) {
  const jsonlFiles = walkJsonl(stageRoot);
  const byName = new Map();
  for (const filePath of jsonlFiles) {
    const name = path.basename(filePath).toLocaleLowerCase("en-US");
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(filePath);
  }
  return (rolloutPath) => {
    const rollout = normalizeProjectPath(rolloutPath);
    const target = normalizeProjectPath(targetRoot);
    if (rollout && target && (
      rollout.comparisonKey === target.comparisonKey
      || rollout.comparisonKey.startsWith(`${target.comparisonKey}/`)
    )) {
      const relative = rollout.normalized.slice(target.normalized.length).replace(/^\/+/, "");
      const staged = path.join(stageRoot, ...relative.split("/"));
      if (exists(staged)) return staged;
      const current = path.join(targetRoot, ...relative.split("/"));
      if (exists(current)) return current;
    }
    const matches = byName.get(path.basename(String(rolloutPath).replace(/\\/g, "/")).toLocaleLowerCase("en-US")) || [];
    return matches.length === 1 ? matches[0] : null;
  };
}

function adaptStagedPayload({ plan, mappings, stageRoot, targetRoot }) {
  const rewriteMappings = Array.isArray(plan.pathRewriteMappings) ? plan.pathRewriteMappings : [];
  const report = { jsonlFieldsUpdated: 0, sqlite: null };
  if (!rewriteMappings.length) return report;
  for (const mapping of mappings) {
    if (mapping.kind !== "conversation" && !["sessions", "archivedSessions"].includes(mapping.kind)) continue;
    for (const filePath of walkJsonl(mapping.stageTarget)) {
      report.jsonlFieldsUpdated += rewriteJsonlPathMetadata(filePath, rewriteMappings);
    }
  }
  const sqliteMapping = sqliteRestoreMapping(mappings);
  if (sqliteMapping) report.sqlite = rewriteSqlitePaths(sqliteMapping.stageTarget, rewriteMappings, {
    threadIds: sqliteMapping.kind === "stateDbMerge" ? sqliteMapping.selectedThreadIds : undefined
  });
  return report;
}

function installSQLiteAtomically(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const installTemp = path.join(path.dirname(target), `.${path.basename(target)}.codex-link-install-${process.pid}-${crypto.randomBytes(3).toString("hex")}`);
  copyPath(source, installTemp);
  const fd = fs.openSync(installTemp, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const displaced = `${target}.codex-link-displaced-${process.pid}`;
  removePath(displaced);
  try {
    if (exists(target)) fs.renameSync(target, displaced);
    fs.renameSync(installTemp, target);
    removePath(displaced);
  } catch (error) {
    removePath(installTemp);
    if (!exists(target) && exists(displaced)) fs.renameSync(displaced, target);
    throw error;
  }
}

function createRequestedProjectDirectories(plan) {
  const created = [];
  for (const mapping of plan.projectPathMappings || []) {
    if (!["placeholder", "unresolved"].includes(mapping.mode) || !mapping.targetRoot || exists(mapping.targetRoot)) continue;
    fs.mkdirSync(mapping.targetRoot, { recursive: true });
    created.push(mapping.targetRoot);
  }
  return created;
}

function removeEmptyCreatedDirectories(created) {
  for (const directory of [...created].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(directory); } catch {}
  }
}

function executeRestoreTransaction({
  plan,
  cloudDir,
  allowUnverified = false,
  confirmHighRisk = false,
  onProgress = () => {},
  _testFailAfterApply = 0,
  _testCrashAfterApply = 0,
  _testTruncateStagedSQLite = false,
  _testCorruptStagedSQLite = false,
  _testRunningProcesses
}) {
  const emitProgress = onProgress;
  let lastReportedProgress = 0;
  onProgress = (event = {}) => {
    const progress = Math.max(lastReportedProgress, Number(event.progress || 0));
    lastReportedProgress = progress;
    emitProgress({ ...event, progress });
  };
  onProgress({ progress: 2, stage: "source_verification", message: "正在校验恢复点完整性" });
  const sourceVerificationTotal = Math.max(1, Number(plan.integrity?.totalBytes || 0));
  let sourceVerifiedBytes = 0;
  let sourceVerificationProgress = 1;
  const integrity = verifySnapshotIntegrity(plan.snapshotDir, {
    onHashChunk: ({ bytes }) => {
      sourceVerifiedBytes += Number(bytes || 0);
      const progress = Math.min(8, 2 + Math.floor((sourceVerifiedBytes / sourceVerificationTotal) * 6));
      if (progress > sourceVerificationProgress) {
        sourceVerificationProgress = progress;
        onProgress({
          progress,
          stage: "source_verification",
          message: "正在逐文件校验恢复点 SHA-256",
          completedBytes: sourceVerifiedBytes,
          totalBytes: sourceVerificationTotal
        });
      }
    }
  });
  if (integrity.status === "failed") {
    throw new RestoreExecutionError("Restore point integrity verification failed. No target files were changed.", {
      phase: "source_verification",
      integrity
    });
  }
  if (integrity.status === "unverified" && !allowUnverified) {
    throw new RestoreExecutionError("This legacy restore point has no trusted hash manifest. No target files were changed.", {
      phase: "source_verification",
      integrity,
      requiresUnverifiedConfirmation: true
    });
  }
  const highRisk = plan.adaptationPlan?.highRisk || [];
  if ((plan.adaptationPlan?.crossOS || highRisk.length) && !confirmHighRisk) {
    throw new RestoreExecutionError("Cross-system or high-risk restore requires explicit confirmation.", {
      phase: "confirmation",
      crossOS: Boolean(plan.adaptationPlan?.crossOS),
      highRisk
    });
  }

  const { mappings, targetRoot } = validatedMappings(plan);
  const stateDatabaseMapping = sqliteRestoreMapping(mappings);
  let sqlitePreflight = null;
  if (stateDatabaseMapping) {
    sqlitePreflight = assertSQLiteTargetSafe({
      targetDatabase: stateDatabaseMapping.target,
      targetRoot,
      processes: _testRunningProcesses
    });
  }
  let sqliteValidation = null;
  let sourceSqliteValidation = null;
  let sqliteMergeReport = null;
  let expectedStagedSQLiteSize = null;
  let pathAdaptationReport = { jsonlFieldsUpdated: 0, sqlite: null };
  let createdProjectDirectories = [];
  onProgress({ progress: 8, stage: "mapping", message: `已确认 ${mappings.length} 个恢复映射`, completedUnits: 0, totalUnits: mappings.length });
  const mappingMeasures = mappings.map((mapping) => ({ mapping, ...measurePath(mapping.source) }));
  const transferTotalBytes = Math.max(1, mappingMeasures.reduce((sum, item) => sum + item.totalBytes, 0));
  const stageRoot = path.join(
    path.dirname(targetRoot),
    `.${path.basename(targetRoot)}.codex-link-stage-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`
  );
  let rollback = null;
  let appliedCount = 0;

  try {
    fs.mkdirSync(stageRoot, { recursive: true });
    let stageCount = 0;
    let stagedBytes = 0;
    let stageCopyProgress = 7;
    let stageVerifiedBytes = 0;
    let stageVerifyProgress = 29;
    for (const mapping of mappings) {
      const stageTarget = resolveInside(stageRoot, mapping.relativeTarget);
      copyPath(mapping.source, stageTarget, {
        onChunk: ({ bytes, source }) => {
          stagedBytes += Number(bytes || 0);
          const progress = Math.min(30, 8 + Math.floor((stagedBytes / transferTotalBytes) * 22));
          if (progress > stageCopyProgress) {
            stageCopyProgress = progress;
            onProgress({
              progress,
              stage: "staging",
              message: `正在写入临时恢复区：${mapping.label || path.basename(source)}`,
              completedBytes: stagedBytes,
              totalBytes: transferTotalBytes
            });
          }
        }
      });
      const issues = comparePaths(mapping.source, stageTarget, {
        onHashChunk: ({ bytes }) => {
          stageVerifiedBytes += Number(bytes || 0);
          const progress = Math.min(42, 30 + Math.floor((stageVerifiedBytes / (transferTotalBytes * 2)) * 12));
          if (progress > stageVerifyProgress) {
            stageVerifyProgress = progress;
            onProgress({
              progress,
              stage: "staging_verification",
              message: `正在校验临时恢复区：${mapping.label || mapping.relativeTarget}`,
              completedBytes: stageVerifiedBytes,
              totalBytes: transferTotalBytes * 2
            });
          }
        }
      });
      if (issues.length) {
        throw new RestoreExecutionError("Staging verification failed. No target files were changed.", {
          phase: "staging_verification",
          mapping: mapping.label,
          issues
        });
      }
      mapping.stageTarget = stageTarget;
      stageCount += 1;
      onProgress({
        progress: Math.max(stageCopyProgress, stageVerifyProgress, 30 + Math.round((stageCount / mappings.length) * 12)),
        stage: "staging_verification",
        message: `临时恢复区已校验：${mapping.label || mapping.relativeTarget}`,
        completedUnits: stageCount,
        totalUnits: mappings.length
      });
    }

    onProgress({ progress: 42, stage: "files_copied", message: "临时恢复区文件复制与哈希校验通过" });
    if (stateDatabaseMapping) {
      try {
        sourceSqliteValidation = validateSQLiteDatabase(stateDatabaseMapping.source, {
          expectedSize: plan.sqliteMetadata?.size ?? fs.statSync(stateDatabaseMapping.source).size,
          expectedThreadCount: plan.sqliteMetadata?.threadCount,
          requireAllRollouts: false
        });
      } catch (error) {
        throw new RestoreExecutionError("Backup SQLite validation failed. No target files were changed.", {
          phase: "sqlite_validated",
          file: stateDatabaseMapping.source,
          sqlite: error.report || null,
          cause: error.message
        });
      }
      if (stateDatabaseMapping.kind === "stateDbMerge") {
        try {
          sqliteMergeReport = mergeSelectedSqliteThreads({
            sourceDatabase: stateDatabaseMapping.source,
            targetDatabase: stateDatabaseMapping.target,
            outputDatabase: stateDatabaseMapping.stageTarget,
            threadIds: stateDatabaseMapping.selectedThreadIds,
            pathMappings: plan.pathRewriteMappings || []
          });
          stateDatabaseMapping.transactionDetails = {
            insertedThreadIds: sqliteMergeReport.insertedThreadIds,
            insertedThreadFingerprints: sqliteMergeReport.insertedThreadFingerprints,
            insertedAssociationFingerprints: sqliteMergeReport.insertedAssociationFingerprints || {},
            preservedThreadIds: sqliteMergeReport.preservedThreadIds
          };
        } catch (error) {
          throw new RestoreExecutionError("Selected thread index merge failed. No target files were changed.", {
            phase: "sqlite_merge",
            file: stateDatabaseMapping.stageTarget,
            cause: error.message
          });
        }
      }
    }
    if (stateDatabaseMapping) expectedStagedSQLiteSize = fs.statSync(stateDatabaseMapping.stageTarget).size;
    if (stateDatabaseMapping && _testTruncateStagedSQLite) {
      const size = fs.statSync(stateDatabaseMapping.stageTarget).size;
      fs.truncateSync(stateDatabaseMapping.stageTarget, Math.max(100, Math.floor(size / 2)));
    }
    if (stateDatabaseMapping && _testCorruptStagedSQLite) {
      const fd = fs.openSync(stateDatabaseMapping.stageTarget, "r+");
      try { fs.writeSync(fd, Buffer.from("BROKEN!!"), 0, 8, 0); } finally { fs.closeSync(fd); }
    }
    if (stateDatabaseMapping) {
      try {
        validateSQLiteDatabase(stateDatabaseMapping.stageTarget, {
          expectedSize: expectedStagedSQLiteSize,
          expectedThreadCount: sqliteMergeReport?.afterThreadCount ?? sourceSqliteValidation.threadCount,
          requireAllRollouts: false
        });
      } catch (error) {
        throw new RestoreExecutionError("Staged SQLite validation failed. No target files were changed.", {
          phase: "sqlite_validated",
          file: stateDatabaseMapping.stageTarget,
          expectedSize: expectedStagedSQLiteSize,
          actualSize: fs.existsSync(stateDatabaseMapping.stageTarget) ? fs.statSync(stateDatabaseMapping.stageTarget).size : 0,
          sqlite: error.report || null,
          cause: error.message
        });
      }
    }
    pathAdaptationReport = adaptStagedPayload({ plan, mappings, stageRoot, targetRoot });
    onProgress({ progress: 46, stage: "paths_adapted", message: "项目路径元数据适配完成" });
    if (stateDatabaseMapping) {
      try {
        sqliteValidation = validateSQLiteDatabase(stateDatabaseMapping.stageTarget, {
          expectedSize: stateDatabaseMapping.kind === "stateDbMerge" ? undefined : plan.sqliteMetadata?.size,
          expectedThreadCount: sqliteMergeReport?.afterThreadCount ?? sourceSqliteValidation.threadCount,
          threadIds: stateDatabaseMapping.kind === "stateDbMerge" ? stateDatabaseMapping.selectedThreadIds : undefined,
          rolloutResolver: stagedRolloutResolver(stageRoot, targetRoot),
          requireAllRollouts: true
        });
      } catch (error) {
        throw new RestoreExecutionError("Adapted SQLite or rollout-path validation failed. No target files were changed.", {
          phase: error.report?.missingRolloutCount ? "session_paths_validated" : "sqlite_validated",
          file: stateDatabaseMapping.stageTarget,
          sqlite: error.report || null,
          expectedSize: stateDatabaseMapping.kind === "stateDbMerge" ? null : plan.sqliteMetadata?.size,
          actualSize: fs.existsSync(stateDatabaseMapping.stageTarget) ? fs.statSync(stateDatabaseMapping.stageTarget).size : 0,
          cause: error.message
        });
      }
      onProgress({ progress: 50, stage: "sqlite_validated", message: "SQLite quick_check、integrity_check 与页数校验通过" });
      onProgress({ progress: 52, stage: "session_paths_validated", message: "线程数量与 rollout_path 校验通过" });
    }
    rollback = createRollbackPoint({
      mappings,
      targetRoot,
      rollbackRoot: rollbackRootFor(cloudDir),
      sourceSnapshotId: plan.snapshotId,
      onProgress: ({ completedUnits, totalUnits, mapping }) => onProgress({
        progress: 42 + Math.round((completedUnits / Math.max(1, totalUnits)) * 18),
        stage: "rollback",
        message: `已保护原文件：${mapping.label || mapping.relativeTarget}`,
        completedUnits,
        totalUnits
      })
    });
    updateTransactionJournal(rollback, "rollback_ready", {
      stageRoot,
      mappingCount: mappings.length,
      appliedCount: 0
    });
    updateTransactionJournal(rollback, "files_copied", { stageRoot, mappingCount: mappings.length });
    updateTransactionJournal(rollback, "paths_adapted", { pathAdaptationReport });
    if (stateDatabaseMapping) {
      updateTransactionJournal(rollback, "sqlite_validated", { sqliteValidation, sqliteMergeReport });
      updateTransactionJournal(rollback, "session_paths_validated", {
        threadCount: sqliteValidation.threadCount,
        missingRolloutCount: sqliteValidation.missingRolloutCount
      });
    }
    createdProjectDirectories = createRequestedProjectDirectories(plan);
    updateTransactionJournal(rollback, "applying", { sqlitePreflight, createdProjectDirectories });

    let appliedBytes = 0;
    let applyProgress = 59;
    for (const mapping of mappings) {
      if (mapping === stateDatabaseMapping) {
        installSQLiteAtomically(mapping.stageTarget, mapping.target);
        appliedBytes += fs.statSync(mapping.stageTarget).size;
      } else {
        const stagedStat = statSafe(mapping.stageTarget, true);
        const targetStat = statSafe(mapping.target, true);
        if (targetStat && stagedStat?.isDirectory() !== targetStat.isDirectory()) removePath(mapping.target);
      copyPath(mapping.stageTarget, mapping.target, {
        onChunk: ({ bytes, source }) => {
          appliedBytes += Number(bytes || 0);
          const progress = Math.min(86, 60 + Math.floor((appliedBytes / transferTotalBytes) * 26));
          if (progress > applyProgress) {
            applyProgress = progress;
            onProgress({
              progress,
              stage: "applying",
              message: `正在恢复：${mapping.label || path.basename(source)}`,
              completedBytes: appliedBytes,
              totalBytes: transferTotalBytes
            });
          }
        }
      });
      }
      appliedCount += 1;
      onProgress({
        progress: Math.max(applyProgress, 60 + Math.round((appliedCount / mappings.length) * 26)),
        stage: "applying",
        message: `已恢复：${mapping.label || mapping.relativeTarget}`,
        completedUnits: appliedCount,
        totalUnits: mappings.length
      });
      updateTransactionJournal(rollback, "applying", {
        appliedCount,
        lastAppliedTarget: mapping.relativeTarget
      });
      if (_testCrashAfterApply && appliedCount >= _testCrashAfterApply) {
        const crash = new Error("Injected process interruption for journal recovery verification.");
        crash.skipAutomaticRollback = true;
        throw crash;
      }
      if (_testFailAfterApply && appliedCount >= _testFailAfterApply) {
        throw new Error("Injected restore failure for rollback verification.");
      }
    }

    updateTransactionJournal(rollback, "installed", { appliedCount });
    updateTransactionJournal(rollback, "verifying", { appliedCount });
    const postIssues = [];
    let verifiedCount = 0;
    let postVerifiedBytes = 0;
    let postVerifyProgress = 85;
    for (const mapping of mappings) {
      postIssues.push(...comparePaths(mapping.stageTarget, mapping.target, {
        allowUnexpected: Boolean(statSafe(mapping.stageTarget, true)?.isDirectory()),
        onHashChunk: ({ bytes }) => {
          postVerifiedBytes += Number(bytes || 0);
          const progress = Math.min(98, 86 + Math.floor((postVerifiedBytes / (transferTotalBytes * 2)) * 12));
          if (progress > postVerifyProgress) {
            postVerifyProgress = progress;
            onProgress({
              progress,
              stage: "post_restore_verification",
              message: `正在复核：${mapping.label || mapping.relativeTarget}`,
              completedBytes: postVerifiedBytes,
              totalBytes: transferTotalBytes * 2
            });
          }
        }
      })
        .map((issue) => ({ ...issue, target: mapping.target, label: mapping.label })));
      verifiedCount += 1;
      onProgress({
        progress: Math.max(postVerifyProgress, 86 + Math.round((verifiedCount / mappings.length) * 12)),
        stage: "post_restore_verification",
        message: `正在复核：${mapping.label || mapping.relativeTarget}`,
        completedUnits: verifiedCount,
        totalUnits: mappings.length
      });
    }
    if (postIssues.length) {
      throw new RestoreExecutionError("Post-restore verification failed.", {
        phase: "post_restore_verification",
        issues: postIssues.slice(0, 200)
      });
    }

    removePath(stageRoot);
    updateTransactionJournal(rollback, "completed", {
      appliedCount,
      completedAt: new Date().toISOString(),
      stages: {
        files_copied: true,
        paths_adapted: true,
        sqlite_validated: stateDatabaseMapping ? Boolean(sqliteValidation?.valid) : "not_selected",
        session_paths_validated: stateDatabaseMapping ? sqliteValidation?.missingRolloutCount === 0 : "not_selected",
        installed: true
      },
    });
    onProgress({ progress: 100, stage: "completed", message: "恢复完成，逐项校验通过", completedUnits: mappings.length, totalUnits: mappings.length });
    return {
      appVersion: APP_VERSION,
      status: "restored",
      restored: true,
      snapshotId: plan.snapshotId,
      targetCodexHome: targetRoot,
      restoredMappings: mappings.length,
      integrity,
      postRestoreVerification: {
        status: "verified",
        verified: true,
        mappingCount: mappings.length,
        issueCount: 0
      },
      pathAdaptation: pathAdaptationReport,
      sqliteValidation,
      sqlitePreflight,
      sqliteMerge: sqliteMergeReport,
      projectMappings: plan.projectPathMappings || [],
      rollbackPoint: {
        id: rollback.id,
        path: rollback.rollbackDir,
        retained: true
      },
      completedAt: new Date().toISOString()
    };
  } catch (error) {
    if (error.skipAutomaticRollback) throw error;
    removePath(stageRoot);
    removeEmptyCreatedDirectories(createdProjectDirectories);
    if (!rollback) throw error;

    updateTransactionJournal(rollback, "rolling_back", {
      appliedCount,
      failure: error.message
    });
    onProgress({ progress: 90, stage: "rolling_back", message: "恢复未完成，正在自动回退" });
    let rollbackResult;
    try {
      rollbackResult = restoreFromRollback(rollback);
    } catch (rollbackError) {
      rollbackResult = {
        status: "rollback_failed",
        verified: false,
        issueCount: 1,
        issues: [{ kind: "rollback_exception", path: "", detail: rollbackError.message }]
      };
    }

    updateTransactionJournal(
      rollback,
      rollbackResult.verified ? "rolled_back" : "rollback_failed",
      { appliedCount, rollbackResult }
    );
    onProgress({
      progress: rollbackResult.verified ? 100 : 96,
      stage: rollbackResult.verified ? "rolled_back" : "rollback_failed",
      message: rollbackResult.verified ? "已安全回退到恢复前状态" : "自动回退需要人工检查"
    });

    throw new RestoreExecutionError(
      rollbackResult.verified
        ? "Restore failed and the original files were restored from the automatic rollback point."
        : "Restore failed and automatic rollback could not be fully verified.",
      {
        phase: error.details?.phase || "restore_execution",
        ...(error.details || {}),
        cause: error.message,
        appliedCount,
        rollback: rollbackResult,
        rollbackPoint: {
          id: rollback.id,
          path: rollback.rollbackDir,
          retained: true
        }
      }
    );
  }
}

function resolveRollbackPoint(cloudDir, input = {}) {
  const root = rollbackRootFor(cloudDir);
  const requested = input.rollbackDir
    ? path.resolve(input.rollbackDir)
    : path.join(root, path.basename(String(input.id || "")));
  const relative = path.relative(root, requested);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Rollback point is outside the configured rollback folder.");
  }
  const loaded = readSnapshotManifest(requested);
  if (loaded.manifest.snapshotKind !== "automatic-rollback") {
    throw new Error("The selected folder is not a transaction rollback point.");
  }
  return { id: loaded.manifest.id, rollbackDir: loaded.snapshotDir, manifest: loaded.manifest };
}

function listRollbackPoints(cloudDir) {
  const root = rollbackRootFor(cloudDir);
  if (!exists(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        const rollback = resolveRollbackPoint(cloudDir, { id: entry.name });
        const journal = readJsonSafe(path.join(rollback.rollbackDir, TRANSACTION_FILE)) || {};
        const items = Array.isArray(rollback.manifest.items) ? rollback.manifest.items : [];
        const operations = {
          create: items.filter((item) => item.operation === "create" || item.existed === false).length,
          overwrite: items.filter((item) => item.operation === "overwrite").length,
          merge: items.filter((item) => item.operation === "merge").length
        };
        return {
          id: rollback.id,
          rollbackDir: rollback.rollbackDir,
          sourceSnapshotId: rollback.manifest.sourceSnapshotId || null,
          createdAt: rollback.manifest.createdAt || null,
          targetCodexHome: rollback.manifest.targetCodexHome,
          status: journal.status || "unknown",
          transactionState: journal.status || "unknown",
          fileCount: items.length,
          threadCount: new Set(items.flatMap((item) => item.selectedThreadIds || (item.threadId ? [item.threadId] : []))).size,
          operations,
          canUndo: journal.status === "completed"
        };
      } catch (error) {
        return { id: entry.name, rollbackDir: path.join(root, entry.name), status: "invalid", canUndo: false, error: error.message };
      }
    })
    .sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
}

function rollbackHashConflicts(rollback) {
  if (Number(rollback.manifest.transactionSchemaVersion || 0) < 2) return [];
  const conflicts = [];
  for (const item of rollback.manifest.items || []) {
    const target = item.targetPath || item.target;
    if (item.operation === "merge" && Object.keys(item.insertedThreadFingerprints || {}).length) {
      conflicts.push(...(mergedSqliteConflicts(item) || []));
      continue;
    }
    const currentHash = currentEntryHash(target);
    if (item.operation === "create") {
      if (currentHash !== null && currentHash !== item.afterHash) {
        conflicts.push({ path: item.relativeTarget, operation: item.operation, reason: "changed_after_restore" });
      }
      continue;
    }
    if (currentHash !== item.beforeHash && currentHash !== item.afterHash) {
      conflicts.push({ path: item.relativeTarget, operation: item.operation, reason: "changed_after_restore" });
    }
  }
  return conflicts;
}

function captureUndoSafety(rollback) {
  const safetyRoot = path.join(
    path.dirname(rollback.rollbackDir),
    `.${path.basename(rollback.rollbackDir)}-undo-safety-${process.pid}-${crypto.randomBytes(3).toString("hex")}`
  );
  const items = [];
  fs.mkdirSync(path.join(safetyRoot, "payload"), { recursive: true });
  try {
    for (const item of rollback.manifest.items || []) {
      const target = path.resolve(item.targetPath || item.target || "");
      const relativeTarget = validateRelativePath(item.relativeTarget);
      const existed = exists(target);
      const payload = path.join(safetyRoot, "payload", ...relativeTarget.split("/"));
      if (existed) copyPath(target, payload);
      items.push({ target, relativeTarget, existed, payload, hash: currentEntryHash(target) });
    }
    return { root: safetyRoot, items };
  } catch (error) {
    removePath(safetyRoot);
    throw error;
  }
}

function restoreUndoSafety(safety) {
  const issues = [];
  for (const item of [...safety.items].sort((a, b) => b.relativeTarget.split("/").length - a.relativeTarget.split("/").length)) {
    try {
      removePath(item.target);
      if (item.existed) copyPath(item.payload, item.target);
      const actual = currentEntryHash(item.target);
      if (actual !== item.hash) issues.push({ path: item.relativeTarget, expectedHash: item.hash, actualHash: actual });
    } catch (error) {
      issues.push({ path: item.relativeTarget, error: error.message });
    }
  }
  return { verified: issues.length === 0, issueCount: issues.length, issues };
}

function undoRestoreTransaction({ cloudDir, rollbackDir, id, processes, _testFailAfterItems = 0 }) {
  const rollback = resolveRollbackPoint(cloudDir, { rollbackDir, id });
  const integrity = verifySnapshotIntegrity(rollback.rollbackDir);
  if (integrity.status !== "verified") throw new Error("Transaction rollback point failed integrity verification.");
  const journal = readJsonSafe(path.join(rollback.rollbackDir, TRANSACTION_FILE)) || {};
  if (journal.status === "manual_rolled_back") {
    return { status: "manual_rolled_back", alreadyUndone: true, verified: true, rollbackPoint: rollback.rollbackDir };
  }
  if (journal.status !== "completed") {
    throw new Error(`Only a completed restore transaction can be undone (current status: ${journal.status || "unknown"}).`);
  }
  const sqliteItem = (rollback.manifest.items || []).find((item) => path.basename(item.targetPath || item.target || "").toLowerCase() === "state_5.sqlite");
  if (sqliteItem) {
    assertSQLiteTargetSafe({
      targetDatabase: sqliteItem.targetPath || sqliteItem.target,
      targetRoot: rollback.manifest.targetCodexHome,
      processes
    });
  }
  const conflicts = rollbackHashConflicts(rollback);
  if (conflicts.length) {
    updateTransactionJournal(rollback, "completed", {
      lastUndoAttemptAt: new Date().toISOString(),
      lastUndoConflicts: conflicts
    });
    return {
      status: "rollback_conflict",
      verified: false,
      conflictCount: conflicts.length,
      conflicts,
      rollbackPoint: rollback.rollbackDir
    };
  }
  const safety = captureUndoSafety(rollback);
  let result;
  let safetyRecovery = null;
  try {
    result = restoreFromRollback(rollback, { failAfterItems: _testFailAfterItems });
    if (!result.verified) safetyRecovery = restoreUndoSafety(safety);
  } catch (error) {
    safetyRecovery = restoreUndoSafety(safety);
    result = {
      status: safetyRecovery.verified ? "rollback_failed_safely_recovered" : "rollback_failed",
      verified: false,
      issueCount: 1,
      issues: [{ kind: "manual_undo_exception", detail: error.message }]
    };
  } finally {
    removePath(safety.root);
  }
  const completed = result.verified;
  const safelyRecovered = !completed && safetyRecovery?.verified;
  updateTransactionJournal(rollback, completed ? "manual_rolled_back" : safelyRecovered ? "completed" : "rollback_failed", {
    manualRollbackAt: new Date().toISOString(),
    manualRollbackResult: result,
    undoSafetyRecovery: safetyRecovery
  });
  return {
    ...result,
    status: completed ? "manual_rolled_back" : safelyRecovered ? "rollback_failed_safely_recovered" : result.status,
    retryAllowed: safelyRecovered,
    undoSafetyRecovery: safetyRecovery,
    rollbackPoint: rollback.rollbackDir,
    sourceSnapshotId: rollback.manifest.sourceSnapshotId,
    targetCodexHome: rollback.manifest.targetCodexHome
  };
}

module.exports = {
  RestoreExecutionError,
  buildSnapshotIntegrity,
  collectEntries,
  executeRestoreTransaction,
  finalizeSnapshotManifest,
  listRollbackPoints,
  portablePath,
  readSnapshotManifest,
  recoverInterruptedRestores,
  undoRestoreTransaction,
  resolveInside,
  validateRelativePath,
  verifySnapshotIntegrity
};
