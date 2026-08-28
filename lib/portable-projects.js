"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const PROJECT_CATALOG_SCHEMA_VERSION = 2;

function looksWindowsPath(value) {
  return /^(?:\\\\\?\\)?[A-Za-z]:[\\/]/.test(String(value || ""))
    || /^(?:\\\\\?\\UNC\\|\\\\)[^\\/]+[\\/][^\\/]+/i.test(String(value || ""));
}

function normalizeProjectPath(value) {
  let original = String(value || "").trim();
  if (!original) return null;
  original = original.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "");
  const windows = looksWindowsPath(original);
  let normalized = original.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (/^[a-z]:\//i.test(normalized)) normalized = normalized[0].toUpperCase() + normalized.slice(1);
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, "");
  return {
    original: String(value),
    normalized,
    comparisonKey: windows ? normalized.toLocaleLowerCase("en-US") : normalized,
    platform: windows ? "win32" : normalized.startsWith("/") ? "darwin" : "unknown"
  };
}

function stableProjectId(normalizedPath) {
  const info = normalizeProjectPath(normalizedPath);
  return `project-${crypto.createHash("sha256").update(info?.comparisonKey || String(normalizedPath)).digest("hex").slice(0, 16)}`;
}

function projectDisplayName(projectPath) {
  const info = normalizeProjectPath(projectPath);
  if (!info) return "未关联项目";
  const parts = info.normalized.split("/").filter(Boolean);
  return parts.at(-1) || info.normalized;
}

function readJsonlMetadata(filePath) {
  const result = { threadIds: new Set(), paths: [], title: "", startedAt: null };
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return result;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || !record.payload) continue;
    const payload = record.payload;
    if (["session_meta", "turn_context"].includes(record.type)) {
      const id = payload.id || payload.thread_id || payload.threadId || payload.session_id;
      if (id) result.threadIds.add(String(id));
      if (payload.cwd) result.paths.push(String(payload.cwd));
      if (!result.startedAt && (record.timestamp || payload.timestamp)) {
        result.startedAt = record.timestamp || payload.timestamp;
      }
    }
    if (!result.title && record.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const content = Array.isArray(payload.content) ? payload.content : [];
      const messageText = content.find((item) => typeof item?.text === "string")?.text;
      if (messageText) result.title = messageText.trim().slice(0, 120);
    }
    if (!result.title && record.type === "event_msg" && payload.type === "user_message" && payload.message) {
      result.title = String(payload.message).trim().slice(0, 120);
    }
  }
  return result;
}

function walkJsonl(root) {
  if (!root || !fs.existsSync(root)) return [];
  const found = [];
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) visit(path.join(current, entry.name));
    } else if (stat.isFile() && /\.jsonl$/i.test(current)) found.push(current);
  };
  visit(root);
  return found;
}

function readSqliteThreads(databasePath) {
  if (!databasePath || !fs.existsSync(databasePath)) return [];
  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").all();
    if (!tables.length) return [];
    const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((item) => item.name));
    const selected = ["id", "cwd", "rollout_path", "title"].filter((name) => columns.has(name));
    if (!selected.includes("id") || !selected.includes("cwd")) return [];
    return db.prepare(`SELECT ${selected.map((name) => `"${name}"`).join(", ")} FROM threads`).all()
      .map((item) => ({
        id: String(item.id),
        cwd: item.cwd ? String(item.cwd) : "",
        rolloutPath: item.rollout_path ? String(item.rollout_path) : "",
        title: item.title ? String(item.title) : ""
      }));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

function buildPortableProjectCatalog({ codexHome, stateDbPath, sessionRoots, sourcePlatform, projectFilesIncluded = false }) {
  const projects = new Map();
  const threadPaths = new Map();
  const add = (rawPath, threadId, thread = {}) => {
    const info = normalizeProjectPath(rawPath);
    if (!info || info.platform === "unknown") return;
    if (!projects.has(info.comparisonKey)) {
      projects.set(info.comparisonKey, {
        projectId: stableProjectId(info.normalized),
        displayName: projectDisplayName(info.normalized),
        sourceRoot: info.original,
        normalizedSourceRoot: info.normalized,
        threadIds: new Set(),
        threads: new Map(),
        projectFilesIncluded: Boolean(projectFilesIncluded)
      });
    }
    if (threadId) {
      const id = String(threadId);
      const project = projects.get(info.comparisonKey);
      project.threadIds.add(id);
      const existing = project.threads.get(id) || { threadId: id };
      project.threads.set(id, {
        ...existing,
        ...Object.fromEntries(Object.entries(thread).filter(([, value]) => value !== undefined && value !== null && value !== "")),
        threadId: id
      });
    }
  };

  const databasePath = stateDbPath === undefined ? (codexHome ? path.join(codexHome, "state_5.sqlite") : "") : stateDbPath;
  const sqliteThreads = readSqliteThreads(databasePath);
  for (const thread of sqliteThreads) {
    add(thread.cwd, thread.id, { title: thread.title, rolloutPath: thread.rolloutPath });
    if (thread.cwd) threadPaths.set(thread.id, thread.cwd);
  }

  const roots = sessionRoots || ["sessions", "archived_sessions"].map((name) => codexHome ? path.join(codexHome, name) : "");
  for (const root of roots) {
    for (const filePath of walkJsonl(root)) {
      const metadata = readJsonlMetadata(filePath);
      const fallbackId = path.basename(filePath, path.extname(filePath));
      const threadIds = metadata.threadIds.size ? [...metadata.threadIds] : [fallbackId];
      const relativeCandidate = codexHome ? path.relative(codexHome, filePath) : path.basename(filePath);
      const relativePath = relativeCandidate && !relativeCandidate.startsWith("..") && !path.isAbsolute(relativeCandidate)
        ? relativeCandidate.replace(/\\/g, "/")
        : path.basename(filePath);
      const bucket = relativePath.startsWith("archived_sessions/") ? "archived" : "active";
      const stat = fs.statSync(filePath);
      const threadMetadata = { title: metadata.title, startedAt: metadata.startedAt, relativePath, bucket, size: stat.size };
      for (const rawPath of metadata.paths) for (const threadId of threadIds) add(rawPath, threadId, threadMetadata);
      for (const threadId of threadIds) {
        if (!metadata.paths.length && threadPaths.has(threadId)) add(threadPaths.get(threadId), threadId, threadMetadata);
      }
    }
  }

  const list = [...projects.values()].map((item) => ({
    ...item,
    threadIds: [...item.threadIds].sort(),
    threadCount: item.threadIds.size,
    threads: [...item.threads.values()].sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || ""))),
  })).sort((a, b) => a.normalizedSourceRoot.localeCompare(b.normalizedSourceRoot, "en"));
  const detectedPlatform = sourcePlatform || (list.some((item) => looksWindowsPath(item.sourceRoot)) ? "win32" : process.platform);
  return {
    schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION,
    sourcePlatform: detectedPlatform,
    generatedAt: new Date().toISOString(),
    projectFilesIncluded: Boolean(projectFilesIncluded),
    projectCount: list.length,
    threadCount: new Set(list.flatMap((item) => item.threadIds)).size,
    projects: list
  };
}

function loadOrRebuildProjectCatalog(snapshotDir, manifest) {
  const catalogPath = path.join(snapshotDir, "payload", "projects.json");
  if (fs.existsSync(catalogPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
      if (parsed?.schemaVersion === PROJECT_CATALOG_SCHEMA_VERSION && Array.isArray(parsed.projects)) {
        return { ...parsed, migratedFromLegacy: false };
      }
    } catch {}
  }
  const payload = path.join(snapshotDir, "payload");
  return {
    ...buildPortableProjectCatalog({
      codexHome: payload,
      stateDbPath: path.join(payload, "state_5.sqlite"),
      sessionRoots: [path.join(payload, "sessions"), path.join(payload, "archived_sessions"), path.join(payload, "selected", "conversations")],
      sourcePlatform: manifest?.sourceOS || process.platform
    }),
    migratedFromLegacy: true
  };
}

function pathStartsWith(value, root) {
  const candidate = normalizeProjectPath(value);
  const parent = normalizeProjectPath(root);
  if (!candidate || !parent) return false;
  return candidate.comparisonKey === parent.comparisonKey || candidate.comparisonKey.startsWith(`${parent.comparisonKey}/`);
}

function mapPortablePath(value, mappings) {
  const candidates = (mappings || []).filter((item) => item?.sourceRoot && item?.targetRoot && pathStartsWith(value, item.sourceRoot))
    .sort((a, b) => String(b.sourceRoot).length - String(a.sourceRoot).length);
  if (!candidates.length) return value;
  const chosen = candidates[0];
  const source = normalizeProjectPath(chosen.sourceRoot);
  const current = normalizeProjectPath(value);
  const suffix = current.normalized.slice(source.normalized.length).replace(/^\/+/, "");
  const target = String(chosen.targetRoot).replace(/[\\/]+$/, "");
  const separator = target.includes("\\") && !target.includes("/") ? "\\" : "/";
  return suffix ? `${target}${separator}${suffix.replace(/[\\/]+/g, separator)}` : target;
}

function rewriteJsonlPathMetadata(filePath, mappings) {
  const source = fs.readFileSync(filePath, "utf8");
  let changed = 0;
  const output = source.split(/(?<=\n)/).map((lineWithEnding) => {
    const line = lineWithEnding.replace(/\r?\n$/, "");
    const ending = lineWithEnding.slice(line.length);
    if (!line.trim()) return lineWithEnding;
    let record;
    try { record = JSON.parse(line); } catch { return lineWithEnding; }
    if (!record || !["session_meta", "turn_context"].includes(record.type) || !record.payload) return lineWithEnding;
    for (const key of ["cwd", "rollout_path"]) {
      if (typeof record.payload[key] !== "string") continue;
      const next = mapPortablePath(record.payload[key], mappings);
      if (next !== record.payload[key]) { record.payload[key] = next; changed += 1; }
    }
    return `${JSON.stringify(record)}${ending}`;
  }).join("");
  if (changed) fs.writeFileSync(filePath, output, "utf8");
  return changed;
}

function rewriteSqlitePaths(databasePath, mappings, options = {}) {
  const selectedThreadIds = options.threadIds ? new Set(options.threadIds.map(String)) : null;
  const db = new DatabaseSync(databasePath);
  let updatedCwd = 0;
  let updatedRolloutPath = 0;
  try {
    const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((item) => item.name));
    if (!columns.has("id")) return { updatedCwd, updatedRolloutPath };
    const fields = ["id", columns.has("cwd") ? "cwd" : null, columns.has("rollout_path") ? "rollout_path" : null].filter(Boolean);
    const rows = db.prepare(`SELECT ${fields.map((item) => `"${item}"`).join(", ")} FROM threads`).all();
    const cwdUpdate = columns.has("cwd") ? db.prepare("UPDATE threads SET cwd = ? WHERE id = ?") : null;
    const rolloutUpdate = columns.has("rollout_path") ? db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?") : null;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (selectedThreadIds && !selectedThreadIds.has(String(row.id))) continue;
        if (cwdUpdate && typeof row.cwd === "string") {
          const next = mapPortablePath(row.cwd, mappings);
          if (next !== row.cwd) { cwdUpdate.run(next, row.id); updatedCwd += 1; }
        }
        if (rolloutUpdate && typeof row.rollout_path === "string") {
          const next = mapPortablePath(row.rollout_path, mappings);
          if (next !== row.rollout_path) { rolloutUpdate.run(next, row.id); updatedRolloutPath += 1; }
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
  return { updatedCwd, updatedRolloutPath };
}

function vacuumSQLiteCopy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${String(target).replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

function quoteSqliteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function sqliteThreadAssociationTables(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'threads'").all();
  return tables.map(({ name }) => {
    const table = String(name);
    const columns = db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`).all();
    const columnNames = new Set(columns.map((item) => String(item.name)));
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteSqliteIdentifier(table)})`).all();
    const declared = foreignKeys.find((item) =>
      String(item.table).toLowerCase() === "threads" && String(item.to || "id").toLowerCase() === "id"
    );
    const threadColumn = declared?.from
      ? String(declared.from)
      : columnNames.has("thread_id")
        ? "thread_id"
        : null;
    return threadColumn ? { table, threadColumn, columns } : null;
  }).filter(Boolean);
}

function deleteSqliteThreadAssociations(db, threadIds) {
  const ids = [...new Set((threadIds || []).map(String).filter(Boolean))];
  const tables = [];
  let removedRows = 0;
  for (const descriptor of sqliteThreadAssociationTables(db)) {
    const remove = db.prepare(
      `DELETE FROM ${quoteSqliteIdentifier(descriptor.table)} WHERE ${quoteSqliteIdentifier(descriptor.threadColumn)} = ?`
    );
    let tableRows = 0;
    for (const id of ids) tableRows += Number(remove.run(id).changes || 0);
    if (tableRows) tables.push({ table: descriptor.table, threadColumn: descriptor.threadColumn, removedRows: tableRows });
    removedRows += tableRows;
  }
  return { removedRows, tables };
}

function mergeSqliteThreadAssociations(source, output, threadIds) {
  const ids = [...new Set((threadIds || []).map(String).filter(Boolean))];
  const sourceTables = new Map(sqliteThreadAssociationTables(source).map((item) => [item.table, item]));
  const details = [];
  let insertedRows = 0;
  for (const target of sqliteThreadAssociationTables(output)) {
    const from = sourceTables.get(target.table);
    if (!from || from.threadColumn !== target.threadColumn) continue;
    const sourceNames = new Set(from.columns.map((item) => String(item.name)));
    const integerPrimaryKeys = target.columns.filter((item) => Number(item.pk) > 0 && /INT/i.test(String(item.type || "")));
    const generatedPrimaryKey = integerPrimaryKeys.length === 1 && String(integerPrimaryKeys[0].name) !== target.threadColumn
      ? String(integerPrimaryKeys[0].name)
      : null;
    const commonColumns = target.columns
      .map((item) => String(item.name))
      .filter((name) => sourceNames.has(name) && name !== generatedPrimaryKey);
    const incompatibleRequired = target.columns.filter((item) =>
      Number(item.notnull) === 1
      && !item.dflt_value
      && Number(item.pk) === 0
      && !sourceNames.has(String(item.name))
    );
    if (incompatibleRequired.length) {
      throw new Error(`Associated table ${target.table} requires columns missing from the backup: ${incompatibleRequired.map((item) => item.name).join(", ")}`);
    }
    if (!commonColumns.includes(target.threadColumn)) continue;
    const read = source.prepare(
      `SELECT * FROM ${quoteSqliteIdentifier(target.table)} WHERE ${quoteSqliteIdentifier(target.threadColumn)} = ?`
    );
    const insert = output.prepare(
      `INSERT OR IGNORE INTO ${quoteSqliteIdentifier(target.table)} (${commonColumns.map(quoteSqliteIdentifier).join(", ")}) VALUES (${commonColumns.map(() => "?").join(", ")})`
    );
    let tableRows = 0;
    for (const id of ids) {
      for (const row of read.all(id)) {
        tableRows += Number(insert.run(...commonColumns.map((name) => row[name])).changes || 0);
      }
    }
    if (tableRows) details.push({ table: target.table, threadColumn: target.threadColumn, insertedRows: tableRows });
    insertedRows += tableRows;
  }
  return { insertedRows, tables: details };
}

function fingerprintSqliteThreadAssociations(databasePath, threadIds) {
  if (!databasePath || !fs.existsSync(databasePath)) return {};
  const ids = [...new Set((threadIds || []).map(String).filter(Boolean))];
  if (!ids.length) return {};
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = {};
    for (const descriptor of sqliteThreadAssociationTables(db)) {
      const columns = descriptor.columns.map((item) => String(item.name));
      const read = db.prepare(
        `SELECT ${columns.map(quoteSqliteIdentifier).join(", ")} FROM ${quoteSqliteIdentifier(descriptor.table)} WHERE ${quoteSqliteIdentifier(descriptor.threadColumn)} = ?`
      );
      for (const id of ids) {
        const rows = read.all(id).map((row) => columns.map((name) => {
          const value = row[name];
          return [name, typeof value, value instanceof Uint8Array ? Buffer.from(value).toString("base64") : String(value ?? "")];
        }));
        const serialized = rows.map((row) => JSON.stringify(row)).sort();
        const key = `${descriptor.table}:${descriptor.threadColumn}:${id}`;
        result[key] = crypto.createHash("sha256").update(JSON.stringify(serialized)).digest("hex");
      }
    }
    return result;
  } finally {
    db.close();
  }
}

function fingerprintSqliteThreads(databasePath, threadIds) {
  if (!databasePath || !fs.existsSync(databasePath)) return {};
  const ids = [...new Set((threadIds || []).map(String).filter(Boolean))];
  if (!ids.length) return {};
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const columns = db.prepare("PRAGMA table_info(threads)").all().map((item) => String(item.name));
    const quoted = (name) => `"${String(name).replace(/"/g, '""')}"`;
    const read = db.prepare(`SELECT ${columns.map(quoted).join(", ")} FROM threads WHERE id = ?`);
    return Object.fromEntries(ids.map((id) => {
      const row = read.get(id);
      if (!row) return [id, null];
      const values = columns.map((name) => [name, typeof row[name], String(row[name] ?? "")]);
      return [id, crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex")];
    }));
  } finally {
    db.close();
  }
}

function mergeSelectedSqliteThreads({ sourceDatabase, targetDatabase, outputDatabase, threadIds, pathMappings = [] }) {
  const selectedIds = [...new Set((threadIds || []).map(String).filter(Boolean))];
  if (!selectedIds.length) throw new Error("Selective SQLite merge requires at least one thread ID.");
  const targetExisted = Boolean(targetDatabase && fs.existsSync(targetDatabase));
  vacuumSQLiteCopy(targetExisted ? targetDatabase : sourceDatabase, outputDatabase);
  const source = new DatabaseSync(sourceDatabase, { readOnly: true });
  const output = new DatabaseSync(outputDatabase);
  let report;
  try {
    const sourceColumns = source.prepare("PRAGMA table_info(threads)").all();
    const targetColumns = output.prepare("PRAGMA table_info(threads)").all();
    const sourceNames = new Set(sourceColumns.map((item) => String(item.name)));
    const targetNames = new Set(targetColumns.map((item) => String(item.name)));
    if (!sourceNames.has("id") || !targetNames.has("id")) throw new Error("SQLite threads.id is required for selective restore.");
    const incompatibleRequired = targetColumns.filter((item) => Number(item.notnull) === 1 && !item.dflt_value && Number(item.pk) === 0 && !sourceNames.has(String(item.name)));
    if (incompatibleRequired.length) {
      throw new Error(`Target SQLite schema requires columns missing from the backup: ${incompatibleRequired.map((item) => item.name).join(", ")}`);
    }
    const commonColumns = targetColumns.map((item) => String(item.name)).filter((name) => sourceNames.has(name));
    const quoted = (name) => `"${String(name).replace(/"/g, '""')}"`;
    const readSource = source.prepare("SELECT * FROM threads WHERE id = ?");
    const readTarget = output.prepare("SELECT * FROM threads WHERE id = ?");
    const updateColumns = commonColumns.filter((name) => name !== "id");
    const conflictClause = updateColumns.length
      ? `DO UPDATE SET ${updateColumns.map((name) => `${quoted(name)} = excluded.${quoted(name)}`).join(", ")}`
      : "DO NOTHING";
    const sql = `INSERT INTO threads (${commonColumns.map(quoted).join(", ")}) VALUES (${commonColumns.map(() => "?").join(", ")}) ON CONFLICT("id") ${conflictClause}`;
    const upsert = output.prepare(sql);
    const rows = [];
    const insertedThreadIds = [];
    const preservedThreadIds = [];
    for (const id of selectedIds) {
      const row = readSource.get(id);
      if (!row) throw new Error(`Selected thread is missing from backup SQLite: ${id}`);
      if (targetExisted && readTarget.get(id)) preservedThreadIds.push(id);
      else insertedThreadIds.push(id);
      rows.push(row);
    }
    const beforeThreadCount = Number(output.prepare("SELECT COUNT(*) AS count FROM threads").get().count);
    output.exec("BEGIN IMMEDIATE");
    try {
      if (!targetExisted) {
        output.exec("CREATE TEMP TABLE codex_link_selected_threads (id TEXT PRIMARY KEY)");
        const keep = output.prepare("INSERT INTO codex_link_selected_threads (id) VALUES (?)");
        for (const id of selectedIds) keep.run(id);
        for (const descriptor of sqliteThreadAssociationTables(output)) {
          output.exec(
            `DELETE FROM ${quoteSqliteIdentifier(descriptor.table)} WHERE NOT EXISTS (SELECT 1 FROM codex_link_selected_threads selected WHERE selected.id = ${quoteSqliteIdentifier(descriptor.threadColumn)})`
          );
        }
        output.exec("DELETE FROM threads WHERE NOT EXISTS (SELECT 1 FROM codex_link_selected_threads selected WHERE selected.id = threads.id)");
      } else {
        for (const row of rows) {
          if (preservedThreadIds.includes(String(row.id))) continue;
          upsert.run(...commonColumns.map((name) => row[name]));
        }
        const associationMerge = mergeSqliteThreadAssociations(source, output, insertedThreadIds);
        if (associationMerge.insertedRows) {
          report = { associationMerge };
        }
      }
      output.exec("COMMIT");
    } catch (error) {
      output.exec("ROLLBACK");
      throw error;
    }
    const afterThreadCount = Number(output.prepare("SELECT COUNT(*) AS count FROM threads").get().count);
    report = {
      mode: targetExisted ? "merge_into_existing" : "filtered_new_database",
      selectedThreadCount: selectedIds.length,
      insertedThreadCount: insertedThreadIds.length,
      updatedThreadCount: 0,
      preservedThreadCount: preservedThreadIds.length,
      insertedThreadIds,
      preservedThreadIds,
      beforeThreadCount: targetExisted ? beforeThreadCount : 0,
      afterThreadCount,
      targetExisted,
      ...(report?.associationMerge ? {
        associatedRowsInserted: report.associationMerge.insertedRows,
        associatedTables: report.associationMerge.tables
      } : {})
    };
  } finally {
    source.close();
    output.close();
  }
  report.pathRewrite = rewriteSqlitePaths(outputDatabase, pathMappings, { threadIds: selectedIds });
  report.insertedThreadFingerprints = fingerprintSqliteThreads(outputDatabase, report.insertedThreadIds);
  const associationFingerprints = fingerprintSqliteThreadAssociations(outputDatabase, report.insertedThreadIds);
  if (Object.keys(associationFingerprints).length) report.insertedAssociationFingerprints = associationFingerprints;
  return report;
}

module.exports = {
  PROJECT_CATALOG_SCHEMA_VERSION,
  buildPortableProjectCatalog,
  deleteSqliteThreadAssociations,
  fingerprintSqliteThreadAssociations,
  fingerprintSqliteThreads,
  loadOrRebuildProjectCatalog,
  mergeSelectedSqliteThreads,
  mapPortablePath,
  normalizeProjectPath,
  projectDisplayName,
  readJsonlMetadata,
  readSqliteThreads,
  rewriteJsonlPathMetadata,
  rewriteSqlitePaths,
  stableProjectId,
  walkJsonl
};
